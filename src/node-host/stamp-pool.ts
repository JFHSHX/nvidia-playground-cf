// src/node-host/stamp-pool.ts — B: 多核 hashcash 章戳搜索(worker_threads)。
//
// 背景:mintStamp(pow.ts)是同步函数——34-bit 尖峰时章戳搜索会冻结整个 Node
// 事件循环 10s×3,期间所有模型、keep-alive、健康检查全部卡死。Go 原版
// (stamp.go:64-79)>10 bits 就全核并发;TS 移植为单线程是 workerd 单核约束,
// Node host 下该约束不存在。
//
// 结构:同一文件双角色——主线程导入得 mintStampAsync();worker 线程(isMainThread
// =false)跑 searchRange 分片搜索。worker 数量 NPG_STAMP_WORKERS(默认 min(物理核
// 数-1, 8),上限 8——8 核已把 24 bits 压到亚秒,更多核收益递减且 Chromium 也要核)。
// 池懒启动:首次 >10 bits 的搜索才创建 workers;<=10 bits 直接主线程同步(微秒级,
// 不值得跨线程)。预算与单线程一致(DEFAULT_STAMP_BUDGET_MS 10s);搜索分片步进
// stride = worker 数(与 Go 相同),找到即广播终止其余分片。
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { sha1, leadingZeros64, DEFAULT_STAMP_BUDGET_MS, PowBudgetExceeded } from "../hcaptcha/pow";

/** ESM 下没有 __filename;tsx/Node ESM 用 import.meta.url 转换。 */
const SELF_PATH = fileURLToPath(import.meta.url);

const ENC = new TextEncoder();

interface StampJob {
  bits: number;
  prefix: string; // `1:<bits/2>:<date>:<powData>::<salt>:`
  start: number;
  stride: number;
  budgetMs: number;
}

/** 分片搜索:counter 从 start 起、步长 stride;返回 stamp 或 null(预算尽)。 */
function searchRange(job: StampJob): string | null {
  const prefixBytes = ENC.encode(job.prefix);
  const buf = new Uint8Array(prefixBytes.length + 16);
  buf.set(prefixBytes);
  const start = Date.now();
  let counter = job.start;
  for (;;) {
    const hex = counter.toString(16);
    const msgLen = prefixBytes.length + hex.length;
    for (let i = 0; i < hex.length; i++) buf[prefixBytes.length + i] = hex.charCodeAt(i);
    if (leadingZeros64(sha1(buf.subarray(0, msgLen))) >= job.bits) {
      return new TextDecoder().decode(buf.subarray(0, msgLen));
    }
    counter += job.stride;
    if ((counter & 0x3fff) === 0 && Date.now() - start > job.budgetMs) return null;
  }
}

// --- worker 线程入口 ---
if (!isMainThread && parentPort) {
  const job = workerData as StampJob & { jobId: number };
  const stamp = searchRange(job);
  parentPort.postMessage({ jobId: job.jobId, stamp });
}

// --- 主线程:池管理 ---

interface PendingJob {
  resolve: (stamp: string) => void;
  reject: (err: Error) => void;
  workers: Worker[];
  timer: NodeJS.Timeout;
}

const pool: { workers: Worker[]; nextWorker: number; jobs: Map<number, PendingJob>; jobSeq: number } = {
  workers: [],
  nextWorker: 0,
  jobs: new Map(),
  jobSeq: 0,
};

function workerCount(): number {
  const env = Number(process.env.NPG_STAMP_WORKERS);
  if (Number.isFinite(env) && env >= 1) return Math.min(Math.floor(env), 16);
  return Math.min(Math.max(cpus().length - 1, 1), 8);
}

function ensureWorkers(): void {
  if (pool.workers.length > 0) return;
  const n = workerCount();
  for (let i = 0; i < n; i++) {
    const w = new Worker(SELF_PATH, { workerData: null });
    w.on("message", (msg: { jobId: number; stamp: string | null }) => {
      const job = pool.jobs.get(msg.jobId);
      if (!job) return;
      pool.jobs.delete(msg.jobId);
      clearTimeout(job.timer);
      for (const other of job.workers) void other.terminate();
      if (msg.stamp !== null) job.resolve(msg.stamp);
      else job.reject(new Error("stamp search failed"));
    });
    w.on("error", (err) => {
      // worker 异常:终止并让它负责的在飞任务失败(不拖死预算)
      for (const [id, job] of pool.jobs) {
        if (job.workers.includes(w)) {
          pool.jobs.delete(id);
          clearTimeout(job.timer);
          job.reject(err instanceof Error ? err : new Error(String(err)));
          for (const other of job.workers) void other.terminate();
        }
      }
    });
    pool.workers.push(w);
  }
}

/** mintStampAsync:多核分片铸造章戳。bits<=10 主线程同步(微秒级);bits>10
 * 起池,N 核 stride 分片。salt 省略时主线程生成(与 mintStamp 同格式)。 */
export async function mintStampAsync(bits: number, powData: string, salt?: string): Promise<string> {
  if (bits <= 10) {
    const { mintStamp } = await import("../hcaptcha/pow");
    return mintStamp(bits, powData, salt !== undefined ? { salt } : undefined);
  }
  ensureWorkers();
  const actualSalt = salt ?? randomSalt();
  const date = new Date().toISOString().slice(0, 10);
  const prefix = `1:${bits / 2}:${date}:${powData}::${actualSalt}:`;
  const n = pool.workers.length;
  const budgetMs = DEFAULT_STAMP_BUDGET_MS;
  const jobId = ++pool.jobSeq;

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      const job = pool.jobs.get(jobId);
      if (!job) return;
      pool.jobs.delete(jobId);
      for (const w of job.workers) void w.terminate();
      reject(new PowBudgetExceeded(bits, budgetMs, -1));
    }, budgetMs + 500); // 给 worker 启动余量
    const workers: Worker[] = [];
    pool.jobs.set(jobId, { resolve, reject, workers, timer });
    for (let i = 0; i < n; i++) {
      const w = new Worker(SELF_PATH, {
        workerData: { bits, prefix, start: i, stride: n, budgetMs, jobId } satisfies StampJob & { jobId: number },
      });
      w.on("message", (msg: { jobId: number; stamp: string | null }) => {
        const job = pool.jobs.get(msg.jobId);
        if (!job) return;
        pool.jobs.delete(msg.jobId);
        clearTimeout(job.timer);
        for (const other of job.workers) void other.terminate();
        if (msg.stamp !== null) job.resolve(msg.stamp);
        else job.reject(new PowBudgetExceeded(bits, budgetMs, -1));
      });
      w.on("error", (err) => {
        const job = pool.jobs.get(jobId);
        if (!job) return;
        pool.jobs.delete(jobId);
        clearTimeout(job.timer);
        for (const other of job.workers) void other.terminate();
        job.reject(err instanceof Error ? err : new Error(String(err)));
      });
      workers.push(w);
    }
  });
}

function randomSalt(): string {
  const raw = new Uint8Array(8);
  crypto.getRandomValues(raw);
  let bin = "";
  for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]!);
  return btoa(bin).slice(0, 8);
}
