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
import {
  claimJob,
  enqueueJob,
  hasJobs,
  jobKey,
  jobNames,
  jobsDir,
  log,
  logFailed,
  RAN_KEPT,
  runJob,
  SWEEP_READ,
  sweepJobs,
  versionLine,
} from "../src/run.js";

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
  it("a job whose environment names an asker writes delegated_by; the worker's own environment never does", async () => {
    const asker = "codex:0199a8c0-1111-7000-8000-000000000001";
    const asked = { ...job("SessionStart", { source: "startup" }), env: { SESSIONPIPE_ASKED_BY: asker } };
    expect((await runJob(asked, { state: tmp })).events[0]?.session.delegated_by).toBe(asker);
    vi.stubEnv("SESSIONPIPE_ASKED_BY", asker);
    const own = await runJob(job("SessionStart", { source: "startup" }), { state: tmp });
    expect(own.events[0]?.session.delegated_by).toBeUndefined();
  });
  it("a job whose environment names a rule writes triggered_by; the worker's own environment never does", async () => {
    const ran = { ...job("SessionStart", { source: "startup" }), env: { SESSIONPIPE_TRIGGERED_BY: "card-todo" } };
    expect((await runJob(ran, { state: tmp })).events[0]?.session.triggered_by).toBe("card-todo");
    vi.stubEnv("SESSIONPIPE_TRIGGERED_BY", "card-todo");
    const own = await runJob(job("SessionStart", { source: "startup" }), { state: tmp });
    expect(own.events[0]?.session.triggered_by).toBeUndefined();
  });
  it("the effort a Claude Code hook reports goes out with the session (#210)", async () => {
    const id = "4e960f0a-fc94-4b51-a223-9c810563a481";
    const stop = {
      ...job("Stop"),
      harness: "claude-code",
      argv: ["claude-code", "Stop"],
      stdin: JSON.stringify({ session_id: id, cwd: tmp, hook_event_name: "Stop", effort: { level: "xhigh" } }),
      env: { CLAUDE_CONFIG_DIR: tmp },
    };
    expect((await runJob(stop, { state: tmp })).events[0]?.session.effort).toBe("xhigh");
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
  // A rename keeps a file's own time, so a claim's age was its job's age: a job that had
  // waited over a minute was taken back from the worker running it by the next sweep, and
  // both ran it (its events twice) or both put it back (one job became two).
  it("a job that waited a minute for its turn is not taken back from the worker that claimed it", async () => {
    const f = enqueueJob(tmp, job("SessionEnd", { reason: "exit" }));
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 120_000);
    utimesSync(f, old, old);
    const c = claimJob(f);
    expect(Date.now() - statSync(c?.file as string).mtimeMs).toBeLessThan(10_000);
    expect(await sweepJobs(tmp, 0)).toBe(0);
    expect(readdirSync(jobsDir(tmp))).toEqual([path.basename(c?.file as string)]);
    const { events } = await runJob(c?.job as Parameters<typeof runJob>[0], { state: tmp, claimed: c?.file as string });
    expect(events.map((e) => e.type)).toEqual(["session.ended"]);
    expect(readdirSync(jobsDir(tmp))).toEqual([]);
  });
  it("a worker whose claim a sweep gave back stands down: it neither runs the job nor puts a second copy back", async () => {
    const { renameSync } = await import("node:fs");
    const ref = { harness: "codex", session: "race-1" };
    // Held up past any worker's life, its claim went back to the queue for another worker.
    const f = enqueueJob(tmp, job("SessionEnd", { reason: "exit" }));
    const c = claimJob(f);
    renameSync(c?.file as string, f);
    const ran = await runJob(c?.job as Parameters<typeof runJob>[0], { state: tmp, claimed: c?.file as string });
    expect(ran).toEqual({ events: [], delivered: {} });
    expect(readFileSync(path.join(tmp, "log"), "utf8")).toContain(
      "codex SessionEnd: its job went back to the queue while this worker was held up; left to the worker that has it",
    );
    expect(new Outbox(tmp).read(ref, 0, 100).events).toEqual([]);
    expect(readdirSync(jobsDir(tmp))).toEqual([path.basename(f)]);
    // The session's lock is free again for the worker that has the job now.
    const free = takeLock(tmp, ref);
    expect(free).not.toBeNull();
    // The same with the session busy: nothing is re-queued.
    try {
      const held = await runJob(c?.job as Parameters<typeof runJob>[0], {
        state: tmp,
        claimed: c?.file as string,
        lockWaitMs: 120,
      });
      expect(held).toEqual({ events: [], delivered: {} });
      expect(readdirSync(jobsDir(tmp))).toEqual([path.basename(f)]);
    } finally {
      free?.();
    }
  });
  // The same hook event can be in the queue twice: a worker held up past its claim and
  // the one that took its job over, a worker that ended between writing the events and
  // letting go of the claim, the copies an older sessionpipe left behind. Each run of it
  // comes under the session's lock, and only the first writes its events.
  it("a hook event is run once: a copy of its job is dropped, and so is its claim", async () => {
    const j = job("SessionEnd", { reason: "exit" });
    // A job an older hook wrote is told by its time and payload together.
    expect(jobKey(j)).toMatch(/^[0-9a-f]{16}$/);
    expect(jobKey({ ...j, tries: 7 })).toBe(jobKey(j));
    expect(jobKey({ ...j, at: j.at + 1 })).not.toBe(jobKey(j));
    expect((await runJob(j, { state: tmp })).events.map((e) => e.type)).toEqual(["session.ended"]);
    const c = claimJob(enqueueJob(tmp, { ...j, tries: 3 }));
    const again = await runJob(c?.job as Parameters<typeof runJob>[0], { state: tmp, claimed: c?.file as string });
    expect(again).toEqual({ events: [], delivered: {} });
    expect(readdirSync(jobsDir(tmp))).toEqual([]);
    expect(new Outbox(tmp).read({ harness: "codex", session: "race-1" }, 0, 100).events).toHaveLength(1);
    expect(readFileSync(path.join(tmp, "log"), "utf8")).toContain(
      "codex SessionEnd: a copy of a hook event already run; dropped",
    );
    // The same payload at another moment is another hook event.
    expect((await runJob({ ...j, at: j.at + 1 }, { state: tmp })).events).toHaveLength(1);
  });
  it("a job is told by the name its hook gave it: two alike to the byte are two hook events, a copy is one", async () => {
    const j = job("SessionEnd", { reason: "exit" });
    expect(jobKey({ ...j, id: "mwp38apb-ou02in" })).toBe("mwp38apb-ou02in");
    expect(jobKey({ ...j, id: "x".repeat(90) })).toBe("x".repeat(40));
    expect(jobKey({ ...j, id: "" })).toBe(jobKey(j));
    expect((await runJob({ ...j, id: "one" }, { state: tmp })).events).toHaveLength(1);
    expect((await runJob({ ...j, id: "two" }, { state: tmp })).events).toHaveLength(1);
    expect((await runJob({ ...j, id: "one", tries: 4 }, { state: tmp })).events).toHaveLength(0);
    expect(new Outbox(tmp).read({ harness: "codex", session: "race-1" }, 0, 100).events).toHaveLength(2);
  });
  it("a job that names no time is never taken for a copy", async () => {
    const j = { ...job("SessionEnd", { reason: "exit" }), at: undefined } as unknown as Parameters<typeof runJob>[0];
    expect(jobKey(j)).toBeUndefined();
    expect((await runJob(j, { state: tmp })).events).toHaveLength(1);
    expect((await runJob(j, { state: tmp })).events).toHaveLength(1);
  });
  it("a session remembers the last hook events it ran, and one whose copies keep coming stays remembered", async () => {
    const base = Date.now();
    const run = async (i: number) =>
      (await runJob({ ...job("SessionEnd", { reason: "exit" }), at: base + i }, { state: tmp, drain: false })).events
        .length;
    for (let i = 0; i < RAN_KEPT; i++) expect(await run(i)).toBe(1);
    // The oldest it remembers: a copy is dropped, and is the newest again.
    expect(await run(0)).toBe(0);
    expect(await run(RAN_KEPT)).toBe(1);
    expect(await run(0)).toBe(0);
    // The one that was oldest then has been forgotten: its copy would run.
    expect(await run(1)).toBe(1);
    // What is kept is a list of words, whatever the file held before.
    const facts = path.join(tmp, "facts", "codex", "race-1.json");
    const kept = JSON.parse(readFileSync(facts, "utf8"));
    expect(kept.ran).toHaveLength(RAN_KEPT);
    writeFileSync(facts, JSON.stringify({ ...kept, ran: [7, null, ...kept.ran.slice(0, 2)] }));
    expect(await run(1)).toBe(0);
    writeFileSync(facts, JSON.stringify({ ...kept, ran: "not a list" }));
    expect(await run(1)).toBe(1);
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

  it.each(["", "null", "[]", '["private-array-value"]', '"private-string-value"', "42", "{}"])(
    "logs no keys or values for an unclaimed non-object payload: %s",
    async (stdin) => {
      await runJob({ ...job("SessionStart"), stdin }, { state: tmp });
      const text = readFileSync(path.join(tmp, "log"), "utf8");
      expect(text).toContain("codex SessionStart:");
      expect(text).toContain("keys: (none)");
      expect(text).not.toContain("private-");
    },
  );

  // Issue #200: a payload that is not JSON was logged as one the adapter did not claim.
  it("logs the size of a payload that is not JSON, never its text", async () => {
    await runJob({ ...job("SessionStart"), stdin: "{ private-invalid-json" }, { state: tmp });
    const text = readFileSync(path.join(tmp, "log"), "utf8");
    expect(text).toContain("codex SessionStart: the payload (22 bytes) could not be read as JSON; event dropped");
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
  it("takes claude.ai's name for a session only once the person turned remote_titles on", async () => {
    const home = path.join(tmp, "rc-home");
    const config = path.join(home, ".claude-rc");
    const id = "44444444-4444-4444-8444-444444444444";
    mkdirSync(path.join(config, "projects", "-w"), { recursive: true });
    const transcript = path.join(config, "projects", "-w", `${id}.jsonl`);
    writeFileSync(
      transcript,
      `${[
        JSON.stringify({ type: "bridge-session", sessionId: id, bridgeSessionId: "cse_01Remote" }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-10-28T10:00:00.000Z",
          cwd: tmp,
          message: { content: "fleet?" },
        }),
      ].join("\n")}\n`,
    );
    writeFileSync(path.join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
    const f = vi.fn(
      async () =>
        new Response(JSON.stringify({ session: { id: "session_01Remote", title: "test_claude_fleet health check" } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", f);
    const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true }); // no keychain
    const state = path.join(tmp, "remote");
    const stop = () =>
      runJob(
        {
          harness: "claude-code",
          event: "Stop",
          argv: ["claude-code", "Stop"],
          stdin: JSON.stringify({ session_id: id, transcript_path: transcript, cwd: tmp, hook_event_name: "Stop" }),
          cwd: tmp,
          env: { HOME: home, CLAUDE_CONFIG_DIR: config },
          at: Date.now(),
        },
        { state },
      );
    const titles = (on: boolean) =>
      writeFileSync(
        process.env.SESSIONPIPE_CONFIG as string,
        JSON.stringify({ sinks: [], harnesses: {}, remote_titles: on }),
      );
    try {
      titles(false);
      expect((await stop()).events[0]?.session).toMatchObject({ title: "fleet?", title_source: "first-ask" });
      expect(f).not.toHaveBeenCalled();
      titles(true);
      expect((await stop()).events[0]?.session).toMatchObject({
        title: "test_claude_fleet health check",
        title_source: "harness",
        url: "https://claude.ai/code/session_01Remote",
      });
      expect(f).toHaveBeenCalledTimes(1);
      // A harness with no service to ask is left as it was.
      expect((await runJob(job("Stop"), { state })).events).toHaveLength(1);
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "platform", real);
      vi.unstubAllGlobals();
      titles(false);
    }
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
    "a copy of a hook event already run does not tell the daemon again: a Stop from before does not end the turn running now",
    async () => {
      mkdirSync(tmp, { recursive: true }); // the last test's cleanup took it
      const sock = path.join(tmp, "control.sock");
      const got: string[] = [];
      const server = net.createServer((c) =>
        c.once("data", (d) => {
          got.push(JSON.parse(d.toString("utf8").split("\n")[0] as string).event);
          c.end(`${JSON.stringify({ op: "ok" })}\n`);
        }),
      );
      await new Promise<void>((r) => server.listen(sock, () => r()));
      vi.stubEnv("SESSIONPIPE_SOCKET", sock);
      try {
        const stop = { ...job("Stop"), id: "stop-1" };
        expect((await runJob(stop, { state: tmp })).events.length).toBeGreaterThan(0);
        await runJob({ ...job("UserPromptSubmit", { prompt: "next" }), id: "prompt-2" }, { state: tmp });
        expect(got).toEqual(["Stop", "UserPromptSubmit"]);
        expect((await runJob({ ...stop, tries: 2 }, { state: tmp })).events).toEqual([]);
        expect(got).toEqual(["Stop", "UserPromptSubmit"]);
      } finally {
        vi.unstubAllEnvs();
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  );

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

  it.runIf(process.platform !== "win32")(
    "a Claude Code session's events say which thread, which tool call and which moment they are about",
    async () => {
      // What the daemon lets go of a held permission prompt by (CONTROL.md §7): a
      // session's hooks all report under its id, a subagent's tools among them.
      mkdirSync(tmp, { recursive: true });
      const sock = path.join(tmp, "control.sock");
      const got: Record<string, unknown>[] = [];
      const server = net.createServer((c) =>
        c.once("data", (d) => {
          got.push(JSON.parse(d.toString("utf8").split("\n")[0] as string));
          c.end(`${JSON.stringify({ op: "ok" })}\n`);
        }),
      );
      await new Promise<void>((r) => server.listen(sock, () => r()));
      vi.stubEnv("SESSIONPIPE_SOCKET", sock);
      try {
        const SID = "0851aacd-4686-4279-bb7f-fb8604508572";
        const SUB = "a42867b781ec114cb";
        const ws = path.join(tmp, "ws-claude");
        mkdirSync(ws, { recursive: true });
        let at = 1_794_371_357_000;
        const claude = (event: string, extra: Record<string, unknown> = {}) =>
          runJob(
            {
              harness: "claude-code",
              event,
              argv: ["claude-code", event],
              stdin: JSON.stringify({ session_id: SID, cwd: ws, ...extra }),
              cwd: ws,
              env: {},
              at: ++at,
            },
            { state: tmp },
          );
        const said = (event: string, more: Record<string, unknown>) => ({
          op: "event",
          session: `claude-code:${SID}`,
          event,
          cwd: ws,
          ...more,
        });
        await claude("UserPromptSubmit", { prompt: "go", permission_mode: "default" });
        await claude("PostToolUse", { tool_name: "Read", tool_use_id: "toolu_01CvZiCARP5rMi8pXcfL", agent_id: SUB });
        await claude("PostToolUseFailure", { tool_name: "Bash", tool_use_id: "toolu_01GoQcMkV7mkYk6sk1DE" });
        // Still in flight as the turn ends: a subagent, and sessionpipe's own waiter, which is no work.
        await claude("Stop", {
          background_tasks: [
            { id: SUB, type: "subagent", status: "running" },
            { id: "b1", type: "shell", status: "running", command: "sessionpipe wait" },
          ],
        });
        await claude("Stop", {});
        await claude("SubagentStop", { agent_id: SUB, background_tasks: [{ id: SUB, type: "subagent" }] });
        // A tool whose name is no name is no tool.ended, and still says whose it was.
        await claude("PostToolUse", { tool_name: "not a name", tool_use_id: 7, agent_id: SUB });
        await claude("SessionEnd", { reason: "exit" });
        expect(got).toEqual([
          said("UserPromptSubmit", { mode: "default", agent: "", at: 1_794_371_357_001 }),
          said("PostToolUse", { agent: SUB, call: "toolu_01CvZiCARP5rMi8pXcfL", at: 1_794_371_357_002 }),
          said("PostToolUseFailure", { agent: "", call: "toolu_01GoQcMkV7mkYk6sk1DE", at: 1_794_371_357_003 }),
          said("Stop", { agent: "", at: 1_794_371_357_004, background: 1 }),
          said("Stop", { agent: "", at: 1_794_371_357_005 }),
          said("SubagentStop", { agent: SUB, at: 1_794_371_357_006 }),
          said("PostToolUse", { agent: SUB, at: 1_794_371_357_007 }),
          said("SessionEnd", { agent: "", at: 1_794_371_357_008 }),
        ]);
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
  it("the jobs folder's first names, never more than asked for; none when there is no folder", () => {
    expect(jobNames(path.join(tmp, "nowhere"), 10)).toEqual([]);
    const made = [0, 1, 2, 3, 4].map(() => path.basename(enqueueJob(tmp, job("Stop"))));
    expect(jobNames(tmp, 10).sort()).toEqual(made.slice().sort());
    expect(jobNames(tmp, 5)).toHaveLength(5);
    const three = jobNames(tmp, 3);
    expect(three).toHaveLength(3);
    expect(made).toEqual(expect.arrayContaining(three));
    expect(jobNames(tmp, 0)).toEqual([]);
  });
  // Every worker sweeps, and a sweep listed and sorted the whole folder: with 152 800 jobs
  // waiting (2026-11-20) 800 workers held one another on that listing for minutes. A sweep
  // now reads SWEEP_READ names at most, and a folder holding more is still emptied.
  it("a folder that holds more jobs than a sweep reads is emptied all the same, twenty a sweep", async () => {
    const state = path.join(tmp, "behind");
    mkdirSync(jobsDir(state), { recursive: true });
    const all = SWEEP_READ + 45;
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 10_000);
    for (let i = 0; i < all; i++) {
      const f = path.join(jobsDir(state), `${(1000 + i).toString(36)}-behind.json`);
      writeFileSync(
        f,
        JSON.stringify({ harness: "no-such-harness", event: "Stop", argv: [], stdin: "{}", cwd: tmp, env: {}, at: 1 }),
      );
      utimesSync(f, old, old);
    }
    let ran = 0;
    let sweeps = 0;
    for (let n = await sweepJobs(state, 0); n > 0; n = await sweepJobs(state, 0)) {
      expect(n).toBeLessThanOrEqual(20);
      ran += n;
      sweeps++;
    }
    expect(ran).toBe(all);
    expect(sweeps).toBe(Math.ceil(all / 20));
    expect(readdirSync(jobsDir(state))).toEqual([]);
  });
  it("a swept job whose run throws is let go of and said in the log, with the error's words and nothing of the payload", async () => {
    const state = path.join(tmp, "broken");
    // The session's seq counter cannot be written: a folder is where its file should be.
    mkdirSync(path.join(state, "outbox", "codex", "race-1.seq"), { recursive: true });
    const f = enqueueJob(state, job("SessionEnd", { reason: "exit", secret: "hunter2-in-the-payload" }));
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 10_000);
    utimesSync(f, old, old);
    expect(await sweepJobs(state, 3000)).toBe(1);
    expect(readdirSync(jobsDir(state))).toEqual([]);
    const said = readFileSync(path.join(state, "log"), "utf8");
    // What the system said about a file is a code and a path: kept whole.
    expect(said).toMatch(/codex SessionEnd: the job failed and is not run again: Error: E[A-Z]+: /);
    expect(said).not.toContain("hunter2");
    const last = () => (readFileSync(path.join(state, "log"), "utf8").trim().split("\n").pop() as string).slice(25);
    // Any other error can quote what it failed on, and that can be a payload's: its kind and
    // where it was thrown, never its words.
    const quoting = (() => {
      try {
        return JSON.parse("rm -rf / --password=hunter2");
      } catch (e) {
        return e;
      }
    })();
    expect(String((quoting as Error).message)).toContain("rm -rf");
    logFailed(state, { harness: "codex", event: "Stop" }, quoting);
    expect(last()).toMatch(/^codex Stop: the job failed and is not run again: SyntaxError at \S/);
    expect(last()).not.toMatch(/rm -rf|hunter2/);
    // Nor when its words hold a line that looks like where it was thrown.
    for (const words of ["boom\n    at password=hunter2", "x\n  at sk-live-SECRET (rm -rf /)\n    at more"]) {
      logFailed(state, { harness: "codex", event: "Stop" }, new TypeError(words));
      expect(last()).toMatch(/^codex Stop: the job failed and is not run again: TypeError at \S/);
      expect(last()).not.toMatch(/hunter2|SECRET|rm -rf/);
      expect(last()).toMatch(/run\.test\.ts|node:|file:/);
    }
    // One Node names by a code of its own keeps the code.
    logFailed(
      state,
      { harness: "codex", event: "Stop" },
      Object.assign(new RangeError("Cannot create a string longer than 0x1fffffe8 characters"), {
        code: "ERR_STRING_TOO_LONG",
      }),
    );
    expect(last()).toMatch(
      /^codex Stop: the job failed and is not run again: RangeError \[ERR_STRING_TOO_LONG\] at \S/,
    );
    // An error with no stack, and something thrown that is no error: said as that, nothing of it kept.
    const bare = new Error("secret words");
    delete bare.stack;
    logFailed(state, { harness: "codex", event: "Stop" }, bare);
    expect(last()).toBe("codex Stop: the job failed and is not run again: Error at an unknown place");
    logFailed(state, { harness: "codex", event: "Stop" }, `only\nwords ${"w".repeat(900)}`);
    expect(last()).toBe("codex Stop: the job failed and is not run again: something that is not an error was thrown");
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
