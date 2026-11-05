// scripts/verify-fp-pool.ts — TS 指纹池最小验证版的自测:
// (1) v0 确定性(同一 pow 两次构建字节相同);(2) v0 ≠ v1(池真的产出不同身份);
// (3) 两个变体都是合法 JSON,身份字段(canvas_hash/screen)不同、UA 同族一致;
// (4) lane 粘性:NPG_FINGERPRINT_COUNT=2 时两个模型 lane 分到不同变体且重复
// 分配稳定;count=1 时全回 v0(与历史单指纹行为完全一致);unset 默认 2 身份池
// (实测单指纹高频求解触发 hCaptcha 34-bit 升级,双身份分摊后全天零升级);
// (5) PowBudgetExceeded 消息带 (fp vN) 后缀(401 日志按身份归因的依据)。
// 运行:node node_modules/tsx/dist/cli.mjs scripts/verify-fp-pool.ts
import { buildFingerprint, laneVariant } from "../src/hcaptcha/fingerprint";
import type { Pow } from "../src/hcaptcha/pow";

const fakePow: Pow = {
  fingerprintType: 0,
  difficulty: 4,
  type: "w",
  powData: "verify-fp-pool-data",
  location: "/c/verify-fp-pool",
  signature: "",
  timestamp: 0,
  n: "hsw",
  timeout: 1000,
};

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// (1) identity fields deterministic across builds; proof stamp fresh per build
// (the stamp carries a fresh timestamp + random salt by design — mirrors the
// real client; the historical single fingerprint behaves the same way)
const dec = (b64: string): any => JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
const v0a = buildFingerprint(fakePow, 0);
const v0b = buildFingerprint(fakePow, 0);
const v1 = buildFingerprint(fakePow, 1);
const d0a = dec(v0a);
const d0b = dec(v0b);
check(
  "v0 identity fields deterministic (hash fields + screen stable across builds)",
  d0a.components.canvas_hash === d0b.components.canvas_hash &&
    d0a.components.parent_win_hash === d0b.components.parent_win_hash &&
    d0a.components.performance_hash === d0b.components.performance_hash &&
    JSON.stringify(d0a.components.screen) === JSON.stringify(d0b.components.screen),
);
check("v0 proof stamp fresh per build (bytes differ, identity stable)", v0a !== v0b);
check("v0 != v1 (pool yields distinct identities)", v0a !== v1);

// (3) both valid JSON, identity fields differ, UA family identical
const j0 = d0a;
const j1 = dec(v1);
check("v0 screen 3440x1440 (historical)", j0.components.screen.width === 3440 && j0.components.screen.height === 1440);
check("v1 screen 2560x1440 (alternate)", j1.components.screen.width === 2560 && j1.components.screen.height === 1440);
check("canvas_hash differs across variants", j0.components.canvas_hash !== j1.components.canvas_hash);
check("UA identical (self-consistent Chrome/123 family)", j0.components.navigator.user_agent === j1.components.navigator.user_agent);

// (4) lane stickiness
process.env.NPG_FINGERPRINT_COUNT = "2";
const g = laneVariant("glm-5-3");
const k = laneVariant("kimi-k3");
check("two model lanes get distinct variants", g !== k, `glm-5-3=v${g}, kimi-k3=v${k}`);
check("assignment sticky on repeat", laneVariant("glm-5-3") === g && laneVariant("kimi-k3") === k);
process.env.NPG_FINGERPRINT_COUNT = "1";
check("count=1 → v0 (historical behavior)", laneVariant("glm-5-3") === 0 && laneVariant("kimi-k3") === 0);
delete process.env.NPG_FINGERPRINT_COUNT;
check("unset → default pool 2 (sticky index preserved)", laneVariant("glm-5-3") === 0);
process.env.NPG_FINGERPRINT_COUNT = "2";
check("no lane → v0 (laneless callers share default)", laneVariant() === 0);
delete process.env.NPG_FINGERPRINT_COUNT;

// (5) budget-exceeded message carries the variant (s=17 → 34 bits → 10s burn)
try {
  buildFingerprint({ ...fakePow, difficulty: 17 }, 1);
  check("budget throw raised", false, "no throw at 34 bits");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  check("PowBudgetExceeded carries (fp v1)", msg.includes("(fp v1)"), msg);
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
