// SPDX-License-Identifier: Apache-2.0
// `sessionpipe ask` at the terminal (CONTROL.md §13) against a stand-in daemon on the local
// socket that speaks the ask wire: what goes out in the request, what each reply becomes on
// stdout and stderr, the exit codes, the switch (on / off / status) in control.json, and the
// section `ask setup` writes into CLAUDE.md and AGENTS.md and takes out again, byte for byte.
// And what stands between a session's command and the daemon: a sandbox that refuses the
// socket is said as that, and the rules `ask setup` writes for Codex are the file in
// conformance/control-ask-codex-rules.json, tried on a Codex before they are put in place.
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { codexControl } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASK_HELP,
  type AskOptions,
  askMain,
  askSection,
  CODEX_RULE_READINGS,
  CODEX_RULES_MARK,
  codexAskRules,
  codexReads,
  codexRulesFile,
  type RulesRead,
  setupAsk,
  setupCodexRules,
  setupFiles,
  withAskSection,
  withoutAskSection,
} from "../src/ask.js";
import { type LocalReply, type LocalRequest, reach } from "../src/control/local.js";
import { installService, uninstallService } from "../src/control/pair.js";
import { readControl, writeControl } from "../src/control/store.js";
import { rerunGlobally, viaNpx } from "../src/runtime.js";
import { PLAIN } from "../src/style.js";
import { usage } from "../src/usage.js";

vi.mock("../src/control/pair.js", async (original) => ({
  ...(await original<typeof import("../src/control/pair.js")>()),
  installService: vi.fn(() => "launchd agent (stand-in)"),
  uninstallService: vi.fn(),
}));
vi.mock("../src/runtime.js", async (original) => ({
  ...(await original<typeof import("../src/runtime.js")>()),
  viaNpx: vi.fn(() => false),
  rerunGlobally: vi.fn(),
}));
/** What `--text -` reads from this process's stdin when the caller gave no reader. */
const piped = vi.hoisted(() => ({ stdin: null as string | null }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const readFileSync = ((p: unknown, ...a: unknown[]) =>
    p === 0 && piped.stdin !== null
      ? piped.stdin
      : (real.readFileSync as (...x: unknown[]) => unknown)(p, ...a)) as typeof real.readFileSync;
  return { ...real, readFileSync };
});

const unix = process.platform !== "win32";
/** The Codex installed where the tests run, when there is one, and its version: the fixture
 *  is tried on the version it was recorded on (any, with SESSIONPIPE_TEST_CODEX=1, which is
 *  how a newer Codex is checked before the fixture is recorded again). */
const codexHere = codexControl.findCodex();
const codexVersion = ((): string | null => {
  try {
    return (
      codexHere &&
      execFileSync(codexHere, ["--version"], {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    );
  } catch {
    return null;
  }
})();
const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
const ASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
let tmp: string;
let home: string;
let project: string;
let sock: string;
let env: NodeJS.ProcessEnv;
let agents: string[];
let server: net.Server | null = null;
let seen: LocalRequest[];
/** What the Codex of a test makes of the rules `ask setup` writes (no test runs a real one
 *  through `ask setup`). */
let reads: RulesRead;

type Script = (req: LocalRequest, send: (r: LocalReply | string) => void) => void | Promise<void>;
/** A stand-in daemon: one request per connection, the script's replies, then it hangs up. */
const serve = (script: Script) =>
  new Promise<void>((ready) => {
    server = net.createServer((s) => {
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString("utf8");
        const i = buf.indexOf("\n");
        if (i < 0) return;
        const req = JSON.parse(buf.slice(0, i)) as LocalRequest;
        buf = "";
        seen.push(req);
        void Promise.resolve(script(req, (r) => s.write(`${typeof r === "string" ? r : JSON.stringify(r)}\n`))).then(
          () => s.end(),
        );
      });
    });
    server.listen(sock, ready);
  });
const answer =
  (text = "All good.", session = "codex:t1"): Script =>
  (_req, send) => {
    send({ op: "asked", ask_id: ASK_ID });
    send({ op: "progress", text: "Looking", seq: 1 });
    send({ op: "progress", text: "Looking at the diff…", seq: 2 });
    send({ op: "answer", ask_id: ASK_ID, session, text, ms: 1234 });
  };

const run = (argv: string[], o: Partial<AskOptions> = {}, stdin?: string) => {
  const out: string[] = [];
  const err: string[] = [];
  return askMain(
    ["ask", ...argv],
    {
      out: (s = "") => void out.push(s),
      err: (s) => void err.push(s),
      ...(stdin !== undefined ? { stdin: () => stdin } : {}),
    },
    { env, harnesses: () => agents, distDir: path.join(tmp, "dist"), codexReads: () => reads, ...o },
  ).then((code) => ({ code, out: out.join("\n"), err: err.join("") }));
};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-ask-")));
  home = path.join(tmp, "home");
  project = path.join(home, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(tmp, "dist"));
  writeFileSync(path.join(tmp, "dist", "cli.js"), "");
  sock = path.join(tmp, "ctl.sock");
  env = {
    HOME: home,
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_SOCKET: sock,
  };
  vi.stubEnv("SESSIONPIPE_CONFIG", env.SESSIONPIPE_CONFIG as string);
  vi.stubEnv("SESSIONPIPE_STATE", env.SESSIONPIPE_STATE as string);
  vi.stubEnv("SESSIONPIPE_SOCKET", sock);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(os, "hostname").mockReturnValue("Box.local");
  vi.spyOn(process, "cwd").mockReturnValue(project);
  agents = ["codex", "gemini-cli"];
  reads = "ok";
  seen = [];
  vi.mocked(installService).mockClear();
  vi.mocked(uninstallService).mockClear();
  vi.mocked(viaNpx).mockReturnValue(false);
  vi.mocked(rerunGlobally).mockClear();
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(unix)("ask <agent> <task>", () => {
  it("sends the request as the wire says, says who is on it on stderr and prints the answer on stdout", async () => {
    await serve(answer());
    env.CLAUDE_CODE_SESSION_ID = SID;
    env.SESSIONPIPE_ASK_CHAIN = "codex:t0, gemini-cli:g1";
    const r = await run(["codex", "review", "this", "--permission", "read", "--model", "gpt-5", "--cwd", "sub/../."]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("All good.");
    expect(seen).toEqual([
      {
        op: "ask",
        harness: "codex",
        text: "review this",
        cwd: project,
        chain: ["codex:t0", "gemini-cli:g1"],
        pid: process.pid,
        from: `claude-code:${SID}`,
        permission: "read",
        model: "gpt-5",
      },
    ]);
    // The asker is a session, so a model reads this: who is on it and how long it took,
    // and the answer once, on stdout.
    expect(r.err).toBe(
      `sessionpipe ask: codex is on it (ask ${ASK_ID})\nsessionpipe ask: codex:t1 answered in 1.2 s\n`,
    );
  });

  it("a person at the terminal sees the answer grow: the whole answer-so-far arrives each time, only what is new is shown", async () => {
    await serve(answer());
    const r = await run(["codex", "review this"]);
    expect(r.out).toBe("All good.");
    expect(r.err).toBe(
      `sessionpipe ask: codex is on it (ask ${ASK_ID})\nLooking at the diff…\nsessionpipe ask: codex:t1 answered in 1.2 s\n`,
    );
    expect(seen[0]).not.toHaveProperty("from");
  });

  it("with nobody watching stderr the answer is not shown as it grows: a model given both streams reads it once", async () => {
    await serve(answer("Looking at the diff… all good."));
    const out: string[] = [];
    const err: string[] = [];
    const code = await askMain(
      ["ask", "codex", "review this"],
      { out: (s = "") => void out.push(s), err: (s) => void err.push(s), watched: false },
      { env, harnesses: () => agents },
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toBe("Looking at the diff… all good.");
    expect(err.join("")).toBe(
      `sessionpipe ask: codex is on it (ask ${ASK_ID})\nsessionpipe ask: codex:t1 answered in 1.2 s\n`,
    );
  });

  it("a session that asks is a model reading: the answer is not shown as it grows, terminal or not", async () => {
    await serve(answer("All good."));
    const r = await run(["codex", "x"], { env: { ...env, CODEX_SESSION_ID: "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c" } });
    expect(r.out).toBe("All good.");
    expect(r.err).toBe(
      `sessionpipe ask: codex is on it (ask ${ASK_ID})\nsessionpipe ask: codex:t1 answered in 1.2 s\n`,
    );
    expect(seen[0]).toMatchObject({ from: "codex:0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c" });
  });

  it("names a session to continue it; --json prints the one object and nothing else on stdout", async () => {
    await serve(answer("Done.", "codex:t1"));
    const r = await run(["codex:t1", "go on", "--json"]);
    expect(r.code).toBe(0);
    expect(seen[0]).toMatchObject({ harness: "codex", session: "codex:t1", text: "go on", chain: [] });
    expect(seen[0]).not.toHaveProperty("from");
    expect(JSON.parse(r.out)).toEqual({ ask_id: ASK_ID, session: "codex:t1", reply: "Done.", ms: 1234 });
    expect(r.err).toContain("codex is on it");
  });

  it("--quiet keeps stderr empty; --text - takes the task from stdin; a progress text that restarts is shown whole", async () => {
    await serve((_req, send) => {
      send({ op: "asked", ask_id: ASK_ID, session: "gemini-cli:g9" });
      send({ op: "progress", text: "abc", seq: 1 });
      send({ op: "progress", text: "xyz", seq: 2 });
      send({ op: "answer", ask_id: ASK_ID, session: "gemini-cli:g9", text: "ok", ms: 10 });
    });
    const quiet = await run(["gemini-cli", "--quiet", "--text", "-"], {}, "from stdin\n");
    expect(quiet).toEqual({ code: 0, out: "ok", err: "" });
    expect(seen[0]).toMatchObject({ harness: "gemini-cli", text: "from stdin\n" });
    const loud = await run(["gemini-cli", "--text", "given"]);
    expect(seen[1]).toMatchObject({ text: "given" });
    expect(loud.err).toBe(
      `sessionpipe ask: gemini-cli:g9 is on it (ask ${ASK_ID})\nabc\nxyz\nsessionpipe ask: gemini-cli:g9 answered in 0.0 s\n`,
    );
  });

  it("a refusal is exit 1 with the daemon's words and, where there is one, what to do", async () => {
    let code = "ask_off";
    await serve((_req, send) => {
      send({ op: "asked", ask_id: ASK_ID });
      send({ op: "progress", text: "half", seq: 1 });
      send({ op: "refused", code, detail: `because ${code}` });
    });
    const off = await run(["codex", "x"]);
    expect(off.code).toBe(1);
    expect(off.out).toBe("");
    expect(off.err).toBe(
      `sessionpipe ask: codex is on it (ask ${ASK_ID})\nhalf\nsessionpipe ask: refused (ask_off): because ask_off\n  \`sessionpipe ask on\` at this machine's terminal allows it.\n`,
    );
    code = "folder";
    expect((await run(["codex", "x", "--quiet"])).err).toBe(
      "sessionpipe ask: refused (folder): because folder\n  `sessionpipe control folders add <folder>` allows a folder; an asked agent runs only in one of those.\n",
    );
    code = "harness";
    expect((await run(["codex", "x", "--quiet"])).err).toContain("Agents sessionpipe can run here: codex, gemini-cli.");
    agents = [];
    expect((await run(["codex", "x", "--quiet"])).err).toContain(
      "No agent sessionpipe can run headlessly is installed here.",
    );
    code = "depth";
    expect((await run(["codex", "x", "--quiet"])).err).toBe("sessionpipe ask: refused (depth): because depth\n");
  });

  it("a failure is exit 1 with the detail", async () => {
    await serve((_req, send) => {
      send({ op: "asked", ask_id: ASK_ID, session: "codex:t1" });
      send({ op: "failed", detail: "codex exited 1" });
    });
    const r = await run(["codex:t1", "x", "--quiet"]);
    expect(r).toEqual({ code: 1, out: "", err: "sessionpipe ask: codex:t1 failed: codex exited 1\n" });
  });

  it("no daemon: one line that says what to run", async () => {
    const r = await run(["codex", "x"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toBe(
      "sessionpipe ask: no control daemon is answering on this machine. The person runs `sessionpipe ask on` once at its terminal (not from inside a session): that starts the daemon as a service and keeps it running.\n",
    );
  });

  it("the daemon going away mid-run is exit 1, after the progress line is ended", async () => {
    await serve((_req, send) => {
      send({ op: "asked", ask_id: ASK_ID });
      send({ op: "progress", text: "partial", seq: 1 });
      send({ op: "ok" }); // not an ask's reply: ignored
    });
    const r = await run(["codex", "x"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      `sessionpipe ask: codex is on it (ask ${ASK_ID})\npartial\nsessionpipe ask: the control daemon went away before codex answered\n`,
    );
  });

  it("with no reader given, --text - reads this process's stdin", async () => {
    await serve(answer());
    piped.stdin = "piped task\n";
    try {
      expect((await run(["codex", "--text", "-"])).code).toBe(0);
    } finally {
      piped.stdin = null;
    }
    expect(seen[0]).toMatchObject({ op: "ask", text: "piped task\n" });
  });

  it("with no options it reads this process's environment and the agents on its PATH", async () => {
    const err: string[] = [];
    expect(await askMain(["ask"], { out: () => {}, err: (s) => void err.push(s) })).toBe(2);
    expect(err.join("")).toContain(ASK_HELP);
    expect(existsSync(sock)).toBe(false);
  });

  it("usage errors are exit 2, before anything reaches the socket", async () => {
    const bad = async (argv: string[], says: string) => {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.out).toBe("");
      expect(r.err, argv.join(" ")).toContain(says);
    };
    await bad([], ASK_HELP);
    await bad(["--bogus", "codex", "x"], "unknown flag --bogus");
    await bad(["codex"], "nothing to ask");
    await bad(["codex", "  ", " "], "nothing to ask");
    await bad(["codex", "x".repeat(20_001)], "20,001 characters; an ask carries 20,000 at most");
    await bad(["claude-code:not-a-uuid", "x"], "claude-code:not-a-uuid isn't a session");
    await bad(["Codex", "x"], "Codex isn't an agent's name");
    await bad(["codex", "x", "--permission", "auto"], "--permission is read or safe");
    await bad(["codex", "x", "--model"], "--model needs a name");
    expect(seen).toEqual([]);
    // A word after the agent that starts with a dash is the task, not a flag.
    await serve(answer());
    expect((await run(["codex", "-v", "means", "verbose"])).code).toBe(0);
    expect(seen[0]).toMatchObject({ text: "-v means verbose" });
    // After `--` every word is the task, so text that starts like a flag moves nothing.
    expect((await run(["codex", "--json", "--", "--cwd", "/elsewhere", "--model", "x"])).code).toBe(0);
    expect(seen[1]).toMatchObject({ text: "--cwd /elsewhere --model x", cwd: project });
    expect(seen[1]).not.toHaveProperty("model");
  });
});

describe("ask on / off / status", () => {
  it("on: control.json gets ask: true, this folder is allowed, the service is installed", async () => {
    const r = await run(["on"]);
    expect(r.code).toBe(0);
    expect(readControl(env)).toEqual({ name: "Box", folders: [project], mode: "safe", receivers: [], ask: true });
    expect(installService).toHaveBeenCalledWith(
      expect.objectContaining({ cli: path.join(tmp, "dist", "cli.js"), node: expect.any(String) }),
    );
    expect(r.out).toContain("Sessions on this machine may ask another agent");
    expect(r.out).toContain("agents: codex, gemini-cli");
    expect(r.out).toContain(`Allowed ${project} for asked agents`);
    expect(r.out).toContain("  Background service: launchd agent (stand-in)\n");
    expect(r.out).toContain("`sessionpipe ask setup`");
  });
  it("on from inside a session is refused, unless --yes: allowing a folder and installing a service is the person's call", async () => {
    for (const inside of [
      { CLAUDE_CODE_SESSION_ID: SID },
      { CODEX_SESSION_ID: "t1" },
      { SESSIONPIPE_CONTROL_JOB: "1" },
    ]) {
      const r = await run(["on"], { env: { ...env, ...inside } });
      expect(r.code, JSON.stringify(inside)).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toContain("ask them to run `sessionpipe ask on` at this machine's terminal");
      expect(readControl(env)).toBeNull();
      expect(installService).not.toHaveBeenCalled();
    }
    const r = await run(["on", "--yes"], { env: { ...env, CLAUDE_CODE_SESSION_ID: SID } });
    expect(r.code).toBe(0);
    expect(readControl(env)).toMatchObject({ ask: true, folders: [project] });
    expect(installService).toHaveBeenCalledTimes(1);
  });
  it("on from the home folder allows nothing and says so; --no-service installs none; a paired machine keeps its config", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(home);
    const r = await run(["on", "--no-service"]);
    expect(readControl(env)?.folders).toEqual([]);
    expect(r.out).toContain("! No folder is allowed");
    expect(r.out).toContain("--no-service");
    expect(installService).not.toHaveBeenCalled();
    const paired = {
      name: "box",
      folders: ["/work"],
      mode: "auto" as const,
      receivers: [{ url: "https://rx.test" } as never],
      ask: false,
    };
    writeControl(paired, env);
    agents = [];
    const again = await run(["on"]);
    expect(readControl(env)).toEqual({ ...paired, ask: true });
    expect(again.out).toContain("agents: none sessionpipe can run headlessly");
    expect(again.out).not.toContain("Allowed ");
    // A dist that isn't there: the service still names cli.js under it.
    await run(["on"], { distDir: path.join(tmp, "nowhere") });
    expect(installService).toHaveBeenLastCalledWith(
      expect.objectContaining({ cli: path.join(tmp, "nowhere", "cli.js") }),
    );
  });
  it("on names the daemon's cli.js as it finds it: resolved when it is a file, as given otherwise", async () => {
    await askMain(["ask", "on"], { out: () => {}, err: () => {} }, { env, harnesses: () => agents });
    expect(installService).toHaveBeenLastCalledWith(expect.objectContaining({ cli: "cli.js" }));
    rmSync(path.join(tmp, "dist", "cli.js"));
    mkdirSync(path.join(tmp, "dist", "cli.js"));
    await run(["on"]);
    expect(installService).toHaveBeenLastCalledWith(expect.objectContaining({ cli: path.join(tmp, "dist", "cli.js") }));
  });

  it("on through npx reruns the global copy, as pair does", async () => {
    vi.mocked(viaNpx).mockReturnValue(true);
    expect((await run(["on"])).code).toBe(0);
    expect(rerunGlobally).toHaveBeenCalledWith(["ask", "on"], expect.any(Function));
    expect(readControl(env)).toBeNull();
  });
  it("off: ask: false; the service goes when no receiver needs it, stays when one does", async () => {
    const none = await run(["off"]);
    expect(none.out).toContain("already off");
    expect(uninstallService).not.toHaveBeenCalled();
    await run(["on", "--no-service"]);
    const r = await run(["off"]);
    expect(r.code).toBe(0);
    expect(readControl(env)?.ask).toBe(false);
    expect(uninstallService).toHaveBeenCalledTimes(1);
    expect(r.out).toContain("  Background service: removed; with no receiver paired, nothing was left for it to do.");
    writeControl({ name: "box", folders: [], mode: "safe", receivers: [{ url: "https://rx.test" } as never] }, env);
    const kept = await run(["off"]);
    expect(uninstallService).toHaveBeenCalledTimes(1);
    expect(kept.out).toContain("within seconds");
    expect(readControl(env)?.ask).toBe(false);
  });
  it("status: the switch, the daemon, the agents and the folders", async () => {
    expect((await run(["status"])).out).toBe(
      [
        "  ask: off (`sessionpipe ask on` turns it on)",
        "  daemon: not running (`sessionpipe ask on` installs it as a service)",
        "  agents: codex, gemini-cli",
        "  folders: none allowed (`sessionpipe control folders add <project>`)",
      ].join("\n"),
    );
    await run(["on", "--no-service"]);
    agents = [];
    const on = await run(["status"]);
    expect(on.out).toContain("  ask: on\n");
    expect(on.out).toContain("  agents: none sessionpipe can run headlessly");
    expect(on.out).toContain(`  folders: ${project}`);
  });
  it.runIf(unix)("status with the daemon up: its pid, version and the agents it can start", async () => {
    await serve((_req, send) =>
      send({ op: "status", status: { pid: 42, version: "9.9.9", start: { codex: {}, "claude-code": {} } } }),
    );
    const r = await run(["status"]);
    expect(seen).toEqual([{ op: "status" }]);
    expect(r.out).toContain("  daemon: running (pid 42, 9.9.9)");
    expect(r.out).toContain("  agents: codex, claude-code");
  });
  it.runIf(unix)("status lists the agents an ask can start, an ACP agent with no start options too", async () => {
    await serve((_req, send) =>
      send({
        op: "status",
        status: {
          pid: 42,
          version: "9.9.9",
          start: { codex: {} },
          ask: { on: true, harnesses: ["codex", "grok-build"] },
        },
      }),
    );
    expect((await run(["status"])).out).toContain("  agents: codex, grok-build");
  });
});

/** Every connection refused by the system itself, as a sandbox around the command does:
 *  the socket is there and the daemon may be running, and `connect` answers `code`. */
const refuseConnections = (code: string) =>
  vi.spyOn(net, "connect").mockImplementation((() => {
    const s = new EventEmitter() as net.Socket;
    Object.assign(s, { destroy: () => s, write: () => true });
    queueMicrotask(() => s.emit("error", Object.assign(new Error(`connect ${code} ${sock}`), { code })));
    return s;
  }) as unknown as typeof net.connect);

describe("a sandbox between the command and the daemon", () => {
  const STOPPED =
    "this command was stopped on its way to this computer's background service (permission denied on its socket), so nothing here says the service is not running.";
  const ANY =
    "A sandbox around this command is the usual reason. The person can run it at this machine's terminal, or let this command out of the sandbox.";
  const CODEX =
    'Codex runs commands in a sandbox that closes that way, and lets this one out only as a whole command line under its bare name: `sessionpipe ask <agent> "<task>"`, the agent right after `ask`, nothing chained, piped or redirected, and no `$`, backtick or backslash in the task. If it is still stopped, the person runs `sessionpipe ask setup` once at this machine\'s terminal: it writes the Codex rule that lets this one command through.';

  it("an ask says it was stopped on the way, never that no daemon runs", async () => {
    refuseConnections("EPERM");
    const r = await run(["codex", "x"]);
    expect(r).toEqual({ code: 1, out: "", err: `sessionpipe ask: ${STOPPED} ${ANY}\n` });
    expect(r.err).not.toContain("ask on");
  });

  it("inside Codex's sandbox it says what lets the command through (either of the two marks Codex sets)", async () => {
    refuseConnections("EPERM");
    for (const mark of [{ CODEX_SANDBOX: "seatbelt" }, { CODEX_SANDBOX_NETWORK_DISABLED: "1" }]) {
      const r = await run(["codex", "x"], { env: { ...env, ...mark } });
      expect(r).toEqual({ code: 1, out: "", err: `sessionpipe ask: ${STOPPED} ${CODEX}\n` });
    }
  });

  it("status says the daemon is not reachable from here, not that it is not running", async () => {
    refuseConnections("EACCES");
    expect((await run(["status"])).out).toContain(
      `  daemon: not reachable from here (permission denied on its socket). ${ANY}`,
    );
    const inCodex = await run(["status"], { env: { ...env, CODEX_SANDBOX: "seatbelt" } });
    expect(inCodex.out).toContain(`  daemon: not reachable from here (permission denied on its socket). ${CODEX}`);
    expect(inCodex.out).not.toContain("not running");
  });

  it("reach: blocked when the system refuses the connection, absent for any other error", async () => {
    const spy = refuseConnections("EPERM");
    expect(await reach(sock)).toBe("blocked");
    spy.mockRestore();
    refuseConnections("EACCES");
    expect(await reach(sock)).toBe("blocked");
    vi.restoreAllMocks();
    refuseConnections("ECONNREFUSED");
    expect(await reach(sock)).toBe("absent");
  });

  it("reach: absent when nothing answers in time", async () => {
    vi.spyOn(net, "connect").mockImplementation((() =>
      Object.assign(new EventEmitter(), { destroy: () => undefined })) as unknown as typeof net.connect);
    expect(await reach(sock, 20)).toBe("absent");
  });

  it.runIf(unix)("reach: open when a daemon listens, absent when no socket is there", async () => {
    expect(await reach(sock)).toBe("absent");
    await serve(() => {});
    expect(await reach(sock)).toBe("open");
  });

  // The real thing, where the test may close a folder to itself (root passes any mode).
  it.runIf(unix && process.getuid?.() !== 0)("a socket in a folder this user may not enter is blocked", async () => {
    const closed = path.join(tmp, "closed");
    mkdirSync(closed);
    sock = path.join(closed, "ctl.sock");
    await serve(() => {});
    chmodSync(closed, 0o000);
    try {
      expect(await reach(sock)).toBe("blocked");
      const r = await run(["codex", "x"], { env: { ...env, SESSIONPIPE_SOCKET: sock } });
      expect(r.err).toBe(`sessionpipe ask: ${STOPPED} ${ANY}\n`);
    } finally {
      chmodSync(closed, 0o700);
    }
  });
});

describe("on, off, status and setup are commands only as the first word", () => {
  it("a flag or `--` before one is a usage error, and nothing is switched or written", async () => {
    mkdirSync(path.join(home, ".codex"));
    for (const [argv, word] of [
      [["--yes", "on"], "on"],
      [["--no-service", "--yes", "on"], "on"],
      [["--", "on"], "on"],
      [["--json", "off"], "off"],
      [["--", "off"], "off"],
      [["--remove", "setup"], "setup"],
      [["--quiet", "status"], "status"],
      [["--cwd", project, "on", "--yes"], "on"],
      // The whole CLI's own flag, which it takes out of every other command's words.
      [["--no-color", "on", "--yes", "--no-service"], "on"],
      [["--no-color", "off"], "off"],
      [["--no-color", "setup", "--remove"], "setup"],
    ] as const) {
      const r = await run([...argv]);
      expect(r, argv.join(" ")).toEqual({
        code: 2,
        out: "",
        err: `sessionpipe ask: \`${word}\` goes right after \`ask\`: sessionpipe ask ${word} …\n`,
      });
    }
    expect(readControl(env)).toBeNull();
    expect(installService).not.toHaveBeenCalled();
    expect(existsSync(path.join(home, ".codex", "AGENTS.md"))).toBe(false);
    // As the first word each is what it was.
    expect((await run(["status", "--quiet"])).code).toBe(0);
    expect((await run(["status", "--no-color"])).code).toBe(0);
  });

  // The daemon's socket is a Unix one here, as in the tests of an ask above.
  it.runIf(unix)("as a later word it is part of the task", async () => {
    await serve(answer("fine"));
    expect((await run(["codex", "on", "--quiet"])).out).toBe("fine");
    expect(seen[0]).toMatchObject({ op: "ask", harness: "codex", text: "on" });
  });
});

describe("ask setup: Codex's rules for the one command (conformance/control-ask-codex-rules.json)", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../../../conformance/control-ask-codex-rules.json", import.meta.url), "utf8"),
  ) as {
    file: string;
    rules: string;
    readings: { command: string[]; decision: string }[];
    without: { line_starting: string; command: string[]; decision: string }[];
    codex: string;
  };
  const rulesFile = () => path.join(home, ".codex", "rules", "sessionpipe.rules");
  const shown = (p: string) => `~${p.slice(home.length)}`;

  it("the file is the fixture's, byte for byte, and so are the readings it is tried against", () => {
    expect(codexAskRules()).toBe(fixture.rules);
    expect(codexAskRules().startsWith(CODEX_RULES_MARK)).toBe(true);
    expect(CODEX_RULE_READINGS.map(([command, decision]) => ({ command, decision }))).toEqual(fixture.readings);
    expect(codexRulesFile(env)).toBe(path.join(home, ".codex", ...fixture.file.split("/")));
    expect(codexRulesFile({ ...env, CODEX_HOME: path.join(tmp, "elsewhere") })).toBe(
      path.join(tmp, "elsewhere", ...fixture.file.split("/")),
    );
    expect(codexRulesFile({ HOME: "" })).toBe(rulesFile());
    expect(codexRulesFile()).toContain("sessionpipe.rules");
  });

  it("no word but the agent can stand between `ask` and what the command is", async () => {
    // The words the rules refuse in the agent's place: `--`, every flag, and the CLI's own.
    const refused = JSON.parse(
      /\["sessionpipe", "ask", (\["--",.*?\])\], decision="forbidden"/.exec(fixture.rules)?.[1] ?? "[]",
    ) as string[];
    for (const flag of [...(ASK_HELP.match(/--[a-z-]+/g) ?? []), "--", "--no-color", "--help", "-h"])
      expect(refused, flag).toContain(flag);
    // And the command itself never takes `on` for the switch after any of them. (`--help`
    // and `-h` are answered with help by the CLI, before this command is reached.)
    mkdirSync(path.join(home, ".codex"));
    for (const flag of refused.filter((f) => f !== "--help" && f !== "-h")) {
      const r = await run([flag, "on", "--yes", "--no-service"]);
      expect(r.code, flag).toBe(2);
      expect(r.out, flag).toBe("");
    }
    expect(readControl(env)).toBeNull();
    expect(installService).not.toHaveBeenCalled();
  });

  it("written where Codex is and its Codex reads them as meant; said in the person's words", async () => {
    expect((await run(["setup"])).out).toContain(`· Codex is not here: ${shown(rulesFile())}`);
    expect(existsSync(rulesFile())).toBe(false);
    mkdirSync(path.join(home, ".codex"));
    const first = await run(["setup"]);
    expect(first.out).toContain(`✓ wrote Codex's rule for \`sessionpipe ask\` into ${shown(rulesFile())}`);
    expect(first.out).toContain(
      "    Codex keeps a session's commands in a sandbox that closes the way to this computer's background service. The rule lets `sessionpipe ask <agent> …` out of it and nothing else: `sessionpipe ask on`, `off` and `setup` stay yours.",
    );
    expect(readFileSync(rulesFile(), "utf8")).toBe(fixture.rules);
    const again = await run(["setup"]);
    expect(again.out).toContain(`· Codex's rule for \`sessionpipe ask\` is already current: ${shown(rulesFile())}`);
    expect(again.out).not.toContain("Codex keeps a session's commands");
    // An older file of ours is brought up to date; --remove takes it out and says so once.
    writeFileSync(rulesFile(), `${CODEX_RULES_MARK}\n# an earlier one\n`);
    expect((await run(["setup"])).out).toContain(
      `✓ brought Codex's rule for \`sessionpipe ask\` up to date in ${shown(rulesFile())}`,
    );
    expect(readFileSync(rulesFile(), "utf8")).toBe(fixture.rules);
    expect((await run(["setup", "--remove"])).out).toContain(
      `✓ took Codex's rule for \`sessionpipe ask\` out of ${shown(rulesFile())}`,
    );
    expect(existsSync(rulesFile())).toBe(false);
    expect((await run(["setup", "--remove"])).out).toContain(`· no rule of ours in ${shown(rulesFile())}`);
  });

  it("a Codex that reads them otherwise gets no file, and loses one it had; none to try them with writes nothing", async () => {
    mkdirSync(path.join(home, ".codex", "rules"), { recursive: true });
    reads = "unfit";
    const r = await run(["setup"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "  ! did not write Codex's rule for `sessionpipe ask`: the Codex on this machine does not read it as meant. Update Codex, then run `sessionpipe ask setup` again. Until then a Codex session's sandbox stops `sessionpipe ask`.",
    );
    expect(existsSync(rulesFile())).toBe(false);
    // One line this Codex does not know and it reads none of its rules files: ours goes.
    writeFileSync(rulesFile(), fixture.rules);
    expect(setupCodexRules(env, false, () => "unfit")).toEqual({ file: rulesFile(), did: "unfit" });
    expect(existsSync(rulesFile())).toBe(false);
    reads = "none";
    expect((await run(["setup"])).out).toContain(
      "  · did not write Codex's rule for `sessionpipe ask`: no `codex` command was found here to try it with",
    );
    expect(existsSync(rulesFile())).toBe(false);
    // With none to try them with, a file of ours that is there stays as it is.
    writeFileSync(rulesFile(), fixture.rules);
    expect(setupCodexRules(env, false, () => "none").did).toBe("unchecked");
    expect(readFileSync(rulesFile(), "utf8")).toBe(fixture.rules);
  });

  it("a file of that name sessionpipe did not write is left alone, both ways", async () => {
    mkdirSync(path.join(home, ".codex", "rules"), { recursive: true });
    const line = `! left alone, since sessionpipe did not write it: ${shown(rulesFile())}`;
    // Theirs, even when it starts with words like ours: only the whole first line is the mark.
    for (const theirs of [
      'prefix_rule(pattern=["sessionpipe"], decision="prompt")\n',
      '# sessionpipe ask: my own notes\nprefix_rule(pattern=["sessionpipe", "ask"], decision="prompt")\n',
    ]) {
      writeFileSync(rulesFile(), theirs);
      expect((await run(["setup"])).out).toContain(line);
      expect((await run(["setup", "--remove"])).out).toContain(line);
      expect(readFileSync(rulesFile(), "utf8")).toBe(theirs);
    }
  });

  it("a rules folder that cannot be used is said in a line, with exit 1, and nothing is thrown", async () => {
    mkdirSync(path.join(home, ".codex"));
    // `rules` is a file: no folder can be made of it.
    writeFileSync(path.join(home, ".codex", "rules"), "");
    const r = await run(["setup"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ {2}! could not write Codex's rule for `sessionpipe ask` \(.*sessionpipe\.rules\): E[A-Z]+/);
    // The section was still written: the command exists, and the blocked answer says what is missing.
    expect(r.out).toContain("✓ wrote the section into");
    rmSync(path.join(home, ".codex", "rules"));
    // The rules file is a folder: it can be neither read nor taken out.
    mkdirSync(rulesFile(), { recursive: true });
    const gone = await run(["setup", "--remove"]);
    expect(gone.code).toBe(1);
    expect(gone.out).toMatch(/ {2}! could not take out Codex's rule for `sessionpipe ask` \(.*\): E[A-Z]+/);
  });

  it("with no Codex to be found the rules are not tried at all", () => {
    expect(codexReads(fixture.rules, env, null)).toBe("none");
  });

  it("the rules are tried in a file of their own, which is gone after: ok only when every reading is as meant", () => {
    const tried: string[] = [];
    const says =
      (wrong?: string) =>
      (bin: string, file: string, words: string[]): string | null => {
        expect(bin).toBe("/somewhere/codex");
        expect(path.basename(file)).toBe("sessionpipe.rules");
        expect(readFileSync(file, "utf8")).toBe(fixture.rules);
        tried.push(file);
        const said = fixture.readings.find((r) => r.command.join(" ") === words.join(" "))?.decision ?? null;
        return words.join(" ") === wrong ? null : said;
      };
    expect(codexReads(fixture.rules, env, "/somewhere/codex", says())).toBe("ok");
    expect(tried).toHaveLength(fixture.readings.length);
    expect(existsSync(tried[0] as string)).toBe(false);
    // A reading Codex did not give at first (a slow start) is asked once more.
    let slow = 1;
    const second = says();
    expect(
      codexReads(fixture.rules, env, "/somewhere/codex", (bin, file, words) =>
        slow-- > 0 ? null : second(bin, file, words),
      ),
    ).toBe("ok");
    // One reading this Codex cannot give (it does not know the command, or a line of the file).
    for (const r of fixture.readings)
      expect(codexReads(fixture.rules, env, "/somewhere/codex", says(r.command.join(" "))), r.command.join(" ")).toBe(
        "unfit",
      );
  });

  // A stand-in `codex` on disk (a shell script): what the default lookup and the default
  // way of asking it do, end to end. POSIX only.
  it.runIf(unix)("asks the codex this machine would run, found as a headless turn finds it", () => {
    const bin = path.join(tmp, "codex");
    const table = fixture.readings.map((r) => `${r.command.join(" ")}=${r.decision}`).join("\n");
    writeFileSync(path.join(tmp, "table"), `${table}\n`);
    writeFileSync(
      bin,
      `#!/bin/sh
[ "$1 $2 $3 $5" = "execpolicy check --rules --resolve-host-executables" ] || exit 9
grep -q '^host_executable' "$4" || exit 1
shift 5
d=$(grep -F -x -e "$*=allow" -e "$*=forbidden" "${path.join(tmp, "table")}" | sed 's/.*=//')
if [ -n "$d" ]; then echo "{\\"matchedRules\\":[{}],\\"decision\\":\\"$d\\"}"; else echo '{"matchedRules":[]}'; fi
`,
    );
    chmodSync(bin, 0o755);
    const e = { ...env, SESSIONPIPE_CODEX: bin };
    expect(codexReads(fixture.rules, e)).toBe("ok");
    expect(codexReads(fixture.rules, { ...e, HOME: "" })).toBe("ok");
    // A Codex from before `host_executable` cannot read the file at all.
    expect(codexReads(fixture.rules.replace(/^host_executable.*\n/m, ""), e)).toBe("unfit");
    mkdirSync(path.join(home, ".codex"));
    expect(setupCodexRules(e, false)).toEqual({ file: rulesFile(), did: "added" });
    expect(setupCodexRules(e, false).did).toBe("unchanged");
    expect(setupCodexRules(e, true).did).toBe("removed");
  });

  // Where a real Codex is installed, the fixture is tried on it: every reading, and for
  // each line of the file the command that gets through without it.
  it.runIf(
    codexHere !== null && (codexVersion === `codex-cli ${fixture.codex}` || !!process.env.SESSIONPIPE_TEST_CODEX),
  )(
    "the Codex installed here reads the file as the fixture says",
    () => {
      const dir = path.join(tmp, "real");
      mkdirSync(dir);
      const withRules = path.join(dir, "sessionpipe.rules");
      writeFileSync(withRules, fixture.rules);
      const real = codexHere as string;
      for (const r of fixture.readings)
        expect(codexControl.codexRuleReading(real, withRules, r.command), r.command.join(" ")).toBe(r.decision);
      for (const w of fixture.without) {
        const lines = fixture.rules.split("\n");
        const less = lines.filter((l) => !l.startsWith(w.line_starting));
        expect(less.length, w.line_starting).toBe(lines.length - 1);
        const file = path.join(dir, "less.rules");
        writeFileSync(file, less.join("\n"));
        expect(codexControl.codexRuleReading(real, file, w.command), w.command.join(" ")).toBe(w.decision);
      }
    },
    60_000,
  );
});

describe("ask setup", () => {
  const claude = () => path.join(home, ".claude", "CLAUDE.md");
  const codex = () => path.join(home, ".codex", "AGENTS.md");
  const section = () => askSection(agents);
  /** As the CLI prints a path under home: `~` and the platform's own separators. */
  const shown = (p: string) => `~${p.slice(home.length)}`;

  it("writes the section where a harness is, creates the file when its dir is there, skips a harness that isn't", async () => {
    mkdirSync(path.join(home, ".claude"));
    const r = await run(["setup"]);
    expect(r.code).toBe(0);
    expect(readFileSync(claude(), "utf8")).toBe(`${section()}\n`);
    expect(existsSync(codex())).toBe(false);
    expect(r.out).toContain(`✓ wrote the section into ${shown(claude())}`);
    expect(r.out).toContain(`· not here: ${shown(codex())}`);
    expect(r.out).toContain("A session reads it when it starts");
    // Again: nothing changes. The agents change: the section follows.
    expect((await run(["setup"])).out).toContain(`· already current: ${shown(claude())}`);
    agents = ["codex"];
    expect((await run(["setup"])).out).toContain(`✓ brought the section up to date in ${shown(claude())}`);
    expect(readFileSync(claude(), "utf8")).toBe(`${askSection(["codex"])}\n`);
    expect(readFileSync(claude(), "utf8")).toContain("Agents here: codex.");
    // --remove takes it out; a file that is then empty was ours and goes.
    const gone = await run(["setup", "--remove"]);
    expect(gone.out).toContain(`✓ took the section out of ${shown(claude())}`);
    expect(gone.out).toContain(`· no section in ${shown(codex())}`);
    expect(existsSync(claude())).toBe(false);
  });

  it("joins an existing file with one newline and gives it back byte for byte", async () => {
    mkdirSync(path.join(home, ".claude"));
    mkdirSync(path.join(home, ".codex"));
    for (const before of ["# Mine\n", "# Mine", "# Mine\n\n- a\n- b\n\n"]) {
      writeFileSync(claude(), before);
      writeFileSync(codex(), before);
      await run(["setup"]);
      expect(readFileSync(claude(), "utf8")).toBe(`${before}\n${section()}\n`);
      expect(readFileSync(codex(), "utf8")).toBe(`${before}\n${section()}\n`);
      await run(["setup", "--remove"]);
      expect(readFileSync(claude(), "utf8"), JSON.stringify(before)).toBe(before);
      expect(readFileSync(codex(), "utf8"), JSON.stringify(before)).toBe(before);
    }
    // A section the person wrote text after is replaced in place and removed in place.
    writeFileSync(claude(), `A\n\n${askSection(["old"])}\nB\n`);
    await run(["setup"]);
    expect(readFileSync(claude(), "utf8")).toBe(`A\n\n${section()}\nB\n`);
    await run(["setup", "--remove"]);
    expect(readFileSync(claude(), "utf8")).toBe("A\nB\n");
    // --remove where nothing was ever written leaves every byte alone.
    writeFileSync(claude(), "keep");
    await run(["setup", "--remove"]);
    expect(readFileSync(claude(), "utf8")).toBe("keep");
  });

  it("with no HOME in the environment the files are under this user's home; a Codex home elsewhere is named whole", async () => {
    expect(setupFiles({ HOME: "" })).toContain(path.join(home, ".codex", "AGENTS.md"));
    expect(setupFiles().length).toBeGreaterThan(0);
    const codexHome = path.join(tmp, "codex-elsewhere");
    mkdirSync(codexHome);
    const r = await run(["setup"], { env: { ...env, HOME: "", CODEX_HOME: codexHome } });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`✓ wrote the section into ${path.join(codexHome, "AGENTS.md")}`);
    expect(r.out).toContain(`· not here: ${shown(claude())}`);
  });

  it("every Claude Code config dir, and Codex's home from CODEX_HOME", () => {
    mkdirSync(path.join(home, ".claude"));
    mkdirSync(path.join(home, ".claude-work"));
    const other = path.join(tmp, "codex-home");
    mkdirSync(other);
    const e = { ...env, CLAUDE_CONFIG_DIR: path.join(home, ".claude-work"), CODEX_HOME: other };
    expect(setupFiles(e)).toEqual([
      path.join(home, ".claude", "CLAUDE.md"),
      path.join(home, ".claude-work", "CLAUDE.md"),
      path.join(other, "AGENTS.md"),
    ]);
    expect(setupAsk(e, ["codex"], false).map((r) => r.did)).toEqual(["added", "added", "added"]);
    expect(readFileSync(path.join(other, "AGENTS.md"), "utf8")).toBe(`${askSection(["codex"])}\n`);
    expect(setupAsk(e, ["codex"], true).map((r) => r.did)).toEqual(["removed", "removed", "removed"]);
    expect(setupAsk(e, ["codex"], true).map((r) => r.did)).toEqual(["absent", "absent", "absent"]);
  });

  it("the section itself, and the two pure edits", () => {
    const s = askSection([]);
    expect(s.startsWith("<!-- sessionpipe ask -->\n")).toBe(true);
    expect(s.endsWith("\n<!-- /sessionpipe ask -->")).toBe(true);
    expect(s).toContain("No agent sessionpipe can run is installed here yet");
    expect(s).toContain('`sessionpipe ask <agent> "<task>"`');
    expect(s).toContain("Never use it to send your own reply");
    expect(s).toContain(
      "Run it as a command of its own, under\nits bare name and with the agent right after `ask`, never chained, piped or redirected",
    );
    expect(askSection(["codex", "gemini-cli"])).toContain("Agents here: codex, gemini-cli.");
    expect(withAskSection(null, s)).toBe(`${s}\n`);
    expect(withAskSection("", s)).toBe(`${s}\n`);
    expect(withoutAskSection("no section here\n")).toBe("no section here\n");
    expect(withoutAskSection(`${s}\n`)).toBe("");
    expect(withoutAskSection(s)).toBe("");
    // An opening marker with no close is not a section.
    expect(withoutAskSection("x\n<!-- sessionpipe ask -->\n")).toBe("x\n<!-- sessionpipe ask -->\n");
    expect(withAskSection("x\n<!-- sessionpipe ask -->\n", s)).toBe(`x\n<!-- sessionpipe ask -->\n\n${s}\n`);
  });
});

describe("help", () => {
  it("has a usage row for ask and each of its subcommands", () => {
    // Into a pipe a command's usage is one whole line.
    expect(usage(PLAIN, ["ask"], [])).toContain('Usage: sessionpipe ask <agent|harness:id> "<task>"');
    expect(usage(PLAIN, ["ask", "codex", "x"], [])).toContain('ask <agent|harness:id> "<task>"');
    for (const sub of ["on", "off", "status", "setup"])
      expect(usage(PLAIN, ["ask", sub], [])).toContain(`Usage: sessionpipe ask ${sub}`);
    expect(usage(PLAIN, ["ask", "setup"], [])).toContain("--remove");
  });
});
