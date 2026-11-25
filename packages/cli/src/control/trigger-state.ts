// SPDX-License-Identifier: Apache-2.0
// The daemon's record of the person's rules (`<state>/control/triggers-state.json`), read as
// untrusted input: anything a person, another program or a newer sessionpipe wrote there that
// does not fit is dropped, one line in the log, and nothing in it can stop the daemon starting or
// widen a rule (a count below zero, a waiting run kept past its cause's own deadline, a last tick
// in the future). Keys are names out of a file: every map here has no prototype, so a rule named
// `constructor` is a rule like any other.
import { readFileSync, statSync } from "node:fs";
import { CONFIG_SCHEMAS, problems } from "@sessionpipe/core";
import type { Cause, RuleState, TriggerState, Waiting } from "./triggers.js";

/** The record is at most this large on disk: 50 rules, each with 20 history lines and its day's
 *  50 cooldown keys, and the waiting runs (each holding a notice of at most 1 KiB), with room to
 *  spare. A larger file is no record. */
export const STATE_MAX_BYTES = 4 * 1024 * 1024;
/** Waiting runs kept at most: 50 rules, each waiting on at most one per notice of a poll (50). */
export const WAITING_MAX = 2500;
/** How long a tick's run may wait (§14.6). */
const TICK_WAIT_MS = 6 * 3600_000;

const HISTORY_LINE = (
  CONFIG_SCHEMAS["trigger-list"].properties.rules.items.properties.recent as unknown as { items: object }
).items;
const NOTICE = CONFIG_SCHEMAS["trigger-test"].properties.notice as unknown as object;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}\/[a-z0-9_-]{0,32}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A history line a newer sessionpipe may write: the definition's, or one whose only difference
 *  is a refusal code this version does not know (`list` says it as unknown). */
function historyLine(v: unknown): boolean {
  if (!problems(HISTORY_LINE as never, v).length) return true;
  if (!isObject(v) || typeof v.code !== "string" || !/^[a-z_]{1,32}$/.test(v.code)) return false;
  return !problems(HISTORY_LINE as never, { ...v, code: "cap" }).length;
}

function ruleState(v: unknown, now: number, say: (s: string) => void): RuleState | null {
  if (!isObject(v)) return null;
  const out: RuleState = { history: [] };
  if (Array.isArray(v.history)) out.history = v.history.filter(historyLine).slice(0, 20) as RuleState["history"];
  const t = v.today;
  if (isObject(t) && typeof t.day === "string" && DAY_RE.test(t.day) && Number.isInteger(t.runs))
    out.today = {
      day: t.day,
      runs: Math.min(50, Math.max(0, t.runs as number)),
      keys: Array.isArray(t.keys)
        ? t.keys.filter((k): k is string => typeof k === "string" && KEY_RE.test(k)).slice(0, 50)
        : [],
    };
  const c = v.clock;
  if (isObject(c) && typeof c.every === "string" && c.every.length <= 20 && finite(c.since)) {
    if (c.since > now || (finite(c.last) && c.last > now))
      say("a clock's last tick or start lay in the future; counted from now");
    out.clock = {
      every: c.every,
      since: Math.min(c.since, now),
      ...(finite(c.last) ? { last: Math.min(c.last, now) } : {}),
    };
  }
  const p = v.paused;
  if (isObject(p) && typeof p.at === "string" && p.code === "no_session" && typeof p.rule === "string")
    out.paused = {
      at: p.at,
      code: "no_session",
      rule: p.rule,
      ...(p.why === "gone" || p.why === "unknown_level" ? { why: p.why } : {}),
    };
  return out;
}

function cause(v: unknown): Cause | null {
  if (!isObject(v)) return null;
  if (v.kind === "tick" && finite(v.due)) return { kind: "tick", due: v.due };
  if (
    v.kind === "notice" &&
    typeof v.receiver === "string" &&
    v.receiver.length <= 259 &&
    !problems(NOTICE as never, v.notice).length
  )
    return { kind: "notice", receiver: v.receiver, notice: v.notice as never };
  return null;
}

function waiting(v: unknown, now: number): Waiting | null {
  if (!isObject(v) || typeof v.rule !== "string" || !NAME_RE.test(v.rule)) return null;
  const c = cause(v.cause);
  if (!c || !finite(v.until) || typeof v.day !== "string" || !DAY_RE.test(v.day)) return null;
  if (v.reason !== "held" && v.reason !== "start_limit" && v.reason !== "busy") return null;
  // Never past its cause's own deadline, whatever the file says.
  const deadline = c.kind === "tick" ? c.due + TICK_WAIT_MS : Date.parse(c.notice.expires_at);
  if (c.kind === "tick" && c.due > now) return null;
  return {
    rule: v.rule,
    cause: c,
    until: Math.min(v.until, deadline),
    reason: v.reason,
    day: v.day,
    key: typeof v.key === "string" && KEY_RE.test(v.key) ? v.key : null,
    ...(v.told === true ? { told: true } : {}),
    ...(typeof v.shape === "string" && v.shape.length <= 128 ? { shape: v.shape } : {}),
  };
}

/** A saved record, read deeply: what does not fit is dropped and said once; a record of another
 *  version's shape is no record. Never throws. */
export function stateOf(v: unknown, o: { now?: number; log?: (line: string) => void } = {}): TriggerState {
  const now = o.now ?? Date.now();
  const dropped = new Set<string>();
  const say = (s: string) => dropped.add(s);
  const rules: TriggerState["rules"] = Object.create(null);
  const out: TriggerState = { v: 1, rules, waiting: [] };
  if (v === undefined) return out;
  if (!isObject(v) || v.v !== 1 || !isObject(v.rules)) {
    o.log?.("the triggers' record is not one this version reads: it starts empty");
    return out;
  }
  for (const [name, st] of Object.entries(v.rules)) {
    const r = NAME_RE.test(name) ? ruleState(st, now, say) : null;
    if (r) rules[name] = r;
    else say(`a rule's record that does not fit (${JSON.stringify(name).slice(0, 44)})`);
  }
  const list = Array.isArray(v.waiting) ? v.waiting.slice(0, WAITING_MAX) : [];
  for (const w of list) {
    const ok = waiting(w, now);
    if (ok) out.waiting.push(ok);
    else say("a waiting run that does not fit");
  }
  // A waiting run holds its count of the day: never fewer counted than wait.
  for (const w of out.waiting) {
    rules[w.rule] ??= { history: [] };
    const st = rules[w.rule] as RuleState;
    if (st.today?.day !== w.day) st.today = { day: w.day, runs: 0, keys: [] };
    const waits = out.waiting.filter((x) => x.rule === w.rule && x.day === w.day).length;
    st.today.runs = Math.max(st.today.runs, waits);
  }
  if (dropped.size) o.log?.(`the triggers' record held what does not fit, dropped: ${[...dropped].join("; ")}`);
  return out;
}

/** The record on disk, parsed: nothing when it is missing, unreadable, not JSON or over the size an
 *  honest one reaches (said in the log). Never throws. */
export function readStateFile(file: string, log?: (line: string) => void): unknown {
  try {
    if (statSync(file).size > STATE_MAX_BYTES) {
      log?.("the triggers' record is larger than any this version writes: it starts empty");
      return undefined;
    }
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
