// scripts/check-snapshot.ts — one-off: what does the module system ACTUALLY
// resolve for models-snapshot? Distinguishes a stale-cache issue from a real
// file issue. Run: npx tsx scripts/check-snapshot.ts
const m = await import("../src/gateway/models-snapshot.ts");
console.log("models:", Object.keys(m.MODEL_SNAPSHOT).length);
console.log("has glm-5-3:", "z-ai/glm-5-3" in m.MODEL_SNAPSHOT);
console.log("has minimax-m3 (removed):", "minimaxai/minimax-m3" in m.MODEL_SNAPSHOT);
console.log("predictEndpoint:", typeof m.predictEndpoint);
console.log("kimi-k3 functionId:", m.MODEL_SNAPSHOT["moonshotai/kimi-k3"]?.functionId?.slice(0, 8));
