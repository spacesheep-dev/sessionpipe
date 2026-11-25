// SPDX-License-Identifier: Apache-2.0
// `sessionpipe triggers …` and `sessionpipe trigger …` (CONTROL.md §14.1, src/triggers.ts): who may
// run what (the terminal and the typed yes for what widens, the harness guard for everything that
// changes a rule), what `add` checks and says before it asks, the level a rule really runs at on
// this computer and why, the history `list` shows, what `test` would run, and the JSON of
// config.proto's messages. The terminal, the background service, the receiver's well-known file
// and the sessions on this computer are stand-ins (TriggerDeps); the rules file and the daemon's
// record are real files under the test's own home.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { isStart, type TriggerRule } from "@sessionpipe/core";
import { beforeEach, describe, expect, it } from "vitest";
import { readRules, triggerStateFile, triggersFile, writeRules } from "../src/control/rules-file.js";
import { controlState, readControl, writeControl, writePrivate } from "../src/control/store.js";
import type { TriggerState } from "../src/control/triggers.js";
import { Refusal } from "../src/refusal.js";
import { makeUi, PLAIN, plain, type Ui } from "../src/style.js";
import {
  defaultTriggerDeps,
  hostOf,
  levelHere,
  levelMeans,
  lineArgv,
  printJson,
  readRecord,
  sessionFolder,
  sessionThere,
  shellWord,
  type TriggerDeps,
  triggerMain,
} from "../src/triggers.js";

const NOW = Date.parse("2026-11-24T09:30:00.000Z");
let home: string;
let work: string;
let lines: string[];
let printed: string[];
let asked: string[];
let typed: string;
let daemon: Record<string, unknown> | null;
let services: number;
/** The environment of a plain terminal: these tests may themselves run inside a coding session. */
let env: NodeJS.ProcessEnv;

const deps = (over: Partial<TriggerDeps> = {}): TriggerDeps => ({
  env,
  interactive: () => true,
  confirm: async (q) => {
    asked.push(q);
    return typed;
  },
  harnesses: () => ["claude-code", "codex"],
  local: async (req) => {
    if (!daemon) return null;
    if (req.op === "status") return { op: "status", status: daemon };
    if (req.op === "trigger") return { op: "ok" };
    return null;
  },
  wellKnown: async () => ({ control: { notices: true } }),
  sessionThere: (ref) => ref === "codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
  sessionFolder: (ref) => (ref === "codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b" ? work : null),
  installService: () => {
    services++;
    return "installed and started (launchd)";
  },
  now: () => NOW,
  zone: "UTC",
  ...over,
});
const run = (argv: string[], over: Partial<TriggerDeps> = {}, ui: Ui = PLAIN) =>
  triggerMain(argv, { ui, say: (l = "") => lines.push(l), print: (l) => printed.push(l) }, deps(over));
const text = () => lines.map(plain).join("\n");
const refusal = async (p: Promise<unknown>): Promise<Refusal> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof Refusal) return e;
    throw e;
  }
  throw new Error("not refused");
};

const clock: TriggerRule = {
  name: "monday-report",
  paused: false,
  source: { every: "mon 09:00" },
  target: { start: "codex" },
  folder: "~/work/acme",
  level: "safe",
  cap: { per_day: 1 },
  words: "Make last week's sales report.",
};
const card: TriggerRule = {
  name: "card-todo",
  paused: false,
  source: { receiver: "board.example", topic: "acme/tasks", event: "record.updated" },
  when: { state: ["todo"] },
  subject: "^X-[0-9]{1,6}$",
  target: { start: "claude-code" },
  folder: "~/work/acme",
  level: "edits",
  tools: ["mcp__board"],
  cap: { per_day: 5 },
  words: "Card {subject} is yours and in TODO.",
};
const ADD = [
  "trigger",
  "add",
  "card-todo",
  "--on",
  "https://Board.Example",
  "--topic",
  "acme/tasks",
  "--when",
  "state=todo",
  "--subject",
  "^X-[0-9]{1,6}$",
  "--start",
  "claude-code",
  "--folder",
  "~/work/acme",
  "--level",
  "edits",
  "--tools",
  "mcp__board",
  "--cap",
  "5/day",
  "--words",
  "Card {subject} is yours.",
];

beforeEach(() => {
  env = { ...process.env };
  for (const v of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "SESSIONPIPE_CONTROL_JOB"])
    delete env[v];
  rmSync(triggersFile(), { force: true });
  rmSync(triggerStateFile(), { force: true });
  home = os.homedir();
  work = path.join(home, "work", "acme");
  mkdirSync(work, { recursive: true });
  writeControl({
    name: "studio-mac",
    folders: [path.join(home, "work")],
    mode: "safe",
    receivers: [
      {
        url: "https://board.example",
        control: "https://board.example/api/sessionpipe/v1/control",
        rpId: "board.example",
        machine: "m_abc",
        token: "t",
        keys: [],
        paired_at: "2026-11-01T00:00:00.000Z",
      },
    ],
  });
  lines = [];
  printed = [];
  asked = [];
  typed = "yes";
  daemon = null;
  services = 0;
});

describe("trigger add", () => {
  it("shows the rule in plain words, the level it really runs at here and why, then writes it on yes", async () => {
    await run(ADD);
    const t = text();
    expect(t).toContain("Add this rule?");
    expect(t).toContain("card-todo: When board.example sends a notice on acme/tasks");
    expect(t).toContain(
      "On studio-mac it runs at safe: it asks for edits, and this computer's mode is safe, so it will run at safe.",
    );
    expect(t).toContain("Claude Code does only what the folder's own settings allow");
    expect(asked).toEqual(["  Type yes to add it, anything else to stop: "]);
    expect(t).toContain(
      "Added card-todo. Triggers are off, so it runs once you turn them on: `sessionpipe triggers on`.",
    );
    const r = readRules();
    expect(r.state === "ok" && r.file.rules[0]).toMatchObject({
      name: "card-todo",
      folder: "~/work/acme",
      level: "edits",
    });
  });
  it("anything but yes changes nothing", async () => {
    typed = "y";
    await run(ADD);
    expect(text()).toContain("Nothing changed.");
    expect(readRules()).toEqual({ state: "none" });
  });
  it("says what it writes when a level or a cap isn't given, and warns of a field the words need", async () => {
    await run([
      "trigger",
      "add",
      "card",
      "--on",
      "board.example",
      "--topic",
      "acme/tasks",
      "--start",
      "codex",
      "--folder",
      work,
      "--words",
      "Card {subject} moved to {state}.",
    ]);
    const t = text();
    expect(t).toContain("No --level, so it is written as safe.");
    expect(t).toContain("No --cap, so it is written as 5 runs a day at most.");
    expect(t).toContain("The words name {state}, and the rule doesn't require one");
    expect(t).toContain("Codex's safe is its workspace sandbox: it writes files in ~/work/acme, with no network.");
  });
  it("refuses with what to do: no terminal, inside a session, and every check a run would make", async () => {
    expect((await refusal(run(ADD, { interactive: () => false }))).message).toMatch(
      /needs this computer's own terminal/,
    );
    env.CLAUDECODE = "1";
    expect((await refusal(run(ADD))).message).toMatch(/inside a coding session \(CLAUDECODE is set\)/);
    delete env.CLAUDECODE;
    const with_ = (i: number, v: string) => ADD.map((a, j) => (j === i ? v : a));
    const folder = ADD.indexOf("--folder") + 1;
    expect((await refusal(run(with_(folder, "~/elsewhere")))).next).toBe("sessionpipe control folders add ~/elsewhere");
    expect((await refusal(run(with_(folder, "~")))).message).toMatch(/home folder/);
    // A link in an allowed folder that leads to sessionpipe's own config is caught by its real path.
    symlinkSync(path.dirname(triggersFile(env)), path.join(home, "work", "cfg-link"));
    const c = readControl() as NonNullable<ReturnType<typeof readControl>>;
    writeControl({ ...c, folders: [...c.folders, path.dirname(path.dirname(triggersFile(env)))] });
    expect((await refusal(run(with_(folder, "~/work/cfg-link")))).message).toMatch(
      /cfg-link: the folder is, holds or lies inside sessionpipe.s config folder/,
    );
    writeControl(c);
    expect((await refusal(run(with_(ADD.indexOf("--on") + 1, "tasks.example")))).next).toBe(
      "sessionpipe control pair tasks.example",
    );
    expect((await refusal(run(with_(ADD.indexOf("--on") + 1, "[::1]")))).message).toMatch(/isn't paired/);
    expect((await refusal(run(with_(ADD.indexOf("--start") + 1, "antigravity")))).message).toMatch(
      /Antigravity can't run headlessly on this computer; these can: claude-code, codex/,
    );
    expect((await refusal(run(with_(ADD.indexOf("--start") + 1, "grok-build")))).message).toMatch(
      /can't run grok-build yet/,
    );
    expect((await refusal(run(with_(2, "Card")))).message).toMatch(/can't be a rule's name/);
    expect((await refusal(run(with_(ADD.indexOf("--cap") + 1, "500/day")))).message).toMatch(/1 to 50/);
    expect((await refusal(run(with_(ADD.indexOf("--when") + 1, "who=me")))).message).toMatch(/--when is state=/);
    expect((await refusal(run(with_(ADD.indexOf("--level") + 1, "auto")))).message).toMatch(
      /can't be written: .*edits at most/,
    );
    const cont = with_(ADD.indexOf("--start"), "--continue").map((a, j) =>
      j === ADD.indexOf("--start") + 1 ? "codex:0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c" : a,
    );
    expect((await refusal(run(cont))).message).toMatch(/no Codex session codex:0199b6f2 on this computer/);
    await run(ADD);
    expect((await refusal(run(ADD))).message).toMatch(/there is a rule named card-todo already/);
  });
  it("needs one source, one target, a folder and words", async () => {
    const without = (...drop: string[]) =>
      ADD.filter((a, i) => !drop.includes(a) && !drop.includes(ADD[i - 1] as string));
    expect((await refusal(run(without("--on")))).message).toMatch(/one of the two/);
    expect((await refusal(run([...ADD, "--every", "2h"]))).message).toMatch(/one of the two/);
    expect((await refusal(run(without("--topic")))).message).toMatch(/--topic/);
    expect((await refusal(run(without("--start")))).message).toMatch(/starts a new session/);
    expect((await refusal(run(without("--folder")))).message).toMatch(/--folder/);
    expect((await refusal(run(without("--words")))).message).toMatch(/--words/);
    expect((await refusal(run(["trigger", "add"]))).message).toMatch(/takes the rule's name/);
    expect((await refusal(run([...ADD, "--bogus"]))).message).toMatch(/unknown option --bogus/);
    expect((await refusal(run([...ADD, "--words"]))).message).toMatch(/--words needs a value/);
    const clockAdd = [
      "trigger",
      "add",
      "x",
      "--every",
      "2h",
      "--topic",
      "a",
      "--start",
      "codex",
      "--folder",
      work,
      "--words",
      "w",
    ];
    expect((await refusal(run(clockAdd))).message).toMatch(/a clock rule has no notice to filter/);
  });
  it("two pairings with one name are refused; a receiver that sends no notices, or can't be read, is said", async () => {
    const c = readControl() as NonNullable<ReturnType<typeof readControl>>;
    writeControl({
      ...c,
      receivers: [...c.receivers, { ...(c.receivers[0] as (typeof c.receivers)[number]), machine: "m_2" }],
    });
    expect((await refusal(run(ADD))).message).toMatch(/names 2 pairings/);
    writeControl(c);
    await run(ADD, { wellKnown: async () => ({}) });
    expect(text()).toContain("board.example doesn't say it sends notices");
    lines = [];
    await run(
      ADD.map((a) => (a === "card-todo" ? "card-two" : a)),
      {
        wellKnown: async () => {
          throw new Error("HTTP 404");
        },
      },
    );
    // Never the other side's own words: ours.
    expect(text()).toContain(
      "board.example's well-known file couldn't be read now, so whether it sends notices isn't known.",
    );
    expect(text()).not.toContain("HTTP 404");
  });
  it("an auto machine runs it as asked; a continued session says it may run narrower; triggers on says it reads it", async () => {
    const c = readControl() as NonNullable<ReturnType<typeof readControl>>;
    writeControl({ ...c, mode: "auto" });
    writeRules({ v: 1, on: true, rules: [] });
    daemon = { start: { "claude-code": { permissions: ["read", "safe", "edits", "auto"] } } };
    await run(ADD);
    expect(text()).toContain("On studio-mac it runs at edits.");
    expect(text()).toContain("Added card-todo. The background service reads it within seconds.");
    lines = [];
    await run([
      "trigger",
      "add",
      "again",
      "--every",
      "day 08:30",
      "--continue",
      "codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
      "--folder",
      work,
      "--level",
      "auto",
      "--words",
      "Go on.",
    ]);
    expect(text()).toContain("If that session was started at a narrower level, it runs at that one.");
  });
});

describe("the switch, and the narrowing commands", () => {
  it("triggers on: at the terminal, with yes, showing every rule; installs the service when none runs", async () => {
    writeRules({ v: 1, on: false, rules: [clock] });
    await run(["triggers", "on"]);
    expect(text()).toContain("Turn triggers on? Then these rules run on studio-mac by themselves:");
    expect(text()).toContain("monday-report: Every Monday at 09:00");
    expect(text()).toContain("Background service: installed and started (launchd)");
    expect(services).toBe(1);
    expect(readRules()).toMatchObject({ state: "ok", file: { on: true } });
    lines = [];
    await run(["triggers", "on"]);
    expect(text()).toContain("Triggers are on already.");
    lines = [];
    daemon = {};
    await run(["triggers", "on"]);
    expect(text()).toContain("Background service: running");
  });
  it("triggers on with no control file writes one that leaves asking off, and --no-service installs nothing", async () => {
    writeFileSync(path.join(path.dirname(triggersFile()), "control.json"), "");
    await run(["triggers", "on", "--no-service"]);
    expect(readControl()).toMatchObject({ folders: [], mode: "safe", receivers: [], ask: false });
    expect(text()).toContain("There are no rules yet");
    expect(text()).toContain("not installed (--no-service)");
    expect(services).toBe(0);
  });
  it("triggers off, pause and remove need no terminal, and refuse inside a session", async () => {
    writeRules({ v: 1, on: true, rules: [clock, card] });
    await run(["triggers", "off"], { interactive: () => false });
    expect(text()).toContain("Triggers are off: no rule runs");
    await run(["triggers", "off"]);
    expect(text()).toContain("Triggers are off already.");
    await run(["trigger", "pause", "card-todo"], { interactive: () => false });
    expect(text()).toContain("Paused card-todo");
    await run(["trigger", "pause", "card-todo"]);
    expect(text()).toContain("card-todo is paused already.");
    await run(["trigger", "remove", "monday-report"], { interactive: () => false });
    expect(readRules()).toMatchObject({ state: "ok", file: { rules: [{ name: "card-todo", paused: true }] } });
    env.CODEX_SESSION_ID = "x";
    expect((await refusal(run(["trigger", "remove", "card-todo"]))).message).toMatch(/CODEX_SESSION_ID is set/);
    expect((await refusal(run(["triggers", "off"]))).message).toMatch(/inside a coding session/);
    delete env.CODEX_SESSION_ID;
    expect((await refusal(run(["trigger", "pause", "nope"]))).next).toBe("sessionpipe trigger list");
    expect((await refusal(run(["trigger", "pause"]))).message).toMatch(/which rule/);
  });
  it("with no rules file, triggers off is off already; a broken one is never written over", async () => {
    await run(["triggers", "off"]);
    expect(text()).toContain("Triggers are off already.");
    writeFileSync(triggersFile(), "{");
    lines = [];
    await run(["triggers", "off"]);
    expect(text()).toContain("the rules file can't be read");
    expect((await refusal(run(["triggers", "on"]))).message).toMatch(/the rules file can't be read \(\$: not JSON\)/);
    expect(readFileSync(triggersFile(), "utf8")).toBe("{");
  });
  it("resume: the person's own pause, at the terminal with yes; the machine's pause, let go of by the service or here", async () => {
    writeRules({ v: 1, on: true, rules: [{ ...clock, paused: true }] });
    await run(["trigger", "resume", "monday-report"]);
    expect(text()).toContain("Resume this rule?");
    expect(readRules()).toMatchObject({ file: { rules: [{ paused: false }] } });
    lines = [];
    await run(["trigger", "resume", "monday-report"]);
    expect(text()).toContain("monday-report isn't paused.");
    const cont = { ...clock, name: "nightly", target: { continue: "codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b" } };
    writeRules({ v: 1, on: false, rules: [cont] });
    const rec: TriggerState = {
      v: 1,
      rules: { nightly: { history: [], paused: { at: "2026-11-24T08:00:00.000Z", code: "no_session", rule: "" } } },
      waiting: [],
    };
    writePrivate(triggerStateFile(), rec);
    lines = [];
    await run(["trigger", "list"]);
    expect(text()).toContain("paused by this computer: the session it continues is gone");
    // No service running: the pause is taken out of its record here.
    await run(["trigger", "resume", "nightly"]);
    expect(readRecord(env).rules.nightly?.paused).toBeUndefined();
    expect(text()).toContain("Resumed nightly. Triggers are off");
    writePrivate(triggerStateFile(), rec);
    daemon = {};
    await run(["trigger", "resume", "nightly"]);
    expect(readRecord(env).rules.nightly?.paused).toBeDefined();
    expect((await refusal(run(["trigger", "resume", "nightly"], { sessionThere: () => false }))).next).toBe(
      "sessionpipe trigger remove nightly",
    );
    expect((await refusal(run(["trigger", "resume", "nightly"], { interactive: () => false }))).message).toMatch(
      /terminal/,
    );
  });
});

describe("trigger list and triggers status", () => {
  const history = (): TriggerState => ({
    v: 1,
    rules: {
      "card-todo": {
        history: [
          {
            at: "2026-11-24T09:14:00.000Z",
            result: "ran",
            subject: "X-003",
            state: "todo",
            session: "claude-code:58ab6602-0000-4000-8000-000000000000",
            ms: 660_000,
          },
          {
            at: "2026-11-24T09:20:00.000Z",
            result: "ran",
            subject: "X-004",
            session: "claude-code:7c1d0000-0000-4000-8000-000000000000",
          },
          { at: "2026-11-24T08:02:00.000Z", result: "refused", code: "cooldown", subject: "X-001", state: "todo" },
          { at: "2026-11-24T07:00:00.000Z", result: "refused", code: "cap" },
          { at: "2026-11-23T19:00:00.000Z", result: "failed", subject: "X-000" },
        ],
        today: { day: "2026-11-24", runs: 2, keys: [] },
      },
      "monday-report": { history: [{ at: "2026-11-23T15:00:00.000Z", result: "missed" }] },
    },
    waiting: [],
  });
  it("each rule in a line with the level here, its runs today and its latest history", async () => {
    writeRules({ v: 1, on: true, rules: [card, { ...clock, paused: true }] });
    writePrivate(triggerStateFile(), history());
    await run(["trigger", "list"]);
    const t = text();
    expect(t).toContain("✓ Triggers are on · 2 rules, 1 paused");
    expect(t).toContain(
      "✓ card-todo  board.example acme/tasks record.updated state=todo subject ^X-[0-9]{1,6}$ → claude-code safe (asks edits) · 2/5 today",
    );
    expect(t).toContain("09:14  X-003 → claude-code:58ab6602 · 11 min");
    expect(t).toContain("09:20  X-004 → claude-code:7c1d0000 · running");
    expect(t).toContain("08:02  X-001 refused: ran for X-001/todo today");
    expect(t).toContain("07:00  refused: it ran its 5 times today");
    expect(t).toContain("Nov 23 19:00  X-000 couldn't start");
    expect(t).toContain("· monday-report  every mon 09:00 → codex safe · 0/1 today · paused");
    expect(t).toContain("missed: this computer was asleep or off until six hours after its time");
    expect(t).toContain("A rule shown in yellow asks for a wider level than it runs at here.");
  });
  it("off, no rules, and a broken file each say what to do", async () => {
    await run(["trigger", "list"]);
    expect(text()).toContain("Triggers are off · 0 rules · `sessionpipe triggers on` turns them on");
    expect(text()).toContain("No rules yet.");
    writeFileSync(triggersFile(), "{");
    lines = [];
    await run(["trigger"]);
    expect(text()).toContain("✗ Triggers are off: the rules file can't be read ($: not JSON)");
  });
  it("--json is config.proto's TriggerList, checked before it is printed", async () => {
    writeRules({ v: 1, on: true, rules: [card] });
    writePrivate(triggerStateFile(), history());
    await run(["trigger", "list", "--json"]);
    const j = JSON.parse(printed.join("\n"));
    expect(j.on).toBe(true);
    expect(j.rules[0]).toMatchObject({ rule: { name: "card-todo" }, today: 2 });
    expect(j.rules[0].recent).toHaveLength(5);
    printed = [];
    await run(["triggers", "status", "--json"]);
    expect(JSON.parse(printed.join("\n")).rules).toHaveLength(1);
  });
  it("status: the switch, the service, the level a rule runs at here", async () => {
    writeRules({ v: 1, on: true, rules: [card] });
    await run(["triggers", "status"]);
    expect(text()).toContain("background service: not running, so no rule runs: `sessionpipe triggers on` installs it");
    expect(text()).toContain("this computer's mode: safe, so a rule runs at safe at most here");
    lines = [];
    daemon = { triggers: { waiting: 1, running: 1 } };
    await run(["triggers"]);
    expect(text()).toContain("background service: running · 1 run now · 1 waiting");
    lines = [];
    daemon = {};
    await run(["triggers", "status"]);
    expect(text()).toContain("running a sessionpipe from before triggers");
    writeRules({ v: 1, on: false, rules: [card] });
    lines = [];
    daemon = null;
    await run(["triggers", "status"]);
    expect(text()).toContain("background service: not running\n");
    const c = readControl() as NonNullable<ReturnType<typeof readControl>>;
    writeControl({ ...c, mode: "auto" });
    lines = [];
    await run(["triggers", "status"]);
    expect(text()).toContain("this computer's mode: auto, so a rule runs at auto at most here\n");
  });
  it("unknown subcommands are refused with the help to read", async () => {
    expect((await refusal(run(["triggers", "maybe"]))).next).toBe("sessionpipe triggers --help");
    expect((await refusal(run(["trigger", "maybe"]))).next).toBe("sessionpipe trigger --help");
  });
});

describe("trigger test", () => {
  beforeEach(() => writeRules({ v: 1, on: true, rules: [card, clock] }));
  it("a matching sample: what would run, at which level, with the framed words, and nothing ran", async () => {
    await run(["trigger", "test", "card-todo", "--subject", "X-001", "--state", "todo"]);
    const t = text();
    expect(t).toContain("card-todo takes it. Nothing ran: this is what would run.");
    expect(t).toContain(
      "start claude-code in ~/work/acme at safe (it asks for edits; this computer's mode is safe), with mcp__board allowed without asking",
    );
    expect(t).toContain("│ Card `X-001` is yours and in TODO.");
    expect(readRecord(env).rules).toEqual({});
  });
  it("a sample that doesn't fit says which part", async () => {
    await run(["trigger", "test", "card-todo", "--subject", "X-001", "--state", "review"]);
    expect(text()).toContain(
      "card-todo doesn't take it: its state is review, and the rule takes todo. Nothing would run.",
    );
    lines = [];
    await run(["trigger", "test", "card-todo", "--subject", "Y-1", "--state", "todo"]);
    expect(text()).toContain("its subject Y-1 doesn't match ^X-[0-9]{1,6}$");
    lines = [];
    await run(["trigger", "test", "card-todo", "--subject", "X-1"]);
    expect(text()).toContain("it has no state, and the rule takes only some");
  });
  it("a clock rule needs no sample; what would refuse it now is said", async () => {
    writePrivate(triggerStateFile(), {
      v: 1,
      rules: { "monday-report": { history: [], today: { day: "2026-11-24", runs: 1, keys: [] } } },
      waiting: [],
    });
    await run(["trigger", "test", "monday-report"]);
    expect(text()).toContain("monday-report takes it.");
    expect(text()).toContain("Right now it would be refused: it ran its 1 time today.");
  });
  it("--json is config.proto's TriggerTestAnswer", async () => {
    await run([
      "trigger",
      "test",
      "card-todo",
      "--subject",
      "X-001",
      "--state",
      "todo",
      "--for",
      "sam",
      "--by",
      "dana",
      "--json",
    ]);
    const j = JSON.parse(printed.join("\n"));
    expect(j).toMatchObject({ rule: "card-todo", matches: true, run: { level: "safe" } });
  });
  it("a notice rule needs a sample, and a sample a receiver could send", async () => {
    expect((await refusal(run(["trigger", "test", "card-todo"]))).next).toBe(
      "sessionpipe trigger test card-todo --subject X-001",
    );
    expect((await refusal(run(["trigger", "test", "card-todo", "--subject", "X 1"]))).message).toMatch(
      /no receiver could send/,
    );
  });
});

describe("the level, in words", () => {
  it("says why a level is narrower, and what a level means for each agent", () => {
    expect(levelHere(card, "auto", {})).toEqual({ level: "edits", why: null });
    expect(levelHere({ ...card, target: { start: "codex" } }, "auto", { codex: ["read", "safe", "auto"] })).toEqual({
      level: "safe",
      why: "Codex has no edits level here",
    });
    expect(levelHere({ ...card, level: "auto" }, "auto", {})).toEqual({
      level: "edits",
      why: "a rule a notice runs is edits at most",
    });
    expect(
      levelHere({ ...clock, level: "read", target: { start: "antigravity" } }, "auto", { antigravity: ["safe"] }).level,
    ).toBeNull();
    expect(levelMeans("codex", "read", "~/w")).toMatch(/read-only sandbox/);
    expect(levelMeans("codex", "auto", "~/w")).toMatch(/automatic review/);
    expect(levelMeans("claude-code", "read", "~/w")).toMatch(/changes nothing/);
    expect(levelMeans("claude-code", "auto", "~/w")).toMatch(/auto mode/);
    expect(levelMeans("antigravity", "edits", "~/w")).toBe("Antigravity runs at its own edits level.");
  });
  it("in colour, a narrowed level and every hidden character stand out", async () => {
    writeRules({ v: 1, on: true, rules: [{ ...card, words: "Card {subject}\tnow.\nThen REVIEW." }] });
    await run(
      ["trigger", "test", "card-todo", "--subject", "X-001", "--state", "todo"],
      {},
      makeUi({ isTTY: true, columns: 100, env: {} }),
    );
    expect(lines.join("\n")).toContain("\x1b[33m\\t\x1b[39m");
  });
  it("a session is found by the service's own names, Claude Code's transcripts and Codex's rollouts", () => {
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CODEX_HOME: path.join(home, ".codex"),
    };
    expect(sessionThere("nope", env)).toBe(false);
    expect(sessionThere("claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e", env)).toBe(false);
    expect(sessionThere("codex:0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c", env)).toBe(false);
    expect(sessionThere("antigravity:x", env)).toBe(false);
    // Found, its folder is the one its transcript or rollout records, or none when it records none.
    const claude = path.join(home, ".claude", "projects", "-w");
    mkdirSync(claude, { recursive: true });
    const sid = (n: number) => `8c132906-8c3f-4814-870a-afc3d05e1d2${n}`;
    writeFileSync(path.join(claude, `${sid(1)}.jsonl`), `${JSON.stringify({ type: "user", cwd: work })}\n`);
    writeFileSync(path.join(claude, `${sid(2)}.jsonl`), `${JSON.stringify({ type: "user" })}\n`);
    expect(sessionFolder(`claude-code:${sid(1)}`, env)).toBe(work);
    expect(sessionFolder(`claude-code:${sid(2)}`, env)).toBeNull();
    const day = path.join(home, ".codex", "sessions", "2026", "10", "28");
    mkdirSync(day, { recursive: true });
    const tid = (n: number) => `0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0${n}`;
    for (const [n, payload] of [
      [1, { id: tid(1), cwd: work }],
      [2, { id: tid(2) }],
    ] as const)
      writeFileSync(
        path.join(day, `rollout-2026-10-28T10-00-00-${tid(n)}.jsonl`),
        `${JSON.stringify({ type: "session_meta", payload })}\n`,
      );
    expect(sessionFolder(`codex:${tid(1)}`, env)).toBe(work);
    expect(sessionFolder(`codex:${tid(2)}`, env)).toBeNull();
    expect(sessionFolder("antigravity:x", env)).toBeNull();
    expect(sessionFolder("nope", env)).toBeNull();
  });
});

describe("corners", () => {
  const withHistory = (rule: TriggerRule, history: TriggerState["rules"][string]["history"]) => {
    writeRules({ v: 1, on: true, rules: [rule] });
    writePrivate(triggerStateFile(), { v: 1, rules: { [rule.name]: { history } }, waiting: [] });
  };
  it("the defaults reach this computer: no service answers, nothing is installed by asking", async () => {
    const d = defaultTriggerDeps("dist", env);
    expect(typeof d.interactive()).toBe("boolean");
    expect(Array.isArray(d.harnesses())).toBe(true);
    expect(await d.local({ op: "status" }, 200)).toBeNull();
    await expect(d.wellKnown("http://127.0.0.1:9")).rejects.toThrow();
    expect(d.sessionThere("codex:x")).toBe(false);
    expect(d.sessionFolder("codex:x")).toBeNull();
    expect(typeof d.now()).toBe("number");
    expect(d.confirm).toBeTypeOf("function");
  });
  it("a session the service started is found by its name; a receiver's name is its host", () => {
    mkdirSync(controlState(env), { recursive: true });
    writeFileSync(
      path.join(controlState(env), "aliases.json"),
      JSON.stringify({
        "codex:abc": { id: "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c", cwd: work, at: "2026-11-24T00:00:00.000Z" },
      }),
    );
    expect(sessionThere("codex:abc", env)).toBe(true);
    expect(hostOf("https://Board.Example:443/x")).toBe("board.example");
    expect(hostOf("localhost:8891")).toBe("localhost:8891");
    expect(hostOf("http://[::1]:80")).toBeNull();
    expect(hostOf("http://[bad")).toBeNull();
    expect(levelMeans("droid", "safe", "~/w")).toBe("droid runs at its own safe level.");
  });
  it("every refusal a history line can carry, in words; how long a run took", async () => {
    const at = "2026-11-24T09:00:00.000Z";
    withHistory({ ...card, source: { receiver: "board.example", topic: "acme/tasks" } }, [
      ...(["folder", "harness", "no_session", "held", "start_limit", "triggers_off", "bad_notice"] as const).map(
        (code) => ({
          at,
          result: "refused" as const,
          code,
        }),
      ),
      { at, result: "refused", code: "cooldown", subject: "X-9" },
      { at, result: "ran", ms: 30_000 },
      { at, result: "ran", ms: 3 * 3600_000 },
    ]);
    await run(["trigger", "list"]);
    // A list shows each rule's latest five; the rest are the JSON's.
    const all = readRecord(env).rules["card-todo"]?.history ?? [];
    writePrivate(triggerStateFile(), { v: 1, rules: { "card-todo": { history: all.slice(5) } }, waiting: [] });
    await run(["trigger", "list"]);
    const t = text();
    for (const w of [
      "the background service doesn't allow its folder now",
      "Claude Code can't run headlessly here now",
      "the session it continues is gone",
      "a window held the session",
      "caps on new sessions stayed reached",
      "triggers were off",
      "a broken notice",
      "X-9 refused: ran for X-9/no state today",
      "→ a new session · 30 s",
      "→ a new session · 3 h",
      "board.example acme/tasks state=todo",
    ])
      expect(t).toContain(w);
  });
  it("a rule with nothing yet, a harness with no level so narrow, two running", async () => {
    writeRules({ v: 1, on: true, rules: [{ ...clock, target: { start: "antigravity" }, level: "read" }] });
    daemon = { start: { antigravity: { permissions: ["safe"] } }, triggers: { waiting: 0, running: 2 } };
    await run(["trigger", "list"]);
    expect(text()).toContain("no level Antigravity takes here");
    expect(text()).toContain("nothing yet");
    await run(["triggers", "status"]);
    expect(text()).toContain("2 runs now");
    await run(["trigger", "test", "monday-report"]);
    expect(text()).toContain(
      "monday-report takes it, and it would be refused: Antigravity takes no level as narrow as read",
    );
    writeRules({
      v: 1,
      on: false,
      rules: [{ ...clock, target: { start: "antigravity" }, level: "read", paused: true }],
    });
    expect((await refusal(run(["trigger", "resume", "monday-report"]))).message).toMatch(
      /takes no level as narrow as read/,
    );
  });
  it("a broken rules file refuses every change, and with no file the JSON is an empty list", async () => {
    await run(["trigger", "list", "--json"]);
    expect(JSON.parse(printed.join("\n"))).toEqual({ on: false, rules: [] });
    writeRules({ v: 1, on: false, rules: [clock] });
    printed = [];
    await run(["trigger", "list", "--json"]);
    expect(JSON.parse(printed.join("\n")).rules[0]).toMatchObject({ today: 0, recent: [] });
    // With no control file there is no allowlist: a test says the folder would refuse it.
    rmSync(path.join(path.dirname(triggersFile()), "control.json"));
    writeRules({ v: 1, on: true, rules: [(({ when: _w, ...rest }) => rest)(card), { ...clock, paused: true }] });
    await run(["trigger", "test", "card-todo", "--subject", "X-1"]);
    expect(text()).toContain("the background service doesn't allow its folder now");
    await run(["trigger", "resume", "monday-report"]);
    expect(readRules()).toMatchObject({ file: { rules: [{ name: "card-todo" }, { paused: false }] } });
    writeFileSync(triggersFile(), "{");
    expect((await refusal(run(["trigger", "pause", "x"]))).message).toMatch(/can't be read/);
  });
  it("add on a computer never paired, with nothing it can run, with an event, and a session that can't be named", async () => {
    rmSync(path.join(path.dirname(triggersFile()), "control.json"));
    expect((await refusal(run(ADD))).message).toMatch(/isn't paired with board.example/);
    const clockAdd = ["trigger", "add", "x", "--every", "2h", "--start", "codex", "--folder", work, "--words", "w"];
    expect((await refusal(run(clockAdd))).next).toBe("sessionpipe control folders add ~/work/acme");
    writeControl({ name: "build-box", folders: [path.join(home, "work")], mode: "safe", receivers: [] });
    expect((await refusal(run(clockAdd, { harnesses: () => [] }))).message).toMatch(
      /can't run headlessly on this computer$/,
    );
    const odd = clockAdd.map((a) => (a === "--start" ? "--continue" : a === "codex" ? "codex:no such id" : a));
    expect((await refusal(run(odd))).message).toMatch(/there is no Codex session/);
    const c = readControl() as NonNullable<ReturnType<typeof readControl>>;
    writeControl({
      ...c,
      receivers: [
        { url: "https://board.example", control: "x", rpId: "x", machine: "m", token: "t", keys: [], paired_at: "x" },
      ],
    });
    await run([...ADD.slice(0, 7), "--event", "record.updated", ...ADD.slice(7)]);
    expect(readRules()).toMatchObject({ file: { rules: [{ source: { event: "record.updated" } }] } });
  });
  it("triggers on and resume take no for an answer; resume names this computer when it was never named", async () => {
    typed = "no";
    writeRules({ v: 1, on: false, rules: [{ ...clock, paused: true }] });
    await run(["triggers", "on"]);
    await run(["trigger", "resume", "monday-report"]);
    expect(lines.filter((l) => plain(l).includes("Nothing changed."))).toHaveLength(2);
    expect(readRules()).toMatchObject({ file: { on: false, rules: [{ paused: true }] } });
    typed = "yes";
    rmSync(path.join(path.dirname(triggersFile()), "control.json"));
    lines = [];
    await run(["trigger", "resume", "monday-report"]);
    expect(text()).toContain("Resumed monday-report.");
  });
  it("test: every check that would refuse it now, a continued session, and the fields a sample may name", async () => {
    const cont = {
      ...card,
      name: "cont",
      target: { continue: "codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b" },
      words: "By {by}, for {for}.",
    };
    writeRules({ v: 1, on: false, rules: [cont, { ...card, folder: "~/elsewhere" }] });
    await run(["trigger", "test", "cont", "--subject", "X-1", "--state", "todo", "--for", "sam", "--by", "dana"]);
    expect(text()).toContain("continue codex:019a2b3c");
    expect(text()).toContain("Right now it would be refused: triggers were off.");
    writeRules({ v: 1, on: true, rules: [cont, { ...card, folder: "~/elsewhere" }] });
    writePrivate(triggerStateFile(), {
      v: 1,
      rules: { cont: { history: [], today: { day: "2026-11-24", runs: 1, keys: ["X-1/todo"] } } },
      waiting: [],
    });
    lines = [];
    await run(["trigger", "test", "cont", "--subject", "X-1", "--state", "todo", "--for", "sam", "--by", "dana"]);
    expect(text()).toContain("Right now it would be refused: ran for X-1/todo today.");
    lines = [];
    await run(["trigger", "test", "card-todo", "--subject", "X-1", "--state", "todo"]);
    expect(text()).toContain("the background service doesn't allow its folder now");
    lines = [];
    await run(["trigger", "test", "cont", "--subject", "X-2", "--state", "todo", "--for", "sam", "--by", "dana"], {
      harnesses: () => [],
    });
    expect(text()).toContain("Codex can't run headlessly here now");
    const misses = async (rule: TriggerRule, ...more: string[]) => {
      writeRules({ v: 1, on: true, rules: [rule] });
      lines = [];
      await run(["trigger", "test", rule.name, "--subject", "X-1", "--state", "todo", ...more]);
      return text();
    };
    expect(await misses({ ...card, when: { for: ["sam"] } }, "--for", "dana")).toContain(
      "it is for dana, and the rule takes sam",
    );
    expect(await misses({ ...card, when: { for: ["sam"] } })).toContain("it is for nobody");
    expect(await misses({ ...card, when: { by: ["sam"] } }, "--by", "dana")).toContain(
      "dana made the change, and the rule takes sam",
    );
    expect(await misses({ ...card, when: { by: ["sam"] } })).toContain("it names nobody who made the change");
    expect(await misses({ ...card, words: "By {by}." })).toContain("the words name a field the notice doesn't carry");
  });

  it("a pause for a recorded level this computer doesn't know says resume won't clear it", async () => {
    const cont = { ...clock, name: "nightly", target: { continue: "codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b" } };
    writeRules({ v: 1, on: true, rules: [cont] });
    writePrivate(triggerStateFile(), {
      v: 1,
      rules: {
        nightly: {
          history: [],
          paused: { at: "2026-11-24T08:00:00.000Z", code: "no_session", rule: "", why: "unknown_level" },
        },
      },
      waiting: [],
    });
    await run(["trigger", "list"]);
    expect(text()).toContain("was started at a level this computer doesn't know. `trigger resume` won't clear that");
    expect((await refusal(run(["trigger", "resume", "nightly"]))).next).toBe("sessionpipe trigger remove nightly");
    await run(["trigger", "list", "--json"]);
    expect(JSON.parse(printed.join("\n")).rules[0].machine_paused).toBe("unknown_level");
  });

  it("a busy refusal in words; a pause recorded before it had a reason reads as gone; a rule cut to a terminal's width", async () => {
    writeRules({ v: 1, on: true, rules: [clock] });
    writePrivate(triggerStateFile(), {
      v: 1,
      rules: {
        "monday-report": {
          history: [{ at: "2026-11-24T09:00:00.000Z", result: "refused", code: "busy" }],
          paused: { at: "2026-11-24T08:00:00.000Z", code: "no_session", rule: "" },
        },
      },
      waiting: [],
    });
    await run(["trigger", "list"]);
    expect(text()).toContain("its own earlier run was still going for as long as this one could wait");
    await run(["trigger", "list", "--json"]);
    expect(JSON.parse(printed.join("\n")).rules[0].machine_paused).toBe("gone");
    writeRules({ v: 1, on: false, rules: [clock] });
    lines = [];
    await run(["triggers", "on"], {}, makeUi({ isTTY: true, columns: 60, env: {} }));
    for (const l of lines) expect(plain(l).length).toBeLessThanOrEqual(60);
    expect(lines.some((l) => plain(l).includes("words  │ Make last week's sales report."))).toBe(true);
  });
});

describe("what the review found", () => {
  const CONT = "codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
  const nightly = ["trigger", "add", "nightly", "--every", "day 03:00", "--continue", CONT, "--words", "Go on."];
  /** While the question waits, another terminal changes the rules file. */
  const meanwhile = (change: () => void): Partial<TriggerDeps> => ({
    confirm: async (q) => {
      asked.push(q);
      change();
      return "yes";
    },
  });

  it("a continue rule's folder is its session's: shown, written, and another --folder refused", async () => {
    await run(nightly);
    expect(text()).toContain("folder │ ~/work/acme");
    expect(readRules()).toMatchObject({ file: { rules: [{ name: "nightly", folder: "~/work/acme" }] } });
    rmSync(triggersFile());
    lines = [];
    await run([...nightly, "--folder", "~/work/acme"]);
    expect(readRules()).toMatchObject({ file: { rules: [{ folder: "~/work/acme" }] } });
    rmSync(triggersFile());
    const r = await refusal(run([...nightly, "--folder", "~/work"]));
    expect(r.message).toBe(
      "that session runs in ~/work/acme, and a rule that continues a session runs in the session's own folder: leave --folder out, or name ~/work/acme",
    );
    expect(readRules()).toEqual({ state: "none" });
    const gone = await refusal(run(nightly, { sessionFolder: () => null }));
    expect(gone.message).toBe(
      "there is no Codex session codex:019a2b3c on this computer: a rule continues a session that is here",
    );
  });

  it("a change made while the question waits is never written over: add, resume and triggers on", async () => {
    const said = "The rules changed while you were reading. Nothing was written. Run the command again.";
    // add, while another terminal turns triggers off: off stays off, and nothing is added.
    writeRules({ v: 1, on: true, rules: [clock] });
    await run(
      ["trigger", "add", "x", "--every", "day 03:00", "--start", "codex", "--folder", "~/work/acme", "--words", "go"],
      meanwhile(() => writeRules({ v: 1, on: false, rules: [clock] })),
    );
    expect(text()).toContain(said);
    expect(readRules()).toMatchObject({ file: { on: false, rules: [{ name: "monday-report" }] } });
    // resume, while another terminal removes the rule.
    writeRules({ v: 1, on: true, rules: [{ ...clock, paused: true }] });
    lines = [];
    await run(
      ["trigger", "resume", "monday-report"],
      meanwhile(() => writeRules({ v: 1, on: true, rules: [] })),
    );
    expect(text()).toContain(said);
    expect(readRules()).toMatchObject({ file: { rules: [] } });
    // triggers on, while another terminal adds a rule nobody here was shown.
    writeRules({ v: 1, on: false, rules: [clock] });
    lines = [];
    await run(
      ["triggers", "on"],
      meanwhile(() => writeRules({ v: 1, on: false, rules: [clock, { ...clock, name: "unseen" }] })),
    );
    expect(text()).toContain(said);
    expect(readRules()).toMatchObject({ file: { on: false } });
    expect(services).toBe(0);
  });

  it("triggers on, already on, still needs the terminal before it installs anything", async () => {
    writeRules({ v: 1, on: true, rules: [clock] });
    const r = await refusal(run(["triggers", "on"], { interactive: () => false }));
    expect(r.message).toMatch(/^Turning triggers on needs this computer's own terminal/);
    expect(services).toBe(0);
  });

  it("nothing from a receiver or a hand-edited record is printed raw; a reason it doesn't know is said", async () => {
    await run(
      ["trigger", "add", "card", "--on", "board.example", "--topic", "acme/tasks", "--start", "codex"].concat([
        "--folder",
        "~/work/acme",
        "--words",
        "go",
      ]),
      { wellKnown: async () => JSON.parse("\u001b[9A\u001b[Jok") },
    );
    expect(lines.some((l) => l.includes("\u001b"))).toBe(false);
    expect(text()).toContain("board.example's well-known file couldn't be read now");
    writeRules({ v: 1, on: true, rules: [clock] });
    writePrivate(triggerStateFile(), {
      v: 1,
      rules: {
        "monday-report": {
          history: [
            { at: "2026-11-24T09:00:00.000Z", result: "ran", subject: "X-1", session: "codex:\u001b]0;x\u0007abc" },
            { at: "2026-11-24T09:01:00.000Z", result: "refused", code: "nope" },
          ],
        },
      },
      waiting: [],
    });
    lines = [];
    await run(["trigger", "list"]);
    expect(lines.some((l) => l.includes("\u001b") || l.includes("\u0007"))).toBe(false);
    expect(text()).toContain("refused: a reason this version doesn't know (nope)");
    // A line whose session is not a session's name was never read in; the JSON leaves the unknown
    // reason's line out rather than print what doesn't fit its definition.
    await run(["trigger", "list", "--json"]);
    expect(JSON.parse(printed.join("\n")).rules[0].recent).toEqual([]);
  });

  it("a problem says a hidden character once, and a hand-edited file's bytes never reach the terminal", async () => {
    const r = await refusal(
      run(
        ["trigger", "add", "x", "--every", "day 03:00", "--start", "codex", "--folder", "~/work/acme"].concat([
          "--words",
          "Write the\u00a0notes.",
        ]),
      ),
    );
    expect(r.message).toContain("(shown as \\u{a0})");
    expect(r.message).not.toContain("\\\\u");
    writeFileSync(triggersFile(), JSON.stringify({ v: 1, on: true, rules: [{ ...clock, name: "\u001b[2Jx\u202e" }] }));
    lines = [];
    await run(["trigger", "list"]);
    expect(lines.some((l) => l.includes("\u001b") || l.includes("\u202e"))).toBe(false);
    expect(text()).toContain("the rules file can't be read");
  });
  it("--json after a missed tick is the definition's, list and status alike", async () => {
    writeRules({ v: 1, on: true, rules: [clock] });
    writePrivate(triggerStateFile(), {
      v: 1,
      rules: { "monday-report": { history: [{ at: "2026-11-24T09:00:00.000Z", result: "missed" }] } },
      waiting: [],
    });
    await run(["trigger", "list", "--json"]);
    expect(JSON.parse(printed.join("\n")).rules[0].recent).toEqual([
      { at: "2026-11-24T09:00:00.000Z", result: "missed" },
    ]);
    printed = [];
    await run(["triggers", "status", "--json"]);
    expect(JSON.parse(printed.join("\n")).rules[0].recent).toHaveLength(1);
    expect(() =>
      printJson({ ui: PLAIN, say: () => {}, print: () => {} }, "trigger-list", { on: "yes" } as never),
    ).toThrow(/^the JSON would not fit its definition: /);
  });

  it("a rule named constructor is added, listed and shown like any other", async () => {
    await run([
      "trigger",
      "add",
      "constructor",
      "--every",
      "day 03:00",
      "--start",
      "codex",
      "--folder",
      "~/work/acme",
      "--words",
      "go",
    ]);
    expect(readRules()).toMatchObject({ file: { rules: [{ name: "constructor" }] } });
    writePrivate(triggerStateFile(), {
      v: 1,
      rules: {
        constructor: {
          history: [{ at: "2026-11-24T09:00:00.000Z", result: "missed" }],
          today: { day: "2026-11-24", runs: 1, keys: [] },
        },
      },
      waiting: [],
    });
    lines = [];
    await run(["trigger", "list"]);
    expect(text()).toContain("constructor  every day 03:00 → codex safe · 1/5 today");
    expect(text()).toContain("09:00  missed: this computer was asleep or off");
    await run(["trigger", "list", "--json"]);
    expect(JSON.parse(printed.join("\n")).rules[0]).toMatchObject({ rule: { name: "constructor" }, today: 1 });
  });

  it("a clock rule added with no background service running says when its first tick is", async () => {
    await run([
      "trigger",
      "add",
      "x",
      "--every",
      "day 03:00",
      "--start",
      "codex",
      "--folder",
      "~/work/acme",
      "--words",
      "go",
    ]);
    expect(text()).toContain(
      "A clock rule's first tick is the first after the background service has seen it, and it isn't running now: `sessionpipe triggers on` installs it.",
    );
    rmSync(triggersFile());
    lines = [];
    daemon = {};
    await run([
      "trigger",
      "add",
      "x",
      "--every",
      "day 03:00",
      "--start",
      "codex",
      "--folder",
      "~/work/acme",
      "--words",
      "go",
    ]);
    expect(text()).not.toContain("first tick");
  });
});

describe("trigger line", () => {
  const CONT = "codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
  /** A POSIX shell's word splitting of one command line, for what `line` prints: single quotes,
   *  double quotes and backslashes as sh reads them; anything sh would act on, left bare, fails. */
  function shSplit(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let word = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i] as string;
      if (c === "'") {
        const j = line.indexOf("'", i + 1);
        if (j < 0) throw new Error("an open single quote");
        cur += line.slice(i + 1, j);
        i = j;
        word = true;
      } else if (c === '"') {
        for (i++; line[i] !== '"'; i++) {
          if (i >= line.length) throw new Error("an open double quote");
          if (line[i] === "$" || line[i] === "`") throw new Error("an expansion inside double quotes");
          if (line[i] === "\\" && '$`"\\\n'.includes(line[i + 1] as string)) i++;
          cur += line[i];
        }
        word = true;
      } else if (c === "\\") {
        if (line[i + 1] !== "\n") cur += line[i + 1];
        i++;
        word = true;
      } else if (c === " " || c === "\t" || c === "\n") {
        if (word) out.push(cur);
        cur = "";
        word = false;
      } else if ("|&;<>()$`*?[#~".includes(c) && !word) throw new Error(`a bare ${c}`);
      else if ("|&;<>()$`*?[".includes(c)) throw new Error(`a bare ${c}`);
      else {
        cur += c;
        word = true;
      }
    }
    if (word) out.push(cur);
    return out;
  }
  const lineFor = async (name: string): Promise<string> => {
    printed = [];
    lines = [];
    await run(["trigger", "line", name]);
    expect(lines).toEqual([]);
    expect(printed).toHaveLength(1);
    return printed[0] as string;
  };
  /** The rule, written alone; its line; the rule removed; the line's words given to `add`: the rule
   *  `add` writes is the rule, unpaused. */
  const roundTrip = async (rule: TriggerRule, over: Partial<TriggerDeps> = {}) => {
    writeRules({ v: 1, on: true, rules: [rule] });
    const line = await lineFor(rule.name);
    expect(line.includes("\u001b") || line.endsWith(" "), rule.name).toBe(false);
    if (!rule.words.includes("\n")) expect(line).not.toContain("\n");
    const argv = shSplit(line);
    expect(argv[0]).toBe("sessionpipe");
    expect(argv.slice(1, 3)).toEqual(["trigger", "add"]);
    writeRules({ v: 1, on: true, rules: [] });
    typed = "yes";
    await run(argv.slice(1), over);
    const back = readRules();
    expect(back.state === "ok" && back.file.rules[0], line).toEqual({ ...rule, paused: false });
    return line;
  };
  const sessionAt = (folder: string): Partial<TriggerDeps> => ({
    sessionThere: () => true,
    sessionFolder: () => path.join(home, folder.replace(/^~\//, "")),
  });
  beforeEach(() => {
    mkdirSync(path.join(home, "work", "sales"), { recursive: true });
    const c = readControl() as NonNullable<ReturnType<typeof readControl>>;
    const rx = c.receivers[0] as (typeof c.receivers)[number];
    writeControl({
      ...c,
      receivers: [...c.receivers, { ...rx, url: "https://tasks.example", rpId: "tasks.example", machine: "m_def" }],
    });
  });

  it("is the add command, alone on stdout, in one fixed order, read back as the same rule", async () => {
    const line = await roundTrip(card);
    expect(line).toBe(
      "sessionpipe trigger add card-todo --on board.example --topic acme/tasks --event record.updated --when state=todo --subject '^X-[0-9]{1,6}$' --start claude-code --folder '~/work/acme' --level edits --tools mcp__board --cap 5/day --words 'Card {subject} is yours and in TODO.'",
    );
    expect(await roundTrip(clock)).toBe(
      "sessionpipe trigger add monday-report --every 'mon 09:00' --start codex --folder '~/work/acme' --level safe --cap 1/day --words 'Make last week'\\''s sales report.'",
    );
    await roundTrip(
      { ...clock, name: "nightly", target: { continue: CONT }, folder: "~/work/acme" },
      sessionAt("~/work/acme"),
    );
  });

  it("round-trips hostile rules: quotes, expansions, separators, a leading dash, newlines, every flag", async () => {
    const hostile: TriggerRule[] = [
      { ...clock, name: "q", words: `It's "done" $(rm -rf ~) \`whoami\`; echo hi && x | y > z < w # not a comment` },
      { ...clock, name: "dash", words: "--json -x --words" },
      { ...clock, name: "nl", words: "First line.\nSecond line,\tand a tab.\n\n'quoted' end" },
      { ...clock, name: "a".repeat(40), words: "Forty." },
      { ...clock, name: "every-flag-0_", source: { every: "2h" }, cap: { per_day: 50 }, level: "read", words: "''" },
      {
        ...card,
        name: "all",
        source: { receiver: "tasks.example", topic: "acme/tasks", event: "record.updated" },
        when: { state: ["todo", "doing"], for: ["studio-claude", "u-41c9"], by: ["u-1"] },
        subject: "^[A-Z]+-[0-9]{1,6}$",
        tools: ["mcp__board", "mcp__board__read"],
        level: "edits",
        cap: { per_day: 50 },
        words: "Card {subject} in {state}: $HOME $x \\n \\ end\\",
      },
    ];
    const c = readControl() as NonNullable<ReturnType<typeof readControl>>;
    writeControl({ ...c, mode: "auto" });
    for (const r of hostile) await roundTrip(r);
    await roundTrip({ ...card, name: "cont", target: { continue: CONT } }, sessionAt("~/work/acme"));
  });

  it("round-trips every rule in the scenario files", async () => {
    const dir = path.resolve(import.meta.dirname, "../../../conformance/triggers");
    const rules = new Map<string, TriggerRule>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const fx = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as {
        cases?: {
          triggers?: { rules?: TriggerRule[] };
          triggers_ok?: boolean;
          steps?: { change?: { rules?: TriggerRule[] } }[];
        }[];
      };
      for (const c of fx.cases ?? []) {
        if (c.triggers_ok === false) continue;
        for (const r of [...(c.triggers?.rules ?? []), ...(c.steps ?? []).flatMap((s) => s.change?.rules ?? [])])
          rules.set(JSON.stringify(r), r);
      }
    }
    expect(rules.size).toBeGreaterThan(20);
    const ctl = readControl() as NonNullable<ReturnType<typeof readControl>>;
    writeControl({ ...ctl, mode: "auto" });
    for (const r of rules.values()) await roundTrip(r, isStart(r.target) ? {} : sessionAt(r.folder));
  });

  it("--json is TriggerLine; a name it doesn't know, or a file it can't read, is refused", async () => {
    writeRules({ v: 1, on: true, rules: [card, clock] });
    printed = [];
    await run(["trigger", "line", "card-todo", "--json"]);
    const j = JSON.parse(printed.join("\n"));
    expect(Object.keys(j)).toEqual(["line", "argv"]);
    expect(shSplit(j.line).slice(1)).toEqual(j.argv);
    const r = await refusal(run(["trigger", "line", "monday-reprot"]));
    expect(r.message).toBe("there is no rule named monday-reprot on this computer (the nearest: monday-report)");
    expect((await refusal(run(["trigger", "line", "zzz"]))).message).toBe(
      "there is no rule named zzz on this computer",
    );
    expect((await refusal(run(["trigger", "line"]))).message).toBe("which rule? `sessionpipe trigger line <name>`");
    writeFileSync(triggersFile(), "{");
    expect((await refusal(run(["trigger", "line", "card-todo"]))).message).toMatch(/^the rules file can't be read/);
    // Read-only: it needs no terminal, and runs inside a session.
    writeRules({ v: 1, on: true, rules: [card] });
    env.CLAUDECODE = "1";
    printed = [];
    await run(["trigger", "line", "card-todo"], { interactive: () => false });
    expect(printed).toHaveLength(1);
  });

  it("quotes a word only when it must", () => {
    expect(shellWord("abc-XYZ_0.9/:@=+")).toBe("abc-XYZ_0.9/:@=+");
    expect(shellWord("")).toBe("''");
    expect(shellWord("a b")).toBe("'a b'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
    expect(shellWord("~/w")).toBe("'~/w'");
    expect(lineArgv({ ...clock, when: { state: [] }, tools: [] })).not.toContain("--when");
  });
});

describe("the rules' lock", () => {
  const lock = () => `${triggersFile()}.lock`;
  it("another command holding it: every writer refuses and writes nothing", async () => {
    writeRules({ v: 1, on: false, rules: [clock, { ...card, paused: true }] });
    const before = readFileSync(triggersFile(), "utf8");
    writeFileSync(lock(), "1\n");
    const said = "Another sessionpipe command is changing the rules. Run it again.";
    for (const argv of [
      ["trigger", "add", "x", "--every", "day 03:00", "--start", "codex", "--folder", "~/work/acme", "--words", "go"],
      ["triggers", "on"],
      ["trigger", "pause", "monday-report"],
      ["trigger", "remove", "monday-report"],
      ["trigger", "resume", "card-todo"],
    ])
      expect((await refusal(run(argv))).message, argv.join(" ")).toBe(said);
    writeRules({ v: 1, on: true, rules: [clock] });
    const on = readFileSync(triggersFile(), "utf8");
    expect((await refusal(run(["triggers", "off"]))).message).toBe(said);
    expect(readFileSync(triggersFile(), "utf8")).toBe(on);
    expect(before).not.toBe(on);
  });
  it("a change made while a command waits for the lock is never written over: off, pause, remove, resume", async () => {
    // A stale lock is broken first; the line that says so is when another terminal changes the file.
    const meanwhile = (argv: string[], over: Partial<TriggerDeps> = {}) => {
      writeFileSync(lock(), "1\n");
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock(), old, old);
      lines = [];
      return triggerMain(
        argv,
        {
          ui: PLAIN,
          say: (l = "") => {
            lines.push(l);
            if (l.includes("was broken")) writeRules({ v: 1, on: true, rules: [clock, { ...card, name: "other" }] });
          },
          print: (l) => printed.push(l),
        },
        deps(over),
      );
    };
    for (const argv of [
      ["triggers", "off"],
      ["trigger", "pause", "monday-report"],
      ["trigger", "remove", "monday-report"],
    ]) {
      writeRules({ v: 1, on: true, rules: [clock] });
      await meanwhile(argv);
      expect(text(), argv.join(" ")).toContain("The rules changed while you were reading. Nothing was written.");
      expect(readRules()).toEqual({
        state: "ok",
        file: { v: 1, on: true, rules: [clock, { ...card, name: "other" }] },
      });
    }
    // resume of a rule only this computer paused: nothing in the file to write, and still checked.
    writeRules({ v: 1, on: true, rules: [clock] });
    writePrivate(triggerStateFile(), {
      v: 1,
      rules: {
        "monday-report": {
          history: [],
          paused: { at: "2026-11-24T09:00:00.000Z", code: "no_session", rule: JSON.stringify(clock.target) },
        },
      },
      waiting: [],
    });
    lines = [];
    await run(["trigger", "resume", "monday-report"], {
      confirm: async () => {
        writeRules({ v: 1, on: false, rules: [clock] });
        return "yes";
      },
    });
    expect(text()).toContain("The rules changed while you were reading.");
    expect(readRecord(env).rules["monday-report"]?.paused).toBeDefined();
  });
  it("names the nearest rules, nearest first", async () => {
    writeRules({ v: 1, on: true, rules: ["abce", "abcd", "abzz", "xyz"].map((name) => ({ ...clock, name })) });
    expect((await refusal(run(["trigger", "line", "abcx"]))).message).toBe(
      "there is no rule named abcx on this computer (the nearest: abcd, abce, abzz)",
    );
  });
  it("one left by a command that ended is broken, said, and the change is written; it is let go after", async () => {
    writeRules({ v: 1, on: true, rules: [clock] });
    writeFileSync(lock(), "1\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock(), old, old);
    await run(["trigger", "pause", "monday-report"]);
    expect(text()).toMatch(/A lock on the rules 6\d s old, left by a command that ended, was broken\./);
    expect(readRules()).toMatchObject({ file: { rules: [{ paused: true }] } });
    expect(existsSync(lock())).toBe(false);
    // Let go of when nothing is written, too.
    await run(["trigger", "resume", "monday-report"], {
      confirm: async () => {
        writeRules({ v: 1, on: false, rules: [{ ...clock, paused: true }] });
        return "yes";
      },
    });
    expect(text()).toContain("The rules changed while you were reading.");
    expect(existsSync(lock())).toBe(false);
  });
});
