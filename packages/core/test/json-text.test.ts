// SPDX-License-Identifier: Apache-2.0
// The JSON config writer on its own (#205): the scanner's spans, an edit that keeps every
// byte it does not change, and the old writer as the reference. Over many generated files,
// laid out every which way and edited at random, the text editJson writes must parse to
// exactly what formatJson's would (keys in the same order), and taking out what was put in
// must give back the file byte for byte.
import { describe, expect, it } from "vitest";
import { editJson, formatJson, scan } from "../src/adapters/json-text.js";
import { layout, pick, type Rand, rng } from "./helpers/json-layout.js";

const shape = { indent: "  ", eol: "\n", finalNewline: true };
const at = (raw: string) => ({ ...shape, raw });
/** What the old writer wrote, parsed: the reference every edit is held to. */
const reference = (v: unknown) => JSON.stringify(JSON.parse(formatJson(v, shape)));
const parsed = (text: string) => JSON.stringify(JSON.parse(text.replace(/^﻿/, "")));

describe("scan", () => {
  it("finds where each value begins and ends, through escapes, numbers and literals", () => {
    const t = ' {"a\\"}": [1, -2.5e+3, true, null, "x\\\\"], "b" : {"c":{}} }\n';
    const root = scan(t);
    expect(t.slice(root.start, root.end)).toBe(t.trim());
    const [a, b] = root.kids!;
    expect(a!.key).toBe('a"}');
    expect(a!.span.kids!.map((k) => t.slice(k.span.start, k.span.end))).toEqual([
      "1",
      "-2.5e+3",
      "true",
      "null",
      '"x\\\\"',
    ]);
    expect(b!.colon).toBe(" : ");
    expect(t.slice(b!.span.start, b!.span.end)).toBe('{"c":{}}');
    expect(b!.span.kids![0]!.span.kids).toEqual([]);
  });
});

describe("editJson", () => {
  it("adds and removes members in the layout of the ones beside them, and back to the same bytes", () => {
    const cases: [string, (v: Record<string, unknown>) => void][] = [
      // An array on one line gets its new element on that line.
      ['{ "allow": ["Read"] }', (v) => (v.allow as unknown[]).push({ a: [1] })],
      ['{"allow":["Read"]}', (v) => (v.allow as unknown[]).push("x")],
      ['{\n\t"allow": [\n\t\t"a",\n\t\t"b"\n\t]\n}', (v) => (v.allow as unknown[]).push({ a: 1 })],
      // An empty one is filled on its line when its object is on one line, below it otherwise.
      ['{ "a": 1, "hooks": {} }', (v) => Object.assign(v.hooks as object, { Stop: [{ x: 1 }] })],
      ['{\r\n    "hooks": {}\r\n}', (v) => Object.assign(v.hooks as object, { Stop: [{ x: 1 }] })],
      ["{}", (v) => Object.assign(v, { hooks: { Stop: [1] } })],
      ['{"a": 1}', (v) => Object.assign(v, { hooks: [] })],
    ];
    for (const [raw, change] of cases) {
      const v = JSON.parse(raw);
      change(v);
      const out = editJson(v, at(raw));
      expect(parsed(out)).toBe(reference(v));
      expect(out).not.toBe(formatJson(v, shape));
      expect(editJson(JSON.parse(raw), at(out))).toBe(raw);
    }
    expect(editJson({ allow: ["Read", { a: [1] }] }, at('{ "allow": ["Read"] }'))).toBe(
      '{ "allow": ["Read", { "a": [ 1 ] }] }',
    );
    expect(editJson({ hooks: { Stop: [1] } }, at("{}"))).toBe('{\n  "hooks": {\n    "Stop": [\n      1\n    ]\n  }\n}');
    const tabs = { indent: "\t", eol: "\r\n", finalNewline: false, raw: '{\r\n\t"hooks": {}\r\n}' };
    expect(editJson({ hooks: { a: 1 } }, tabs)).toBe('{\r\n\t"hooks": {\r\n\t\t"a": 1\r\n\t}\r\n}');
  });
  it("takes out the first, a middle and the last member with their commas", () => {
    const raw = "[\n  1,\n  2,\n  3\n]";
    expect(editJson([2, 3], at(raw))).toBe("[\n  2,\n  3\n]");
    expect(editJson([1, 3], at(raw))).toBe("[\n  1,\n  3\n]");
    expect(editJson([1, 2], at(raw))).toBe("[\n  1,\n  2\n]");
    expect(editJson([], at(raw))).toBe("[]");
    // A replaced element is a new one, laid out like the rest; a value changes in place.
    expect(editJson([1, 9, 3], at(raw))).toBe("[\n  1,\n  9,\n  3\n]");
    expect(editJson({ a: { b: "new", c: [1] } }, at('{"a": {"b": "old", "c": [1]}}'))).toBe(
      '{"a": {"b": "new", "c": [1]}}',
    );
    // An element that is no longer there is the one that changed, and is edited where it is;
    // one put in front is new, and the rest keep their bytes.
    expect(editJson([{ a: 1, b: [2, 3] }, 5], at('[{ "a": 1, "b": [2] }, 5]'))).toBe('[{ "a": 1, "b": [2, 3] }, 5]');
    expect(editJson([0, 1, 2], at("[1, 2]"))).toBe("[0, 1, 2]");
    // A value of another kind is written in its place.
    expect(editJson({ hooks: { Stop: [] }, z: 1 }, at('{\n  "hooks": 3,\n  "z": 1\n}'))).toBe(
      '{\n  "hooks": {\n    "Stop": []\n  },\n  "z": 1\n}',
    );
    expect(editJson({ a: [1] }, at('{ "a": {} }'))).toBe('{ "a": [ 1 ] }');
    expect(editJson({ a: 2 }, at('{"a": [1]}'))).toBe('{"a": 2}');
  });
  it("keeps the order JS gives the keys, and the last of a key written twice", () => {
    const twice = '{"a": 1, "a": 2, "z": 0}';
    const out = editJson({ a: 2, z: 1 }, at(twice));
    expect(out).toBe('{"a": 2, "z": 1}');
    expect(parsed(out)).toBe(reference({ a: 2, z: 1 }));
    // A key like "1" goes first in JS wherever it is written, so it stays where it is.
    const n = JSON.parse('{"b": 1, "1": 2}');
    n.c = 3;
    expect(editJson(n, at('{"b": 1, "1": 2}'))).toBe('{"b": 1, "1": 2, "c": 3}');
    expect(parsed(editJson(n, at('{"b": 1, "1": 2}')))).toBe(reference(n));
  });
  it("keeps the byte-order mark, the line ends, the final newline and what is around the value", () => {
    const raw = '\n {\r\n\t"a": 1\r\n}\r\n\r\n';
    const out = editJson({ a: 1, b: 2 }, { indent: "\t", eol: "\r\n", finalNewline: true, bom: true, raw });
    expect(out).toBe('﻿\n {\r\n\t"a": 1,\r\n\t"b": 2\r\n}\r\n\r\n');
    expect(editJson({ a: 1 }, { indent: "\t", eol: "\r\n", finalNewline: true, bom: true, raw: out.slice(1) })).toBe(
      `﻿${raw}`,
    );
  });
  it("a file that did not exist, and a text that is not the JSON it should be, are written whole", () => {
    expect(editJson({ a: [1] }, at(""))).toBe('{\n  "a": [\n    1\n  ]\n}\n');
    expect(editJson({ a: [1] }, at("{ nope"))).toBe(formatJson({ a: [1] }, shape));
  });
  // No caller moves a key, but one that did would get a text whose keys parse in another
  // order: an edit that does not parse back to the value is never written.
  it("an edit that would not parse back to the value is never written: the file is written whole", () => {
    expect(editJson({ b: 1, a: [1] }, at('{"a": [], "b": 1}'))).toBe(formatJson({ b: 1, a: [1] }, shape));
  });
});

// Generated files: values with escapes and nesting, laid out at random. `keep` is on one
// line in every file and never edited, so finding it verbatim shows the edit was made in
// the text, not by writing the file whole.
const KEEP = '"keep": {"x": [1, "a b"]}';
const KEYS = ["a", "hooks", "Stop", "permissions", "allow", 'q"uote', "ünï", "1", "env", "z"];
function value(r: Rand, depth: number): unknown {
  const k = r();
  if (depth > 3 || k < 0.35) return pick(r, [0, -1.5, 1e21, true, false, null, "x", 'a\\"b\n', " é"]);
  if (k < 0.65) return Array.from({ length: Math.floor(r() * 4) }, () => value(r, depth + 1));
  const o: Record<string, unknown> = {};
  for (let i = Math.floor(r() * 4); i > 0; i--) o[pick(r, KEYS)] = value(r, depth + 1);
  return o;
}
function file(r: Rand) {
  const unit = pick(r, ["  ", "    ", "\t", " "]);
  const eol = pick(r, ["\n", "\r\n"]);
  const v = value(r, 0);
  const top = v && typeof v === "object" && !Array.isArray(v) ? v : { a: v };
  const body = layout(r, top, unit, eol, "");
  const rest = body === "{}" ? "" : `,${eol}${unit}${body.slice(1, -1).trim()}`;
  const end = pick(r, ["", eol]);
  return { raw: `{${eol}${unit}${KEEP}${rest}${eol}}${end}`, shape: { indent: unit, eol, finalNewline: !!end } };
}
/** Every object and array in a value, with the one it sits in. */
function containers(v: unknown, out: unknown[] = []): unknown[] {
  if (v && typeof v === "object") {
    out.push(v);
    for (const x of Object.values(v)) containers(x, out);
  }
  return out;
}

describe("editJson against the old writer, over generated files", () => {
  it("every random edit parses to what formatJson's text parses to, and is made in the text", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const { raw, shape: s } = file(r);
      const v = JSON.parse(raw);
      const all = containers(v).filter((c) => c !== v.keep && c !== v.keep.x);
      for (let i = 1 + Math.floor(r() * 3); i > 0; i--) {
        const c = pick(r, all) as Record<string, unknown> | unknown[];
        const op = r();
        if (Array.isArray(c)) {
          if (op < 0.4) c.push(value(r, 2));
          else if (op < 0.7) c.splice(Math.floor(r() * c.length), 1);
          else if (op < 0.85) c.unshift(value(r, 2));
          else c.length = 0;
        } else {
          const keys = Object.keys(c).filter((k) => k !== "keep");
          // A new key is one the object never had: a key taken out and put back moves to the
          // end in JS, and no caller does that (it is the whole-file writer's case, above).
          if (op < 0.4) c[`${pick(r, KEYS)}${i}`] = value(r, 2);
          else if (op < 0.7 && keys.length) delete c[pick(r, keys)];
          else if (keys.length) c[pick(r, keys)] = value(r, 2);
        }
      }
      const out = editJson(v, { ...s, raw });
      expect(parsed(out), `seed ${seed}`).toBe(JSON.stringify(JSON.parse(formatJson(v, s))));
      expect(out, `seed ${seed}`).toContain(KEEP);
    }
  });
  it("taking out what was put in gives back the file byte for byte", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const { raw, shape: s } = file(r);
      const v = JSON.parse(raw);
      const all = containers(v).filter((c) => c !== v.keep && c !== v.keep.x);
      const c = pick(r, all) as Record<string, unknown> | unknown[];
      const ours = { hooks: [{ type: "command", command: "/opt/sessionpipe/hook.js x Stop" }] };
      if (Array.isArray(c)) c.push(ours);
      else c["sessionpipe-test"] = ours;
      const added = editJson(v, { ...s, raw });
      expect(added, `seed ${seed}`).toContain(KEEP);
      expect(editJson(JSON.parse(raw), { ...s, raw: added }), `seed ${seed}`).toBe(raw);
    }
  });
});
