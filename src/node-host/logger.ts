// src/node-host/logger.ts — tee console.log/error to a daily log file under
// logs/ (gitignored) so the server's terminal output is persisted to disk.
// initFileLog() wraps console.log/error at startup; every later console call
// (the request log, the gateway diagnostics, the rejection handlers) lands in
// the file AND the terminal.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), "logs");

function logFile(): string {
  return join(LOG_DIR, `npg-${new Date().toISOString().slice(0, 10)}.log`);
}

function fmtArg(a: unknown): string {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function initFileLog(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(logFile(), `=== npg server start ${new Date().toISOString()} pid=${process.pid} ===\n`);
  } catch (e) {
    console.error(`[npg-logger] cannot open log file: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  for (const name of ["log", "error"] as const) {
    const orig = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      orig(...args);
      try {
        appendFileSync(logFile(), `${new Date().toISOString()} [${name}] ${args.map(fmtArg).join(" ")}\n`);
      } catch {
        // never break the console because of a log write
      }
    };
  }
}
