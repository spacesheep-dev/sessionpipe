// SPDX-License-Identifier: Apache-2.0
// Issue #9 (no event lost to the lock race) and advisory GHSA-8f6f-c3c9-j5p6
// (the outbox holds redacted strings at rest, 0600/0700).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Outbox, takeLock } from "@sessionpipe/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aliasFile, readAliases, receiverIdOf, writeAliases } from "../src/control/aliases.js";
import { claimJob, enqueueJob, hasJobs, jobsDir, log, runJob, sweepJobs, versionLine } from "../src/run.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-run-"));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
process.env.SESSIONPIPE_CONFIG = path.join(tmp, "config.json");
writeFileSync(process.env.SESSIONPIPE_CONFIG, JSON.stringify({ sinks: [], harnesses: {} }));

const job = (event: string, extra: Record<string, unknown> = {}) => ({
  harness: "codex",
  event,
  argv: ["codex", event],
  stdin: JSON.stringify({ session_id: "race-1", cwd: tmp, hook_event_name: event, model: "m", ...extra }),
  cwd: tmp,
  env: {},
  at: Date.now(),
});

describe("runJob", () => {
  it("four concurrent hooks of one session all reach the outbox, in seq order", async () => {
    const jobs = [
      job("SessionStart", { source: "startup" }),
      job("UserPromptSubmit", { prompt: "hi" }),
      job("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "a" }),
      job("Stop"),
    ];
    await Promise.all(jobs.map((j) => runJob(j, { state: tmp })));
    const { events } = new Outbox(tmp).read({ harness: "codex", session: "race-1" }, 0, 100);
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.session.seq)).toEqual([0, 1, 2, 3]);
  });
  it("a job whose environment names a launcher writes launched_by into the event", async () => {
    const launcher = "claude-code:ed6c7665-589f-40c7-b7b4-e38ee662b7bc";
    const started = { ...job("SessionStart", { source: "startup" }), env: { SESSIONPIPE_LAUNCHED_BY: launcher } };
    const { events } = await runJob(started, { state: tmp });
    expect(events[0]?.session.launched_by).toBe(launcher);
  });
  it("stores tool input redacted at rest, in 0600 files under 0700 dirs", async () => {
    await runJob(
      job("PostToolUse", {
        tool_name: "Bash",
        tool_input: { command: "export DB_PASSWORD=hunter2" },
        tool_response: "ok",
        tool_use_id: "b",
      }),
      { state: tmp },
    );
    const f = new Outbox(tmp).file({ harness: "codex", session: "race-1" });
    const text = readFileSync(f, "utf8");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("[redacted]");
    if (process.platform !== "win32") {
      expect(statSync(f).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(f)).mode & 0o777).toBe(0o700);
    }
  });
  it("a job takes its session's lock as soon as a sibling lets go, not at the next backoff step", async () => {
    const ref = { harness: "codex", session: "race-1" };
    const release = takeLock(tmp, ref);
    setTimeout(() => release?.(), 900);
    const t0 = Date.now();
    const { events } = await runJob(job("PreToolUse", { tool_name: "Bash", tool_input: {}, tool_use_id: "c" }), {
      state: tmp,
    });
    expect(events).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(1400); // doubling backoff got there at 1550 ms
  });
  it("a claim is released once the job's events are in the outbox", async () => {
    const f = enqueueJob(tmp, job("PreToolUse", { tool_name: "Bash", tool_input: {}, tool_use_id: "d" }));
    const c = claimJob(f);
    expect(c?.file).toBe(`${f}.${process.pid}.running`);
    expect(existsSync(f)).toBe(false);
    const { events } = await runJob(c?.job as Parameters<typeof runJob>[0], { state: tmp, claimed: c?.file as string });
    expect(events).toHaveLength(1);
    expect(readdirSync(jobsDir(tmp))).toEqual([]);
  });
  it("a claim a dead worker left mid-run goes back to the queue and the next sweep runs it", async () => {
    const f = enqueueJob(tmp, job("SessionEnd", { reason: "exit" }));
    const old = new Date(Date.now() - 10_000);
    const { renameSync, utimesSync } = await import("node:fs");
    utimesSync(f, old, old);
    renameSync(f, `${f}.2147483647.running`); // no process has this pid
    expect(await sweepJobs(tmp, 3000)).toBe(1);
    expect(readdirSync(jobsDir(tmp))).toEqual([]);
    const { events } = new Outbox(tmp).read({ harness: "codex", session: "race-1" }, 0, 100);
    expect(events.some((e) => e.type === "session.ended")).toBe(true);
  });
  it("a claim a live worker holds is left alone", async () => {
    const f = enqueueJob(tmp, job("SessionEnd", { reason: "exit" }));
    const { renameSync } = await import("node:fs");
    renameSync(f, `${f}.${process.pid}.running`);
    expect(await sweepJobs(tmp, 0)).toBe(0);
    expect(readdirSync(jobsDir(tmp))).toEqual([`${path.basename(f)}.${process.pid}.running`]);
  });
  it("a job the lock holds out goes back to the queue under a new file, its claim released", async () => {
    const release = takeLock(tmp, { harness: "codex", session: "race-1" });
    try {
      const c = claimJob(enqueueJob(tmp, job("Stop")));
      const r = await runJob(c?.job as Parameters<typeof runJob>[0], {
        state: tmp,
        claimed: c?.file as string,
        lockWaitMs: 120,
      });
      expect(r.events).toEqual([]);
      expect(r.requeued).toBeDefined();
      expect(readdirSync(jobsDir(tmp))).toEqual([path.basename(r.requeued as string)]);
      expect(JSON.parse(readFileSync(r.requeued as string, "utf8")).tries).toBe(1);
    } finally {
      release?.();
    }
  });
  it("sweepJobs runs a job another worker left behind", async () => {
    const f = enqueueJob(tmp, job("SessionEnd", { reason: "exit" }));
    const old = new Date(Date.now() - 10_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(f, old, old);
    expect(await sweepJobs(tmp, 3000)).toBe(1);
    const { events } = new Outbox(tmp).read({ harness: "codex", session: "race-1" }, 0, 100);
    expect(events.some((e) => e.type === "session.ended")).toBe(true);
  });

  // Several harnesses import ~/.claude/settings.json, so our entry there arrives under
  // the claude-code name with a payload Claude Code never sent. The adapter refuses it
  // (claude-code.ts notClaudeCode) and the event IS dropped — but the log has to say
  // so, or the machine holds no trace of a harness reporting nothing.
  it("says in the log when an adapter would not claim the payload", async () => {
    const state = path.join(tmp, "unclaimed");
    const r = await runJob(
      {
        harness: "claude-code",
        event: "PermissionRequest",
        argv: ["claude-code", "PermissionRequest"],
        // Devin's shape: a word-word session id and no transcript_path.
        stdin: JSON.stringify({ session_id: "zest-lantana", prompt_id: "p1", tool_name: "exec" }),
        cwd: tmp,
        env: {},
        at: Date.now(),
      },
      { state },
    );
    expect(r.events).toEqual([]);
    expect(readFileSync(path.join(state, "log"), "utf8")).toContain(
      "claude-code PermissionRequest: the claude-code adapter did not claim this payload",
    );
  });

  it.each(["codex", "claude-code", "gemini-cli", "antigravity", "devin"])(
    "%s logs only unclaimed payload keys and the hook name at the default log tier",
    async (harness) => {
      const payload = {
        cwd: "/private/unclaimed-project",
        hook_event_name: "private-payload-event",
        prompt: "private prompt text",
        extra: { nested_secret: "private nested value" },
      };
      const r = await runJob(
        { ...job("SessionStart"), harness, argv: [harness, "SessionStart"], stdin: JSON.stringify(payload) },
        { state: tmp },
      );
      expect(r.events).toEqual([]);
      const text = readFileSync(path.join(tmp, "log"), "utf8");
      expect(text).toContain(`${harness} SessionStart:`);
      expect(text).toContain("keys: cwd, hook_event_name, prompt, extra");
      for (const value of [payload.cwd, payload.hook_event_name, payload.prompt, payload.extra.nested_secret])
        expect(text).not.toContain(value);
      expect(text).not.toContain("nested_secret");
    },
  );

  it("logs keys from an unclaimed notify JSON argument, never its values", async () => {
    const payload = { type: "private-notify-type", prompt: "private-notify-prompt" };
    await runJob(
      { ...job("notify"), argv: ["codex", "notify", JSON.stringify(payload)], stdin: '{"ignored":"private-stdin"}' },
      { state: tmp },
    );
    const text = readFileSync(path.join(tmp, "log"), "utf8");
    expect(text).toContain("codex notify:");
    expect(text).toContain("keys: type, prompt");
    for (const value of [...Object.values(payload), "ignored", "private-stdin"]) expect(text).not.toContain(value);
  });

  it.each([
    "",
    "null",
    "[]",
    '["private-array-value"]',
    '"private-string-value"',
    "42",
    "{ private-invalid-json",
    "{}",
  ])("logs no keys or values for an unclaimed non-object or invalid payload: %s", async (stdin) => {
    await runJob({ ...job("SessionStart"), stdin }, { state: tmp });
    const text = readFileSync(path.join(tmp, "log"), "utf8");
    expect(text).toContain("codex SessionStart:");
    expect(text).toContain("keys: (none)");
    expect(text).not.toContain("private-");
  });

  // The facts pass gets the HOOK's environment, not the worker's. It matters because
  // sweepJobs runs any stale job file: a devin job can be processed by a worker that a
  // Claude Code hook spawned, and devin resolves its config and its session store from
  // XDG_CONFIG_HOME / XDG_DATA_HOME.
  it("reads a harness's facts from the job's environment, not the worker's", async () => {
    const other = path.join(tmp, "elsewhere");
    mkdirSync(path.join(other, "config", "devin"), { recursive: true });
    writeFileSync(
      path.join(other, "config", "devin", "config.json"),
      JSON.stringify({ version: 1, devin: { org_id: "org-from-the-job" } }),
    );
    const state = path.join(tmp, "devin-facts");
    const r = await runJob(
      {
        harness: "devin",
        event: "SessionStart",
        argv: ["devin", "SessionStart"],
        stdin: JSON.stringify({ session_id: "frill-vulture", source: "startup" }),
        cwd: tmp,
        env: {
          // Windows resolves both through %APPDATA%; the others through XDG.
          APPDATA: path.join(other, "config"),
          XDG_CONFIG_HOME: path.join(other, "config"),
          XDG_DATA_HOME: path.join(other, "data"),
          DEVIN_PROJECT_DIR: tmp,
        },
        at: Date.now(),
      },
      { state },
    );
    expect(r.events[0]?.type).toBe("session.started");
    expect(r.events[0]?.session.account_id).toBe("org-from-the-job");
    expect(r.events[0]?.session.cwd).toBe(tmp);
  });
  it("session.attended comes from the job's environment, never the worker's", async () => {
    const run = (id: string, env: Record<string, string>) =>
      runJob(
        {
          harness: "claude-code",
          event: "SessionStart",
          argv: ["claude-code", "SessionStart"],
          stdin: JSON.stringify({ session_id: id, cwd: tmp, source: "startup" }),
          cwd: tmp,
          env,
          at: Date.now(),
        },
        { state: path.join(tmp, "attended") },
      );
    // The worker was spawned by a desktop session's hook during a control turn, and sweeps the
    // job of a `claude -p` nobody watches.
    const keys = ["CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_HOST_SESSION_ID", "SESSIONPIPE_CONTROL_JOB"];
    const saved = keys.map((k) => process.env[k]);
    Object.assign(process.env, {
      CLAUDE_CODE_SESSION_ATTENDED: "1",
      CLAUDE_CODE_HOST_SESSION_ID: "local_the-worker",
      SESSIONPIPE_CONTROL_JOB: "1",
    });
    try {
      const probe = await run("11111111-1111-4111-8111-111111111111", { CLAUDE_CODE_SESSION_ATTENDED: "0" });
      expect(probe.events[0]?.session.attended).toBe(false);
      expect(probe.events[0]?.session.url).toBeUndefined();
      const desktop = await run("22222222-2222-4222-8222-222222222222", {
        CLAUDE_CODE_SESSION_ATTENDED: "0",
        CLAUDE_CODE_HOST_SESSION_ID: "local_the-job",
      });
      expect(desktop.events[0]?.session).toMatchObject({ attended: true, url: "claude://code/continue/local_the-job" });
      const unsaid = await run("33333333-3333-4333-8333-333333333333", {});
      expect(unsaid.events[0]?.session).not.toHaveProperty("attended");
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });
});

describe("sessions the control daemon named (control/aliases.ts)", () => {
  it("aliases are written whole, 0600, and looked up both ways", () => {
    const file = aliasFile(path.join(tmp, "control"));
    expect(readAliases(file)).toEqual({});
    writeAliases(file, { "codex:start-1": { id: "thread-1", cwd: tmp, at: "2026-10-04T00:00:00.000Z" } });
    expect(readAliases(file)["codex:start-1"]).toMatchObject({ id: "thread-1", cwd: tmp });
    expect(receiverIdOf(readAliases(file), "codex", "thread-1")).toBe("start-1");
    expect(receiverIdOf(readAliases(file), "antigravity", "thread-1")).toBeNull();
    expect(receiverIdOf(readAliases(file), "codex", "start-1")).toBeNull();
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "{");
    expect(readAliases(file)).toEqual({});
  });

  it("a hook event of a session the daemon started goes out under the start's id", async () => {
    writeAliases(aliasFile(path.join(tmp, "control")), {
      "codex:start-1": { id: "race-1", cwd: tmp, at: "2026-10-04T00:00:00.000Z" },
    });
    const { events } = await runJob(job("SessionStart", { source: "startup" }), { state: tmp });
    expect(events.map((e) => e.session.id)).toEqual(["start-1"]);
    const outbox = new Outbox(tmp);
    expect(outbox.read({ harness: "codex", session: "start-1" }, 0, 10).events).toHaveLength(1);
    expect(outbox.read({ harness: "codex", session: "race-1" }, 0, 10).events).toHaveLength(0);
  });

  it.runIf(process.platform !== "win32")(
    "every harness tells the daemon, with the session's own folder; Antigravity's folder is kept",
    async () => {
      mkdirSync(tmp, { recursive: true }); // the last test's cleanup took it
      const sock = path.join(tmp, "control.sock");
      const got: Record<string, unknown>[] = [];
      const server = net.createServer((c) =>
        c.once("data", (d) => {
          got.push(JSON.parse(d.toString("utf8").split("\n")[0] as string));
          c.end(`${JSON.stringify({ op: "ok" })}\n`);
        }),
      );
      await new Promise<void>((r) => server.listen(sock, () => r()));
      // The sandbox points SESSIONPIPE_SOCKET elsewhere; the fake daemon is here.
      vi.stubEnv("SESSIONPIPE_SOCKET", sock);
      try {
        const ws = path.join(tmp, "ws");
        mkdirSync(ws, { recursive: true });
        writeAliases(aliasFile(path.join(tmp, "control")), {
          "antigravity:start-2": { id: "conv-1", cwd: ws, at: "2026-10-04T00:00:00.000Z" },
        });
        await runJob(
          {
            harness: "antigravity",
            event: "Stop",
            argv: ["antigravity", "Stop"],
            stdin: JSON.stringify({ conversationId: "conv-1", workspacePaths: [`file://${ws}`] }),
            cwd: "/",
            env: {},
            at: Date.now(),
          },
          { state: tmp },
        );
        await runJob(job("Stop", { cwd: ws }), { state: tmp });
        expect(got).toEqual([
          { op: "event", session: "antigravity:start-2", event: "Stop", cwd: ws },
          { op: "event", session: "codex:race-1", event: "Stop", cwd: ws },
        ]);
        const facts = JSON.parse(readFileSync(path.join(tmp, "facts", "antigravity", "start-2.json"), "utf8"));
        expect(facts.cwd).toBe(ws);
      } finally {
        vi.unstubAllEnvs();
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  );
});

describe("claims and sweeps, the edges", () => {
  it("a claim fails on a job that is gone, or one that is not a job (its file is dropped)", () => {
    mkdirSync(jobsDir(tmp), { recursive: true });
    expect(claimJob(path.join(jobsDir(tmp), "gone.json"))).toBeNull();
    const f = path.join(jobsDir(tmp), "bad.json");
    writeFileSync(f, "{");
    expect(claimJob(f)).toBeNull();
    expect(readdirSync(jobsDir(tmp))).toEqual([]);
  });
  it("a sweep of a state dir without jobs is nothing", async () => {
    expect(hasJobs(path.join(tmp, "nowhere"))).toBe(false);
    expect(await sweepJobs(path.join(tmp, "nowhere"))).toBe(0);
    enqueueJob(tmp, job("Stop"));
    expect(hasJobs(tmp)).toBe(true);
  });
  it("a sweep leaves a job younger than olderThanMs to the worker its hook spawned", async () => {
    enqueueJob(tmp, job("SessionEnd", { reason: "exit" }));
    expect(await sweepJobs(tmp, 3000)).toBe(0);
    expect(readdirSync(jobsDir(tmp))).toHaveLength(1);
  });
  it("two dead claims of one job give one job back; what is not a job file is skipped", async () => {
    const { renameSync, utimesSync, copyFileSync } = await import("node:fs");
    const f = enqueueJob(tmp, job("SessionEnd", { reason: "exit" }));
    const old = new Date(Date.now() - 10_000);
    copyFileSync(f, `${f}.2147483646.running`);
    renameSync(f, `${f}.2147483647.running`);
    const dir = path.join(jobsDir(tmp), "zzz.json");
    mkdirSync(dir);
    for (const p of [`${f}.2147483646.running`, `${f}.2147483647.running`, dir]) utimesSync(p, old, old);
    expect(await sweepJobs(tmp, 3000)).toBe(1);
    expect(readdirSync(jobsDir(tmp))).toEqual([`zzz.json.${process.pid}.running`]);
  });
  it("the log turns over past 1 MiB", () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(path.join(tmp, "log"), "x".repeat(1024 * 1024 + 1));
    log(tmp, "next");
    expect(existsSync(path.join(tmp, "log.1"))).toBe(true);
    expect(readFileSync(path.join(tmp, "log"), "utf8")).toMatch(/ next\n$/);
  });
  it("the version is the one the build defines, else 0.0.0", async () => {
    expect(versionLine()).toBe("sessionpipe 0.0.0");
    vi.stubGlobal("__SESSIONPIPE_VERSION__", "9.9.9");
    try {
      vi.resetModules();
      const built = await import("../src/run.js");
      expect(built.versionLine()).toBe("sessionpipe 9.9.9");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
