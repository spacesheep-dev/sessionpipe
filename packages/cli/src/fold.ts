// SPDX-License-Identifier: Apache-2.0
// Fewer tool events per sink (issue #208). A Claude Code workflow with a few hundred
// subagents fires two hooks per tool call, and a receiver that counts requests per
// machine ran out of them by 2 a.m. The outbox keeps every event; a sink's `tools`
// setting says which of them it is sent:
//   all   every tool.started / tool.ended (file and stdout sinks, by default)
//   main  the main thread's tool events go live; a subagent's (data.agent_id set) at
//         most one per session per minute (HTTP sinks, by default)
//   beat  every tool event of a session at most one per minute
// The first tool event of each minute goes, the rest of that minute is skipped (the
// cursor still moves over them). Only tool events are thinned: turns, attention,
// subagents, files and limits go as they come (PROTOCOL.md §4).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Event, type SinkConfig, safeId } from "@sessionpipe/core";

export type ToolsMode = "all" | "main" | "beat";
export const TOOLS_MODES: readonly ToolsMode[] = ["all", "main", "beat"];

/** One tool event per this window, per session, when a sink thins them. */
export const TOOL_FOLD_MS = 60_000;
/** A session whose last tool event sent is this much older than the newest one's is
 *  dropped from the clock file: it stays small on a machine that runs for months. */
const KEEP_MS = 24 * 60 * 60_000;

export function isToolsMode(v: unknown): v is ToolsMode {
  return typeof v === "string" && (TOOLS_MODES as readonly string[]).includes(v);
}

/** What a sink is sent: its own setting, else `main` for a receiver across the network
 *  (it counts requests) and `all` for a local file or stdout (a full local record). */
export function toolsMode(s: Pick<SinkConfig, "url" | "tools">): ToolsMode {
  if (isToolsMode(s.tools)) return s.tools;
  return /^https?:\/\//.test(s.url) ? "main" : "all";
}

/** Whether a sink in `mode` is sent `e`. `clock` holds, per session (`key`), the time
 *  of the last tool event it was sent, and moves when this one is. Times are the
 *  events' own, so a backlog thins the same way it would have live. A clock that went
 *  backwards sends (and restarts the window) rather than skipping for a minute. */
export function sendTool(e: Event, mode: ToolsMode, clock: Record<string, number>, key: string): boolean {
  if (mode === "all" || (e.type !== "tool.started" && e.type !== "tool.ended")) return true;
  if (mode === "main" && !(typeof e.data.agent_id === "string" && e.data.agent_id)) return true;
  const t = Date.parse(e.time);
  const last = clock[key];
  if (last !== undefined && t >= last && t - last < TOOL_FOLD_MS) return false;
  clock[key] = t;
  return true;
}

/** <state>/folds/<sink>.json: the per-session clock `sendTool` reads, beside the
 *  sink's cursors. Written with them, after a batch was acknowledged, so a refused
 *  batch's tool event is not taken for sent. */
export class ToolClock {
  constructor(
    readonly root: string,
    readonly sink: string,
  ) {}
  private file(): string {
    return path.join(this.root, "folds", `${safeId(this.sink)}.json`);
  }
  read(): Record<string, number> {
    try {
      const j = JSON.parse(readFileSync(this.file(), "utf8")) as unknown;
      return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, number>) : {};
    } catch {
      return {};
    }
  }
  write(c: Record<string, number>): void {
    const newest = Math.max(0, ...Object.values(c).filter(Number.isFinite));
    const kept: Record<string, number> = {};
    for (const [k, v] of Object.entries(c)) if (Number.isFinite(v) && v >= newest - KEEP_MS) kept[k] = v;
    const f = this.file();
    mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(kept), { mode: 0o600 });
    renameSync(tmp, f);
  }
}
