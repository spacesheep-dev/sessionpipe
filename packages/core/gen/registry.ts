// SPDX-License-Identifier: Apache-2.0
// GENERATED from proto/sessionpipe/v1/*.proto by tools/doors; do not edit. `npm run schemas` rewrites it.
// The protocol's registry at run time: event types, their tiers and keys, session keys, harness names.

/** The protocol integer every event carries. */
export const PROTOCOL = 1;

/** The event types this version of the protocol names, in the order the definition lists them. */
export const KNOWN_TYPES = ["session.started", "session.heartbeat", "session.ended", "session.backfill", "session.forgotten", "turn.started", "turn.ended", "turn.transcript", "turn.progress", "tool.started", "tool.ended", "files.changed", "attention.needed", "attention.cleared", "subagent.started", "subagent.ended", "context.compacted", "limits.observed", "delegation.started", "delegation.ended", "native"] as const;

/** The lowest tier that carries each known type (spec/PRIVACY.md §1). */
export const TYPE_TIER: Readonly<Record<string, 0 | 1 | 2 | 3>> = {
  "session.started": 0,
  "session.heartbeat": 0,
  "session.ended": 0,
  "session.backfill": 0,
  "session.forgotten": 0,
  "turn.started": 0,
  "turn.ended": 0,
  "turn.transcript": 2,
  "turn.progress": 2,
  "tool.started": 1,
  "tool.ended": 1,
  "files.changed": 1,
  "attention.needed": 0,
  "attention.cleared": 0,
  "subagent.started": 1,
  "subagent.ended": 1,
  "context.compacted": 1,
  "limits.observed": 1,
  "delegation.started": 0,
  "delegation.ended": 0,
  "native": 3,
};

/** The data keys each type carries at each tier, cumulative: a sink at tier N sees the keys of every
 *  tier up to N. A type not listed here (`native`) is carried whole. */
export const DATA_ALLOW: Readonly<Record<string, Readonly<Partial<Record<0 | 1 | 2 | 3, readonly string[]>>>>> = {
  "session.started": { 0: ["source"] },
  "session.heartbeat": { 0: [] },
  "session.ended": { 0: ["reason"] },
  "session.backfill": { 0: ["started_at", "last_at", "turns"] },
  "session.forgotten": { 0: [] },
  "turn.started": { 0: ["turn_id", "submitted_by", "injected"], 1: ["prompt_chars"] },
  "turn.ended": { 0: ["turn_id", "reason", "ms", "background"], 1: ["error"] },
  "turn.transcript": { 2: ["turn", "user", "assistant", "at", "injected"] },
  "turn.progress": { 2: ["turn", "user", "assistant", "at", "injected"] },
  "tool.started": { 1: ["tool", "call_id", "turn_id", "agent_id"], 3: ["input"] },
  "tool.ended": { 1: ["tool", "call_id", "turn_id", "agent_id", "ms", "ok", "error"], 3: ["input", "output"] },
  "files.changed": { 1: ["paths"] },
  "attention.needed": { 0: ["attention_id", "kind"], 1: ["tool", "message", "agent_id"] },
  "attention.cleared": { 0: ["attention_id", "how"] },
  "subagent.started": { 1: ["agent_id", "agent_type"] },
  "subagent.ended": { 1: ["agent_id", "agent_type", "background"] },
  "context.compacted": { 1: ["trigger"] },
  "limits.observed": { 1: ["windows", "plan", "account_id"] },
  "delegation.started": { 0: ["ask_id", "via", "harness", "to"], 1: ["text"] },
  "delegation.ended": { 0: ["ask_id", "to", "ok", "ms", "error", "relayed"], 2: ["reply"] },
};

/** The keys of `session` every event may carry, in the definition's order. */
export const SESSION_KEYS = ["id", "seq", "machine", "cwd", "repo", "branch", "model", "title", "title_source", "url", "account_id", "attended", "parent_id", "launched_by", "delegated_by", "effort"] as const;

/** The harnesses in the registry (spec/ADAPTERS.md), in the definition's order. */
export const HARNESS_NAMES = ["claude-code", "codex", "gemini-cli", "antigravity", "devin", "cursor", "copilot-cli", "droid", "kiro", "opencode", "grok-build", "autopilot"] as const;
