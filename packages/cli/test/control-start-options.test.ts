// SPDX-License-Identifier: Apache-2.0
// A start's options end to end (CONTROL.md §2 `start`, §3.1, §5 step 8, §6 Options):
// the hello says what each harness takes, capped by the machine's mode; a start above
// that is refused before anything is taken or run; what a start ran with is recorded
// and every later run of the session is at the narrower of that and the mode now; the
// acks carry `applied`; and a model the harness rejects ends `failed` with code `model`.
// The harnesses are a stand-in `run`: it records each argv and answers in the
// harness's own output shape, so no agent ever runs.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunResult } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlDaemon, type DaemonDeps, type SdkHost } from "../src/control/daemon.js";
import type { ControlConfig } from "../src/control/store.js";
import { FakeReceiver } from "./helpers/receiver.js";

const NEW = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b";
const RECV = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7e01";
const THREAD = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c";
const ALL = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"];
const BAD_MODEL =
  "There's an issue with the selected model (nope-9). It may not exist or you may not have access to it.";

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let project: string;
let configDir: string;
let runs: { bin: string; args: string[]; cwd: string }[];

function cfg(mode: ControlConfig["mode"]): ControlConfig {
  return {
    name: "testbox",
    folders: [project],
    mode,
    receivers: [
      {
        url: rx.url,
        control: `${rx.url}/api/sessionpipe/v1/control`,
        rpId: "localhost",
        machine: rx.machine,
        token: rx.token,
        keys: [{ ...rx.passkey.key, added_at: new Date().toISOString() }],
        paired_at: new Date().toISOString(),
      },
    ],
  };
}

/** The harnesses' answers: Claude Code's result object, Codex's JSONL. A run asked for
 *  model `nope-9` fails the way each harness says so. */
function run(bin: string, args: string[], o: { cwd: string }): Promise<RunResult> {
  runs.push({ bin, args, cwd: o.cwd });
  const bad = args.includes("nope-9");
  const res = (stdout: string): RunResult => ({
    code: bad ? 1 : 0,
    signal: null,
    stdout,
    stderr: "",
    tooBig: false,
    timedOut: false,
  });
  if (bin === "codex") {
    const lines = [{ type: "thread.started", thread_id: THREAD }];
    const tail = bad
      ? [
          {
            type: "turn.failed",
            error: { message: "The 'nope-9' model is not supported when using Codex with a ChatGPT account." },
          },
        ]
      : [{ type: "item.completed", item: { type: "agent_message", text: "codex ok" } }, { type: "turn.completed" }];
    return Promise.resolve(res([...lines, ...tail].map((l) => JSON.stringify(l)).join("\n")));
  }
  if (bin === "agy")
    return Promise.resolve(
      res(
        JSON.stringify({
          event: "result",
          result: { conversation_id: "conv-1", status: "SUCCESS", response: "agy ok" },
        }),
      ),
    );
  const i = args.indexOf("--session-id");
  const j = args.indexOf("--resume");
  const sid = i >= 0 ? args[i + 1] : args[j + 1];
  return Promise.resolve(
    res(JSON.stringify({ type: "result", is_error: bad, result: bad ? BAD_MODEL : "claude ok", session_id: sid })),
  );
}

async function startDaemon(
  o: { mode?: ControlConfig["mode"]; caps?: string[]; sdk?: SdkHost; extra?: Partial<DaemonDeps> } = {},
) {
  d = new ControlDaemon(cfg(o.mode ?? "safe"), path.join(tmp, "state", "control"), path.join(tmp, "control.sock"), {
    now: Date.now,
    fetch,
    log: process.env.SP_DEBUG ? (s: string) => console.error(`[daemon] ${s}`) : () => {},
    claudeDirs: () => [configDir],
    claude: () => ({ bin: "claude", caps: { hasMode: true, modes: o.caps ?? ALL, promptsNone: false, fork: true } }),
    codex: () => "codex",
    agy: () => "agy",
    codexModels: () => ["gpt-6-astra", "gpt-5.6-sol"],
    run: run as DaemonDeps["run"],
    sdk: o.sdk ?? null,
    env: { ...process.env, CODEX_HOME: path.join(tmp, "codex-home") },
    ...o.extra,
  });
  await d.start();
}

/** The transcript a started session wrote, ten minutes ago (so it isn't "live"). */
function transcript(sid: string): void {
  const dir = path.join(configDir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sid}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: "user", cwd: project, message: { content: "hi" } })}\n`);
  const past = new Date(Date.now() - 600_000);
  utimesSync(f, past, past);
}

const outcomes = (id: string) => rx.acks.filter((a) => a.id === id && a.outcome !== "progress");
const flag = (args: string[] | undefined, f: string) => (args ? args[args.indexOf(f) + 1] : undefined);
const start = (session: string, extra: Record<string, unknown> = {}) =>
  rx.send({ kind: "start", session, cwd: project, text: "go", ...extra });

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-options-"));
  project = path.join(tmp, "project");
  configDir = path.join(tmp, "claude-config");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  runs = [];
  rx.queue.clear();
  rx.acks.length = 0;
  rx.hellos.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(tmp, { recursive: true, force: true });
});

const lastHello = async () => {
  for (let i = 0; i < 100 && !rx.hellos.length; i++) await new Promise((r) => setTimeout(r, 20));
  return rx.hellos.at(-1) as { start?: Record<string, unknown>; mode?: string };
};

describe("the hello says what a start may carry", { timeout: 30_000 }, () => {
  it("a safe machine: read and safe, defaults safe; Codex's own models; Antigravity no model; never the home folder", async () => {
    await startDaemon();
    const h = await lastHello();
    expect(h).not.toHaveProperty("home");
    expect(h.start).toEqual({
      "claude-code": { permissions: ["read", "safe"], permission: "safe", any_model: true },
      codex: {
        permissions: ["read", "safe"],
        permission: "safe",
        any_model: true,
        models: ["gpt-6-astra", "gpt-5.6-sol"],
      },
      antigravity: { permissions: ["safe"], permission: "safe" },
    });
    expect(d?.status().start).toEqual(h.start);
  });
  it("an auto machine: every level Claude Code's --help lists, Codex auto, Antigravity edits", async () => {
    await startDaemon({ mode: "auto", extra: { codexModels: () => [] } });
    expect((await lastHello()).start).toEqual({
      "claude-code": { permissions: ["read", "safe", "edits", "auto"], permission: "auto", any_model: true },
      codex: { permissions: ["read", "safe", "auto"], permission: "auto", any_model: true },
      antigravity: { permissions: ["safe", "edits"], permission: "edits" },
    });
  });
  it("from --help: no plan, no acceptEdits; an auto machine whose Claude Code has no auto offers it nothing", async () => {
    await startDaemon({ caps: ["default", "dontAsk"], extra: { harnesses: () => ["claude-code", "gemini-cli"] } });
    expect((await lastHello()).start).toEqual({
      "claude-code": { permissions: ["safe"], permission: "safe", any_model: true },
    });
    await d?.stop();
    rx.hellos.length = 0;
    await startDaemon({ mode: "auto", caps: ["acceptEdits", "dontAsk"], extra: { harnesses: () => ["claude-code"] } });
    // A start without options would be refused here, so the hello advertises none.
    expect((await lastHello()).start).toEqual({});
  });
  it("with the Agent SDK, a start isn't limited by what claude --help lists", async () => {
    const sdk: SdkHost = {
      start: () => ({
        send: async () => ({ reply: "" }),
        interrupt: async () => {},
        close() {},
        busy: false,
        lastUsed: 0,
      }),
    };
    await startDaemon({ caps: [], sdk, extra: { harnesses: () => ["claude-code"] } });
    expect((await lastHello()).start).toEqual({
      "claude-code": { permissions: ["read", "safe"], permission: "safe", any_model: true },
    });
  });
});

describe("a start's options are checked before anything is taken", { timeout: 30_000 }, () => {
  it("above the machine's mode: refused permission at once, no taken, nothing runs", async () => {
    await startDaemon();
    for (const [session, permission] of [
      [`claude-code:${NEW}`, "auto"],
      [`codex:${RECV}`, "auto"],
      [`antigravity:${RECV}`, "edits"],
    ] as const) {
      const q = await start(session, { permission });
      expect(await rx.waitAck(q.id)).toMatchObject({
        outcome: "refused",
        code: "permission",
        detail: `this machine runs in safe mode; ${permission} needs \`sessionpipe control mode auto\` at the machine`,
      });
      expect(outcomes(q.id).map((a) => a.outcome)).toEqual(["refused"]);
    }
    expect(runs).toEqual([]);
  });
  it("a level the harness doesn't have here, in its own words", async () => {
    await startDaemon({ mode: "auto", caps: ["dontAsk", "auto"] });
    const cases = [
      [`claude-code:${NEW}`, "read", "this machine's Claude Code has no plan permission mode"],
      [`codex:${RECV}`, "edits", "Codex has no edits level: its safe level, the workspace sandbox, already edits"],
      [`antigravity:${RECV}`, "read", "Antigravity has no read-only mode"],
      [`antigravity:${NEW}`, "auto", "Antigravity's widest level is edits"],
    ] as const;
    for (const [session, permission, detail] of cases) {
      const q = await start(session, { permission });
      expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "refused", code: "permission", detail });
    }
    expect(runs).toEqual([]);
  });
  it("a model for a harness that takes none: refused model", async () => {
    await startDaemon();
    const q = await start(`antigravity:${RECV}`, { model: "gemini-3" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "refused",
      code: "model",
      detail: "Antigravity takes no model choice on this machine",
    });
    expect(runs).toEqual([]);
  });
});

describe("what a start ran with: applied, recorded, and kept", { timeout: 30_000 }, () => {
  it("Claude Code: the asked level and model run, applied on taken and delivered, and stick across a resume", async () => {
    await startDaemon({ mode: "auto" });
    const q = await start(`claude-code:${NEW}`, { permission: "read", model: "opus[1m]" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "resume",
      applied: { permission: "read", model: "opus[1m]" },
    });
    expect(outcomes(q.id)[0]).toMatchObject({ outcome: "taken", applied: { permission: "read", model: "opus[1m]" } });
    expect(flag(runs[0]?.args, "--permission-mode")).toBe("plan");
    expect(flag(runs[0]?.args, "--model")).toBe("opus[1m]");
    const state = JSON.parse(readFileSync(path.join(tmp, "state", "control", "state.json"), "utf8"));
    expect(state.started[NEW]).toEqual({ permission: "read", model: "opus[1m]" });
    // The next message resumes it at read, with its model, though the machine is auto.
    transcript(NEW);
    const p = await rx.send({ session: `claude-code:${NEW}`, text: "and now?" });
    expect(await rx.waitAck(p.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(runs[1]?.args).toContain("--resume");
    expect(flag(runs[1]?.args, "--permission-mode")).toBe("plan");
    expect(flag(runs[1]?.args, "--model")).toBe("opus[1m]");
  });
  it("a machine turned down from auto to safe takes a recorded auto session down at its next run", async () => {
    await startDaemon({ mode: "auto" });
    const q = await start(`claude-code:${NEW}`);
    // No options asked: the default, applied without a model.
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", applied: { permission: "auto" } });
    expect(outcomes(q.id)[1]?.applied).toEqual({ permission: "auto" });
    expect(flag(runs[0]?.args, "--permission-mode")).toBe("auto");
    d?.reload(cfg("safe"));
    transcript(NEW);
    const p = await rx.send({ session: `claude-code:${NEW}`, text: "more" });
    await rx.waitAck(p.id);
    expect(flag(runs[1]?.args, "--permission-mode")).toBe("dontAsk");
  });
  it("Codex: -s read-only and -m; the alias records them, and its resume keeps both", async () => {
    await startDaemon({ mode: "auto" });
    const q = await start(`codex:${RECV}`, { permission: "read", model: "gpt-5.6-sol" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      applied: { permission: "read", model: "gpt-5.6-sol" },
    });
    expect(flag(runs[0]?.args, "-s")).toBe("read-only");
    expect(flag(runs[0]?.args, "-m")).toBe("gpt-5.6-sol");
    const aliases = JSON.parse(readFileSync(path.join(tmp, "state", "control", "aliases.json"), "utf8"));
    expect(aliases[`codex:${RECV}`]).toMatchObject({ id: THREAD, permission: "read", model: "gpt-5.6-sol" });
    const p = await rx.send({ session: `codex:${RECV}`, text: "next" });
    const ack = await rx.waitAck(p.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "resume" });
    // A resume says what ran in its own acks only through its flags: no `applied`.
    expect(ack).not.toHaveProperty("applied");
    expect(runs[1]?.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(runs[1]?.args).toContain('sandbox_mode="read-only"');
    expect(flag(runs[1]?.args, "-m")).toBe("gpt-5.6-sol");
  });
  it("Antigravity on an auto machine starts at edits by default, and says so", async () => {
    await startDaemon({ mode: "auto" });
    const q = await start(`antigravity:${RECV}`);
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", applied: { permission: "edits" } });
    expect(runs[0]?.args.slice(-2)).toEqual(["--mode", "accept-edits"]);
  });
  it("the Agent SDK gets the level and the model", async () => {
    const seen: unknown[] = [];
    const sdk: SdkHost = {
      start: (o) => {
        seen.push(o);
        return {
          send: async () => ({ reply: "sdk ok" }),
          interrupt: async () => {},
          close() {},
          busy: false,
          lastUsed: Date.now(),
        };
      },
    };
    await startDaemon({ mode: "auto", sdk });
    const q = await start(`claude-code:${NEW}`, { permission: "edits", model: "sonnet" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "sdk",
      applied: { permission: "edits", model: "sonnet" },
    });
    expect(seen[0]).toMatchObject({ session: NEW, cwd: expect.any(String), permission: "edits", model: "sonnet" });
  });
});

describe("a record that can't be written", { timeout: 30_000 }, () => {
  it("doesn't stop the start: it runs, and says so in the log", async () => {
    const lines: string[] = [];
    // A folder where state.json should be: the record can't be renamed into place.
    mkdirSync(path.join(tmp, "state", "control", "state.json"), { recursive: true });
    await startDaemon({ extra: { log: (s) => lines.push(s) } });
    const q = await start(`claude-code:${NEW}`, { permission: "read" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", applied: { permission: "read" } });
    expect(lines.some((l) => l.startsWith(`couldn't record what ${NEW.slice(0, 8)} runs with`))).toBe(true);
  });
});

describe("a model the harness won't run", { timeout: 30_000 }, () => {
  it("ends failed with code model and the harness's words; nothing else is tried", async () => {
    await startDaemon({ mode: "auto" });
    const c = await start(`claude-code:${NEW}`, { model: "nope-9" });
    expect(await rx.waitAck(c.id)).toMatchObject({ outcome: "failed", code: "model", detail: BAD_MODEL });
    const x = await start(`codex:${RECV}`, { model: "nope-9" });
    expect(await rx.waitAck(x.id)).toMatchObject({
      outcome: "failed",
      code: "model",
      detail: expect.stringContaining("'nope-9' model is not supported"),
    });
    expect(runs).toHaveLength(2);
  });
});

describe("an inherit machine (CONTROL.md §2, §3.1)", { timeout: 30_000 }, () => {
  it("the hello offers read and safe, and inherit as the default", async () => {
    await startDaemon({ mode: "inherit", extra: { codexModels: () => [] } });
    expect((await lastHello()).start).toEqual({
      "claude-code": { permissions: ["read", "safe"], permission: "inherit", any_model: true },
      codex: { permissions: ["read", "safe"], permission: "inherit", any_model: true },
      antigravity: { permissions: ["safe"], permission: "inherit" },
    });
  });
  it("a start with no level passes no permission flag and says inherit; one may narrow to read", async () => {
    await startDaemon({ mode: "inherit" });
    const q = await start(`claude-code:${NEW}`, { model: "sonnet" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      applied: { permission: "inherit", model: "sonnet" },
    });
    expect(runs[0]?.args).not.toContain("--permission-mode");
    expect(flag(runs[0]?.args, "--model")).toBe("sonnet");
    // Its next run inherits too, with its model.
    transcript(NEW);
    const p = await rx.send({ session: `claude-code:${NEW}`, text: "more" });
    await rx.waitAck(p.id);
    expect(runs[1]?.args).not.toContain("--permission-mode");
    expect(flag(runs[1]?.args, "--model")).toBe("sonnet");
    const c = await start(`codex:${RECV}`, { permission: "read" });
    expect(await rx.waitAck(c.id)).toMatchObject({ outcome: "delivered", applied: { permission: "read" } });
    expect(flag(runs[2]?.args, "-s")).toBe("read-only");
    const a = await start(`antigravity:${RECV}`);
    expect(await rx.waitAck(a.id)).toMatchObject({ outcome: "delivered", applied: { permission: "inherit" } });
    expect(runs[3]?.args).not.toContain("--mode");
  });
  it("a level above safe is refused, never run", async () => {
    await startDaemon({ mode: "inherit" });
    const q = await start(`claude-code:${NEW}`, { permission: "edits" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "refused",
      code: "permission",
      detail:
        "this machine runs in inherit mode, where a message may only name read or safe; edits needs `sessionpipe control mode auto` at the machine",
    });
    expect(runs).toEqual([]);
  });
  it("a session recorded at auto, on a machine now in inherit, runs at safe", async () => {
    await startDaemon({ mode: "auto" });
    const q = await start(`claude-code:${NEW}`);
    await rx.waitAck(q.id);
    d?.reload(cfg("inherit"));
    transcript(NEW);
    const p = await rx.send({ session: `claude-code:${NEW}`, text: "more" });
    await rx.waitAck(p.id);
    expect(flag(runs[1]?.args, "--permission-mode")).toBe("dontAsk");
  });
});

describe("an ACP agent takes no start options", { timeout: 30_000 }, () => {
  it("a permission or a model on its start is refused before anything runs", async () => {
    await startDaemon({ mode: "auto", extra: { acp: () => ({ bin: "goose", args: ["acp"] }) } });
    const p = await start("goose:0199a", { permission: "read" });
    expect(await rx.waitAck(p.id)).toMatchObject({
      outcome: "refused",
      code: "permission",
      detail: "goose takes no permission level or model choice on this machine",
    });
    const m = await start("goose:0199b", { model: "x" });
    expect(await rx.waitAck(m.id)).toMatchObject({ outcome: "refused", code: "model" });
    expect(runs).toEqual([]);
  });
});

describe("a start's folder under ~", { timeout: 30_000 }, () => {
  it("~/… is read under this user's home; ~ alone is that folder; ~user is malformed", async () => {
    vi.stubEnv("HOME", tmp);
    vi.stubEnv("USERPROFILE", tmp);
    try {
      await startDaemon();
      const q = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: "~/project", text: "go" });
      expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered" });
      expect(runs[0]?.cwd).toBe(realpathSync(project));
      // The home folder itself isn't one this machine allows.
      const h = await rx.send({ kind: "start", session: `claude-code:${RECV}`, cwd: "~", text: "go" });
      expect(await rx.waitAck(h.id)).toMatchObject({ outcome: "refused", code: "folder" });
      const u = await rx.send({
        kind: "start",
        session: "claude-code:0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7e02",
        cwd: "~root/project",
        text: "go",
      });
      expect(await rx.waitAck(u.id)).toMatchObject({ outcome: "refused", code: "bad_fields" });
      expect(runs).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
