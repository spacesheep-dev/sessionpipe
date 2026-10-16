// SPDX-License-Identifier: Apache-2.0
// The Claude-shaped hooks file helpers on their own: a file read back in its own
// shape (CRLF, tabs), the top-level keys a harness demands (Cursor's version: 1), a
// lean install that leaves a foreign hook on an event it no longer takes, and what
// "installed" says about a file it cannot read.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatJson,
  installClaudeShaped,
  installedClaudeShaped,
  readJson,
  readJsonFile,
  uninstallClaudeShaped,
} from "../src/adapters/claude-shaped.js";
import type { HookCommand } from "../src/adapters/types.js";

const cmd: HookCommand = (a) => ({
  argv: ["/n", "/opt/sessionpipe/dist/hook.js", ...a],
  command: `"/n" "/opt/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});
const OPTS = { matcherFor: (e: string) => (/Tool/.test(e) ? "" : undefined), timeout: 5 };
const FOREIGN = { hooks: [{ type: "command", command: "/other/tool", timeout: 1 }] };

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "sp-shaped-"));
  file = path.join(dir, "hooks.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readJsonFile and formatJson", () => {
  it("keeps CRLF line ends and a tab indent", () => {
    writeFileSync(file, '{\r\n\t"a": 1\r\n}\r\n');
    const f = readJsonFile(file);
    expect(f).toMatchObject({ ok: true, existed: true, indent: "\t", eol: "\r\n", finalNewline: true });
    if (f.ok) expect(formatJson({ a: 1, b: [2] }, f)).toBe('{\r\n\t"a": 1,\r\n\t"b": [\r\n\t\t2\r\n\t]\r\n}\r\n');
    expect(readJson(file)).toEqual({ a: 1 });
  });
  it("refuses an array, a comment, and reads an unreadable file as nothing", () => {
    writeFileSync(file, "[1]");
    expect(readJsonFile(file)).toEqual({ ok: false, existed: true, reason: "not a JSON object" });
    expect(readJson(file)).toEqual({});
    writeFileSync(file, "/* c */ {}");
    expect(readJsonFile(file)).toMatchObject({ ok: false, reason: "not plain JSON (it has comments)" });
    writeFileSync(file, "{ nope");
    expect(readJsonFile(file)).toMatchObject({ ok: false, reason: "not plain JSON" });
    expect(readJsonFile(path.join(dir, "none.json"))).toMatchObject({ ok: true, existed: false, value: {} });
  });
});

describe("installClaudeShaped", () => {
  it("writes the top-level keys a harness demands, once", () => {
    const o = { ...OPTS, top: { version: 1 } };
    expect(installClaudeShaped(file, "cursor", ["stop"], cmd, o)).toEqual({ file, changed: true, created: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      hooks: { stop: [{ hooks: [{ type: "command", command: cmd(["cursor", "stop"]).command, timeout: 5 }] }] },
    });
    expect(installClaudeShaped(file, "cursor", ["stop"], cmd, o).changed).toBe(false);
    writeFileSync(file, JSON.stringify({ version: 0, hooks: JSON.parse(readFileSync(file, "utf8")).hooks }));
    expect(installClaudeShaped(file, "cursor", ["stop"], cmd, o).changed).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  });
  it("a lean install drops only our entry from an event it no longer takes, keeping a foreign one there", () => {
    installClaudeShaped(file, "h", ["PreToolUse", "Stop"], cmd, OPTS);
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.hooks.PreToolUse.unshift(FOREIGN);
    j.hooks.Stop = "not a list";
    writeFileSync(file, JSON.stringify(j));
    expect(installedClaudeShaped(file, "h", ["Stop"], cmd, OPTS)).toBe("stale");
    expect(installClaudeShaped(file, "h", ["Stop"], cmd, OPTS).changed).toBe(true);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.hooks.PreToolUse).toEqual([FOREIGN]);
    expect(after.hooks.Stop).toHaveLength(1);
    expect(installedClaudeShaped(file, "h", ["Stop"], cmd, OPTS)).toBe("current");
    // An event holding only ours loses the key; one holding no list is left alone.
    installClaudeShaped(file, "h", ["PreToolUse", "Stop"], cmd, OPTS);
    const full = JSON.parse(readFileSync(file, "utf8"));
    full.hooks.PreToolUse.shift();
    full.hooks.Odd = "not a list";
    writeFileSync(file, JSON.stringify(full));
    expect(installClaudeShaped(file, "h", ["Stop"], cmd, OPTS).changed).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).hooks).toEqual({ Stop: after.hooks.Stop, Odd: "not a list" });
    // Two entries of ours on one event (a hand edit) are replaced by one.
    after.hooks.Stop.push(after.hooks.Stop[0]);
    writeFileSync(file, JSON.stringify(after));
    expect(installedClaudeShaped(file, "h", ["Stop"], cmd, OPTS)).toBe("stale");
    installClaudeShaped(file, "h", ["Stop"], cmd, OPTS);
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.Stop).toHaveLength(1);
  });
  it("a hooks key that is not an object is replaced", () => {
    writeFileSync(file, JSON.stringify({ hooks: 3 }));
    installClaudeShaped(file, "h", ["Stop"], cmd, OPTS);
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.Stop).toHaveLength(1);
  });
});

describe("uninstallClaudeShaped and installedClaudeShaped", () => {
  it("a file without hooks, or without ours, is left as it is", () => {
    expect(uninstallClaudeShaped(file, ["Stop"])).toEqual({ file, changed: false });
    writeFileSync(file, JSON.stringify({ model: "x" }));
    expect(uninstallClaudeShaped(file, ["Stop"])).toEqual({ file, changed: false });
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [FOREIGN], Odd: 1 } }));
    expect(uninstallClaudeShaped(file, ["Stop"])).toEqual({ file, changed: false });
    expect(installedClaudeShaped(file, "h", ["Stop"], cmd, OPTS)).toBe("missing");
    writeFileSync(file, "{ nope");
    expect(installedClaudeShaped(file, "h", ["Stop"], cmd, OPTS)).toBe("missing");
  });
  it("removes ours from every event, ours or not in the wanted set, and the empty hooks key", () => {
    installClaudeShaped(file, "h", ["PreToolUse", "Stop"], cmd, OPTS);
    writeFileSync(file, JSON.stringify({ keep: true, ...JSON.parse(readFileSync(file, "utf8")) }, null, 4));
    expect(uninstallClaudeShaped(file, ["Stop"], { created: true })).toEqual({ file, changed: true });
    expect(readFileSync(file, "utf8")).toBe('{\n    "keep": true\n}');
  });
});
