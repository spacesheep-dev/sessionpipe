// SPDX-License-Identifier: Apache-2.0
// The JSON Schema checker: every keyword the generator writes, each on a small schema, then the
// real schemas on real values. A keyword it doesn't know is a problem, never a silent pass.
import { describe, expect, it } from "vitest";
import {
  DATA_ALLOW,
  dataSchema,
  HARNESS_NAMES,
  KNOWN_TYPES,
  PROTOCOL,
  problems,
  SCHEMAS,
  SESSION_KEYS,
  TYPE_TIER,
  validate,
} from "../src/schema/index.js";

const EVENT = {
  protocol: 1,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  type: "tool.ended",
  time: "2026-09-28T00:00:00.000Z",
  tier: 1,
  harness: { name: "codex" },
  session: { id: "s1", seq: 3, parent_id: null },
  privacy: { rulesets: ["secrets@1"], pii: false },
  data: { tool: "Bash", ok: true, extra: "kept" },
};

describe("problems(): one keyword at a time", () => {
  it("type, as one word or a list; integer is a number", () => {
    expect(problems({ type: "string" }, 1)).toEqual(["$: expected string, got integer"]);
    expect(problems({ type: ["integer", "string"] }, "1")).toEqual([]);
    expect(problems({ type: "number" }, 2)).toEqual([]);
    expect(problems({ type: "integer" }, 2.5)).toEqual(["$: expected integer, got number"]);
    expect(problems({ type: "null" }, null)).toEqual([]);
    expect(problems({ type: "array" }, {})).toEqual(["$: expected array, got object"]);
  });
  it("const and enum", () => {
    expect(problems({ const: 1 }, 1)).toEqual([]);
    expect(problems({ const: 1 }, "1")).toEqual(['$: expected 1, got "1"']);
    expect(problems({ const: 1 }, undefined)).toEqual(["$: expected 1, got undefined"]);
    expect(problems({ enum: ["a", "b"] }, "b")).toEqual([]);
    expect(problems({ enum: ["a", "b"] }, "c")).toEqual(['$: expected one of "a", "b", got "c"']);
  });
  it("anyOf and oneOf", () => {
    const alts = [{ type: "string" }, { type: "null" }];
    expect(problems({ anyOf: alts }, null)).toEqual([]);
    expect(problems({ anyOf: alts }, 1)).toEqual(["$: fits none of the 2 alternatives"]);
    const both = [{ type: "integer" }, { type: "number" }];
    expect(problems({ oneOf: both }, 1.5)).toEqual([]);
    expect(problems({ oneOf: both }, 1)).toEqual(["$: fits 2 of the 2 alternatives, not exactly one"]);
  });
  it("strings: length, pattern, format", () => {
    expect(problems({ minLength: 2, maxLength: 3 }, "a")).toEqual(["$: shorter than 2"]);
    expect(problems({ minLength: 2, maxLength: 3 }, "abcd")).toEqual(["$: longer than 3"]);
    expect(problems({ pattern: "^a+$" }, "bb")).toEqual(["$: does not match ^a+$"]);
    expect(problems({ format: "uri" }, "not a url")).toEqual(["$: not a URL"]);
    expect(problems({ format: "uri" }, "https://x.example/y")).toEqual([]);
    expect(problems({ minLength: 2, pattern: "^a+$", format: "uri" }, 5)).toEqual([]);
  });
  it("numbers: minimum and maximum", () => {
    expect(problems({ minimum: 0, maximum: 3 }, -1)).toEqual(["$: below 0"]);
    expect(problems({ minimum: 0, maximum: 3 }, 4)).toEqual(["$: above 3"]);
    expect(problems({ minimum: 0, maximum: 3 }, "x")).toEqual([]);
  });
  it("arrays: length, uniqueness, items", () => {
    const s = { minItems: 1, maxItems: 2, uniqueItems: true, items: { type: "string" } };
    expect(problems(s, [])).toEqual(["$: fewer than 1 items"]);
    expect(problems(s, ["a", "b", "c"])).toEqual(["$: more than 2 items"]);
    expect(problems(s, ["a", "a"])).toEqual(["$: repeats an item"]);
    expect(problems(s, ["a", 1])).toEqual(["$[1]: expected string, got integer"]);
    expect(problems({ uniqueItems: false }, [1, 1])).toEqual([]);
  });
  it("objects: required, properties, maxProperties, propertyNames, additionalProperties", () => {
    expect(problems({ required: ["a"], properties: { a: { type: "string" } } }, {})).toEqual(["$: missing a"]);
    expect(problems({ properties: { a: { type: "string" } } }, { a: 1 })).toEqual([
      "$.a: expected string, got integer",
    ]);
    expect(problems({ maxProperties: 1 }, { a: 1, b: 2 })).toEqual(["$: more than 1 keys"]);
    expect(problems({ propertyNames: { pattern: "^[a-z]+$" } }, { A: 1 })).toEqual([
      "$.A (key): does not match ^[a-z]+$",
    ]);
    expect(problems({ additionalProperties: false }, { a: 1 })).toEqual(["$.a: not a key of this object"]);
    expect(problems({ additionalProperties: { type: "string" } }, { a: 1 })).toEqual([
      "$.a: expected string, got integer",
    ]);
    expect(problems({ additionalProperties: {} }, { a: 1 })).toEqual([]);
    expect(problems({ properties: {} }, { a: 1 })).toEqual([]);
  });
  it("a keyword the generator never writes is a problem, not a pass; $id, $schema and default are known", () => {
    expect(problems({ $id: "x", $schema: "y", default: 1, type: "integer" }, 1)).toEqual([]);
    expect(problems({ if: {}, type: "integer" }, 1)).toEqual([
      '$: the schema uses "if", which this checker doesn\'t know',
    ]);
  });
});

describe("the protocol's own schemas", () => {
  it("a good event fits; an open data object keeps extra keys", () => {
    expect(validate("event", EVENT)).toEqual([]);
    expect(problems(dataSchema("tool.ended")!, EVENT.data)).toEqual([]);
  });
  it("says what is wrong, every problem, with its path", () => {
    expect(validate("event", { ...EVENT, protocol: 2, tier: 9, harness: { name: "Codex" } })).toEqual([
      "$.protocol: expected 1, got 2",
      "$.tier: above 3",
      "$.harness.name: does not match ^[a-z][a-z0-9-]{0,39}$",
    ]);
    expect(problems(dataSchema("tool.ended")!, { tool: "Bash" })).toEqual(["$: missing ok"]);
    expect(dataSchema("no.such")).toBeUndefined();
    expect(dataSchema("constructor")).toBeUndefined();
  });
  it("a closed union: a key is a passkey or a device key, never both or neither", () => {
    const passkey = { id: "a".repeat(16), alg: -7, spki: "AQID" };
    expect(validate("control-key", passkey)).toEqual([]);
    expect(validate("control-key", { ...passkey, type: "device" })).toEqual([
      "$: fits 0 of the 2 alternatives, not exactly one",
    ]);
  });
  it("the registry matches the schemas", () => {
    expect(PROTOCOL).toBe(1);
    expect(Object.keys((SCHEMAS["event-data"] as { properties: object }).properties)).toEqual([...KNOWN_TYPES]);
    expect(Object.keys(TYPE_TIER)).toEqual([...KNOWN_TYPES]);
    expect(
      Object.keys((SCHEMAS.event as { properties: { session: { properties: object } } }).properties.session.properties),
    ).toEqual([...SESSION_KEYS]);
    expect(Object.keys(DATA_ALLOW)).toEqual(KNOWN_TYPES.filter((t) => t !== "native"));
    expect(HARNESS_NAMES).toContain("claude-code");
  });
});
