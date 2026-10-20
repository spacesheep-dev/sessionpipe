// SPDX-License-Identifier: Apache-2.0
// The fixture runner: a recorded hook input through core's adapter, its events against
// what the fixture expects (`"*"` anywhere is a wildcard, `seq` always is), one row per
// file. And the command around it: usage, the receiver scenarios still to come, the
// table and the exit code, run only as the script node started (a bin symlink too).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { runAdapterFixtures } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-conformance-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Fixture = {
  harness: string;
  input: { argv: string[]; stdin: string; env?: Record<string, string>; cwd?: string };
  expect: { type: string; harness: { event: string }; session: Record<string, unknown>; data: unknown }[];
};
/** The recorded Claude Code PostToolUse fixture, as a fresh object to bend. */
const recorded = (): Fixture =>
  JSON.parse(readFileSync(path.join(root, "conformance/harness/claude-code/post-tool-use-bash.json"), "utf8"));
let n = 0;
const fixture = (fx: unknown, dir = tmp): string => {
  const f = path.join(dir, `fx-${++n}.json`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, JSON.stringify(fx));
  return f;
};
const why = async (fx: unknown) => (await runAdapterFixtures([fixture(fx)])).results[0]!;

describe("runAdapterFixtures", () => {
  it("passes the recorded fixture, with or without env and cwd, and through nested wildcards", async () => {
    const plain = recorded();
    delete plain.input.env;
    delete plain.input.cwd;
    const wild = recorded();
    wild.expect[0]!.data = { tool: "*", input: { command: "*" }, output: "*" };
    const files = [fixture(recorded()), fixture(plain), fixture(wild)];
    const r = await runAdapterFixtures(files);
    expect(r.results).toEqual(files.map((file) => ({ file, ok: true })));
    expect(r.failed).toBe(0);
    expect(r.table).toBe(files.map((f) => `ok   ${f}`).join("\n"));
  });
  it("names the first miss: the event count, a type, the harness event, a data leaf, a session field", async () => {
    const count = recorded();
    count.expect = [];
    expect((await why(count)).why).toBe("types: expected 0 items");
    const type = recorded();
    type.expect[0]!.type = "tool.started";
    expect((await why(type)).why).toBe('types[0]: expected "tool.started", got "tool.ended"');
    const event = recorded();
    event.expect[0]!.harness.event = "PreToolUse";
    expect((await why(event)).why).toBe('[0].harness.event: expected "PreToolUse", got "PostToolUse"');
    const leaf = recorded();
    (leaf.expect[0]!.data as { tool: string }).tool = "Read";
    expect((await why(leaf)).why).toBe('[0].data.tool: expected "Read", got "Bash"');
    const session = recorded();
    session.expect[0]!.session.id = "someone-else";
    expect((await why(session)).why).toBe(
      '[0].session.id: expected "someone-else", got "ed6c7665-589f-40c7-b7b4-e38ee662b7bc"',
    );
  });
  it("an array wants an array of the same length, an object an object, and seq is never compared", async () => {
    const array = recorded();
    (array.expect[0]!.data as { output: unknown }).output = ["README.md", ""];
    expect((await why(array)).why).toBe("[0].data.output: expected 2 items");
    const shape = recorded();
    (shape.expect[0]!.data as { tool: unknown }).tool = { name: "Bash" };
    expect((await why(shape)).why).toBe("[0].data.tool: expected an object");
    const seq = recorded();
    seq.expect[0]!.session.seq = 99;
    expect((await why(seq)).ok).toBe(true);
  });
  it("an unknown harness and a hook the adapter has no event for are failures, not throws", async () => {
    const unknown = recorded();
    unknown.harness = "nope";
    expect(await why(unknown)).toMatchObject({ ok: false, why: "no adapter nope" });
    // An empty `expect` is a payload the adapter must report nothing for: a null is a pass.
    // The same null against an expected event is the failure it always was.
    const nothing: Fixture = {
      harness: "codex",
      input: { argv: ["codex", "notify"], stdin: "" },
      expect: [],
    };
    expect(await why(nothing)).toEqual({ file: expect.any(String), ok: true });
    const missing = recorded();
    missing.input.stdin = "";
    expect(await why(missing)).toMatchObject({ ok: false, why: "fromHook returned null" });
    const r = await runAdapterFixtures([fixture(unknown), fixture(recorded())]);
    expect(r.failed).toBe(1);
    expect(r.table.split("\n")).toEqual([`FAIL ${r.results[0]!.file} — no adapter nope`, `ok   ${r.results[1]!.file}`]);
  });
});

describe("the command", () => {
  const io = () => {
    const out: string[] = [];
    return { out, stdout: { write: (s: string) => out.push(s) } };
  };
  it("usage without a target, M3 for a receiver URL, the table and the count for a fixture dir", async () => {
    const none = io();
    expect(await main([], none)).toBe(2);
    expect(none.out.join("")).toBe("usage: sessionpipe-conformance <conformance/harness dir | https://receiver>\n");
    const url = io();
    expect(await main(["https://receiver.example"], url)).toBe(2);
    expect(url.out.join("")).toBe("receiver scenarios land in M3\n");
    const dir = path.join(tmp, "dir");
    const good = fixture(recorded(), path.join(dir, "nested"));
    writeFileSync(path.join(dir, "notes.txt"), "not a fixture");
    const ok = io();
    expect(await main([dir], ok)).toBe(0);
    expect(ok.out.join("")).toBe(`ok   ${good}\n1/1 passed\n`);
    const bad = recorded();
    bad.harness = "nope";
    const failing = fixture(bad, dir);
    const fail = io();
    expect(await main([dir], fail)).toBe(1);
    expect(fail.out.join("")).toBe(`FAIL ${failing} — no adapter nope\nok   ${good}\n1/2 passed\n`);
  });
});

describe("as the script node started", () => {
  const cli = path.resolve(here, "../src/cli.ts");
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
    vi.resetModules();
  });
  /** Import the entry afresh with `process.argv` as given; what it wrote and whether it exited. */
  async function load(args: string[]) {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => {
      out.push(s);
      return true;
    }) as typeof process.stdout.write);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as () => never);
    process.argv = args;
    vi.resetModules();
    await import("../src/cli.js");
    return { out: out.join(""), code: exit.mock.calls[0]?.[0] };
  }
  it("runs with the script's own path and through a symlink to it", async () => {
    expect(await load([process.execPath, cli])).toEqual({
      out: "usage: sessionpipe-conformance <conformance/harness dir | https://receiver>\n",
      code: 2,
    });
    if (process.platform !== "win32") {
      const link = path.join(tmp, "bin", "sessionpipe-conformance");
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(cli, link);
      expect(await load([process.execPath, link, "https://receiver.example"])).toEqual({
        out: "receiver scenarios land in M3\n",
        code: 2,
      });
    }
  });
  it("stays quiet when imported: another script, a script that is not there, no script at all", async () => {
    expect(await load([process.execPath, fileURLToPath(import.meta.url)])).toEqual({ out: "", code: undefined });
    expect(await load([process.execPath, path.join(tmp, "missing.js")])).toEqual({ out: "", code: undefined });
    expect(await load([process.execPath])).toEqual({ out: "", code: undefined });
  });
});
