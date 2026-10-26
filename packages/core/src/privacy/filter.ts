// SPDX-License-Identifier: Apache-2.0
// filter(event, tier, pii): the pure function every sink runs an event through.
// Removes by ALLOWLIST per type and tier (spec/PRIVACY.md §1), redacts every string
// above tier 0 with secrets@1, and runs pii@1 when asked. Returns null when the
// type is not carried at the tier. The conformance runner runs the same function.
import type { Event, Tier } from "../types.js";
import { hashMachine, RULESET_PII, reducePiiDeep } from "./pii.js";
import { RULESET_SECRETS, redactDeep } from "./secrets.js";

/** The lowest tier that carries each known type (kept in step with schema/v1.ts). */
export const TYPE_TIER: Record<string, Tier> = {
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
  native: 3,
};

/** data keys allowed per type at tier N (cumulative: tier 1 includes tier 0's). */
const DATA_ALLOW: Record<string, Partial<Record<Tier, string[]>>> = {
  "session.started": { 0: ["source"] },
  "session.heartbeat": { 0: [] },
  "session.ended": { 0: ["reason"] },
  "session.backfill": { 0: ["started_at", "last_at", "turns"] },
  "session.forgotten": { 0: [] },
  "turn.started": { 0: ["turn_id", "submitted_by", "injected"], 1: ["prompt_chars"] },
  "turn.ended": { 0: ["turn_id", "reason", "ms", "background"], 1: ["error"] },
  "turn.transcript": { 2: ["turn", "user", "assistant", "at"] },
  "turn.progress": { 2: ["turn", "user", "assistant", "at"] },
  "tool.started": { 1: ["tool", "call_id", "turn_id", "agent_id"], 3: ["input"] },
  "tool.ended": { 1: ["tool", "call_id", "turn_id", "agent_id", "ms", "ok", "error"], 3: ["input", "output"] },
  "files.changed": { 1: ["paths"] },
  "attention.needed": { 0: ["attention_id", "kind"], 1: ["tool", "message"] },
  "attention.cleared": { 0: ["attention_id", "how"] },
  "subagent.started": { 1: ["agent_id", "agent_type"] },
  "subagent.ended": { 1: ["agent_id", "agent_type"] },
  "context.compacted": { 1: ["trigger"] },
};

const SESSION_ALLOW = [
  "id",
  "seq",
  "machine",
  "cwd",
  "repo",
  "branch",
  "model",
  "title",
  "title_source",
  "url",
  "account_id",
  "attended",
  "parent_id",
  "launched_by",
];
const MAX_SIDE = 20_000;
const MAX_IO = 64 * 1024;

function allowedKeys(type: string, tier: Tier): string[] | null {
  const table = DATA_ALLOW[type];
  if (!table) return null; // unknown type: kept whole (receivers keep extra keys), redacted
  const out: string[] = [];
  for (let t = 0; t <= tier; t++) for (const k of table[t as Tier] ?? []) out.push(k);
  return out;
}

function cap(v: unknown, max: number): unknown {
  if (typeof v === "string") return v.length > max ? `${v.slice(0, max)}…` : v;
  if (v && typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}…` : v;
  }
  return v;
}

/** At most `max` characters, keeping the end: an ellipsis, then the last max − 1. */
export function capTail(v: string, max: number): string {
  return v.length > max ? `…${v.slice(v.length - max + 1)}` : v;
}

export interface FilterOptions {
  /** The person's home directory, for pii@1's `~` rewrite. */
  home?: string;
}

/** The event as a sink at `tier` may see it, or null when the type is above the tier. */
export function filterEvent(event: Event, tier: Tier, pii: boolean, opts: FilterOptions = {}): Event | null {
  const minTier = TYPE_TIER[event.type];
  if (minTier !== undefined && minTier > tier) return null;

  const session: Record<string, unknown> = {};
  for (const k of SESSION_ALLOW)
    if (event.session[k as keyof typeof event.session] !== undefined)
      session[k] = event.session[k as keyof typeof event.session];

  let data: Record<string, unknown> = {};
  const keys = allowedKeys(event.type, tier);
  if (keys === null) data = { ...event.data };
  else for (const k of keys) if (event.data[k] !== undefined) data[k] = event.data[k];
  if (typeof data.user === "string") data.user = cap(data.user, MAX_SIDE);
  // A turn still running is read for where it is now: its reply keeps the end.
  if (typeof data.assistant === "string")
    data.assistant = event.type === "turn.progress" ? capTail(data.assistant, MAX_SIDE) : cap(data.assistant, MAX_SIDE);
  if (data.input !== undefined) data.input = cap(data.input, MAX_IO);
  if (data.output !== undefined) data.output = cap(data.output, MAX_IO);
  if (typeof data.message === "string") data.message = cap(data.message, 200);

  const rulesets: string[] = [];
  let out: Event = { ...event, tier, session: session as Event["session"], data, privacy: { rulesets, pii } };
  if (tier > 0) {
    // Redact, then the caps above already applied: a cut before redaction could leave half a key.
    out = { ...out, session: redactDeep(out.session), data: redactDeep(out.data) };
    rulesets.push(RULESET_SECRETS);
  }
  if (pii) {
    const s = reducePiiDeep(out.session, opts.home) as Record<string, unknown>;
    if (typeof s.machine === "string") s.machine = hashMachine(s.machine);
    delete s.account_id;
    out = { ...out, session: s as Event["session"], data: reducePiiDeep(out.data, opts.home) };
    rulesets.push(RULESET_PII);
  }
  out.privacy = { rulesets, pii };
  return out;
}
