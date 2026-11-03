// SPDX-License-Identifier: Apache-2.0
// Fewer tool events per sink (issue #208). A Claude Code workflow with a few hundred
// subagents fires two hooks per tool call, and a receiver that counts requests per
// machine ran out of them by 2 a.m. The outbox keeps every event; a sink's `tools`
// setting says which of them it is sent:
//   all   every tool.started / tool.ended (the default: a receiver's view never changes
//         unless it asked, or the sink's owner chose)
//   main  the main thread's tool events go live; a subagent's (data.agent_id set) are
//         thinned (what a receiver that meters requests asks for in its well-known
//         file, `tools: "main"`)
//   beat  every tool event of a session is thinned
// A thinned stream is sent tool.ended only, and of those at most one per session per
// minute, by the events' own time: tool.ended is what a receiver reads as "a tool ran"
// (spacesheep reads nothing from tool.started), so the one event kept is never one it
// throws away. One more is always sent: the asking thread's first tool.ended after its
// attention.needed, the event that shows the prompt was answered (PROTOCOL.md §4,
// attention.cleared). Only tool events are thinned: turns, attention, subagents, files
// and limits go as they come.
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

/** What a sink is sent: its owner's own setting, else what the receiver's well-known
 *  file asked for, else every tool event. Never thinned on nobody's say-so: a receiver
 *  that reads a subagent's tool calls (sessionpipe-gui does) keeps them on an upgrade. */
export function toolsMode(s: Pick<SinkConfig, "url" | "tools" | "receiver_tools">): ToolsMode {
  if (isToolsMode(s.tools)) return s.tools;
  if (isToolsMode(s.receiver_tools)) return s.receiver_tools;
  return "all";
}

const agentOf = (e: Event): string => (typeof e.data.agent_id === "string" ? e.data.agent_id : "");
/** Whether a sink in `mode` thins the tool events of the thread `agent` ("" = main). */
const thins = (mode: ToolsMode, agent: string): boolean => mode === "beat" || (mode === "main" && agent !== "");
/** The clock entry that says a thread of `key` is waiting on a prompt: its next
 *  tool.ended goes whatever the window says. */
const askKey = (key: string, agent: string): string => `${key}\u0000ask\u0000${agent}`;

/** Whether a sink in `mode` is sent `e`. `clock` holds, per session (`key`), the time
 *  of the last tool event it was sent, and moves when this one is. Times are the
 *  events' own, so a backlog thins the same way it would have live. An event a little
 *  out of time order (hooks reach the outbox in lock order, not hook order) falls in
 *  the window like any other; only a jump back by a whole window or more (a clock set
 *  back) sends and restarts it. */
export function sendTool(e: Event, mode: ToolsMode, clock: Record<string, number>, key: string): boolean {
  if (mode === "all") return true;
  const agent = agentOf(e);
  const t = Date.parse(e.time);
  if (e.type === "attention.needed") {
    if (thins(mode, agent)) clock[askKey(key, agent)] = Number.isFinite(t) ? t : 0;
    return true;
  }
  if ((e.type !== "tool.started" && e.type !== "tool.ended") || !thins(mode, agent)) return true;
  if (e.type === "tool.started") return false;
  if (!Number.isFinite(t)) return true;
  const ask = askKey(key, agent);
  // Only a tool.ended timed at or after the prompt answers it.
  const asked = clock[ask];
  if (asked !== undefined && t >= asked) {
    delete clock[ask];
    clock[key] = t;
    return true;
  }
  const last = clock[key];
  if (last !== undefined && t > last - TOOL_FOLD_MS && t < last + TOOL_FOLD_MS) return false;
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
