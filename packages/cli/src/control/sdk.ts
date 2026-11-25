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
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { claudeControl } from "@sessionpipe/core";
import type { Picture, RunLevel, StartPermission } from "@sessionpipe/core/control";
import type { SdkHost, SdkSession } from "./daemon.js";

/** Each level (CONTROL.md §3.1) as the SDK's `permissionMode`. Never bypassPermissions.
 *  Inherit gives none: the SDK then starts the session in its settings'
 *  permissions.defaultMode, as `claude -p` does (0.3.310, measured with bypassPermissions
 *  there, which needed no allowDangerouslySkipPermissions). */
const PERMISSION_MODE: Record<StartPermission, string> = {
  read: "plan",
  safe: "dontAsk",
  edits: "acceptEdits",
  auto: "auto",
};

type SdkMessage = {
  type: string;
  subtype?: string;
  result?: unknown;
  is_error?: boolean;
  permission_denials?: unknown;
};
type SdkQuery = AsyncIterable<SdkMessage> & {
  interrupt(): Promise<void>;
  close(): void;
};
type QueryFn = (p: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => SdkQuery;

const SDK_NAME = "@anthropic-ai/claude-agent-sdk";

/** The version of the Agent SDK that `spec` names, from its own package.json: the first
 *  package.json above the file the name resolves to from here, as `import()` below
 *  resolves it (the same package: a package's exports never point outside it). Null when
 *  that file is not the SDK's, or anything can't be read. */
export function sdkVersion(spec: string): string | null {
  try {
    let dir = path.dirname(createRequire(import.meta.url).resolve(spec));
    for (;;) {
      let text: string | null = null;
      try {
        text = readFileSync(path.join(dir, "package.json"), "utf8");
      } catch {}
      if (text !== null) {
        const j = JSON.parse(text) as { name?: unknown; version?: unknown } | null;
        return j?.name === SDK_NAME && typeof j.version === "string" ? j.version : null;
      }
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  } catch {
    return null;
  }
}

export async function loadSdk(o: {
  claudeBin: string | null;
  env?: NodeJS.ProcessEnv;
  log: (s: string) => void;
}): Promise<SdkHost | null> {
  const spec = o.env?.SESSIONPIPE_AGENT_SDK || SDK_NAME;
  let query: QueryFn;
  try {
    const mod = (await import(/* @vite-ignore */ spec)) as { query?: QueryFn };
    if (typeof mod.query !== "function") return null;
    query = mod.query;
  } catch {
    return null;
  }
  o.log(`Agent SDK found (${spec}): new sessions start in place`);
  // Which settings files a session reads is said only where this SDK's own default reads
  // the same ones already, so saying it widens nothing. An older SDK (or one whose version
  // can't be read) is told nothing, as before, and reads no settings files at all: not
  // the folder's allow rules, nor the person's own settings with sessionpipe's hooks.
  const version = sdkVersion(spec);
  const sources = claudeControl.sdkReadsAllSettings(version);
  if (!sources)
    o.log(
      `Agent SDK ${version ?? "of a version that can't be read"}: its sessions read no settings files (the SDK reads them from ${claudeControl.SDK_ALL_SETTINGS_FROM} on)`,
    );
  return {
    start({
      session,
      cwd,
      permission,
      model,
      allowedTools,
      env,
    }: {
      session: string;
      cwd: string;
      permission: RunLevel;
      model?: string;
      allowedTools?: string[];
      /** Over the process's own: an ask's lineage for the session's hooks (CONTROL.md §13). */
      env?: Record<string, string>;
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
      // Why Claude Code left out the folder's own allow rules, once it has said so in a
      // whole line of stderr, and the denials already named in an earlier reply.
      let dropped: claudeControl.DroppedRules | null = null;
      const lines = claudeControl.stderrLines((line) => {
        dropped ??= claudeControl.droppedRules(line);
      });
      const named = new Set<string>();
      const q = query({
        prompt: input(),
        options: {
          sessionId: session,
          cwd,
          ...(permission === "inherit" ? {} : { permissionMode: PERMISSION_MODE[permission] }),
          ...(model ? { model } : {}),
          ...(allowedTools?.length ? { allowedTools } : {}),
          ...(o.claudeBin ? { pathToClaudeCodeExecutable: o.claudeBin } : {}),
          // The files `claude -p` reads, which this SDK reads by default already: said, so
          // a later default can't read fewer (CONTROL.md §3.1).
          ...(sources ? { settingSources: [...claudeControl.SETTING_SOURCES] } : {}),
          // Read only for Claude Code's word that it left out the folder's allow rules.
          stderr: lines,
          // Ours as a `claude -p` run gets it (claudeEnv): without the lineage this process
          // may carry and without the markers of a Claude Code session around it (a daemon
          // started from one would hand on CLAUDECODE and its entrypoint, and the session
          // would take itself for a nested one), then the session's own (jobEnv).
          env: { ...claudeControl.claudeEnv(undefined, o.env ?? process.env), ...env, SESSIONPIPE_CONTROL_JOB: "1" },
        },
      });
      const waiting: { resolve: (v: { reply: string; error?: string; note?: string }) => void }[] = [];
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
            if (m.is_error) {
              w?.resolve({ reply: "", error: text });
              continue;
            }
            // What this turn was denied, named as a `claude -p` run names it (CONTROL.md
            // §3.1), each denial once however many results list it.
            const fresh = (Array.isArray(m.permission_denials) ? m.permission_denials : []).filter(
              (d: { tool_use_id?: unknown } | null) => {
                const id = d?.tool_use_id;
                if (typeof id !== "string") return true;
                if (named.has(id)) return false;
                named.add(id);
                return true;
              },
            );
            // The note apart from the words, so a long reply is cut before it (finish).
            const note = claudeControl.refusedNote(fresh, dropped);
            w?.resolve(note ? { reply: text, note } : { reply: text });
          }
        } catch (e) {
          for (const w of waiting.splice(0)) w.resolve({ reply: "", error: String((e as Error)?.message || e) });
        }
      })();
      return {
        send(text: string, pictures: readonly Picture[] = []) {
          busy = true;
          lastUsed = Date.now();
          // Its pictures first, then the words, as Claude reads them best; with none (or
          // none it takes), the text alone, as always.
          const images = claudeControl.claudeImages(pictures);
          const content = images.length ? [...images, { type: "text", text }] : text;
          // How many of its pictures went as image blocks, where it had any.
          const counted = (r: { reply: string; error?: string; note?: string }) =>
            pictures.length ? { ...r, native: images.length } : r;
          return new Promise((resolve) => {
            waiting.push({ resolve: (r) => resolve(counted(r)) });
            queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
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
