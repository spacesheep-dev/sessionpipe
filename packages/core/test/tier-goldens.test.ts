// SPDX-License-Identifier: Apache-2.0
// filterEvent in this tree gives, for every expected fixture event at every tier with and
// without PII, exactly what the published sessionpipe-core 0.13.3 gave: conformance/tiers/
// (docs/rfcs/decisions/003). The envelope is scripts/lib/envelope.mjs, the one the recorder used. A difference here is a protocol change and needs its own fixture and a
// deliberate re-recording, never a silent update.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { envelope } from "../../../scripts/lib/envelope.mjs";
import { TYPE_TIER } from "../schema/v1.js";
import { filterEvent } from "../src/privacy/filter.js";
import type { Event, Tier } from "../src/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
describe("filterEvent matches the 0.13.3 goldens", () => {
  const tiersDir = path.join(root, "conformance/tiers");
  for (const file of readdirSync(tiersDir).filter((f) => f.endsWith(".json"))) {
    const harness = file.replace(/\.json$/, "");
    const golden = JSON.parse(readFileSync(path.join(tiersDir, file), "utf8")) as {
      recorded_from: string;
      cases: Record<string, Record<string, unknown>>;
    };
    it(`${harness}: ${Object.keys(golden.cases).length} events, recorded from ${golden.recorded_from}`, () => {
      for (const [key, cases] of Object.entries(golden.cases)) {
        const [fixture, index] = key.split("#") as [string, string];
        const fx = JSON.parse(readFileSync(path.join(root, "conformance/harness", harness, fixture), "utf8"));
        const ev = envelope(fx.expect[Number(index)], TYPE_TIER) as Event;
        for (const [c, want] of Object.entries(cases)) {
          const [tier, pii] = c.split("+");
          expect(filterEvent(ev, Number(tier) as Tier, pii === "pii"), `${harness}/${key} @${c}`).toEqual(want);
        }
      }
    });
  }
});
