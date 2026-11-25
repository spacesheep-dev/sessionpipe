// SPDX-License-Identifier: Apache-2.0
// `<config>/triggers.json` on disk (CONTROL.md §14.1, control/rules-file.ts): read whole or not
// at all, written whole (0600, renamed into place), never written in a shape that would not
// read back; the folder rule the daemon and the CLI share; and the guard that keeps a harness
// session from changing a rule.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  harnessSession,
  lockRules,
  RULES_MAX_BYTES,
  readRules,
  rulesOf,
  triggerStateFile,
  triggersFile,
  writeRules,
} from "../src/control/rules-file.js";
import { allowedIn } from "../src/control/store.js";

let tmp: string;
let env: NodeJS.ProcessEnv;
const unix = process.platform !== "win32";

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-rules-")));
  env = { SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"), SESSIONPIPE_STATE: path.join(tmp, "state") };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const rule = {
  name: "monday-report",
  paused: false,
  source: { every: "mon 09:00" },
  target: { start: "codex" },
  folder: "~/work/sales",
  level: "safe" as const,
  cap: { per_day: 1 },
  words: "Make last week's sales report.",
};

describe("the rules file", () => {
  it("lives beside control.json, and the daemon's record beside its state", () => {
    expect(triggersFile(env)).toBe(path.join(tmp, "config", "triggers.json"));
    expect(triggerStateFile(env)).toBe(path.join(tmp, "state", "control", "triggers-state.json"));
  });
  it("not there is none; a file that fits is read whole; one that doesn't is refused whole", () => {
    expect(readRules(env)).toEqual({ state: "none" });
    expect(rulesOf(readRules(env))).toBeNull();
    writeRules({ v: 1, on: true, rules: [rule] }, env);
    expect(readRules(env)).toEqual({ state: "ok", file: { v: 1, on: true, rules: [rule] } });
    expect(rulesOf(readRules(env))?.on).toBe(true);
    writeFileSync(triggersFile(env), JSON.stringify({ v: 1, on: true, rules: [{ ...rule, level: "boss" }] }));
    const r = readRules(env);
    expect(r.state).toBe("refused");
    expect(rulesOf(r)).toBeNull();
    // Larger than any honest file: refused whole, never parsed, and read as no rules, off.
    writeFileSync(triggersFile(env), " ".repeat(RULES_MAX_BYTES + 1));
    expect(readRules(env)).toEqual({ state: "refused", problems: [`$: larger than ${RULES_MAX_BYTES} bytes`] });
    expect(rulesOf(readRules(env))).toBeNull();
  });
  it.skipIf(!unix)("one it may not read is refused, and says why", () => {
    writeRules({ v: 1, on: false, rules: [] }, env);
    chmodSync(triggersFile(env), 0o000);
    const r = readRules(env);
    chmodSync(triggersFile(env), 0o600);
    // A test run as root reads it all the same.
    if (r.state === "refused") expect(r.problems[0]).toMatch(/^\$: can't be read \(E[A-Z]+\)$/);
    else expect(r.state).toBe("ok");
  });
  it.skipIf(!unix)("its lock is taken once, let go of, and a folder it can't write in is said as it is", () => {
    const one = lockRules(env);
    expect(one).not.toBeNull();
    expect(lockRules(env)).toBeNull();
    one?.release();
    const two = lockRules(env);
    expect(two).not.toBeNull();
    two?.release();
    const dir = path.dirname(triggersFile(env));
    chmodSync(dir, 0o500);
    try {
      // A test run as root writes there all the same.
      let threw: unknown = null;
      try {
        lockRules(env)?.release();
      } catch (e) {
        threw = e;
      }
      if (threw) expect((threw as NodeJS.ErrnoException).code).toMatch(/^E[A-Z]+$/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
  it.skipIf(!unix)("is written 0600 and renamed into place, nothing left beside it", () => {
    writeRules({ v: 1, on: false, rules: [] }, env);
    expect(statSync(triggersFile(env)).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.join(tmp, "config"))).toEqual(["triggers.json"]);
  });
  it("is never written in a shape that would not read back", () => {
    expect(() => writeRules({ v: 1, on: true, rules: [rule, rule] }, env)).toThrow(/would not read back/);
    expect(readRules(env)).toEqual({ state: "none" });
  });
});

describe("a folder on the allowlist", () => {
  it("by real path, on whole segments, under ~ too; never a file, a missing folder or a relative one", () => {
    const work = path.join(tmp, "work");
    mkdirSync(path.join(work, "acme"), { recursive: true });
    mkdirSync(path.join(tmp, "workshop"), { recursive: true });
    writeFileSync(path.join(work, "notes.txt"), "");
    expect(allowedIn(path.join(work, "acme"), [work])).toBe(path.join(work, "acme"));
    expect(allowedIn(work, [`${work}/`])).toBe(work);
    expect(allowedIn(path.join(tmp, "workshop"), [work])).toBeNull();
    expect(allowedIn(path.join(work, "notes.txt"), [work])).toBeNull();
    expect(allowedIn(path.join(work, "gone"), [work])).toBeNull();
    expect(allowedIn("work", [work])).toBeNull();
    expect(allowedIn(path.join(work, "acme"), [path.join(tmp, "nowhere")])).toBeNull();
    expect(allowedIn("~", [os.homedir()])).toBe(realpathSync(os.homedir()));
  });
});

describe("the guard", () => {
  it("names the variable that says a harness session runs this, or null at a plain terminal", () => {
    expect(harnessSession({})).toBeNull();
    expect(harnessSession({ CLAUDECODE: "1" })).toBe("CLAUDECODE");
    expect(harnessSession({ CLAUDE_CODE_SESSION_ID: "x" })).toBe("CLAUDE_CODE_SESSION_ID");
    expect(harnessSession({ CODEX_SESSION_ID: "x" })).toBe("CODEX_SESSION_ID");
    expect(harnessSession({ SESSIONPIPE_CONTROL_JOB: "x" })).toBe("SESSIONPIPE_CONTROL_JOB");
  });
});
