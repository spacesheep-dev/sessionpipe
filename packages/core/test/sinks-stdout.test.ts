// SPDX-License-Identifier: Apache-2.0
// The stdout sink keeps the sink contract (sinks/types.ts): send() answers with a
// result, never a throw, like the file and HTTP sinks.
import { describe, expect, it } from "vitest";
import { StdoutSink } from "../src/sinks/stdout.js";
import type { Event } from "../src/types.js";

const event: Event = {
  protocol: 1,
  id: "01K6ABCXYZ0123456789ABCDEF",
  type: "session.heartbeat",
  time: "2026-10-16T00:00:00.000Z",
  tier: 0,
  harness: { name: "codex" },
  session: { id: "s", seq: 0 },
  privacy: { rulesets: [], pii: false },
  data: {},
};

describe("stdout sink", () => {
  it("writes one line per event and counts them", async () => {
    const lines: string[] = [];
    const sink = new StdoutSink("o", 0, false, (l) => lines.push(l));
    expect(await sink.send([event, { ...event, session: { id: "s", seq: 1 } }])).toEqual({
      ok: true,
      acknowledged: 2,
      accepted: 2,
      duplicates: 0,
      rejected: [],
    });
    expect(lines.map((l) => (JSON.parse(l) as Event).session.seq)).toEqual([0, 1]);
  });
  it("a writer that fails (a closed pipe) is a retry result, not a throw", async () => {
    const sink = new StdoutSink("o", 0, false, () => {
      throw new Error("EPIPE: broken pipe");
    });
    await expect(sink.send([event])).resolves.toEqual({
      ok: false,
      acknowledged: 0,
      error: "EPIPE: broken pipe",
      action: "retry",
    });
    const plain = new StdoutSink("o", 0, false, () => {
      throw "closed";
    });
    expect((await plain.send([event])).error).toBe("closed");
  });
});
