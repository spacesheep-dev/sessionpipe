// SPDX-License-Identifier: Apache-2.0
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../dist/cli.js");
const guard = path.join(here, "helpers/no-cli-effects.cjs");
let tmp: string;
let env: NodeJS.ProcessEnv;
let job: string;

function put(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function snapshot(dir: string): Record<string, unknown> {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => {
        const file = path.join(dir, name);
        const st = statSync(file);
        return [
          name,
          st.isDirectory()
            ? snapshot(file)
            : { bytes: readFileSync(file).toString("base64"), mode: st.mode, mtime: st.mtimeMs },
        ];
      }),
  );
}

function run(args: string[], guarded = true) {
  return spawnSync(process.execPath, [...(guarded ? ["--require", guard] : []), cli, ...args], {
    cwd: tmp,
    env,
    encoding: "utf8",
    timeout: guarded ? 5000 : 30000,
  });
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-cli-"));
  const state = path.join(tmp, "state");
  const config = path.join(tmp, "config", "config.json");
  job = path.join(state, "jobs", "pending.json");
  // A populated machine: existing hooks, keys, queued work, and pending deliveries
  // must survive even a fully specified destructive command followed by --help.
  put(config, {
    machine: "lab-box",
    update_check: false,
    harnesses: { "claude-code": { enabled: true }, "gemini-cli": { enabled: true } },
    sinks: [
      {
        name: "receiver",
        url: "https://receiver.invalid",
        tier: 3,
        max_tier: 1,
        pii: true,
        token: "private-token",
        secret: "private-secret",
        paused: "HTTP 401",
      },
      { name: "local", url: "stdout", tier: 0 },
    ],
  });
  put(path.join(tmp, ".claude", "settings.json"), {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "sessionpipe hook" }] }] },
  });
  put(path.join(tmp, ".gemini", "settings.json"), { tools: { enableHooks: true } });
  put(path.join(tmp, ".codex", "hooks.json"), {});
  put(path.join(tmp, "config", "control.json"), {
    name: "lab-box",
    mode: "safe",
    folders: [tmp],
    receivers: [
      {
        url: "https://receiver.invalid",
        machine: "lab-box",
        token: "control-token",
        keys: [{ id: "key-id" }],
      },
    ],
  });
  put(path.join(state, "outbox", "claude-code", "session.jsonl"), {
    v: 1,
    type: "session.heartbeat",
    time: new Date().toISOString(),
    id: "event",
    harness: { name: "claude-code" },
    session: { id: "session", seq: 0, machine: "lab-box" },
    data: {},
    privacy: { tier: 0 },
  });
  put(path.join(state, "cursors", "receiver.json"), { "claude-code/session": 1 });
  put(path.join(state, "cursors", "local.json"), { "claude-code/session": 100000 });
  put(path.join(state, "timing.jsonl"), { ms: 3 });
  put(job, { harness: "claude-code", argv: ["claude-code", "SessionStart"], stdin: "{}" });
  env = {
    // No real harnesses, keychains, services, or inherited sessionpipe settings.
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    PATH: "",
    HOME: tmp,
    USERPROFILE: tmp,
    APPDATA: tmp,
    LOCALAPPDATA: tmp,
    XDG_CONFIG_HOME: path.join(tmp, ".config"),
    CLAUDE_CONFIG_DIR: path.join(tmp, ".claude"),
    CODEX_HOME: path.join(tmp, ".codex"),
    GEMINI_CLI_HOME: path.join(tmp, ".gemini"),
    GROK_HOME: path.join(tmp, ".grok"),
    SESSIONPIPE_CONFIG: config,
    SESSIONPIPE_STATE: state,
    SESSIONPIPE_SOCKET:
      process.platform === "win32" ? `\\\\.\\pipe\\${path.basename(tmp)}` : path.join(tmp, "control.sock"),
    SESSIONPIPE_DATA: path.join(tmp, "data"),
    SESSIONPIPE_SECRETS: "file",
    SESSIONPIPE_NO_UPDATE_CHECK: "1",
    SESSIONPIPE_CLAUDE: path.join(tmp, "no-claude"),
  };
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const commands: [string, ...string[]][] = [
  ["connect", "https://receiver.invalid", "--mode", "safe", "--no-service"],
  ["install", "--claude-code", "--machine", "changed", "--sink", "https://receiver.invalid"],
  ["uninstall"],
  ["sink"],
  ["sink", "add", "https://receiver.invalid"],
  ["sink", "list"],
  ["sink", "remove", "receiver"],
  ["sink", "test", "receiver"],
  ["secrets"],
  ["secrets", "move", "file"],
  ["status"],
  ["doctor"],
  ["tail"],
  ["backfill", "--claude-code"],
  ["forget", "claude-code", "session"],
  ["replay", "--sink", "receiver", "--from-start"],
  ["update"],
  ["update", "off"],
  ["update", "on"],
  ["titles"],
  ["titles", "on"],
  ["titles", "off"],
  ["titles", "refresh"],
  ["control"],
  ["control", "pair", "https://receiver.invalid", "--mode", "safe", "--no-service"],
  ["control", "mode", "auto"],
  ["control", "folders"],
  ["control", "folders", "add", "/tmp"],
  ["control", "folders", "remove", "/tmp"],
  ["control", "status"],
  ["control", "keys"],
  ["control", "keys", "remove", "key-id"],
  ["control", "off"],
  ["control", "run"],
  ["wait", "--session", "claude-code:session"],
  ["channel", "--session", "claude-code:session"],
  ["worker", "JOB"],
  ["hook"],
  ["version"],
  ["--version"],
  ["-v"],
];

describe("help never dispatches a command", () => {
  for (const flag of ["--help", "-h"])
    for (const args of commands)
      it(`${args.join(" ")} ${flag}: usage, exit 0, no writes, hooks, queued work, processes or network`, () => {
        const before = snapshot(tmp);
        const actual = args.map((a) => (a === "JOB" ? job : a));
        const r = run([...actual, flag]);
        expect(r.error).toBeUndefined();
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toMatch(/Usage:/);
        expect(r.stdout).toContain(`sessionpipe ${args[0]}`);
        expect(r.stderr).toBe("");
        expect(snapshot(tmp)).toEqual(before);
      });

  for (const command of [...new Set(commands.map((a) => a[0]))])
    it(`${command} --help with no operands`, () => {
      const before = snapshot(tmp);
      const r = run([command, "--help"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/Usage:/);
      expect(r.stderr).toBe("");
      expect(snapshot(tmp)).toEqual(before);
    });

  for (const args of [[], ["help"], ["--help"], ["-h"], ["help", "--help"], ["--help", "install"]])
    it(`top-level usage: ${args.join(" ")}`, () => {
      const before = snapshot(tmp);
      const r = run(args);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("Usage:");
      expect(r.stderr).toBe("");
      expect(snapshot(tmp)).toEqual(before);
    });
});

describe("the installed binary", () => {
  it("runs through npm's bin link (a symlink to dist/cli.js), as `npm install -g` places it", () => {
    const bin = path.join(tmp, "bin", "sessionpipe");
    mkdirSync(path.dirname(bin), { recursive: true });
    symlinkSync(cli, bin);
    const r = spawnSync(process.execPath, [bin, "--version"], { cwd: tmp, env, encoding: "utf8", timeout: 30000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${JSON.parse(readFileSync(path.resolve(here, "../package.json"), "utf8")).version}\n`);
  });
});

describe("status", () => {
  it("emits only JSON, with doctor's shared facts and pending session/job counts, without leaking credentials", () => {
    const before = snapshot(tmp);
    const r = run(["status", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({
      machine: "lab-box",
      state: env.SESSIONPIPE_STATE,
      config: env.SESSIONPIPE_CONFIG,
      jobs: 1,
      timing: { n: 1, p50: 3, p95: 3 },
      sinks: [
        {
          name: "receiver",
          url: "https://receiver.invalid",
          tier: 3,
          max_tier: 1,
          pii: true,
          tools: "all",
          control: false,
          paused: "HTTP 401",
          pending_sessions: 1,
        },
        {
          name: "local",
          url: "stdout",
          tier: 0,
          max_tier: null,
          pii: false,
          tools: "all",
          control: false,
          paused: null,
          pending_sessions: 0,
        },
      ],
    });
    for (const secret of ["private-token", "private-secret", "control-token", '"token"', '"secret"'])
      expect(r.stdout).not.toContain(secret);
    expect(snapshot(tmp)).toEqual(before);
    // Doctor intentionally benchmarks hooks. Run only here without the guard,
    // with isolated HOME/state and no harness executable on PATH.
    // With --json it exits 0 whatever it found, as it always has: what needs attention
    // (a daemon that isn't running) is in `warnings`, and the report is whole on stdout.
    const diagnostic = run(["doctor", "--json"], false);
    expect(diagnostic.status, diagnostic.stderr).toBe(0);
    expect(diagnostic.stderr).toBe("");
    const doctor = JSON.parse(diagnostic.stdout);
    for (const key of ["version", "machine", "state", "config", "harnesses", "timing", "update", "control"])
      expect(report[key], key).toEqual(doctor[key]);
    expect(report.control).toEqual({ running: false, receivers: [] });
    expect(doctor.warnings).toContain("the control daemon is not running or not responding; polling is stopped");
    doctor.sinks.forEach(({ token: _token, ...sink }: Record<string, unknown>, i: number) => {
      const { pending_sessions: _pending, ...actual } = report.sinks[i];
      expect(actual).toEqual(sink);
    });
  }, 30000);

  it("is a few lines for a person: the verdict, then a line a group, with what is wrong said and what is fine named", () => {
    const r = run(["status"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    // Captured from this fixture, into a pipe: no colour, no folding. Platform path
    // separators, the hook launcher (none on Windows) and the version are the variables.
    const version = JSON.parse(readFileSync(path.resolve(here, "../package.json"), "utf8")).version;
    const launcher = process.platform !== "win32";
    const rows = [
      `! ${launcher ? 4 : 3} things need attention`,
      "",
      `  ✗ This computer  lab-box (sessionpipe ${version}), background service: not running${launcher ? ", hooks: have no launcher to run" : ""}`,
      // Codex is here and was never hooked: that only informs, so it is left to doctor.
      `  ! Agents         claude-code: not hooked · ~${path.sep}.claude${path.sep}settings.json, gemini-cli: not hooked · ~${path.sep}.gemini${path.sep}settings.json`,
      "  ✗ Reports to     receiver: tier 1 · stopped: HTTP 401, local",
      "  ✗ Messages from  receiver.invalid: not live: the background service isn't running",
      "  · Updates        by hand: update_check is false in config.json (`sessionpipe update on`)",
      "",
      "  `sessionpipe doctor` says what to do about it.",
    ];
    expect(r.stdout).toBe(`${rows.join("\n")}\n`);
  });

  it("uses empty collections, null timing and zero jobs on a fresh machine", () => {
    const saved = env;
    const absent = path.join(tmp, "absent");
    env = {
      ...env,
      HOME: absent,
      USERPROFILE: absent,
      CLAUDE_CONFIG_DIR: path.join(absent, ".claude"),
      CODEX_HOME: path.join(absent, ".codex"),
      GEMINI_CLI_HOME: path.join(absent, ".gemini"),
      GROK_HOME: path.join(absent, ".grok"),
      SESSIONPIPE_CONFIG: path.join(absent, "config.json"),
      SESSIONPIPE_STATE: path.join(absent, "state"),
    };
    try {
      const before = snapshot(tmp);
      const r = run(["status", "--json"]);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ harnesses: {}, sinks: [], timing: null, jobs: 0, control: null });
      expect(r.stderr).toBe("");
      expect(snapshot(tmp)).toEqual(before);
    } finally {
      env = saved;
    }
  });
});

// Async children let the fake local daemon answer while the built commands run. `status`
// only reports, and `doctor --json` is for a program: both end 0. `doctor` for a person
// ends 1 here: this fixture always has a command to run (hooks that aren't written).
function diagnostic(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(args[0] === "status" ? ["--require", guard] : []), cli, ...args], {
      cwd: tmp,
      env,
      timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b;
    });
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    child.on("error", reject);
    const expected = args[0] === "doctor" && !args.includes("--json") ? 1 : 0;
    child.on("close", (code) =>
      code === expected && !stderr ? resolve(stdout) : reject(new Error(`${code}: ${stderr}`)),
    );
  });
}

describe("control health in status and doctor", () => {
  const error = "the receiver no longer knows this machine (401); run `sessionpipe control pair` again";
  it.each([
    {
      name: "an old daemon that permanently stopped",
      polling: false,
      minutes: 3480,
      error,
      legacy: true,
      brief: "✗ Messages from  receiver.invalid: not live: it no longer knows this computer",
      row: "✗ receiver.invalid      not live: it no longer knows this computer",
      fix: [
        "receiver.invalid no longer knows this computer, so its messages can't arrive. Pair with it again:",
        "sessionpipe control pair https://receiver.invalid",
      ],
    },
    {
      name: "a daemon backing off before its first success",
      polling: false,
      minutes: 5,
      error,
      never: true,
      brief: "✗ Messages from  receiver.invalid: not live: it no longer knows this computer",
      row: "✗ receiver.invalid      not live: it no longer knows this computer",
      fix: [
        "receiver.invalid no longer knows this computer, so its messages can't arrive. Pair with it again:",
        "sessionpipe control pair https://receiver.invalid",
      ],
    },
    {
      name: "a stalled loop still claiming to poll",
      polling: true,
      minutes: 5,
      error: null,
      brief: "✗ Messages from  receiver.invalid: not live for 5 min: no answer",
      row: "✗ receiver.invalid      not live for 5 min: no answer",
      fix: [
        "receiver.invalid hasn't answered for 5 min. Messages wait there, and the background service keeps trying: nothing to type unless it stays this way.",
      ],
    },
    {
      name: "a healthy long-poll",
      polling: true,
      minutes: 0,
      error: null,
      brief: "✓ Messages from  receiver.invalid",
      row: "✓ receiver.invalid      live · heard just now · 1 key trusted",
      fix: [],
    },
  ])(
    "reports $name in both text and JSON",
    async (test) => {
      const version = JSON.parse(readFileSync(path.resolve(here, "../package.json"), "utf8")).version;
      const receiver = {
        url: "https://receiver.invalid",
        polling: test.polling,
        last_poll: test.never ? null : Date.now() - test.minutes * 60_000,
        last_error: test.error,
        ...(test.legacy ? {} : { last_poll_age_ms: test.minutes * 60_000 }),
      };
      // What each command asks the daemon: its status; doctor then asks what it sees from
      // where it runs (`health`), which a daemon older than that question hangs up on.
      const asked: unknown[] = [];
      const server = net.createServer((socket) => {
        socket.once("data", (data) => {
          const request = JSON.parse(data.toString());
          asked.push(request);
          if (request.op !== "status") return socket.end();
          socket.end(`${JSON.stringify({ op: "status", status: { version, receivers: [receiver] } })}\n`);
        });
      });
      await new Promise<void>((resolve) => server.listen(env.SESSIONPIPE_SOCKET, resolve));
      try {
        for (const command of ["status", "doctor"]) {
          asked.length = 0;
          const report = JSON.parse(await diagnostic([command, "--json"]));
          expect(asked).toEqual(command === "doctor" ? [{ op: "status" }, { op: "health" }] : [{ op: "status" }]);
          expect(report.control).toMatchObject({ running: true, receivers: [receiver] });
          expect(report.control.receivers[0].last_poll_age_ms).toBeGreaterThanOrEqual(test.minutes * 60_000);
          if (command === "doctor") {
            const warning = `${receiver.url}: the daemon has not polled for ${test.minutes} minutes: ${test.error ?? "no successful poll response"}`;
            if (test.minutes) expect(report.warnings).toContain(warning);
            else expect(report.warnings.some((w: string) => w.includes("daemon has"))).toBe(false);
          }
          // For a person: `status` names the receiver in its group's line, with what is
          // wrong when it isn't heard; doctor has a row that says since when, and what to
          // do about it, with the command on its own line.
          const text = await diagnostic([command]);
          if (command === "status") {
            expect(text).toMatch(
              new RegExp(
                `^ {2}. This computer {2}lab-box \\(sessionpipe ${version}\\), background service(?:, hooks: .*)?$`,
                "m",
              ),
            );
            expect(text).toContain(`  ${test.brief}\n`);
            expect(text).not.toContain("To fix");
          } else {
            expect(text).toContain("  ✓ background service  running\n");
            expect(text).toContain(`  ${test.row}\n`);
            for (const line of test.fix) expect(text).toContain(line);
            if (!test.fix.length) expect(text).not.toMatch(/receiver\.invalid (?:hasn't answered|no longer knows)/);
          }
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    30_000,
  );
});
