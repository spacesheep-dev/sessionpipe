// SPDX-License-Identifier: Apache-2.0
// filter(event, tier, pii): the pure function every sink runs an event through.
// Removes by ALLOWLIST per type and tier (spec/PRIVACY.md §1), redacts every string
// above tier 0 with secrets@1, and runs pii@1 when asked. Returns null when the
// type is not carried at the tier. The conformance runner runs the same function.
import { DATA_ALLOW, SESSION_KEYS, TYPE_TIER } from "../../gen/registry.js";
import type { Event, Tier } from "../types.js";
import { hashMachine, RULESET_PII, reducePiiDeep } from "./pii.js";
import { RULESET_SECRETS, redactDeep } from "./secrets.js";

// The tables the filter reads come from the proto: which types exist, the tier each is first carried
// at, which data keys arrive at each tier, and the session keys (packages/core/gen/registry.ts).
export { TYPE_TIER } from "../../gen/registry.js";

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
  for (const k of SESSION_KEYS)
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
  // What an ask asked, and what came back (PROTOCOL.md §4 delegation.*): the daemon cuts
  // them too, but the cap is this function's promise.
  if (event.type === "delegation.started" && typeof data.text === "string") data.text = cap(data.text, 200);
  if (event.type === "delegation.ended" && typeof data.reply === "string") data.reply = cap(data.reply, MAX_SIDE);

  const rulesets: string[] = [];
  let out: Event = {
    ...event,
    tier,
    session: session as unknown as Event["session"],
    data,
    privacy: { rulesets, pii },
  };
  if (tier > 0) {
    // Redact, then the caps above already applied: a cut before redaction could leave half a key.
    out = { ...out, session: redactDeep(out.session), data: redactDeep(out.data) };
    rulesets.push(RULESET_SECRETS);
  }
  if (pii) {
    const s = reducePiiDeep(out.session, opts.home) as unknown as Record<string, unknown>;
    if (typeof s.machine === "string") s.machine = hashMachine(s.machine);
    delete s.account_id;
    const d = reducePiiDeep(out.data, opts.home) as Record<string, unknown>;
    // limits.observed names the account its numbers belong to: the same identifier
    // pii@1 drops from the session block, so it goes the same way.
    delete d.account_id;
    out = { ...out, session: s as unknown as Event["session"], data: d };
    rulesets.push(RULESET_PII);
  }
  out.privacy = { rulesets, pii };
  return out;
}
