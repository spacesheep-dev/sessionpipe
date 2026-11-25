// SPDX-License-Identifier: Apache-2.0
// conformance/triggers/*.json (CONTROL.md §14), as far as they can be held without an engine: every
// rules file reads or is refused as its case says, every notice reads as its ack says where the
// pure functions decide (triggers off, a broken notice, an expired one, no rule), every run a
// match makes is the rule's own (target, folder, narrowed level, tools, framed words, the mark),
// every hello says the topics and nothing else, and every ack fits control-notice-ack.json. What
// needs a machine's state (dedup, today's counts, the allowlist, a held session, the caps, the
// clock, turning off) is the engine's, which runs the same files.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMAS, validate } from "../src/schema/index.js";
import { noticeId, noticesIn, parseNotice } from "../src/triggers/notice.js";
import { subjectPattern } from "../src/triggers/pattern.js";
import { checkTriggers, firstMatch, helloTriggers, triggerRun } from "../src/triggers/rules.js";
import type { ControlNotice, MachineMode, TriggerRule, TriggersFile } from "../src/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "conformance/triggers");
const read = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
const PURE = new Set(["subject-patterns.json", "rules-file.json"]);
const scenarios = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && !PURE.has(f))
  .sort();

interface Ack {
  id: string;
  outcome: string;
  code?: string;
  session?: string;
}
interface Run {
  rule: string;
  run: unknown;
  env: Record<string, string>;
}
interface Step {
  at?: string;
  poll?: { receiver: string; body: unknown };
  hello?: string;
  change?: unknown;
  tick?: string;
  wake?: boolean;
  asleep?: string;
  release?: string;
  start_ended?: number;
  permission?: unknown;
  expect: {
    acks?: Ack[];
    runs?: Run[];
    triggers?: unknown;
    hello?: boolean;
    history?: { rule: string; result: string; code?: string }[];
    [k: string]: unknown;
  };
}
interface Case {
  name: string;
  machine: { mode: MachineMode; folders: string[]; harnesses: string[]; receivers: string[] };
  triggers: unknown;
  triggers_ok?: boolean;
  sessions?: Record<string, { level: "read" | "safe" | "edits" | "auto"; held: boolean }>;
  steps: Step[];
}
const STEP_KINDS = ["poll", "hello", "change", "tick", "wake", "release", "start_ended", "permission"];
const AT = "2026-11-24T09:14:05.000Z";

/** The rules file as the machine reads it: refused or absent is no rules, triggers off. */
function rulesOf(v: unknown, expectOk = true): TriggersFile | null {
  if (v === null) return null;
  const r = checkTriggers(v);
  expect(r.ok, JSON.stringify(r.ok ? "" : r.problems)).toBe(expectOk);
  return r.ok ? r.file : null;
}
/** An ack as a machine sends it: its clock, and a real session id where the fixture says any. */
const sent = (a: Ack) => ({
  ...a,
  at: AT,
  ...(a.session ? { session: a.session.replace(/:\*$/, ":8c132906-8c3f-4814-870a-afc3d05e1d2e") } : {}),
});

describe("conformance/triggers: the scenario files", () => {
  it("are there, and name every scenario the spec lists", () => {
    expect(scenarios).toEqual([
      "clock-missed.json",
      "hello-topics-only.json",
      "notice-broken-id.json",
      "notice-cap.json",
      "notice-cooldown.json",
      "notice-duplicate.json",
      "notice-expired.json",
      "notice-extra-field.json",
      "notice-no-rule.json",
      "notice-other-receiver.json",
      "run-level-capped.json",
      "run-waits.json",
      "triggers-off.json",
    ]);
  });
  for (const f of scenarios) {
    const fx = read(f) as { spec: string; note: string; cases: Case[] };
    it(`${f}: ${fx.cases.length} cases, every part the definition decides`, () => {
      expect(fx.spec).toMatch(/^CONTROL\.md §14/);
      expect(fx.note.length).toBeGreaterThan(40);
      for (const c of fx.cases) {
        let file = rulesOf(c.triggers, c.triggers_ok ?? true);
        // What a notice an earlier step took was, by id: for the runs a later step starts.
        const taken = new Map<string, { notice: ControlNotice; rule: TriggerRule }>();
        for (const s of c.steps) {
          const kinds = STEP_KINDS.filter((k) => k in s);
          expect(kinds.length, `${c.name}: one kind a step`).toBeLessThanOrEqual(1);
          const now = Date.parse(s.at ?? AT);
          const acks = s.expect.acks ?? [];
          for (const a of acks)
            expect(validate("control-notice-ack", { acks: [sent(a)] }), `${c.name}: ${JSON.stringify(a)}`).toEqual([]);
          if (s.change !== undefined) file = rulesOf(s.change);
          if (s.hello) {
            const t = helloTriggers(file, s.hello);
            expect(s.expect.triggers, c.name).toEqual(t);
            const shape = (SCHEMAS["control-hello"].properties as Record<string, object>).triggers!;
            expect(
              validate("control-hello", {
                name: "studio-mac",
                harnesses: [],
                modes: [],
                keys: [],
                version: "1",
                triggers: t,
              }),
            ).toEqual([]);
            expect(Object.keys(t).sort(), JSON.stringify(shape)).toEqual(["on", "topics"]);
          }
          if (s.poll) {
            const { notices, left } = noticesIn(s.poll.body);
            const ids = new Set<string>();
            for (const raw of notices) {
              const id = noticeId(raw);
              const mine = acks.filter((a) => a.id === id);
              if (id === null) continue; // nothing to ack: checked below that no ack names it
              ids.add(id);
              expect(mine, `${c.name}: one ack for ${id}`).toHaveLength(1);
              const a = mine[0]!;
              if (!file?.on) {
                expect(a, c.name).toEqual({ id, outcome: "refused", code: "triggers_off" });
                continue;
              }
              const r = parseNotice(raw, now);
              if (!r.ok) {
                expect(a, c.name).toEqual(
                  r.code === "expired" ? { id, outcome: "expired" } : { id, outcome: "refused", code: "bad_notice" },
                );
                continue;
              }
              const rule = firstMatch(file, s.poll.receiver, r.notice);
              if (!rule) {
                expect(a, c.name).toEqual({ id, outcome: "no_match" });
                continue;
              }
              // A rule takes it: whether it runs now, waits or is refused is the machine's state.
              expect(["ran", "taken", "duplicate", "refused", "failed"], c.name).toContain(a.outcome);
              expect(a.code, c.name).not.toBe("bad_notice");
              taken.set(id, { notice: r.notice, rule });
            }
            for (const a of acks) expect(ids.has(a.id), `${c.name}: an ack for a notice it can read`).toBe(true);
            expect(((s.expect.unacked as string[] | undefined) ?? []).length, c.name).toBe(left);
          }
          // Every run is the rule's own, from the notice it took (or none, on a clock).
          const ran = acks.filter((a) => a.outcome === "ran");
          const runs = s.expect.runs ?? [];
          const clock = s.tick !== undefined || s.wake !== undefined;
          if (!clock) expect(runs.length, `${c.name}: a run per ran ack`).toBe(ran.length);
          runs.forEach((want, i) => {
            const by = clock ? null : taken.get(ran[i]!.id)!;
            const rule = by ? by.rule : file!.rules.find((r) => r.name === want.rule)!;
            const target = rule.target as { continue?: string };
            const recorded = target.continue ? c.sessions?.[target.continue]?.level : undefined;
            expect(want, c.name).toEqual({
              rule: rule.name,
              run: triggerRun(rule, c.machine.mode, by?.notice, recorded),
              env: { SESSIONPIPE_TRIGGERED_BY: rule.name },
            });
            if (by)
              expect(ran[i]!.session, c.name).toBe(target.continue ?? `${(rule.target as { start: string }).start}:*`);
          });
          for (const h of s.expect.history ?? []) {
            expect(["ran", "refused", "failed"]).toContain(h.result);
            if (h.code)
              expect(
                validate("control-notice-ack", {
                  acks: [{ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4H", outcome: "refused", at: AT, code: h.code }],
                }),
              ).toEqual([]);
          }
        }
      }
    });
  }
});

describe("conformance/triggers/subject-patterns.json", () => {
  const fx = read("subject-patterns.json") as {
    cases: { pattern: string; ok: boolean; matches?: string[]; misses?: string[] }[];
  };
  const SUBJECT = new RegExp(SCHEMAS["control-notice"].properties.subject.pattern);
  it(`${fx.cases.length} patterns: taken or refused, and what each matches, as a RegExp would`, () => {
    for (const c of fx.cases) {
      const p = subjectPattern(c.pattern);
      expect(!("error" in p), c.pattern).toBe(c.ok);
      if ("error" in p) continue;
      for (const s of c.matches ?? []) {
        expect(SUBJECT.test(s), s).toBe(true);
        expect(p.test(s) && new RegExp(c.pattern).test(s), `${c.pattern} on ${s}`).toBe(true);
      }
      for (const s of c.misses ?? []) expect(p.test(s), `${c.pattern} on ${s}`).toBe(false);
    }
  });
});

describe("conformance/triggers/rules-file.json", () => {
  const fx = read("rules-file.json") as { cases: { name: string; file: unknown; ok: boolean }[] };
  it(`${fx.cases.length} files, each read whole or refused whole`, () => {
    for (const c of fx.cases) expect(checkTriggers(c.file).ok, c.name).toBe(c.ok);
  });
});
