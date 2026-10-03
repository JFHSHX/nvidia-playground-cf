// src/node-host/cloudflare-workers.d.ts — minimal declaration for the
// dynamic `import("cloudflare:workers")` in src/hcaptcha/runner.ts so the
// Node-host type program (tsconfig.node.json, types: ["node"]) compiles
// without pulling in @cloudflare/workers-types (which declares conflicting
// globals with @types/node).
declare module "cloudflare:workers" {
  export const env: unknown;
}
