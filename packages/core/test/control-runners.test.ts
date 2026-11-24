// SPDX-License-Identifier: Apache-2.0
// Codex and Antigravity as the control daemon drives them (CONTROL.md §6): the command
// lines per mode, and their output read line by line. The lines follow the shapes
// measured from codex-cli 0.160.0 and agy 1.2.16 on 2026-10-04 (Codex's two warning
// items verbatim from a run in a box); the texts in them are made up.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  agyArgs,
  agyEnv,
  agyError,
  agyLine,
  reading as agyReading,
  findAgy,
} from "../src/adapters/antigravity-control.js";
import {
  codexArgs,
  codexEnv,
  codexLine,
  codexLocks,
  codexLogin,
  codexQueue,
  reading as codexReading,
  codexRuleReading,
  findCodex,
  findRollout,
  heldElsewhere,
  lastTurn,
  threadLocked,
} from "../src/adapters/codex-control.js";
import { drivableHarnesses, runHeadless } from "../src/adapters/index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-runners-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const j = (o: unknown) => JSON.stringify(o);
const THREAD = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c";
const CONV = "5d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";

/** A codex exec --json run, in codex-cli 0.160.0's shapes. */
const CODEX_RUN = [
  j({ type: "thread.started", thread_id: THREAD }),
  j({
    type: "item.completed",
    item: {
      id: "item_0",
      type: "error",
      message:
        "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.",
    },
  }),
  j({
    type: "item.completed",
    item: { id: "item_2", type: "error", message: "clamping SessionEnd hook timeout to 3s in /root/.codex/hooks.json" },
  }),
  j({ type: "turn.started" }),
  j({ type: "item.completed", item: { id: "item_3", type: "reasoning", text: "**Listing files**" } }),
  j({ type: "item.completed", item: { id: "item_4", type: "agent_message", text: "I'll look at the folder." } }),
  j({
    type: "item.started",
    item: { id: "item_5", type: "command_execution", command: "ls", aggregated_output: "", status: "in_progress" },
  }),
  j({
    type: "item.completed",
    item: {
      id: "item_5",
      type: "command_execution",
      command: "ls",
      aggregated_output: "a.txt\n",
      exit_code: 0,
      status: "completed",
    },
  }),
  j({ type: "item.completed", item: { id: "item_6", type: "agent_message", text: "There is one file, a.txt." } }),
  j({ type: "turn.completed", usage: { input_tokens: 9120, cached_input_tokens: 0, output_tokens: 41 } }),
];

/** An agy -p --output-format stream-json run, in agy 1.2.16's shapes. */
const AGY_RUN = [
  j({ event: "init", conversation_id: CONV, init: { cwd: "/work/app", permission_mode: "default" } }),
  j({
    event: "step_update",
    step_update: { conversation_id: CONV, step_index: 0, state: "DONE", step_type: "user_input" },
  }),
  j({
    event: "step_update",
    step_update: {
      conversation_id: CONV,
      step_index: 1,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: "Checking ",
    },
  }),
  j({
    event: "step_update",
    step_update: {
      conversation_id: CONV,
      step_index: 1,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "the folder.",
    },
  }),
  j({ event: "step_update", step_update: { conversation_id: CONV, step_index: 2, state: "DONE", step_type: "tool" } }),
  j({
    event: "step_update",
    step_update: {
      conversation_id: CONV,
      step_index: 3,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "One file.",
    },
  }),
  j({
    event: "result",
    result: {
      conversation_id: CONV,
      status: "SUCCESS",
      response: "Checking the folder.\n\nOne file.",
      error: "",
      denied_actions: [{ tool_name: "run_command" }],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  }),
];

describe("codex exec --json", () => {
  it("command lines: a new session in its folder, a resume by id, the text after --", () => {
    expect(codexArgs({ permission: "safe", prompt: "-v fix it", cwd: "/w" })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "/w",
      "-s",
      "workspace-write",
      "--",
      "-v fix it",
    ]);
    // `codex exec resume` takes neither -s nor --approve-for-me (0.160 refuses them as
    // unexpected arguments): a resume says the same in config overrides.
    expect(codexArgs({ permission: "auto", prompt: "go on", resume: THREAD })).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="on-request"',
      "-c",
      'approvals_reviewer="auto_review"',
      "--",
      THREAD,
      "go on",
    ]);
    expect(codexArgs({ permission: "safe", prompt: "go on", resume: THREAD }).join(" ")).toContain(
      '-c sandbox_mode="workspace-write" --',
    );
    expect(codexArgs({ permission: "auto", prompt: "x", cwd: "/w" })).toContain("--approve-for-me");
    expect(codexArgs({ permission: "safe", prompt: "x" })).not.toContain("-C");
    // Inherit: no sandbox or approval flag and no config override, a new session's or a
    // resume's, so the person's own config.toml decides.
    expect(codexArgs({ permission: "inherit", prompt: "x", cwd: "/w" })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "/w",
      "--",
      "x",
    ]);
    expect(codexArgs({ permission: "inherit", prompt: "go on", resume: THREAD })).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--",
      THREAD,
      "go on",
    ]);
    // Never a bypass flag, at any level or in inherit, a new session's or a resume's.
    for (const permission of ["read", "safe", "edits", "auto", "inherit"] as const)
      for (const o of [{ cwd: "/w" }, { resume: THREAD }])
        expect(codexArgs({ permission, prompt: "x", ...o }).join(" ")).not.toMatch(/dangerously|full-auto/);
  });

  it("reads the id, the messages, and error items as warnings", () => {
    expect(codexLine(CODEX_RUN[0] as string)).toEqual({ session: THREAD });
    expect(codexLine(CODEX_RUN[1] as string)).toHaveProperty("warning");
    expect(codexLine(CODEX_RUN[4] as string)).toBeNull(); // reasoning
    expect(codexLine(CODEX_RUN[5] as string)).toEqual({ message: "I'll look at the folder." });
    expect(codexLine(j({ type: "turn.failed", error: { message: "usage limit" } }))).toEqual({
      done: true,
      failed: "usage limit",
    });
    expect(codexLine(j({ type: "error", message: "Reconnecting... 2/5 (stream disconnected)" }))).toEqual({
      note: "Reconnecting... 2/5 (stream disconnected)",
    });
    expect(codexLine("Reading additional input from stdin...")).toBeNull();
    const r = codexReading();
    const changed = CODEX_RUN.map((l) => r.feed(l));
    expect(changed.filter(Boolean)).toHaveLength(2);
    expect(r.session).toBe(THREAD);
    expect(r.warnings).toHaveLength(2);
    expect(r.outcome({ code: 0, signal: null, stderr: "" })).toEqual({
      reply: "I'll look at the folder.\n\nThere is one file, a.txt.",
    });
  });

  it("fails on turn.failed, or on a non-zero exit that said nothing — never on a warning", () => {
    const failed = codexReading();
    for (const l of [CODEX_RUN[0], j({ type: "turn.failed", error: { message: "You've hit your usage limit." } })])
      failed.feed(l as string);
    expect(failed.outcome({ code: 1 })).toEqual({ failed: "You've hit your usage limit." });

    const silent = codexReading();
    for (const l of [CODEX_RUN[0], CODEX_RUN[1], j({ type: "error", message: "Reconnecting... 5/5" })])
      silent.feed(l as string);
    expect(silent.outcome({ code: 1, signal: null, stderr: "Reading additional input from stdin...\n" })).toEqual({
      failed: "Codex exited (code 1) without an answer: Reconnecting... 5/5",
    });
    const quiet = codexReading();
    quiet.feed(CODEX_RUN[0] as string);
    expect(
      quiet.outcome({ code: 2, stderr: "Reading additional input from stdin...\nerror: no such session\n" }),
    ).toEqual({ failed: "Codex exited (code 2) without an answer: error: no such session" });
    // A message, then a non-zero exit: the answer stands.
    const said = codexReading();
    said.feed(CODEX_RUN[5] as string);
    expect(said.outcome({ code: 1 })).toEqual({ reply: "I'll look at the folder." });
    expect(codexReading().outcome({ error: "spawn ENOENT" })).toEqual({ failed: "couldn't start Codex: spawn ENOENT" });
    expect(codexReading().outcome({ timedOut: true, code: null, signal: "SIGTERM" })).toHaveProperty("failed");
  });

  // Runs a fake executable (a shell script), as the spawn test below does: POSIX only.
  it.runIf(process.platform !== "win32")(
    "login: CODEX_API_KEY is enough; else `codex login status` decides by exit code",
    async () => {
      const bin = path.join(tmp, "codex-login");
      const say = (code: number) =>
        writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "login status" ] || exit 9\necho "Not logged in"\nexit ${code}\n`);
      say(1);
      chmodSync(bin, 0o755);
      expect(await codexLogin(bin, { PATH: process.env.PATH })).toEqual({ loggedIn: false });
      expect(await codexLogin(bin, { PATH: process.env.PATH, CODEX_API_KEY: "sk-test" })).toMatchObject({
        loggedIn: true,
      });
      say(0);
      expect(await codexLogin(bin, { PATH: process.env.PATH })).toEqual({ loggedIn: true });
      expect(await codexLogin(path.join(tmp, "nope"), {})).toEqual({ loggedIn: null });
    },
  );

  it("finds a thread's rollout by its exact id, never by a fragment", () => {
    const home = path.join(tmp, "codex-home");
    const day = path.join(home, "sessions", "2026", "10", "04");
    mkdirSync(day, { recursive: true });
    const f = path.join(day, `rollout-2026-10-04T10-00-00-${THREAD}.jsonl`);
    writeFileSync(f, "");
    expect(findRollout(THREAD, { CODEX_HOME: home })).toBe(f);
    expect(findRollout("0199b6f2", { CODEX_HOME: home })).toBeNull();
    expect(findRollout("-", { CODEX_HOME: home })).toBeNull();
  });
});

describe("agy --output-format stream-json", () => {
  it("command lines: a conversation in the folder it runs in, --conversation to go on", () => {
    expect(agyArgs({ permission: "safe", prompt: "hi" })).toEqual(["-p", "hi", "--output-format", "stream-json"]);
    expect(agyArgs({ permission: "auto", prompt: "go on", resume: CONV })).toEqual([
      "--conversation",
      CONV,
      "-p",
      "go on",
      "--output-format",
      "stream-json",
      "--mode",
      "accept-edits",
    ]);
    // A message that starts with a dash is still the prompt.
    expect(agyArgs({ permission: "safe", prompt: "--help me" })[1]).toBe(" --help me");
    // Inherit: no permission flag, as in safe.
    expect(agyArgs({ permission: "inherit", prompt: "go on", resume: CONV })).toEqual([
      "--conversation",
      CONV,
      "-p",
      "go on",
      "--output-format",
      "stream-json",
    ]);
    for (const permission of ["safe", "edits", "auto", "inherit"] as const)
      expect(agyArgs({ permission, prompt: "x" }).join(" ")).not.toMatch(/dangerously|skip-permissions/);
  });

  it("reads the id, the text as it streams (a paragraph per response step), the result", () => {
    expect(agyLine(AGY_RUN[0] as string)).toEqual({ session: CONV });
    expect(agyLine(AGY_RUN[2] as string)).toEqual({ session: CONV, delta: { step: 1, text: "Checking " } });
    const r = agyReading();
    const texts: string[] = [];
    for (const l of AGY_RUN) if (r.feed(l)) texts.push(r.text);
    expect(texts).toEqual(["Checking ", "Checking the folder.", "Checking the folder.\n\nOne file."]);
    expect(r.session).toBe(CONV);
    expect(r.outcome({ code: 0 })).toEqual({
      reply:
        "Checking the folder.\n\nOne file.\n\n(Not allowed on this machine, since nobody was there to approve: run_command.)",
    });
  });

  it("an ERROR result reports its error; no result reports AGY_ERROR from stderr", () => {
    const r = agyReading();
    r.feed(AGY_RUN[0] as string);
    r.feed(
      j({
        event: "result",
        result: { conversation_id: CONV, status: "ERROR", response: "", error: "quota exceeded", denied_actions: [] },
      }),
    );
    expect(r.outcome({ code: 3 })).toEqual({ failed: "quota exceeded" });
    const none = agyReading();
    none.feed(AGY_RUN[0] as string);
    const stderr =
      'warning: something\nAGY_ERROR: {"code":"UNAUTHENTICATED","message":"Sign in to Antigravity first"}\n';
    expect(agyError(stderr)).toBe("Sign in to Antigravity first");
    expect(none.outcome({ code: 3, signal: null, stderr })).toEqual({
      failed: "Antigravity exited (code 3) without an answer: Sign in to Antigravity first",
    });
  });
});

describe("finding the binaries, and running one", () => {
  // Runs a fake executable (a shell script), as the spawn test below does: POSIX only.
  it.runIf(process.platform !== "win32")(
    "SESSIONPIPE_CODEX / SESSIONPIPE_AGY first, then PATH, then the installers' folders",
    () => {
      const bin = path.join(tmp, "bin");
      mkdirSync(bin, { recursive: true });
      for (const n of ["codex", "agy", "my-codex"]) {
        writeFileSync(path.join(bin, n), "#!/bin/sh\n");
        chmodSync(path.join(bin, n), 0o755);
      }
      const empty = path.join(tmp, "empty");
      mkdirSync(empty, { recursive: true });
      expect(findCodex({ PATH: bin }, empty, empty)).toBe(path.join(bin, "codex"));
      expect(findCodex({ PATH: empty, SESSIONPIPE_CODEX: path.join(bin, "my-codex") }, empty, empty)).toBe(
        path.join(bin, "my-codex"),
      );
      // Beside the node that runs the daemon (an npm install -g there).
      expect(findCodex({ PATH: empty }, empty, bin)).toBe(path.join(bin, "codex"));
      expect(findAgy({ PATH: bin }, empty)).toBe(path.join(bin, "agy"));
      const home = path.join(tmp, "home");
      mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
      writeFileSync(path.join(home, ".local", "bin", "agy"), "#!/bin/sh\n");
      chmodSync(path.join(home, ".local", "bin", "agy"), 0o755);
      expect(findAgy({ PATH: empty }, home)).toBe(path.join(home, ".local", "bin", "agy"));
      expect(drivableHarnesses({ PATH: bin, SESSIONPIPE_CLAUDE: path.join(bin, "codex") })).toEqual(
        expect.arrayContaining(["claude-code", "codex", "antigravity"]),
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "runHeadless streams every line, keeps only what it is told, and closes stdin",
    async () => {
      const bin = path.join(tmp, "talk");
      writeFileSync(
        bin,
        `#!/bin/sh\nread x && echo "stdin open: $x" >&2\nprintf '{"a":1}\\n{"type":"result"}\\n{"b":2}'\nexit 0\n`,
      );
      chmodSync(bin, 0o755);
      const lines: string[] = [];
      const res = await runHeadless(bin, [], { cwd: tmp, env: process.env, onLine: (l) => lines.push(l) });
      expect(lines).toEqual(['{"a":1}', '{"type":"result"}', '{"b":2}']);
      expect(res.stdout).toBe("");
      expect(res.stderr).not.toContain("stdin open");
      const kept = await runHeadless(bin, [], {
        cwd: tmp,
        env: process.env,
        onLine: () => {},
        keep: (l) => l.includes("result"),
      });
      expect(kept.stdout).toBe('{"type":"result"}');
    },
  );
});

describe("the readers on lines they were not measured on", () => {
  it("codexLine: anything that is not one of its shapes is nothing; a turn.failed without words still fails", () => {
    for (const l of [
      "5",
      "null",
      "[]",
      j({ type: "thread.started" }),
      j({ type: "item.completed", item: { type: "error" } }),
      j({ type: "item.completed", item: { type: "todo_list" } }),
      j({ type: "error" }),
      j({ type: "something.else" }),
    ])
      expect(codexLine(l)).toBeNull();
    expect(codexLine(j({ type: "turn.failed" }))).toEqual({ done: true, failed: "Codex reported an error" });
    expect(codexEnv({ A: "1" })).toEqual({ A: "1", SESSIONPIPE_CONTROL_JOB: "1" });
  });
  it("codex outcome: a clean exit with no words is a placeholder; a silent failure's reason is the last warning, or none", () => {
    expect(codexReading().outcome({ code: 0 })).toEqual({ reply: "(Codex finished without a written reply.)" });
    const warned = codexReading();
    warned.feed(CODEX_RUN[1] as string);
    expect(warned.outcome({ code: 1, stderr: "" })).toEqual({
      failed: expect.stringContaining("without an answer: `--dangerously-bypass-hook-trust`"),
    });
    expect(codexReading().outcome({ code: 1 })).toEqual({ failed: "Codex exited (code 1) without an answer" });
    const many = codexReading();
    for (let i = 0; i < 25; i++) many.feed(CODEX_RUN[1] as string);
    expect(many.warnings).toHaveLength(20);
  });
  it("agyLine: the id from a step or the result, an error step's words, nothing for the rest", () => {
    for (const l of [
      "5",
      "null",
      j({ event: "other" }),
      j({ event: "init" }),
      j({ event: "step_update", step_update: { step_type: "tool" } }),
    ])
      expect(agyLine(l)).toBeNull();
    expect(
      agyLine(
        j({ event: "step_update", step_update: { conversation_id: CONV, step_type: "error_message", error: "quota" } }),
      ),
    ).toEqual({ session: CONV, note: "quota" });
    expect(agyLine(j({ event: "step_update", step_update: { step_type: "error_message", message: "m" } }))).toEqual({
      note: "m",
    });
    expect(agyLine(j({ event: "step_update", step_update: { step_type: "error_message" } }))).toBeNull();
    expect(agyLine(j({ event: "result" }))).toEqual({ result: { status: "", response: "", error: "", denied: [] } });
    expect(agyEnv({ A: "1" })).toEqual({ A: "1", SESSIONPIPE_CONTROL_JOB: "1" });
  });
  it("agyError: nothing without the marker, the first line of what isn't JSON, the raw line of JSON without words", () => {
    expect(agyError("")).toBe("");
    expect(agyError("AGY_ERROR:")).toBe("");
    expect(agyLine("not json")).toBeNull();
    expect(agyReading().feed("not json")).toBe(false);
    expect(agyLine(j({ event: "step_update" }))).toBeNull();
    expect(agyLine(j({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "t" } }))).toEqual(
      {
        delta: { step: 0, text: "t" },
      },
    );
    expect(agyError("x\nAGY_ERROR: not json\nmore")).toBe("not json");
    expect(agyError('AGY_ERROR: {"code":"X"}')).toBe('{"code":"X"}');
    expect(agyError('AGY_ERROR: {"detail":"d"}')).toBe("d");
  });
  it("agy outcome: no result reports the error step or nothing; a failed status without words falls back; the text when the result has none", () => {
    const noted = agyReading();
    noted.feed(j({ event: "step_update", step_update: { step_type: "error_message", text_delta: "no quota" } }));
    expect(noted.outcome({ code: 2 })).toEqual({ failed: "Antigravity exited (code 2) without an answer: no quota" });
    expect(agyReading().outcome({ code: null, signal: "SIGKILL" })).toEqual({
      failed: "Antigravity exited (SIGKILL) without an answer",
    });
    expect(agyReading().outcome({ error: "spawn ENOENT" })).toEqual({
      failed: "couldn't start Antigravity: spawn ENOENT",
    });
    const bad = agyReading();
    bad.feed(j({ event: "result", result: { status: "ERROR" } }));
    expect(bad.outcome({ code: 1 })).toEqual({ failed: "Antigravity reported an error" });
    expect(bad.outcome({ code: 1, stderr: 'AGY_ERROR: {"message":"stderr says"}' })).toEqual({ failed: "stderr says" });
    bad.feed(j({ event: "step_update", step_update: { step_type: "error_message", text_delta: "noted" } }));
    expect(bad.outcome({ code: 1 })).toEqual({ failed: "noted" });
    const streamed = agyReading();
    streamed.feed(
      j({ event: "step_update", step_update: { step_index: 1, step_type: "agent_response", text_delta: "Hi.\n\n" } }),
    );
    streamed.feed(
      j({ event: "step_update", step_update: { step_index: 3, step_type: "agent_response", text_delta: "Bye." } }),
    );
    streamed.feed(
      j({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "  ",
          denied_actions: ["rm", { name: "edit" }, { x: 1 }, 7, { tool: "" }],
        },
      }),
    );
    expect(streamed.outcome({ code: 0 })).toEqual({
      reply: "Hi.\n\nBye.\n\n(Not allowed on this machine, since nobody was there to approve: rm, edit.)",
    });
    const silent = agyReading();
    silent.feed(j({ event: "result", result: { status: "SUCCESS" } }));
    expect(silent.outcome({ code: 0 })).toEqual({ reply: "(Antigravity finished without a written reply.)" });
  });
  it("drivableHarnesses reads this machine's PATH when given none", () => {
    expect(Array.isArray(drivableHarnesses())).toBe(true);
  });
});

describe("an npm codex.cmd shim (#165)", () => {
  it("codexLogin asks the shim's own script under this node, with no shell", async () => {
    const dir = path.join(tmp, "codex-shim");
    const cli = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, `process.exit(process.argv.slice(2).join(" ") === "login status" ? 1 : 9);\n`);
    const shim = path.join(dir, "codex.cmd");
    writeFileSync(shim, `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`);
    expect(await codexLogin(shim, { PATH: process.env.PATH })).toEqual({ loggedIn: false });
  });
});

// The stream as the real CLI prints it (the stand-in above is in 0.160.0's shapes):
// recorded on codex-cli 0.171.0 with the commands the daemon runs.
describe("codex exec --json as recorded (conformance/control-codex-exec-stream.json)", () => {
  const recorded = JSON.parse(
    readFileSync(new URL("../../../conformance/control-codex-exec-stream.json", import.meta.url), "utf8"),
  ) as {
    runs: {
      name: string;
      exit: number;
      lines: string[];
      expect: { session: string; warnings: number; reply?: string; failed?: string };
    }[];
  };
  it.each(recorded.runs)("$name: the thread, the warnings, and the answer or the failure", (run) => {
    const r = codexReading();
    for (const line of run.lines) r.feed(line);
    expect(r.session).toBe(run.expect.session);
    expect(r.warnings).toHaveLength(run.expect.warnings);
    expect(r.outcome({ code: run.exit, signal: null, stderr: "" })).toEqual(
      run.expect.reply !== undefined ? { reply: run.expect.reply } : { failed: run.expect.failed },
    );
    // Every line is one the reader knows what to make of, or one it passes over: none throws.
    expect(run.lines.map((l) => typeof codexLine(l))).toEqual(run.lines.map(() => "object"));
  });
  it("holds the four runs a daemon meets: a start, a resume, a turn refused at once, and one retried first", () => {
    expect(recorded.runs.map((r) => [r.name, r.exit, r.expect.reply !== undefined])).toEqual([
      ["start", 0, true],
      ["resume", 0, true],
      ["refused", 1, false],
      ["retried", 1, false],
    ]);
    // A command that failed inside a turn that finished is not a failed turn.
    expect(recorded.runs[0]?.lines.some((l) => l.includes('"status":"failed"'))).toBe(true);
  });
});

// A thread a live Codex process has open (CONTROL.md §6.4), as codex-cli 0.171.0 answered
// on 2026-11-24: a second writer's refusal, `codex queue`'s own two lines, and the turn
// records a headless run and a window leave in a rollout.
describe("a thread a live Codex process holds", () => {
  const OTHER = "0199c0de-1111-7222-8333-944455556666";
  const refusal = (thread: string) =>
    [
      "warning: Untrusted project-local configuration is disabled. Run `codex exec --trust` to allow project configuration and MCP servers for this and future chats in the project, including MCP commands outside the sandbox. Explicitly untrusted projects must have their trust setting updated first.",
      `2026-11-24T21:25:11.777334Z ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: thread ${thread} already has an active writer`,
      `2026-11-24T21:25:11.777398Z ERROR codex_core::session: Failed to create session: thread-store conflict: thread ${thread} already has an active writer`,
      `Error: thread/resume: thread/resume failed: thread ${thread} already has an active writer (code -32600)`,
      "",
    ].join("\n");

  it("heldElsewhere: Codex's own refusal of a second writer for this thread, and no other failure", () => {
    expect(heldElsewhere({ code: 1, stdout: "", stderr: refusal(THREAD) }, THREAD)).toBe(true);
    expect(heldElsewhere({ code: 1, stderr: refusal(THREAD) }, THREAD.toUpperCase())).toBe(true);
    // The same words from a run that did not end that way, about another thread, another
    // refusal, and no words.
    expect(heldElsewhere({ code: 0, stderr: refusal(THREAD) }, THREAD)).toBe(false);
    expect(heldElsewhere({ code: null, signal: "SIGTERM", stderr: refusal(THREAD) }, THREAD)).toBe(false);
    expect(heldElsewhere({ code: 1, stderr: refusal(OTHER) }, THREAD)).toBe(false);
    expect(
      heldElsewhere({ code: 1, stderr: "Error: thread/resume: thread/resume failed: no rollout found" }, THREAD),
    ).toBe(false);
    expect(heldElsewhere({ code: 1 }, THREAD)).toBe(false);
  });

  it("threadLocked: the thread's own lock file is there, or it is not", () => {
    const home = path.join(tmp, "codex-locks");
    mkdirSync(home, { recursive: true });
    expect(threadLocked(THREAD, { CODEX_HOME: home })).toBe(false);
    // The folder alone (it stays once any thread was opened), and another thread's file.
    mkdirSync(path.join(home, "thread-writer-locks"));
    writeFileSync(path.join(home, "thread-writer-locks", ".coordination.lock"), "");
    writeFileSync(path.join(home, "thread-writer-locks", `${OTHER}.lock`), "");
    expect(threadLocked(THREAD, { CODEX_HOME: home })).toBe(false);
    writeFileSync(path.join(home, "thread-writer-locks", `${THREAD}.lock`), "");
    expect(threadLocked(THREAD, { CODEX_HOME: home })).toBe(true);
    expect(threadLocked(THREAD.toUpperCase(), { CODEX_HOME: home })).toBe(true);
    // A name that is no thread id is never looked for.
    expect(threadLocked("../thread-writer-locks/x", { CODEX_HOME: home })).toBe(false);
    expect(threadLocked("", { CODEX_HOME: home })).toBe(false);
    // Asked of this process's own environment when none is given.
    vi.stubEnv("CODEX_HOME", home);
    try {
      expect(threadLocked(THREAD)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // A stand-in `codex` as npm leaves it on Windows (a .cmd naming its script), which runs
  // under this node on every platform, with no shell.
  const dir = path.join(tmp, "codex-queue");
  const cli = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
  const shim = path.join(dir, "codex.cmd");
  const seen = path.join(dir, "seen.json");
  const stand = (body: string) => {
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(
      cli,
      `const fs = require("fs");\nconst a = process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: a, job: process.env.SESSIONPIPE_CONTROL_JOB || null, home: process.env.CODEX_HOME || null }));\n${body}\n`,
    );
    writeFileSync(shim, `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`);
  };

  it("codexLocks: the binary's own version says whether another process's lock stops it", () => {
    const says = (text: string, code = 0) => {
      stand(`process.stdout.write(${JSON.stringify(text)}); process.exit(${code});`);
      return codexLocks(shim, { PATH: process.env.PATH });
    };
    expect(says("codex-cli 0.171.0\n")).toBe(true);
    expect(JSON.parse(readFileSync(seen, "utf8")).argv).toEqual(["--version"]);
    expect(says("codex-cli 0.171.3\n")).toBe(true);
    expect(says("codex-cli 0.172.0\n")).toBe(true);
    expect(says("codex-cli 1.0.0\n")).toBe(true);
    // Before the version it was measured on, a binary that says no version, one that fails.
    expect(says("codex-cli 0.170.9\n")).toBe(false);
    expect(says("codex-cli 0.99.12\n")).toBe(false);
    expect(says("codex\n")).toBe(false);
    expect(says("codex-cli 0.171.0\n", 3)).toBe(false);
    expect(codexLocks(path.join(dir, "no-codex-here"), {})).toBe(false);
    // With this process's own environment when none is given.
    stand(`process.stdout.write("codex-cli 0.171.0");`);
    expect(codexLocks(shim)).toBe(true);
  });

  it("lastTurn: how the thread's last turn stands, however far back its start is", () => {
    const f = path.join(tmp, "last-turn.jsonl");
    const at = "2026-11-24T21:25:52.381Z";
    const began = (turn_trigger?: string) =>
      j({
        timestamp: at,
        type: "event_msg",
        payload: { type: "task_started", ...(turn_trigger ? { turn_attribution: { turn_trigger } } : {}) },
      });
    const over = (type: string) => j({ type: "event_msg", payload: { type } });
    const meta = j({ type: "session_meta", payload: { id: THREAD } });
    const is = (...rows: string[]) => {
      writeFileSync(f, `${[meta, ...rows].join("\n")}\n`);
      const t = lastTurn(f);
      return t && { open: t.open, trigger: t.trigger, at: t.at };
    };
    const running = (trigger: string | null) => ({ open: true, trigger, at: Date.parse(at) });
    const done = { open: false, trigger: null, at: 0 };
    expect(is(began("exec"))).toEqual(running("exec"));
    expect(is(began("user"))).toEqual(running("user"));
    expect(is(began("queue"))).toEqual(running("queue"));
    // What the turn wrote meanwhile changes nothing; neither does a line that is no JSON.
    expect(
      is(
        began("exec"),
        j({ type: "response_item", payload: { type: "message" } }),
        j({ type: "event_msg", payload: { type: "token_count" } }),
        j({ type: "event_msg" }),
        '{"type":"event_msg","payload":',
        "null",
      ),
    ).toEqual(running("exec"));
    // Over, either way a turn ends; and the turn after it.
    expect(is(began("exec"), over("task_complete"))).toEqual(done);
    expect(is(began("exec"), over("turn_aborted"))).toEqual(done);
    expect(is(over("task_complete"), began("user"), over("task_complete"), began("exec"))).toEqual(running("exec"));
    // A Codex from before it said what began a turn, and a start with no time on it.
    expect(is(began())).toEqual(running(null));
    expect(
      is(j({ type: "event_msg", payload: { type: "task_started", turn_attribution: { turn_trigger: 7 } } })),
    ).toEqual({
      open: true,
      trigger: null,
      at: 0,
    });
    // No turn at all, an empty file, and no file.
    expect(is()).toBeNull();
    writeFileSync(f, "");
    expect(lastTurn(f)).toBeNull();
    expect(lastTurn(path.join(tmp, "no-such-rollout.jsonl"))).toBeNull();
    // A turn that has written more since it began than any fixed tail holds: 3 MiB of
    // output in rows of a quarter MiB, and one row longer than a piece read at a time.
    const output = (n: number) =>
      j({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(n) } });
    const long = [began("exec"), ...Array.from({ length: 12 }, () => output(256 * 1024)), output(1500 * 1024)];
    expect(is(...long)).toEqual(running("exec"));
    // When the file was last written is told too.
    expect(lastTurn(f)?.written).toBeGreaterThan(Date.now() - 60_000);
    // As recorded: a window's two finished turns, the second taken from its queue.
    expect(
      lastTurn(fileURLToPath(new URL("../../../conformance/transcripts/codex/queued.jsonl", import.meta.url))),
    ).toMatchObject({
      open: false,
    });
  });

  const TEXT = `Message via board.example.com (sessionpipe control; message 000123456789):\n\n-n "$(id)" & 'quoted' \\ %PATH% é\n\nlast line`;
  const QUEUED = `console.log("Queued message 01a20f72-ce2c-7b53-ae19-98e81248ae3d for thread " + a[2] + ".");`;

  it("codexQueue: one command, the message as one argument whatever it holds; ok when Codex says it is queued", async () => {
    stand(
      `${QUEUED}\nconsole.error("Warning: message was queued, but could not resume thread " + a[2] + ": start a local daemon or specify a server with --remote");`,
    );
    expect(await codexQueue(shim, THREAD, TEXT, { PATH: process.env.PATH, CODEX_HOME: "/h" })).toEqual({
      ok: true,
      said: "",
    });
    expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({
      argv: ["queue", "--thread", THREAD, `--message=${TEXT}`, "--resume"],
      job: "1",
      home: "/h",
    });
    // A message that begins with a dash is still the message: it is joined to its flag.
    await codexQueue(shim, THREAD, "--help me", { PATH: process.env.PATH });
    expect(JSON.parse(readFileSync(seen, "utf8")).argv[3]).toBe("--message=--help me");
    // With this process's own environment when none is given.
    expect(await codexQueue(shim, THREAD, "hi")).toEqual({ ok: true, said: "" });
    // Codex's word is the hand-over, however the command ended after it.
    stand(`${QUEUED}\nprocess.exit(3);`);
    expect(await codexQueue(shim, THREAD, TEXT, { PATH: process.env.PATH })).toEqual({ ok: true, said: "" });
    stand(`${QUEUED}\nsetTimeout(() => {}, 30000);`);
    expect(await codexQueue(shim, THREAD, TEXT, { PATH: process.env.PATH }, { timeoutMs: 600 })).toEqual({
      ok: true,
      said: "",
    });
  });

  it("codexQueue: not queued is said in Codex's words or by how it ended, never with the message or this machine's home", async () => {
    const env = { PATH: process.env.PATH };
    stand(
      `console.error("error: unrecognized subcommand 'queue'\\n\\nUsage: codex [OPTIONS] [PROMPT]"); process.exit(2);`,
    );
    const old = await codexQueue(shim, THREAD, TEXT, env);
    expect(old.ok).toBe(false);
    expect(old.said).toMatch(/^error: unrecognized subcommand 'queue'\s+Usage: codex/);
    // Codex names a file under the person's home: the home is not sent anywhere.
    stand(`console.error("Error: failed to open /home/someone/.codex/queue_1.sqlite"); process.exit(1);`);
    expect(await codexQueue(shim, THREAD, TEXT, env, { home: "/home/someone" })).toEqual({
      ok: false,
      said: "Error: failed to open ~/.codex/queue_1.sqlite",
    });
    // It ended badly and said nothing; it ended well and did not say the message is queued.
    stand("process.exit(3);");
    expect(await codexQueue(shim, THREAD, TEXT, env)).toEqual({ ok: false, said: "it exited with code 3" });
    stand(`console.log("ok");`);
    expect(await codexQueue(shim, THREAD, TEXT, env)).toEqual({ ok: false, said: "" });
    // There is no such program; a launcher that names none.
    const none = await codexQueue(path.join(dir, "no-codex-here"), THREAD, TEXT, {});
    expect(none).toEqual({ ok: false, said: "it could not be run" });
    writeFileSync(path.join(dir, "empty.cmd"), "@ECHO off\r\n");
    const unnamed = await codexQueue(path.join(dir, "empty.cmd"), THREAD, TEXT, {});
    expect(unnamed.ok).toBe(false);
    expect(unnamed.said).toMatch(/^empty\.cmd is a launcher script that names no program to run/);
    for (const r of [old, none, unnamed]) expect(r.said).not.toContain("last line");
  });

  it("codexQueue: a command that never ends leaves it unknown whether the message is queued", async () => {
    stand("setTimeout(() => {}, 30000);");
    expect(await codexQueue(shim, THREAD, TEXT, { PATH: process.env.PATH }, { timeoutMs: 400 })).toEqual({
      ok: null,
      said: "it did not answer in time",
    });
  });
});

describe("codex execpolicy check: what a Codex makes of a rules file (CONTROL.md §13)", () => {
  it("the decision, `none` where no rule matched, null where this Codex could not say", () => {
    const dir = path.join(tmp, "codex-policy");
    const cli = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    mkdirSync(path.dirname(cli), { recursive: true });
    // A stand-in checker: the rules file and the words it is given decide what it prints.
    writeFileSync(
      cli,
      `const a = process.argv.slice(2);
if (a.slice(0, 3).join(" ") !== "execpolicy check --rules" || a[4] !== "--resolve-host-executables") process.exit(9);
if (a[3].endsWith("old.rules")) { console.error("unknown function host_executable"); process.exit(1); }
if (!a[3].endsWith("a b" + require("node:path").sep + "sessionpipe.rules")) process.exit(8);
const words = a.slice(5).join(" ");
if (words === "sessionpipe ask codex hi") console.log(JSON.stringify({ matchedRules: [{}], decision: "allow" }));
else if (words === "sessionpipe ask on") console.log(JSON.stringify({ matchedRules: [{}, {}], decision: "forbidden" }));
else if (words === "garbled") console.log("not json");
else if (words === "nothing") console.log("null");
else console.log(JSON.stringify({ matchedRules: [] }));
`,
    );
    // An npm shim, so the same test runs on every platform (#165): its script under this node.
    const shim = path.join(dir, "codex.cmd");
    writeFileSync(shim, `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`);
    // A path with a space in it goes as one word: no shell reads it.
    const rules = path.join(dir, "a b", "sessionpipe.rules");
    expect(codexRuleReading(shim, rules, ["sessionpipe", "ask", "codex", "hi"])).toBe("allow");
    expect(codexRuleReading(shim, rules, ["sessionpipe", "ask", "on"], { PATH: process.env.PATH })).toBe("forbidden");
    expect(codexRuleReading(shim, rules, ["./sessionpipe", "ask", "codex", "hi"])).toBe("none");
    expect(codexRuleReading(shim, rules, ["garbled"])).toBeNull();
    expect(codexRuleReading(shim, rules, ["nothing"])).toBeNull();
    // A Codex that cannot read the file (a line it does not know), one with no such
    // command, and a launcher that names no program to run.
    expect(codexRuleReading(shim, path.join(dir, "old.rules"), ["sessionpipe", "ask", "codex", "hi"])).toBeNull();
    expect(codexRuleReading(path.join(dir, "no-such-codex"), rules, ["sessionpipe", "ask", "codex", "hi"])).toBeNull();
    const bare = path.join(dir, "bare.cmd");
    writeFileSync(bare, "@ECHO off\r\n");
    expect(codexRuleReading(bare, rules, ["sessionpipe", "ask", "codex", "hi"])).toBeNull();
  });
});
