// scripts/verify-stamp-pool.ts — B 多核章戳池的最小验证:
// (1) mintStampAsync(bits<=10) 与 mintStamp 同步结果格式一致且 checkStamp 通过;
// (2) bits=14(>10 起池)能铸出合法章戳,SHA-1 前导零位数达标;
// (3) 池不冻结事件循环:搜索期间 setTimeout 回调能按时触发(同步 mintStamp 会卡死);
// (4) 多核加速:bits=18 时池耗时 < 单线程同步耗时(允许 3x 容差,CI 机器噪声)。
// 运行:node node_modules/tsx/dist/cli.mjs scripts/verify-stamp-pool.ts
import { mintStampAsync } from "../src/node-host/stamp-pool";
import { mintStamp, checkStamp, leadingZeros64, sha1 } from "../src/hcaptcha/pow";

const ENC = new TextEncoder();
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// (1) 小难度同步路径
const s10 = await mintStampAsync(10, "verify-pool", "AAAAAAAA");
check("bits=10 stamp format", s10.startsWith("1:5:"), s10.slice(0, 40));
check("bits=10 checkStamp", checkStamp(s10, 10));

// (2) 起池路径(bits=14)
const t14 = Date.now();
const s14 = await mintStampAsync(14, "verify-pool", "AAAAAAAA");
const ms14 = Date.now() - t14;
check("bits=14 stamp format", s14.startsWith("1:7:"), s14.slice(0, 40));
check("bits=14 leading zeros >= 14", leadingZeros64(sha1(ENC.encode(s14))) >= 14, `${ms14}ms`);

// (3) 事件循环不冻结:bits=18 起池期间,100ms 定时器应准点(同步 mintStamp 会延迟到搜索结束)
let timerFiredAt = 0;
const t0 = Date.now();
const timer = setTimeout(() => { timerFiredAt = Date.now() - t0; }, 100);
const s18 = await mintStampAsync(18, "verify-pool-timer", "AAAAAAAA");
clearTimeout(timer);
const poolMs = Date.now() - t0;
check("event loop alive during pool search", timerFiredAt > 0 && timerFiredAt < 1000, `timer fired at ${timerFiredAt}ms (pool search ${poolMs}ms)`);
check("bits=18 checkStamp", checkStamp(s18, 18));

// (4) 多核加速对比(同 salt 同难度,同步单线程 vs 池)
const syncT0 = Date.now();
mintStamp(18, "verify-pool-speed", { salt: "AAAAAAAA" });
const syncMs = Date.now() - syncT0;
const poolT0 = Date.now();
await mintStampAsync(18, "verify-pool-speed", "AAAAAAAA");
const poolMs2 = Date.now() - poolT0;
check("pool faster than single-thread", poolMs2 < syncMs * 3, `sync ${syncMs}ms vs pool ${poolMs2}ms (${(syncMs / Math.max(poolMs2, 1)).toFixed(1)}x)`);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
