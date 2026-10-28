// SPDX-License-Identifier: Apache-2.0
// `sessionpipe ask` at the terminal (CONTROL.md §13) against a stand-in daemon on the local
// socket that speaks the ask wire: what goes out in the request, what each reply becomes on
// stdout and stderr, the exit codes, the switch (on / off / status) in control.json, and the
// section `ask setup` writes into CLAUDE.md and AGENTS.md and takes out again, byte for byte.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASK_HELP,
  type AskOptions,
  askMain,
  askSection,
  setupAsk,
  setupFiles,
  withAskSection,
  withoutAskSection,
} from "../src/ask.js";
import type { LocalReply, LocalRequest } from "../src/control/local.js";
import { installService, uninstallService } from "../src/control/pair.js";
import { readControl, writeControl } from "../src/control/store.js";
import { commandHelp } from "../src/help.js";
import { rerunGlobally, viaNpx } from "../src/runtime.js";

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
    { env, harnesses: () => agents, distDir: path.join(tmp, "dist"), ...o },
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
  it("sends the request as the wire says, shows progress on stderr and prints the answer on stdout", async () => {
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
    // The whole answer-so-far arrives each time; only what is new is shown.
    expect(r.err).toBe(
      `sessionpipe ask: codex is on it (ask ${ASK_ID})\nLooking at the diff…\nsessionpipe ask: codex:t1 answered in 1.2 s\n`,
    );
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
      "sessionpipe ask: no control daemon is answering on this machine. Run `sessionpipe ask on` once at its terminal: that starts the daemon as a service and keeps it running.\n",
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
    expect(r.out).toContain("Daemon: launchd agent (stand-in)");
    expect(r.out).toContain("`sessionpipe ask setup`");
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
    expect(r.out).toContain("Daemon: removed");
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
});

describe("ask setup", () => {
  const claude = () => path.join(home, ".claude", "CLAUDE.md");
  const codex = () => path.join(home, ".codex", "AGENTS.md");
  const section = () => askSection(agents);

  it("writes the section where a harness is, creates the file when its dir is there, skips a harness that isn't", async () => {
    mkdirSync(path.join(home, ".claude"));
    const r = await run(["setup"]);
    expect(r.code).toBe(0);
    expect(readFileSync(claude(), "utf8")).toBe(`${section()}\n`);
    expect(existsSync(codex())).toBe(false);
    expect(r.out).toContain("✓ wrote the section into ~/.claude/CLAUDE.md");
    expect(r.out).toContain("· not here: ~/.codex/AGENTS.md");
    expect(r.out).toContain("A session reads it when it starts");
    // Again: nothing changes. The agents change: the section follows.
    expect((await run(["setup"])).out).toContain("· already current: ~/.claude/CLAUDE.md");
    agents = ["codex"];
    expect((await run(["setup"])).out).toContain("✓ brought the section up to date in ~/.claude/CLAUDE.md");
    expect(readFileSync(claude(), "utf8")).toBe(`${askSection(["codex"])}\n`);
    expect(readFileSync(claude(), "utf8")).toContain("Agents here: codex.");
    // --remove takes it out; a file that is then empty was ours and goes.
    const gone = await run(["setup", "--remove"]);
    expect(gone.out).toContain("✓ took the section out of ~/.claude/CLAUDE.md");
    expect(gone.out).toContain("· no section in ~/.codex/AGENTS.md");
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
    expect(r.out).toContain("· not here: ~/.claude/CLAUDE.md");
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
    expect(commandHelp(["ask"], [])).toContain('ask <agent|harness:id> "<task>"');
    expect(commandHelp(["ask", "codex", "x"], [])).toContain('ask <agent|harness:id> "<task>"');
    for (const sub of ["on", "off", "status", "setup"]) expect(commandHelp(["ask", sub], [])).toContain(`ask ${sub}`);
    expect(commandHelp(["ask", "setup"], [])).toContain("--remove");
  });
});
