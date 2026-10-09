#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The hook path. A harness runs `node hook.js <harness> <event>`; this reads stdin,
// writes one job file, spawns the worker detached, prints what the harness needs
// (Antigravity's answer) and exits 0 — in milliseconds, with nothing but node:
// builtins imported (the build checks that). No network, no schema library, no
// config parsing beyond one small file read for the throttle.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ask, socketPath } from "./control/local.js";

/** A Claude Code session id (the same test as core's notClaudeCode). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The two streams the hook touches: stdin once, whole; stdout for an answer. */
export interface HookIO {
  stdin(): Buffer;
  stdout(text: string): void;
}

/** One hook run: `argv` is [harness, event, ...] as the harness invoked it, `env` the
 *  process environment. Resolves once the job is on its way and any answer printed;
 *  the process then exits 0, whatever happened (the hook is invisible to the harness). */
export async function hookMain(argv: string[], env: NodeJS.ProcessEnv, io: HookIO): Promise<void> {
  const t0 = process.hrtime.bigint();
  /** The hook's own work, when a control wait follows it (the wait is not the hook's cost). */
  let workMs: number | null = null;
  const [harness = "", event = "", ...rest] = argv;

  function stateDir(): string {
    if (env.SESSIONPIPE_STATE) return path.resolve(env.SESSIONPIPE_STATE);
    const home = os.homedir();
    if (process.platform === "win32")
      return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "sessionpipe");
    return path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "sessionpipe");
  }
  function configFile(): string {
    if (env.SESSIONPIPE_CONFIG) return path.resolve(env.SESSIONPIPE_CONFIG);
    const home = os.homedir();
    if (process.platform === "win32")
      return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "sessionpipe", "config.json");
    return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "sessionpipe", "config.json");
  }

  // Antigravity parses stdout as the hook's answer; `{}` is "carry on" for every event we
  // register. PreToolUse is not one of them: `{}` there is a deny, so an entry an older
  // install left behind asks the person instead (core's AG_STALE_PRETOOL, same bytes).
  if (harness === "antigravity") {
    try {
      io.stdout(
        event === "PreToolUse"
          ? '{"decision":"ask","reason":"sessionpipe: an outdated PreToolUse hook is still loaded. Restart this conversation (or run sessionpipe install) to drop it."}\n'
          : "{}\n",
      );
    } catch {}
  }

  const state = stateDir();
  try {
    if (!harness || !event) throw new Error("usage: hook <harness> <event>");
    let stdin = "";
    if (harness !== "codex" || event !== "notify") {
      try {
        const buf = io.stdin();
        stdin = buf.subarray(0, 1024 * 1024).toString("utf8");
      } catch {}
    }
    // Tool events are the bulk of what a harness fires. When no sink takes tier ≥ 1
    // they are only a "still working" signal: one heartbeat a minute per session.
    const TOOL = /^(PreToolUse|PostToolUse|PostToolUseFailure|BeforeTool|AfterTool|PostInvocation)$/;
    if (TOOL.test(event) && !anySinkAbove(0)) {
      const id = sessionIdOf(stdin);
      if (!id || !beatDue(id)) return finish(false);
    }
    // A Stop asks the daemon BEFORE its event goes to the worker: the worker reports the
    // Stop to the daemon too, and a message queued for this Stop must be taken here,
    // not rerouted because the event got there first.
    const stopAnswer = event === "Stop" ? await (controlAsk(stdin) ?? Promise.resolve(null)) : null;
    mkdirSync(path.join(state, "jobs"), { recursive: true, mode: 0o700 });
    const job = {
      harness,
      event,
      argv: [harness, event, ...rest],
      stdin,
      cwd: process.cwd(),
      env: pick([
        // Where a harness keeps its config and its sessions, so a job swept by a worker
        // some other harness's hook spawned still resolves this harness's own homes
        // (run.ts sweepJobs runs any stale job file, whatever spawned the worker).
        "APPDATA",
        "CLAUDE_CODE_HOST_SESSION_ID",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_PROJECT_DIR",
        "CODEX_HOME",
        // Devin's payload names no folder at all; this is the only thing that does.
        "DEVIN_PROJECT_DIR",
        "GEMINI_CLI_HOME",
        // Devin's config file and session store are both resolved through these.
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
      ]),
      ppid: process.ppid,
      at: Date.now(),
    };
    const jobFile = path.join(
      state,
      "jobs",
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    writeFileSync(jobFile, JSON.stringify(job), { mode: 0o600 });
    if (!env.SESSIONPIPE_NO_WORKER) {
      const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.js");
      const p = spawn(process.execPath, [worker, jobFile], { detached: true, stdio: "ignore", windowsHide: true, env });
      p.unref();
    }
    if (stopAnswer) {
      try {
        io.stdout(`${stopAnswer}\n`);
      } catch {}
    }
    // A PermissionRequest waits AFTER its event is on its way, so the receiver already
    // shows the Allow / Deny this answer is for.
    const ctl = event === "PermissionRequest" ? controlAsk(stdin) : null;
    if (ctl) {
      workMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const out = await ctl;
      if (out) {
        try {
          io.stdout(`${out}\n`);
        } catch {}
      }
    }
    return finish(true);
  } catch {
    return finish(false); // the hook must be invisible to the harness
  }

  /** Control (spec/CONTROL.md §6, §9): only on a machine with control paired, and only
   *  for a message the daemon itself verified. A Stop hook asks for a queued message and
   *  answers a block with it; a PermissionRequest hook waits for the person's signed
   *  answer while the terminal shows its own prompt, first answer wins. Anything that
   *  goes wrong (no daemon, a timeout) prints nothing: the harness carries on as usual. */
  function controlAsk(stdin: string): Promise<string | null> | null {
    if (harness !== "claude-code" || (event !== "Stop" && event !== "PermissionRequest")) return null;
    if (env.SESSIONPIPE_CONTROL_JOB) return null; // a headless turn the daemon itself runs
    const sock = socketPath(state, env);
    if (
      process.platform === "win32"
        ? !existsSync(path.join(path.dirname(configFile()), "control.json"))
        : !existsSync(sock)
    )
      return null;
    let s: Record<string, unknown>;
    try {
      s = JSON.parse(stdin) as Record<string, unknown>;
    } catch {
      return null;
    }
    const id = typeof s.session_id === "string" ? s.session_id : "";
    if (!id) return null;
    // Our entry in ~/.claude/settings.json is run by every harness that imports that file
    // — Devin's `claude` hooks provider is live, not a stub — and it arrives under the
    // claude-code name. Every Claude Code payload names a transcript and a UUID session;
    // a payload with neither is somebody else's, and must not be parked for up to 125 s
    // waiting on an answer that is not coming. Same test as core's notClaudeCode
    // (claude-code.ts), which the worker applies; repeated here because this file imports
    // nothing but node builtins.
    if (typeof s.transcript_path !== "string" && !UUID.test(id)) return null;
    const session = `claude-code:${id}`;
    if (event === "Stop")
      return ask(sock, { op: "stop", session, active: s.stop_hook_active === true }, 300).then((r) =>
        r?.op === "block" ? JSON.stringify({ decision: "block", reason: r.reason }) : null,
      );
    // The attention id the adapter puts on attention.needed (claude-code.ts), so the
    // receiver's Allow / Deny names this very prompt.
    const tool =
      typeof s.tool_name === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(s.tool_name) ? s.tool_name : undefined;
    const turn = typeof s.prompt_id === "string" ? s.prompt_id : undefined;
    const attention = `perm-${createHash("sha256")
      .update(`${turn ?? ""}|${tool ?? ""}|${JSON.stringify(s.tool_input ?? null)}`)
      .digest("hex")
      .slice(0, 16)}`;
    return ask(sock, { op: "permission", session, attention, ...(tool ? { tool } : {}) }, 125_000).then((r) =>
      r?.op === "decision"
        ? JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision:
                r.behavior === "allow"
                  ? { behavior: "allow" }
                  : { behavior: "deny", message: r.message || "Denied by the owner (sessionpipe control)." },
            },
          })
        : null,
    );
  }

  /** The timing line; the process exits 0 right after. */
  function finish(spawned: boolean): void {
    const total = Number(process.hrtime.bigint() - t0) / 1e6;
    const ms = workMs ?? total;
    try {
      mkdirSync(state, { recursive: true });
      appendFileSync(
        path.join(state, "timing.jsonl"),
        `${JSON.stringify({ at: Date.now(), harness, event, ms: Math.round(ms * 10) / 10, spawned, ...(workMs !== null ? { control_wait_ms: Math.round(total - workMs) } : {}) })}\n`,
      );
    } catch {}
  }
  function pick(names: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of names) if (env[n] !== undefined) out[n] = env[n] as string;
    return out;
  }
  function anySinkAbove(tier: number): boolean {
    try {
      const c = JSON.parse(readFileSync(configFile(), "utf8")) as { sinks?: { tier?: number; paused?: string }[] };
      return (c.sinks ?? []).some((s) => Number(s.tier) > tier && !s.paused);
    } catch {
      return false;
    }
  }
  function sessionIdOf(stdin: string): string {
    const m = /"(?:session_id|sessionId|conversationId)"\s*:\s*"([^"]{1,128})"/.exec(stdin);
    return m?.[1] ?? "";
  }
  /** One heartbeat per minute per session: the stamp file's mtime is the clock. */
  function beatDue(id: string): boolean {
    const stamp = path.join(state, "beats", `${harness}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`);
    try {
      if (Date.now() - statSync(stamp).mtimeMs < 60_000) return false;
    } catch {}
    try {
      mkdirSync(path.dirname(stamp), { recursive: true, mode: 0o700 });
      writeFileSync(stamp, "", { mode: 0o600 });
    } catch {}
    return true;
  }
}

// Run as `node hook.js <harness> <event>`; importing this module runs nothing. The main
// module is known by its real path: node resolves symlinks for import.meta.url, argv[1]
// keeps the spelling it was given (/var → /private/var on macOS).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  hookMain(process.argv.slice(2), process.env, {
    // fd 0 and 1 are the test runner's own (a read of 0 would block it); launcher.test.ts
    // and the bench run these two through the real binary.
    /* v8 ignore next -- see above */
    stdin: () => readFileSync(0),
    /* v8 ignore next -- see above */
    stdout: (text) => writeFileSync(1, text),
  }).then(() => process.exit(0));
