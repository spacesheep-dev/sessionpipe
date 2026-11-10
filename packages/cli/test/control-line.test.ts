// SPDX-License-Identifier: Apache-2.0
// The order one session's messages are delivered in (CONTROL.md §6 `prompt`): the line
// on its own, held to conformance/control-order.json, which any machine's
// implementation can run.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Lines, type Turn } from "../src/control/line.js";

interface Step {
  arrive?: { id: string; session: string; iat: number }[];
  done?: string;
  drop?: string;
}
interface Case {
  name: string;
  steps: Step[];
  expect: string[];
}
const vectors = JSON.parse(
  readFileSync(new URL("../../../conformance/control-order.json", import.meta.url), "utf8"),
) as { cases: Case[] };

/** Everything that was only waiting for the current tick to end. */
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("conformance/control-order.json", () => {
  it("has the cases the spec names", () => {
    expect(vectors.cases.length).toBe(8);
    expect(new Set(vectors.cases.map((c) => c.name)).size).toBe(8);
  });
  it.each(vectors.cases)("$name", async (c) => {
    const lines = new Lines();
    const turns = new Map<string, Turn>();
    const order: string[] = [];
    for (const step of c.steps) {
      // One poll's messages: all taken in hand in the same tick, none awaited.
      for (const m of step.arrive ?? []) {
        const turn = lines.enter(m.session, m.iat);
        turns.set(m.id, turn);
        void turn.ready.then(() => order.push(m.id));
      }
      const leaving = step.done ?? step.drop;
      if (leaving) {
        // A message is done only once it has had its turn.
        if (step.done) expect(order).toContain(step.done);
        (turns.get(leaving) as Turn).leave();
      }
      await tick();
    }
    expect(order).toEqual(c.expect);
  });
});

describe("a place in line", () => {
  it("is given up once, however often it is left; an empty line is forgotten and begins again", async () => {
    const lines = new Lines();
    const first = lines.enter("s", 1);
    const second = lines.enter("s", 2);
    const third = lines.enter("s", 3);
    const got: string[] = [];
    void first.ready.then(() => got.push("first"));
    void second.ready.then(() => got.push("second"));
    void third.ready.then(() => got.push("third"));
    await tick();
    expect(got).toEqual(["first"]);
    // Leaving twice must not hand the turn on twice: the third would start beside the second.
    first.leave();
    first.leave();
    await tick();
    expect(got).toEqual(["first", "second"]);
    second.leave();
    await tick();
    expect(got).toEqual(["first", "second", "third"]);
    third.leave();
    third.leave();
    await tick();
    // Nothing is left, and a new message goes at once.
    const again = lines.enter("s", 0);
    await again.ready;
    again.leave();
  });
  it("one that leaves before its turn never gets one, and holds nobody up", async () => {
    const lines = new Lines();
    const running = lines.enter("s", 1);
    const gone = lines.enter("s", 2);
    const next = lines.enter("s", 3);
    let had = false;
    void gone.ready.then(() => {
      had = true;
    });
    await running.ready;
    gone.leave();
    running.leave();
    await next.ready;
    expect(had).toBe(false);
  });
});
