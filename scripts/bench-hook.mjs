// SPDX-License-Identifier: Apache-2.0
// Hook-path timing: spawns dist/hook.js the way a harness does (stdin JSON, argv
// harness+event) N times and reports p50/p95 of wall time. CI fails above
// --max-p50 ms (300 on shared runners; the laptop target is 150).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(root, "packages/cli/dist/hook.js");
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const runs = arg("--runs", 30);
const maxP50 = arg("--max-p50", 300);
if (!existsSync(hook)) {
  console.log("bench: no dist/hook.js yet (built in M2)");
  process.exit(0);
}
const state = mkdtempSync(path.join(os.tmpdir(), "sessionpipe-bench-"));
const env = {
  ...process.env,
  SESSIONPIPE_STATE: state,
  SESSIONPIPE_CONFIG: path.join(state, "config.json"),
  SESSIONPIPE_NO_WORKER: "1",
};
// Two cases: a small tool event with no sink (the bulk of what a harness fires), and
// an 8 MiB Write while a sink takes tool output (handed on as it came, never parsed).
const small = JSON.stringify({
  session_id: "bench-0000",
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  cwd: root,
});
const write = JSON.stringify({
  session_id: "bench-0001",
  hook_event_name: "PostToolUse",
  tool_name: "Write",
  tool_input: { file_path: path.join(root, "big.txt"), content: "x".repeat(8 * 1024 * 1024) },
  tool_response: { type: "create", filePath: path.join(root, "big.txt") },
  cwd: root,
});
const sinkConfig = path.join(state, "config-sink.json");
writeFileSync(sinkConfig, JSON.stringify({ sinks: [{ name: "bench", url: "stdout", tier: 1 }] }));
const cases = [
  { name: "tool event, no sink", input: small, env },
  { name: "8 MiB Write, a sink", input: write, env: { ...env, SESSIONPIPE_CONFIG: sinkConfig } },
];
let failed = false;
for (const c of cases) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [hook, "claude-code", "PostToolUse"], {
      input: c.input,
      env: c.env,
      encoding: "utf8",
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (r.status !== 0) {
      console.error(`hook exited ${r.status}: ${r.stderr}`);
      process.exit(1);
    }
    times.push(ms);
  }
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(0);
  console.log(
    `hook timing (${c.name}) over ${runs} runs: p50 ${q(0.5)} ms · p95 ${q(0.95)} ms · max ${times[times.length - 1].toFixed(0)} ms (limit p50 ${maxP50})`,
  );
  if (Number(q(0.5)) > maxP50) failed = true;
}
if (failed) process.exit(1);
