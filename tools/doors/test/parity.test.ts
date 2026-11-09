// SPDX-License-Identifier: Apache-2.0
// The proto says what the Zod source says, fact for fact, while both exist (RFC 0001 §6 gate 1,
// and the one-release overlap of §10 step 1). A schema the proto generates is byte-identical to
// the one Zod writes; the tiers, the harness names and the capabilities agree. When the Zod file
// goes (step 2), this test goes with it; the committed schemas/v1 keep the contract from then on.

import path from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "@sessionpipe/core/schema";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { build, lint } from "../src/buf.js";
import { SCHEMA_BASE, SCHEMA_FILES, schemaFiles } from "../src/jsonschema.js";
import { Descriptors, enumWords, typeTiers } from "../src/read.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const d = new Descriptors(build({ root }));

function zodFile(name: string): string {
  const schema = (S.SCHEMAS as Record<string, z.ZodType>)[name];
  if (!schema) throw new Error(`no Zod schema ${name}`);
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" });
  return `${JSON.stringify({ $id: `${SCHEMA_BASE}${name}.json`, ...json }, null, 2)}\n`;
}

describe("the proto and the Zod source agree", () => {
  it("proto/ lints", () => {
    expect(() => lint({ root })).not.toThrow();
  });

  it("names the same schema files", () => {
    expect(Object.keys(SCHEMA_FILES).sort()).toEqual(Object.keys(S.SCHEMAS).sort());
  });

  const generated = schemaFiles(d);
  for (const name of Object.keys(SCHEMA_FILES)) {
    it(`${name}.json is byte-identical`, () => {
      expect(generated[`schemas/v1/${name}.json`]).toBe(zodFile(name));
    });
  }

  it("carries each event type at the same tier", () => {
    expect(typeTiers(d)).toEqual(S.TYPE_TIER);
  });

  it("names the same event types, in order", () => {
    expect(Object.keys(typeTiers(d))).toEqual([...S.KNOWN_TYPES]);
  });

  it("lists the same harnesses, in order", () => {
    expect(enumWords(d.registry.getEnum("sessionpipe.v1.HarnessName")!, d)).toEqual([...S.HARNESS_NAMES]);
  });

  it("names the same capabilities", () => {
    expect(enumWords(d.registry.getEnum("sessionpipe.v1.Capability")!, d)).toEqual(S.Capability.options);
  });
});
