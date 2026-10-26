// SPDX-License-Identifier: Apache-2.0
// The `sdk` delivery mode (spec/CONTROL.md §6): a session the daemon starts itself
// through the Claude Agent SDK's streaming input, and keeps while it is in use, so
// the next message lands in the same process with no cold start. Optional: the SDK
// is a large package with its own binary, so sessionpipe does not depend on it. When
// it can be imported (installed beside sessionpipe, or SESSIONPIPE_AGENT_SDK names
// it), `start` goes through it; otherwise `start` is a headless `claude -p`.
//
// Measured (P1 spike 4, Claude Code 2.1.286): first token 1.5 s cold, 1.1 s warm;
// zero turns while idle; but ~300 MB resident per held session, so the daemon
// closes one that has been idle for ten minutes and a later message resumes it.
import type { SdkHost, SdkSession } from "./daemon.js";
import type { ControlMode } from "./store.js";

/** The SDK's permission mode for each machine mode, as modeFlags gives the CLI's
 *  (claude-code-control.ts). Inherit gives none: the SDK then starts the session in its
 *  settings' permissions.defaultMode, as `claude -p` does (0.3.310, measured with
 *  bypassPermissions there, which needed no allowDangerouslySkipPermissions). */
const PERMISSION_MODE = { safe: "dontAsk", auto: "auto" } as const;

type SdkQuery = AsyncIterable<{ type: string; subtype?: string; result?: unknown; is_error?: boolean }> & {
  interrupt(): Promise<void>;
  close(): void;
};
type QueryFn = (p: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => SdkQuery;

export async function loadSdk(o: {
  claudeBin: string | null;
  env?: NodeJS.ProcessEnv;
  log: (s: string) => void;
}): Promise<SdkHost | null> {
  const spec = o.env?.SESSIONPIPE_AGENT_SDK || "@anthropic-ai/claude-agent-sdk";
  let query: QueryFn;
  try {
    const mod = (await import(/* @vite-ignore */ spec)) as { query?: QueryFn };
    if (typeof mod.query !== "function") return null;
    query = mod.query;
  } catch {
    return null;
  }
  o.log(`Agent SDK found (${spec}): new sessions start in place`);
  return {
    start({
      session,
      cwd,
      mode,
      allowedTools,
    }: {
      session: string;
      cwd: string;
      mode: ControlMode;
      configDir?: string;
      allowedTools?: string[];
    }): SdkSession {
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      let closed = false;
      async function* input() {
        while (!closed) {
          while (queue.length) yield queue.shift();
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      }
      const q = query({
        prompt: input(),
        options: {
          sessionId: session,
          cwd,
          ...(mode === "inherit" ? {} : { permissionMode: PERMISSION_MODE[mode] }),
          ...(allowedTools?.length ? { allowedTools } : {}),
          ...(o.claudeBin ? { pathToClaudeCodeExecutable: o.claudeBin } : {}),
          env: { ...(o.env ?? process.env), SESSIONPIPE_CONTROL_JOB: "1" },
        },
      });
      const waiting: { resolve: (v: { reply: string; error?: string }) => void }[] = [];
      let busy = false;
      let lastUsed = Date.now();
      void (async () => {
        try {
          for await (const m of q) {
            if (m.type !== "result") continue;
            busy = waiting.length > 1;
            lastUsed = Date.now();
            const w = waiting.shift();
            const text =
              typeof m.result === "string" && m.result.trim() ? m.result : "(finished without a written reply)";
            w?.resolve(m.is_error ? { reply: "", error: text } : { reply: text });
          }
        } catch (e) {
          for (const w of waiting.splice(0)) w.resolve({ reply: "", error: String((e as Error)?.message || e) });
        }
      })();
      return {
        send(text: string) {
          busy = true;
          lastUsed = Date.now();
          return new Promise((resolve) => {
            waiting.push({ resolve });
            queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
            wake?.();
          });
        },
        interrupt: () => q.interrupt(),
        close() {
          closed = true;
          wake?.();
          try {
            q.close();
          } catch {}
        },
        get busy() {
          return busy;
        },
        get lastUsed() {
          return lastUsed;
        },
      };
    },
  };
}
