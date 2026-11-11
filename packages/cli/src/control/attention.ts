// SPDX-License-Identifier: Apache-2.0
// When a permission question is over (spec/CONTROL.md §7). A PermissionRequest hook
// holds its connection to the daemon so that an answer signed on the person's device can
// be handed to it; the terminal shows its own prompt meanwhile, and the harness tells
// nobody when that one is answered. So the daemon reads it off the session's later hook
// events, and lets go of the hook when one of them says THIS question is over.
//
// Up to 0.13.5 any of them did, whoever fired it: a session's hooks all report under the
// session's id, and a subagent reading files in the background fires one every few
// seconds. The main thread's question was let go at the subagent's next tool call, with
// the terminal still asking, and the answer from the page found no prompt to give itself
// to (`refused`, `no_attention`: three of three questions in two sessions, 2026-11-11).
//
// One rule, in the protocol's own terms, so that a receiver showing the Allow / Deny
// pair and the machine holding the hook agree on when a question is open
// (conformance/control-attention.json). Only node: builtins, like local.ts.

/** What a hook event says, where it can end a question: the protocol's event types. */
export type Closer = "tool.ended" | "turn.ended" | "turn.started" | "subagent.ended" | "session.ended";

/** The hook events that can end a question, by what each says (Claude Code's names:
 *  the daemon holds a prompt for no other harness). */
export const CLOSERS: Readonly<Record<string, Closer>> = {
  PostToolUse: "tool.ended",
  PostToolUseFailure: "tool.ended",
  Stop: "turn.ended",
  StopFailure: "turn.ended",
  UserPromptSubmit: "turn.started",
  SubagentStop: "subagent.ended",
  SessionEnd: "session.ended",
};

/** A question as it was asked. */
export interface Asked {
  /** Its `attention_id`: the tool call's own id where the harness names one. */
  id: string;
  /** The thread that asked: a subagent's `agent_id`, "" for the main thread, null where
   *  the hook that holds it is older than this rule and did not say. */
  agent: string | null;
  /** When it was asked, by the hook's clock (ms); null from an older hook. */
  at: number | null;
}

/** A later event of the same session. */
export interface Said {
  type: Closer;
  /** The thread it is about: the subagent whose tool ended or that stopped, "" for the
   *  main thread (its tools, its turns, the session's end), null from an older worker. */
  agent: string | null;
  /** A tool event's own call id, where the harness names one. */
  call: string | null;
  /** When its hook fired, by the same clock; null from an older worker. */
  at: number | null;
  /** A `turn.ended`'s count of work still in flight; null where the harness doesn't say. */
  background: number | null;
}

/** Does this event say that this question is over?
 *
 *  - An event from before the question says nothing about it, whenever it arrives: a
 *    hook's report comes through a worker, and the report of the tool call before the
 *    question can reach the daemon after the question has.
 *  - The session's end ends every question.
 *  - A tool that ended: the question's own tool call, or any tool of the thread that
 *    asked, which has therefore moved on. Another thread's tools say nothing.
 *  - A turn that ended or began is the main thread's: it ends the main thread's
 *    questions. A background subagent goes on asking through both; its question is over
 *    when it stops, or when a turn ends with nothing left in flight.
 *
 *  Where either side comes from hooks older than the rule and names no thread, it is as
 *  it was: every one of these but a subagent's stop, which ended nothing then. */
export function questionOver(q: Asked, e: Said): boolean {
  if (q.at !== null && e.at !== null && e.at < q.at) return false;
  if (e.type === "session.ended") return true;
  if (q.agent === null || e.agent === null) return e.type !== "subagent.ended";
  switch (e.type) {
    case "tool.ended":
      return e.agent === q.agent || (e.call !== null && e.call === q.id);
    case "turn.ended":
      return q.agent === "" || e.background === 0;
    case "turn.started":
      return q.agent === "";
    case "subagent.ended":
      return q.agent !== "" && e.agent === q.agent;
  }
}
