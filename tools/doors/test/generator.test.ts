// SPDX-License-Identifier: Apache-2.0
// The generator's own rules, on small protos compiled for the test: what it refuses, and the
// shapes the wire protos don't use yet (a map of words, a float with a ceiling). The parity tests
// cover the rest through the real proto. Together they keep tools/doors at the 100 % rule.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build, lint } from "../src/buf.js";
import { messageSchema, schemaFiles } from "../src/jsonschema.js";
import { run } from "../src/main.js";
import { Descriptors, kindOf, typeTiers } from "../src/read.js";
import { typesFile } from "../src/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const protoDir = path.join(root, "proto");

/** A buf module of one file, `sessionpipe/v1/test.proto`, beside our options and the vendored rules. */
function compile(body: string, { options = true } = {}): Descriptors {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sp-doors-"));
  writeFileSync(path.join(dir, "buf.yaml"), "version: v2\nmodules:\n  - path: .\n");
  for (const sub of ["buf", "google", "sessionpipe/v1/options.proto"])
    cpSync(path.join(protoDir, sub), path.join(dir, sub), { recursive: true });
  const imports = options
    ? 'import "buf/validate/validate.proto";\nimport "google/api/field_behavior.proto";\nimport "google/protobuf/struct.proto";\nimport "sessionpipe/v1/options.proto";\n'
    : "";
  writeFileSync(
    path.join(dir, "sessionpipe/v1/test.proto"),
    `syntax = "proto3";\npackage sessionpipe.v1;\n${imports}${body}`,
  );
  if (!options) rmSync(path.join(dir, "sessionpipe/v1/options.proto"));
  return new Descriptors(build({ root, protoDir: dir }));
}
const message = (d: Descriptors, name: string) => d.message(name);

describe("buf", () => {
  it("a binary that isn't there is an error; a failed lint says buf's words", () => {
    // Without a shell (every platform but Windows), spawning a path that isn't there is ENOENT.
    expect(() => build({ root, buf: path.join(root, "no-such-buf"), platform: "linux" })).toThrow(/ENOENT/);
    // Windows runs buf.cmd through a shell; from a root with no node_modules the shell reports it missing, on every OS.
    const bare = mkdtempSync(path.join(os.tmpdir(), "sp-doors-bare-"));
    expect(() => build({ root: bare, protoDir, platform: "win32", env: process.env })).toThrow(/buf build failed/);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sp-doors-lint-"));
    writeFileSync(path.join(dir, "buf.yaml"), "version: v2\nmodules:\n  - path: .\nlint:\n  use:\n    - COMMENTS\n");
    writeFileSync(path.join(dir, "x.proto"), 'syntax = "proto3";\npackage x.v1;\nmessage Uncommented {}\n');
    expect(() => lint({ root, protoDir: dir })).toThrow(/buf lint failed/);
  });
});

describe("reading the descriptors", () => {
  it("refuses a descriptor set without the options it reads", () => {
    expect(() => compile("message Plain { string a = 1; }", { options: false })).toThrow(
      /no extension sessionpipe.v1.format/,
    );
  });
  it("names a message the proto hasn't got", () => {
    expect(() => compile("message Here {}").message("Elsewhere")).toThrow(/no message sessionpipe.v1.Elsewhere/);
  });
  it("every event type needs a tier on its message", () => {
    expect(() => typeTiers(compile("message NoTier {}\nmessage EventData { NoTier a = 1; }"))).toThrow(
      /EventData.a: no tier/,
    );
    expect(() => typeTiers(compile("message EventData { string a = 1; }"))).toThrow(/EventData.a: no tier/);
  });
  it("a map's kind is its value's: a word, a message or a scalar", () => {
    const d = compile(
      "enum Kind { KIND_UNSPECIFIED = 0; KIND_A = 1; }\nmessage M {}\nmessage Maps { map<string, string> s = 1; map<string, Kind> e = 2; map<string, M> m = 3; }",
    );
    const [s, e, m] = message(d, "Maps").fields;
    expect(kindOf(s!)).toEqual({ scalar: 9 });
    expect("enum" in kindOf(e!)).toBe(true);
    expect("message" in kindOf(m!)).toBe(true);
    expect(messageSchema(d, message(d, "Maps"))).toEqual({
      type: "object",
      properties: {
        s: { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "string" } },
        e: { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "string", enum: ["a"] } },
        m: {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: { type: "object", properties: {} },
        },
      },
    });
    expect(typesFile(d, ["test"])).toContain(
      "  s?: Record<string, string> | undefined;\n  e?: Record<string, Kind> | undefined;\n  m?: Record<string, M> | undefined;",
    );
  });
});

describe("what the generators refuse or haven't a shape for yet", () => {
  it("a bytes field has no JSON Schema and no TypeScript type here", () => {
    const d = compile("message B { bytes raw = 1; }");
    expect(() => messageSchema(d, message(d, "B"))).toThrow(/no JSON Schema for a BYTES field/);
    expect(() => typesFile(d, ["test"])).toThrow(/no TypeScript type for a BYTES field/);
  });
  it("gt and lt rules are refused: the wire says gte and lte", () => {
    const gt = compile("message N { int32 n = 1 [(buf.validate.field).int32.gt = 0]; }");
    expect(() => messageSchema(gt, message(gt, "N"))).toThrow(/a gt rule has no JSON Schema/);
    const lt = compile("message N { double n = 1 [(buf.validate.field).double.lt = 1]; }");
    expect(() => messageSchema(lt, message(lt, "N"))).toThrow(/a lt rule has no JSON Schema/);
  });
  it("a float or double with a ceiling, and a 32-bit float type", () => {
    const d = compile(
      "message F { double d = 1 [(buf.validate.field).double.lte = 5]; float f = 2 [(buf.validate.field).float.gte = 1]; double plain = 3; }",
    );
    expect(messageSchema(d, message(d, "F"))).toEqual({
      type: "object",
      properties: { d: { type: "number", maximum: 5 }, f: { type: "number", minimum: 1 }, plain: { type: "number" } },
    });
    expect(typesFile(d, ["test"])).toContain(
      "  d?: number | undefined;\n  f?: number | undefined;\n  plain?: number | undefined;",
    );
  });
});

describe("the schemas command", () => {
  it("writes, checks, reports each kind of drift, and removes a file no longer generated", () => {
    const fake = mkdtempSync(path.join(os.tmpdir(), "sp-doors-root-"));
    cpSync(protoDir, path.join(fake, "proto"), { recursive: true });
    symlinkSync(path.join(root, "node_modules"), path.join(fake, "node_modules"));
    const log: string[] = [];
    const error: string[] = [];
    const io = { log: (s: string) => log.push(s), error: (s: string) => error.push(s) };
    expect(run({ root: fake, check: true, ...io })).toBe(1);
    expect(error.filter((l) => l.endsWith(": missing"))).toHaveLength(17);
    expect(run({ root: fake, check: false, ...io })).toBe(0);
    expect(existsSync(path.join(fake, "packages/core/gen/v1.ts"))).toBe(true);
    expect(readFileSync(path.join(fake, "schemas/v1/event.json"), "utf8")).toBe(
      readFileSync(path.join(root, "schemas/v1/event.json"), "utf8"),
    );
    expect(run({ root: fake, check: true, ...io })).toBe(0);
    writeFileSync(path.join(fake, "schemas/v1/event.json"), "{}\n");
    rmSync(path.join(fake, "packages/core/gen/v1.ts"));
    writeFileSync(path.join(fake, "schemas/v1/extra.json"), "{}\n");
    error.length = 0;
    expect(run({ root: fake, check: true, ...io })).toBe(1);
    expect(error).toEqual([
      "packages/core/gen/v1.ts: missing",
      "schemas/v1/event.json: out of date",
      "schemas/v1/extra.json: committed but no longer generated",
      "\n3 generated file(s) differ from the proto. Run: npm run schemas",
    ]);
    expect(run({ root: fake, check: false, ...io })).toBe(0);
    expect(existsSync(path.join(fake, "schemas/v1/extra.json"))).toBe(false);
    expect(run({ root: fake, check: true, ...io })).toBe(0);
    expect(log.at(-1)).toMatch(/in sync with proto\/ \(17 files\)/);
    // Six runs of the generator over a copied tree: about five seconds on a Windows
    // runner, where the default 5 s limit failed it twice in one day (2026-11-11).
  }, 30_000);
  it("on this repository, with the default output, everything is in sync", () => {
    expect(run({ root, check: true })).toBe(0);
  });
  it("schemaFiles names every file under schemas/v1", () => {
    const d = new Descriptors(build({ root }));
    expect(Object.keys(schemaFiles(d))).toHaveLength(16);
  });
});
