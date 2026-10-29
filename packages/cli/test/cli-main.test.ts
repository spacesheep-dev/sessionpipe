// SPDX-License-Identifier: Apache-2.0
// Every command of `sessionpipe`, in process: main(argv, io) against a throwaway HOME,
// config, state and data dir, a receiver on localhost, a daemon on a socket in the
// temp dir, and a `claude` that answers `auth status` from a shell script. What would
// start npm, launchctl or the keychain is stood in for at its module boundary.
// cli.test.ts proves the same binary from outside; this is where its branches live.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adapterByName, makeEvent, Outbox, readConfig, writeConfig } from "@sessionpipe/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { controlMain, waitMain } from "../src/control/cli.js";
import { moveControlSecrets } from "../src/control/store.js";
import { HttpSink } from "../src/http-sink.js";
import { factsState, VERSION } from "../src/run.js";
import { rerunGlobally, viaNpx } from "../src/runtime.js";
import { bestStore, dropSinkSecrets, moveSinkSecrets, sinkWithSecrets } from "../src/secrets.js";
import { globalPrefix, installVersion, latestVersion } from "../src/update.js";

type Cli = typeof import("../src/cli.js");

// cli.ts takes its dist folder from its own URL; here that is the built dist, so the
// hook launcher copies real files and the hook command names a real hook.js.
const dist = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:url", async (original) => {
  const real = await original<typeof import("node:url")>();
  return {
    ...real,
    fileURLToPath: (u: string | URL, o?: { windows?: boolean }) =>
      dist.dir && String(u).endsWith("/src/cli.ts") ? `${dist.dir}/cli.ts` : real.fileURLToPath(u, o),
  };
});
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
  // The hook, timed by doctor, answers at once; a keychain tool is not here.
  spawnSync: vi.fn((_cmd: string, args: string[]) => ({
    status: args.some((a) => a.endsWith("hook.js")) ? 0 : 1,
    stdout: "",
    stderr: "",
  })),
}));
vi.mock("../src/runtime.js", async (original) => ({
  ...(await original<typeof import("../src/runtime.js")>()),
  viaNpx: vi.fn(() => false),
  rerunGlobally: vi.fn(),
}));
vi.mock("../src/update.js", async (original) => ({
  ...(await original<typeof import("../src/update.js")>()),
  latestVersion: vi.fn(),
  installVersion: vi.fn(),
  globalPrefix: vi.fn(() => null),
}));
vi.mock("../src/secrets.js", async (original) => {
  const real = await original<typeof import("../src/secrets.js")>();
  return {
    ...real,
    bestStore: vi.fn(real.bestStore),
    moveSinkSecrets: vi.fn(real.moveSinkSecrets),
    sinkWithSecrets: vi.fn(real.sinkWithSecrets),
    dropSinkSecrets: vi.fn(real.dropSinkSecrets),
  };
});
vi.mock("../src/control/store.js", async (original) => {
  const real = await original<typeof import("../src/control/store.js")>();
  return { ...real, moveControlSecrets: vi.fn(real.moveControlSecrets) };
});
vi.mock("../src/control/cli.js", async (original) => ({
  ...(await original<typeof import("../src/control/cli.js")>()),
  controlMain: vi.fn(async () => {}),
  waitMain: vi.fn(async () => {}),
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const realDist = path.resolve(here, "../dist");
const claudeCode = adapterByName("claude-code")!;
const codex = adapterByName("codex")!;
let cli: Cli;
let tmp: string;
let state: string;
let config: string;
let home: string;
const servers: Server[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;

function put(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}
const cfg = () => readConfig();
const onPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p, configurable: true });

/** One run of the CLI: what it printed, and what it did at the end. */
async function run(...argv: string[]) {
  const lines: string[] = [];
  const io = { out: (s = "") => void lines.push(s), err: vi.fn(), exit: vi.fn() };
  await cli.main(argv, io);
  return { lines, text: lines.join("\n"), err: io.err, exit: io.exit };
}

/** A receiver on localhost: its well-known file, and an events endpoint that answers `status`. */
function receiver(o: { wellKnown?: unknown; wellKnownStatus?: number; status?: number; body?: unknown } = {}) {
  const posts: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (b) => {
      body += b;
    });
    req.on("end", () => {
      if (req.url === "/.well-known/sessionpipe") {
        res.writeHead(o.wellKnownStatus ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(o.wellKnown ?? { max_tier: 3 }));
        return;
      }
      posts.push(JSON.parse(body));
      res.writeHead(o.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(o.body ?? { accepted: 2 }));
    });
  });
  servers.push(server);
  return new Promise<{ url: string; posts: unknown[] }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, posts }),
    ),
  );
}

/** The control daemon's socket, answering each op from `replies` (or nothing). */
function daemon(replies: Record<string, unknown>): Promise<() => Promise<void>> {
  const server = net.createServer((socket) => {
    socket.once("data", (d) => {
      const r = replies[(JSON.parse(d.toString()) as { op: string }).op];
      if (r === undefined) socket.end();
      else socket.end(`${JSON.stringify(r)}\n`);
    });
  });
  return new Promise((resolve) =>
    server.listen(process.env.SESSIONPIPE_SOCKET, () =>
      resolve(() => new Promise<void>((r) => server.close(() => r()))),
    ),
  );
}

/** A `claude` that answers `auth status --json` by the account it is asked about. */
function fakeClaude(): string {
  const bin = path.join(tmp, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh
case "$CLAUDE_CONFIG_DIR" in
  *.claude-second) echo '{"loggedIn":false}' ;;
  *.claude-plain) echo '{"loggedIn":true}' ;;
  *.claude-odd) echo 'no json here' ;;
  *) echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}' ;;
esac
`,
    { mode: 0o755 },
  );
  return bin;
}

function event(type: string, data: Record<string, unknown>, session: Record<string, unknown> = {}) {
  return makeEvent(
    { type, harnessEvent: "x", data },
    { harness: { name: "claude-code" }, session: { id: "0123456789abcdef", seq: 0, machine: "m", ...session } },
  );
}

beforeAll(async () => {
  dist.dir = realDist;
  cli = await import("../src/cli.js");
});

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-main-")));
  home = path.join(tmp, "home");
  mkdirSync(home);
  state = path.join(tmp, "state");
  config = path.join(tmp, "config", "config.json");
  for (const [k, v] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    PATH: "",
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    GEMINI_CLI_HOME: path.join(home, ".gemini"),
    SESSIONPIPE_CONFIG: config,
    SESSIONPIPE_STATE: state,
    SESSIONPIPE_DATA: path.join(tmp, "data"),
    SESSIONPIPE_SOCKET: path.join(tmp, "ctl.sock"),
    SESSIONPIPE_SECRETS: "file",
    SESSIONPIPE_CLAUDE: path.join(tmp, "no-claude"),
    SESSIONPIPE_NO_UPDATE_CHECK: undefined,
    SSH_CONNECTION: undefined,
  }))
    vi.stubEnv(k, v as string);
  vi.resetAllMocks();
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("help, version and the dispatch", () => {
  it("prints the usage for a command and its subcommand, and the overview for the rest", async () => {
    expect((await run("sink", "add", "--help")).text).toMatch(/^Usage: sessionpipe sink add <url/);
    expect((await run("control", "keys", "remove", "-h")).text).toContain("control keys remove <id>");
    for (const argv of [[], ["help"], ["--help"], ["bogus"], ["bogus", "-h"]]) {
      const { text } = await run(...argv);
      expect(text).toContain(`sessionpipe ${VERSION} — an open protocol`);
      expect(text).toContain("sessionpipe control pair <receiver>");
    }
    expect(controlMain).not.toHaveBeenCalled();
  });

  it("the version, the hook note, and the control and wait dispatch", async () => {
    for (const v of ["version", "--version", "-v"]) expect((await run(v)).lines).toEqual([VERSION]);
    expect((await run("hook")).lines).toEqual(["sessionpipe hook is dist/hook.js; harnesses run it directly"]);
    await run("control", "status");
    expect(controlMain).toHaveBeenCalledWith(["control", "status"], expect.any(Function), realDist);
    await run("wait", "--session", "claude-code:x");
    expect(waitMain).toHaveBeenCalledWith(["wait", "--session", "claude-code:x"], expect.any(Function));
  });

  it("a failing command says why on stderr and exits 1", async () => {
    const r = await run("install", "--machine");
    expect(r.err).toHaveBeenCalledWith("sessionpipe: --machine NAME is required when naming or renaming a machine\n");
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.lines).toEqual([]);
  });

  it("by default it prints to this process's stdout and stderr and ends it", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await cli.main(["version"]);
    expect(stdout).toHaveBeenCalledWith(`${VERSION}\n`);
    await cli.main(["install", "--machine"]);
    expect(stderr).toHaveBeenCalledWith("sessionpipe: --machine NAME is required when naming or renaming a machine\n");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("the entrypoint test follows npm's bin link to the file, and a missing path is no entrypoint", () => {
    const file = path.join(tmp, "real.js");
    writeFileSync(file, "");
    const link = path.join(tmp, "link");
    symlinkSync(file, link);
    expect(cli.isEntrypoint(link, `file://${file}`)).toBe(true);
    expect(cli.isEntrypoint(file, `file://${file}`)).toBe(true);
    expect(cli.isEntrypoint(path.join(tmp, "other.js"), `file://${file}`)).toBe(false);
    expect(cli.isEntrypoint(path.join(tmp, "missing.js"), `file://${file}`)).toBe(false);
    expect(cli.isEntrypoint(undefined, `file://${file}`)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("install", () => {
  it("hooks the harnesses found here, writes the launcher, backfills, and says where events go", async () => {
    mkdirSync(path.join(home, ".claude"));
    put(path.join(home, ".codex", "config.toml"), "");
    put(path.join(home, ".gemini", "settings.json"), {});
    const rows = [
      {
        session: { id: "aaaaaaaa-0000-4000-8000-000000000001", cwd: path.join(home, "proj"), title: "t" },
        started_at: Date.now() - 1000,
        last_at: Date.now(),
        turns: 3,
      },
      { session: { id: "aaaaaaaa-0000-4000-8000-000000000002" }, started_at: Date.now() - 1000, last_at: Date.now() },
    ];
    vi.spyOn(claudeCode, "backfill").mockReturnValue(rows);
    vi.spyOn(codex, "backfill").mockImplementation(() => {
      throw new Error("unreadable");
    });
    const first = await run("install");
    expect(first.text).toContain("✓ hook launcher:");
    expect(first.text).toContain("Machine: ");
    expect(first.text).toContain("No sink above tier 0: hooking one tool event per harness");
    expect(first.text).toMatch(/✓ claude-code: .*settings\.json written/);
    expect(first.text).toContain("note: Gemini CLI's own telemetry");
    expect(first.text).toContain("note: Codex runs non-managed hooks only after you approve them");
    expect(first.text).toContain("✓ Backfill: 2 sessions from the last 30 days queued as session.backfill");
    expect(first.text).toContain("Nothing leaves this machine yet");
    expect(cfg().harnesses["claude-code"]).toMatchObject({
      enabled: true,
      created: [expect.stringMatching(/\.claude/)],
    });
    const queued = new Outbox(state).read({ harness: "claude-code", session: rows[0]!.session.id }, 0);
    expect(queued.events[0]).toMatchObject({
      type: "session.backfill",
      data: { turns: 3 },
      session: { cwd: expect.any(String) },
    });

    // Again: nothing changes, the backfilled sessions are not queued twice, and a tier-1
    // sink makes the install a full one that reports somewhere.
    const again = await run("install", "--sink", "stdout", "--tier", "1", "--backfill", "7");
    expect(again.text).toContain("✓ sink stdout: stdout at tier 1");
    expect(again.text).not.toContain("No sink above tier 0");
    expect(again.text).toMatch(/[✓=] claude-code: .*settings\.json/);
    expect(again.text).toContain("✓ Backfill: 0 sessions from the last 7 days");
    expect(again.text).toContain("Reporting to stdout (tier 1).");
    expect(again.text).not.toContain("hook launcher");
    const third = await run("install", "--claude-code", "--backfill", "0");
    expect(third.text).toContain("= claude-code: ");
    expect(third.text).not.toContain("Backfill:");
  });

  it("a settings file it can't read is skipped and said so; a single session backfills in the singular", async () => {
    put(path.join(home, ".claude", "settings.json"), "{not json");
    vi.spyOn(claudeCode, "backfill").mockReturnValue([
      { session: { id: "aaaaaaaa-0000-4000-8000-000000000003" }, started_at: 1, last_at: 2 },
    ]);
    const { text } = await run("install", "--claude-code");
    expect(text).toMatch(/! claude-code: .*settings\.json — .*not touched/);
    expect(text).toContain("✓ Backfill: 1 session from the last 30 days");
  });

  it("devin: the note about a hooks file Devin drops whole, unless its config was skipped", async () => {
    const devinConfig = path.join(home, ".config", "devin", "config.json");
    put(devinConfig, {});
    const { text } = await run("install", "--devin", "--backfill", "0");
    expect(text).toMatch(/✓ devin: /);
    expect(text).toContain("Devin ignores a hooks file whole");
    put(devinConfig, "{not json");
    const again = await run("install", "--devin", "--backfill", "0");
    expect(again.text).toMatch(/! devin: .*config\.json — .*not touched/);
    expect(again.text).not.toContain("Devin ignores a hooks file whole");
  });

  it("with no harness here it says so and writes nothing", async () => {
    const { text } = await run("install");
    expect(text).toContain("No supported harness found on this machine");
    expect(existsSync(config)).toBe(false);
  });

  it("run from npx, it hands the command to a persistent copy before anything else", async () => {
    vi.mocked(viaNpx).mockReturnValueOnce(true);
    await run("install", "--claude-code", "--allow-downgrade");
    expect(rerunGlobally).toHaveBeenCalledWith(
      ["install", "--claude-code", "--allow-downgrade"],
      expect.any(Function),
      {
        allowDowngrade: true,
      },
    );
    expect(existsSync(config)).toBe(false);
  });

  it("names the machine once; a different --machine later is ignored unless it is a rename", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    await run("install", "--machine", "box-one", "--backfill", "0");
    expect(cfg().machine).toBe("box-one");
    const kept = await run("install", "--machine", "box-two", "--backfill", "0");
    expect(kept.text).toContain("Keeping configured machine name box-one; ignoring --machine box-two.");
    expect(cfg().machine).toBe("box-one");
    await run("install", "--rename-machine", "--machine", "box-two", "--backfill", "0");
    expect(cfg().machine).toBe("box-two");
    // A config without a name: the hostname's, as the hooks would name it.
    writeConfig({ ...cfg(), machine: undefined } as never);
    await run("install", "--backfill", "0");
    expect(cfg().machine).toBe(os.hostname().replace(/\.local$/, ""));
  });

  it("refuses --machine without a name; an explicit rename renames the paired daemon too", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    expect((await run("install", "--rename-machine")).err).toHaveBeenCalledWith(
      "sessionpipe: --machine NAME is required when naming or renaming a machine\n",
    );
    expect((await run("install", "--machine", "--backfill")).err).toHaveBeenCalled();
    const control = path.join(tmp, "config", "control.json");
    put(control, { name: "paired-box", folders: ["/p"], mode: "safe", receivers: [] });
    // The daemon's name is the machine's when the config has none.
    await run("install", "--backfill", "0");
    expect(cfg().machine).toBe("paired-box");
    // A rename moves both names together, so the hooks and the daemon stay one machine.
    const r = await run("install", "--rename-machine", "--machine", "other", "--backfill", "0");
    expect(r.err).not.toHaveBeenCalled();
    expect(r.text).toContain("Renamed the control daemon paired-box → other; its next hello tells each receiver.");
    expect(cfg().machine).toBe("other");
    expect(JSON.parse(readFileSync(control, "utf8"))).toMatchObject({ name: "other", folders: ["/p"], mode: "safe" });
    // Already the same name: nothing to say, nothing rewritten.
    const again = await run("install", "--rename-machine", "--machine", "other", "--backfill", "0");
    expect(again.text).not.toContain("Renamed the control daemon");
  });

  it("a config without a name keeps the hooks' hostname name and renames a daemon paired under another", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    const control = path.join(tmp, "config", "control.json");
    const hooks = os.hostname().replace(/\.(local|lan|home)$/i, "");
    // Paired before 0.9.0 on a Mac: the daemon said `<host>.local`, the events said `<host>`.
    writeConfig({ ...cfg(), machine: undefined } as never);
    put(control, { name: `${hooks}.local`, folders: ["/p"], mode: "safe", receivers: [] });
    const r = await run("install", "--backfill", "0");
    expect(r.err).not.toHaveBeenCalled();
    expect(cfg().machine).toBe(hooks);
    expect(r.text).toContain(
      `Renamed the control daemon ${hooks}.local → ${hooks}; its next hello tells each receiver.`,
    );
    expect(JSON.parse(readFileSync(control, "utf8"))).toMatchObject({ name: hooks, folders: ["/p"], mode: "safe" });
  });

  it("on Windows the hook names this node and hook.js by path, no launcher", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    onPlatform("win32");
    const { text } = await run("install", "--claude-code", "--backfill", "0");
    expect(text).not.toContain("hook launcher");
    const settings = readFileSync(path.join(home, ".claude", "settings.json"), "utf8");
    expect(settings).toContain(process.execPath);
    expect(settings).toContain(path.join(realDist, "hook.js"));
    expect(settings).not.toContain("sessionpipe-hook");
  });
});

describe.skipIf(process.platform === "win32")("uninstall", () => {
  it("removes what it wrote, the launcher too, and leaves the state", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    await run("install", "--claude-code", "--backfill", "0");
    expect(existsSync(path.join(tmp, "data", "sessionpipe-hook"))).toBe(true);
    writeConfig({ ...cfg(), keep_days: 7 } as never);
    const { text } = await run("uninstall");
    expect(text).toMatch(/✓ claude-code: .*settings\.json/);
    expect(text).toContain("Outbox and state kept under");
    expect(text).toContain("it prunes after 7 days");
    // A hand-edited config with no number there: the default.
    put(config, { ...cfg(), keep_days: null });
    expect((await run("uninstall")).text).toContain("it prunes after 30 days");
    expect(text).toContain("Done. Every config file is byte-identical");
    expect(cfg().harnesses).toEqual({});
    expect(existsSync(path.join(tmp, "data", "sessionpipe-hook"))).toBe(false);
    put(path.join(home, ".claude", "settings.json"), "{broken");
    onPlatform("win32");
    const again = await run("uninstall", "--keep-state");
    expect(again.text).toMatch(/! claude-code: .*settings\.json — /);
    expect(again.text).not.toContain("Outbox and state kept");
  });

  it("names a harness: only that one goes; the launcher and the rest stay", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    await run("install", "--claude-code", "--devin", "--backfill", "0");
    const { text } = await run("uninstall", "--devin");
    expect(text).toMatch(/✓ devin: /);
    expect(text).toContain("Still installed: claude-code.");
    expect(Object.keys(cfg().harnesses)).toEqual(["claude-code"]);
    expect(existsSync(path.join(tmp, "data", "sessionpipe-hook"))).toBe(true);
    expect(readFileSync(path.join(home, ".claude", "settings.json"), "utf8")).toContain("sessionpipe-hook");
    expect((await run("uninstall", "--claude-code")).text).toContain("Still installed: nothing.");
  });

  it("refuses every harness at once while an isolation var leaves one on the real home; --all, or no such vars, go ahead", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    await run("install", "--claude-code", "--backfill", "0");
    // SESSIONPIPE_CONFIG/STATE say "not this machine", but codex would still read ~/.codex.
    vi.stubEnv("CODEX_HOME", undefined as never);
    const r = await run("uninstall");
    expect(r.text).toContain("Refusing an uninstall of every harness");
    expect(r.text).toContain("Name what to remove (--codex)");
    expect(process.exitCode).toBe(2);
    expect(cfg().harnesses["claude-code"]).toBeDefined();
    process.exitCode = undefined;
    expect((await run("uninstall", "--all")).text).toMatch(/✓ claude-code: /);
    expect(cfg().harnesses).toEqual({});
    // With neither isolation var set there is nothing to be outside of: HOME is the sandbox.
    await run("install", "--claude-code", "--backfill", "0");
    vi.stubEnv("SESSIONPIPE_CONFIG", undefined as never);
    vi.stubEnv("SESSIONPIPE_STATE", undefined as never);
    const plain = await run("uninstall");
    expect(plain.text).not.toContain("Refusing");
    expect(plain.text).toMatch(/✓ claude-code: /);
  });
});

describe.skipIf(process.platform === "win32")("sink add | list | remove | test", () => {
  it("adds a sink named after its host with the receiver's cap and endpoints, then lists it", async () => {
    const rx = await receiver({ wellKnown: { max_tier: 1, endpoints: { events: "/in" } } });
    const { text } = await run("sink", "add", rx.url, "--tier", "3", "--token", "tok", "--pii", "--control");
    expect(text).toContain("--control is ignored");
    expect(text).toContain("receiver's max_tier is 1: sending tier 1, not 3");
    expect(text).toContain(`✓ sink 127.0.0.1:${new URL(rx.url).port}: ${rx.url} at tier 1, pii`);
    expect(text).toContain("tier 3 sends: tier 0 + tool names");
    expect(cfg().sinks[0]).toMatchObject({
      tier: 3,
      max_tier: 1,
      token: "tok",
      pii: true,
      endpoints: { events: "/in" },
    });
    expect(cfg().sinks[0]?.well_known_at).toMatch(/^\d{4}-/);
    const list = await run("sink", "list");
    expect(list.text).toContain("tier 3 (capped 1) pii");
    await run("sink", "add", "stdout");
    await run("sink", "add", `file:${path.join(tmp, "events.jsonl")}`, "--name", "disk", "--tier", "9");
    await run("sink", "add", `file:${path.join(tmp, "more.jsonl")}`);
    const names = cfg().sinks.map((s) => `${s.name}:${s.tier}`);
    expect(names).toEqual([expect.stringMatching(/^127\.0\.0\.1/), "stdout:0", "disk:3", "file:0"]);
    const noCap = await receiver({ wellKnown: { max_tier: 3 } });
    await run("sink", "add", noCap.url, "--name", "big");
    expect((cfg().sinks.find((s) => s.name === "big") as { endpoints?: unknown }).endpoints).toBeUndefined();
  });

  it("a receiver without a readable well-known file is added anyway, at the tier asked for", async () => {
    const rx = await receiver({ wellKnownStatus: 404 });
    const bad = await run("sink", "add", rx.url, "--tier", "2");
    expect(bad.text).toContain("has no readable /.well-known/sessionpipe (HTTP 404); added anyway, at tier 2");
    const gone = await run("sink", "add", "http://127.0.0.1:1", "--name", "gone");
    expect(gone.text).toContain("has no readable /.well-known/sessionpipe (fetch failed); added anyway, at tier 0");
    expect(cfg().sinks.map((s) => s.max_tier)).toEqual([undefined, undefined]);
  });

  it("changing a sink's tier keeps the key it has, wherever it lives; a new key replaces it", async () => {
    writeConfig({
      sinks: [
        { name: "kc", url: "https://kc.invalid", tier: 1, token_in: "keychain" },
        { name: "f", url: "https://f.invalid", tier: 1, token: "old", secret: "whsec_x" },
      ],
      harnesses: {},
    } as never);
    vi.mocked(sinkWithSecrets).mockImplementation((s) => (s.token_in ? { ...s, token: "from-keychain" } : s));
    await run("sink", "add", "https://kc.invalid", "--name", "kc", "--tier", "2");
    expect(cfg().sinks.find((s) => s.name === "kc")).toMatchObject({ tier: 2, token_in: "keychain" });
    await run("sink", "add", "https://f.invalid", "--name", "f", "--tier", "2");
    expect(cfg().sinks.find((s) => s.name === "f")).toMatchObject({ tier: 2, token: "old", secret: "whsec_x" });
    await run("sink", "add", "https://kc.invalid", "--name", "kc", "--token", "new");
    expect(dropSinkSecrets).toHaveBeenCalledWith(expect.objectContaining({ name: "kc", token_in: "keychain" }));
    expect(cfg().sinks.find((s) => s.name === "kc")).toMatchObject({ token: "new" });
    expect(cfg().sinks.find((s) => s.name === "kc")?.token_in).toBeUndefined();
    await run("sink", "add", "https://f.invalid", "--name", "f", "--secret", "whsec_y");
    expect(cfg().sinks.find((s) => s.name === "f")).toMatchObject({ token: "old", secret: "whsec_y" });
    // A key in a keychain this session can't read, and a new secret given: the secret
    // is set, and nothing unreadable is carried over.
    writeConfig({
      sinks: [{ name: "kc", url: "https://kc.invalid", tier: 1, token_in: "keychain" }],
      harnesses: {},
    } as never);
    vi.mocked(sinkWithSecrets).mockReturnValue(null);
    await run("sink", "add", "https://kc.invalid", "--name", "kc", "--secret", "whsec_z");
    expect(cfg().sinks[0]).toEqual({ name: "kc", url: "https://kc.invalid", tier: 0, pii: false, secret: "whsec_z" });
  });

  it("lists nothing, removes by name, and says when there is no such sink", async () => {
    expect((await run("sink", "list")).lines).toEqual(["  no sinks"]);
    writeConfig({
      sinks: [
        { name: "a", url: "stdout", tier: 0, control: true, paused: "HTTP 401", token_in: "keychain" },
        { name: "b", url: "stdout", tier: 2, max_tier: 3 },
      ],
      harnesses: {},
    } as never);
    expect((await run("sink", "list")).text).toContain("tier 0 control PAUSED HTTP 401");
    expect((await run("sink", "remove", "a")).lines).toEqual(["  ✓ removed a"]);
    expect(dropSinkSecrets).toHaveBeenCalledTimes(1);
    expect((await run("sink", "remove", "a")).lines).toEqual(["  no sink named a"]);
    expect(cfg().sinks.map((s) => s.name)).toEqual(["b"]);
    for (const argv of [["sink"], ["sink", "add"], ["sink", "remove"], ["sink", "test"], ["sink", "x"]])
      expect((await run(...argv)).text).toMatch(/^usage: sessionpipe sink add/);
  });

  it("tests a sink with a heartbeat and its forget, and reports what the receiver said", async () => {
    const ok = await receiver({ body: { accepted: 2 } });
    const refused = await receiver({ status: 401, body: { reason: "bad key" } });
    writeConfig({
      sinks: [
        { name: "ok", url: ok.url, tier: 1, token: "t" },
        { name: "no", url: refused.url, tier: 1 },
        { name: "paused", url: "stdout", tier: 0, paused: "HTTP 401" },
        { name: "out", url: "stdout", tier: 0 },
      ],
      harnesses: {},
    } as never);
    expect((await run("sink", "test", "ok")).lines).toEqual(["  ✓ ok: 200 accepted 2 (a heartbeat and its forget)"]);
    expect((ok.posts[0] as { events: { type: string }[] }).events.map((e) => e.type)).toEqual([
      "session.heartbeat",
      "session.forgotten",
    ]);
    expect((await run("sink", "test", "no")).lines).toEqual(["  ✗ no: 401 bad key (pause)"]);
    expect((await run("sink", "test", "paused")).lines).toEqual(["  sink type not supported yet"]);
    expect((await run("sink", "test", "nope")).lines).toEqual(["  no sink named nope"]);
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect((await run("sink", "test", "out")).lines).toEqual(["  ✓ out: ok accepted 2 (a heartbeat and its forget)"]);
    expect(write).toHaveBeenCalled();
    // A receiver that said nothing but yes, or nothing at all.
    const send = vi.spyOn(HttpSink.prototype, "send");
    send.mockResolvedValueOnce({ ok: true, acknowledged: 2, status: 202 });
    expect((await run("sink", "test", "ok")).lines).toEqual(["  ✓ ok: 202 accepted 2 (a heartbeat and its forget)"]);
    send.mockResolvedValueOnce({ ok: false, acknowledged: 0, action: "retry" });
    expect((await run("sink", "test", "ok")).lines).toEqual(["  ✗ ok:   (retry)"]);
  });
});

describe.skipIf(process.platform === "win32")("secrets", () => {
  it("says where each key lives and whether this session can read it", async () => {
    const empty = await run("secrets");
    expect(empty.lines).toEqual(["  no keys on this machine", "  best store from this session: a 0600 file"]);
    writeConfig({
      sinks: [
        { name: "kc", url: "https://kc.invalid", tier: 1, token_in: "keychain" },
        { name: "locked", url: "https://l.invalid", tier: 1, token_in: "secret-service" },
        { name: "f", url: "https://f.invalid", tier: 1, token: "t" },
        { name: "none", url: "stdout", tier: 0 },
      ],
      harnesses: {},
    } as never);
    put(path.join(tmp, "config", "control.json"), {
      name: "box",
      folders: [],
      mode: "safe",
      receivers: [
        { url: "https://a.invalid", machine: "m1", token: "t", keys: [] },
        { url: "https://b.invalid", machine: "m2", token_in: "keychain", keys: [] },
        { url: "https://c.invalid", machine: "m3", token_in: "keychain", keys: [] },
      ],
    });
    vi.mocked(sinkWithSecrets).mockImplementation((s) => (s.name === "kc" ? { ...s, token: "x" } : null));
    // The keychain tool hands back m3's token and knows nothing of m2's.
    vi.mocked(spawnSync).mockImplementation(
      (cmd: string, args: readonly string[] | undefined) =>
        ({
          status: cmd === "security" && args?.includes("control:m3") ? 0 : 44,
          stdout: cmd === "security" && args?.includes("control:m3") ? "tok\n" : "",
        }) as never,
    );
    const { text } = await run("secrets");
    expect(text).toContain("sink kc                   the macOS Keychain\n");
    expect(text).toContain(
      "sink locked               the Secret Service keyring — can't be read from this session (locked?)",
    );
    expect(text).toContain(`sink f                    ${config} (0600)`);
    expect(text).toContain("sink none                 no key");
    expect(text).toContain("control a.invalid         control.json (0600)");
    expect(text).toContain("control b.invalid         the macOS Keychain — can't be read from this session (locked?)");
    expect(text).toContain("control c.invalid         the macOS Keychain\n");
  });

  it("moves the keys into a store, or back, and names what stayed", async () => {
    expect((await run("secrets", "move", "vault")).lines).toEqual([
      "usage: sessionpipe secrets move keychain|secret-service|file",
    ]);
    expect((await run("secrets", "move", "file")).lines).toEqual(["  nothing to move to a 0600 file"]);
    vi.mocked(moveSinkSecrets).mockReturnValue({ moved: ["rx"], kept: ["locked"] });
    vi.mocked(moveControlSecrets).mockReturnValue({ moved: ["https://a.invalid"], kept: [] });
    expect((await run("secrets", "move", "keychain")).lines).toEqual([
      "  ✓ moved to the macOS Keychain: rx, https://a.invalid",
      "  ! left where they are (unreadable here, or the macOS Keychain refused them): locked",
    ]);
  });
});

describe.skipIf(process.platform === "win32")("connect", () => {
  it("needs a receiver, and from npx hands itself to a persistent copy first", async () => {
    expect((await run("connect")).text).toMatch(/^usage: sessionpipe connect <receiver>/);
    expect((await run("connect", "--tier", "2")).text).toMatch(/^usage:/);
    vi.mocked(viaNpx).mockReturnValueOnce(true);
    await run("connect", "rx.invalid");
    expect(rerunGlobally).toHaveBeenCalledWith(["connect", "rx.invalid"], expect.any(Function), {
      allowDowngrade: false,
    });
    expect(controlMain).not.toHaveBeenCalled();
  });

  it("does everything at once: hooks, accounts, pairing from this folder, the sink at tier 2, keys, backfill", async () => {
    const rx = await receiver({ wellKnown: { max_tier: 3 } });
    put(path.join(home, ".claude", "settings.json"), {});
    put(path.join(home, ".claude-second", "settings.json"), {});
    put(path.join(home, ".claude-plain", "settings.json"), {});
    put(path.join(home, ".claude-odd", "settings.json"), {});
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    writeConfig({ sinks: [{ name: "rx", url: `${rx.url}/`, tier: 1, token: "key" }], harnesses: {} } as never);
    const rows = [{ session: { id: "aaaaaaaa-0000-4000-8000-000000000009", cwd: home }, started_at: 1, last_at: 2 }];
    vi.spyOn(claudeCode, "backfill").mockReturnValue(rows);
    vi.mocked(bestStore).mockReturnValue("keychain");
    vi.mocked(moveSinkSecrets).mockReturnValue({ moved: ["rx"], kept: [] });
    vi.mocked(moveControlSecrets).mockReturnValue({ moved: [], kept: ["https://x"] });
    const { text } = await run(
      "connect",
      `${rx.url}/`,
      "--mode",
      "auto",
      "--no-service",
      "--rename-machine",
      "--machine",
      "lab",
    );
    const host = new URL(rx.url).host;
    expect(text).toContain(`Connecting lab to ${host}.`);
    expect(text).toContain("✓ hook launcher:");
    expect(text).toMatch(/✓ Claude Code .*\.claude: signed in \(claude\.ai, max\)/);
    expect(text).toMatch(/✓ Claude Code .*\.claude-plain: signed in\n/);
    expect(text).toMatch(
      /! Claude Code .*\.claude-second: not signed in as this shell sees it — `CLAUDE_CONFIG_DIR=.*claude auth login`\n/,
    );
    expect(text).not.toMatch(/Claude Code .*\.claude-odd/);
    expect(controlMain).toHaveBeenCalledWith(
      [
        "control",
        "pair",
        rx.url,
        "--mode",
        "auto",
        "--tier",
        "2",
        "--name",
        "lab",
        "--folder",
        process.cwd(),
        "--no-service",
      ],
      expect.any(Function),
      realDist,
    );
    expect(text).not.toContain("Safe mode:");
    expect(text).toContain("✓ Sink rx: tier 2 (was 1) — sends tier 1 + your prompts");
    expect(text).toContain("✓ Keys: in the macOS Keychain (left in the file: https://x)");
    expect(text).toContain("✓ Backfill: 1 session from the last 30 days");
    expect(text).toContain(`Done: lab reports to ${host} and takes messages you sign on a device it trusts.`);
    expect(cfg().sinks[0]).toMatchObject({ tier: 2, max_tier: 3, well_known_at: expect.any(String) });
  });

  it("already paired with a keyed sink: nothing to approve; the folders come from recent sessions when run from home", async () => {
    const rx = await receiver({ wellKnown: {} });
    put(path.join(tmp, "config", "control.json"), {
      name: "box",
      folders: [],
      mode: "auto",
      receivers: [{ url: rx.url, machine: "m_1", token: "t", keys: [] }],
    });
    writeConfig({ sinks: [{ name: "rx", url: rx.url, tier: 3, token_in: "keychain" }], harnesses: {} } as never);
    vi.stubEnv("SSH_CONNECTION", "10.0.0.1 1 10.0.0.2 22");
    const paired = await run("connect", rx.url, "--tier", "3");
    expect(paired.text).toContain("! No coding agent here yet");
    expect(paired.text).toContain(`✓ Already paired with ${new URL(rx.url).host} as m_1: nothing to approve.`);
    expect(paired.text).toContain("✓ Sink rx: tier 3 — sends everything");
    expect(paired.text).toContain("no unlocked keychain in this session (an ssh shell)");
    expect(controlMain).not.toHaveBeenCalled();

    // A paired daemon whose sink lost its key pairs again, in the daemon's own mode,
    // for the folders the last sessions ran in — this ran from the home folder.
    writeConfig({ sinks: [{ name: "rx", url: rx.url, tier: 3 }], harnesses: {} } as never);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(process, "cwd").mockReturnValue(home);
    put(path.join(home, ".claude", "settings.json"), {});
    const proj = path.join(home, "proj");
    mkdirSync(proj);
    vi.spyOn(claudeCode, "backfill").mockReturnValue([
      { session: { id: "aaaaaaaa-0000-4000-8000-000000000010", cwd: proj }, started_at: 1, last_at: 5 },
      { session: { id: "aaaaaaaa-0000-4000-8000-000000000011", cwd: home }, started_at: 1, last_at: 9 },
      { session: { id: "aaaaaaaa-0000-4000-8000-000000000012" }, started_at: 1, last_at: 3 },
      {
        session: { id: "aaaaaaaa-0000-4000-8000-000000000013", cwd: path.join(home, "gone") },
        started_at: 1,
        last_at: 7,
      },
    ]);
    const again = await run("connect", rx.url, "--mode", "bogus");
    // Printed as the person sees it: under the sandbox HOME, so with a tilde.
    expect(again.text).toContain("Folders from your recent sessions: ~/proj");
    expect(controlMain).toHaveBeenCalledWith(
      ["control", "pair", rx.url, "--mode", "auto", "--tier", "3", "--name", "box", "--folder", proj],
      expect.any(Function),
      realDist,
    );
    expect(again.text).not.toContain("Safe mode:");
  });

  it("from home with no project anywhere: no folder, said plainly; safe mode by default; --folder names them", async () => {
    const rx = await receiver();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(process, "cwd").mockReturnValue(home);
    vi.mocked(bestStore).mockReturnValueOnce("keychain");
    const none = await run("connect", new URL(rx.url).host);
    expect(none.text).toContain("! No folder for sessions you message yet");
    expect(none.text).toContain("Safe mode: `sessionpipe control mode auto`");
    expect(none.text).toContain(
      `! No sink for ${new URL(rx.url).host}: \`sessionpipe sink add https://${new URL(rx.url).host} --token <key> --tier 2\``,
    );
    expect(none.text).toContain("✓ Keys: in the macOS Keychain\n");
    expect(none.text).not.toContain("(an ssh shell)");
    expect(controlMain).toHaveBeenLastCalledWith(
      expect.arrayContaining(["--mode", "safe", "--tier", "2"]),
      expect.any(Function),
      realDist,
    );
    const flagged = await run("connect", rx.url, "--folder", path.join(home, "a"), "--folder", path.join(home, "b"));
    expect(flagged.text).not.toContain("No folder for sessions");
    expect(flagged.text).toContain("Keys: in ");
    expect(flagged.text).toContain("no unlocked keychain in this session\n");
    expect(controlMain).toHaveBeenLastCalledWith(
      expect.arrayContaining(["--folder", path.join(home, "a"), "--folder", path.join(home, "b")]),
      expect.any(Function),
      realDist,
    );
    // Inherit is taken as named, like the other two.
    const inherit = await run("connect", rx.url, "--mode", "inherit", "--folder", path.join(home, "a"));
    expect(inherit.text).not.toContain("Safe mode:");
    expect(controlMain).toHaveBeenLastCalledWith(
      expect.arrayContaining(["--mode", "inherit"]),
      expect.any(Function),
      realDist,
    );
  });

  it("over ssh on a Mac, a signed-out account says why the login can't be read; elsewhere not", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    put(path.join(home, ".claude-second", "settings.json"), {});
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    vi.stubEnv("SSH_CONNECTION", "10.0.0.1 1 10.0.0.2 22");
    onPlatform("darwin");
    expect((await run("connect", "rx.invalid")).text).toContain(
      "(over ssh a Mac's keychain login can't be read; log in at the screen)",
    );
    onPlatform("linux");
    expect((await run("connect", "rx.invalid")).text).not.toContain("over ssh a Mac's");
  });
});

describe.skipIf(process.platform === "win32")("status", () => {
  it("the human table: harnesses, sinks with undelivered sessions, control, update, timing, jobs", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    await run("install", "--claude-code", "--backfill", "0");
    writeConfig({
      ...cfg(),
      harnesses: { ...cfg().harnesses, "gemini-cli": { enabled: true } },
      sinks: [
        { name: "rx", url: "https://rx.invalid", tier: 3, max_tier: 1, paused: "HTTP 401" },
        { name: "out", url: "stdout", tier: 0 },
        { name: "done", url: "stdout", tier: 0 },
      ],
    } as never);
    const outbox = new Outbox(state);
    outbox.append({ harness: "claude-code", session: "s1" }, [event("session.heartbeat", {})]);
    outbox.append({ harness: "claude-code", session: "s2" }, [event("session.heartbeat", {})]);
    const size = readFileSync(outbox.file({ harness: "claude-code", session: "s2" })).length;
    put(path.join(state, "cursors", "done.json"), { "claude-code/s1": 100000, "claude-code/s2": size });
    put(path.join(state, "timing.jsonl"), '{"ms":3}\n{"ms":-1}\n{"ms":9}\n');
    put(path.join(state, "jobs", "a.json"), {});
    put(path.join(state, "jobs", "b.tmp"), {});
    // A session file that vanished between the listing and its size.
    symlinkSync(path.join(state, "gone.jsonl"), path.join(state, "outbox", "claude-code", "dangling.jsonl"));
    const { text } = await run("status");
    expect(text).toContain(`sessionpipe ${VERSION}   state ${state}`);
    expect(text).toMatch(/claude-code {2}.*settings\.json +current\n/);
    expect(text).toMatch(/gemini-cli {3}.*settings\.json +missing — could not run/);
    expect(text).toMatch(/sink {6}rx {15}tier 1 {2}PAUSED HTTP 401/);
    expect(text).toMatch(/sink {6}out {14}tier 0 {2}2 session file\(s\) with undelivered events/);
    expect(text).toMatch(/sink {6}done {13}tier 0 {2}up to date/);
    expect(text).toContain("control:  not paired");
    expect(text).toContain("update:   not automatic: this copy isn't a global npm install");
    expect(text).toContain("hook:     in-process p50 9 ms over 2 runs");
    expect(text).toContain("jobs:     1 waiting");
    const j = JSON.parse((await run("status", "--json")).lines.join("\n"));
    expect(j.harnesses["claude-code"]).toEqual([{ file: "~/.claude/settings.json", state: "current" }]);
    expect(j.harnesses["gemini-cli"][0]).toMatchObject({ state: "missing", note: expect.stringContaining("gemini") });
    expect(j.sinks.map((s: { pending_sessions: number }) => s.pending_sessions)).toEqual([2, 2, 0]);
  });

  it("the JSON: the same facts, and none of the keys", async () => {
    writeConfig({
      sinks: [{ name: "rx", url: "https://rx.invalid", tier: 2, token: "tok_hidden" }],
      harnesses: {},
    } as never);
    const { lines } = await run("status", "--json");
    const j = JSON.parse(lines.join("\n"));
    expect(j).toMatchObject({
      version: VERSION,
      state,
      config,
      harnesses: {},
      sinks: [{ name: "rx", tier: 2, max_tier: null, pii: false, control: false, paused: null, pending_sessions: 0 }],
      timing: null,
      control: null,
      jobs: 0,
    });
    expect(lines.join("\n")).not.toContain("tok_hidden");
  });

  it("with no sinks it says where events stay; a status line even when the outbox is empty", async () => {
    const { text } = await run("status");
    expect(text).toContain("sinks:    none (events stay in the local outbox)");
    expect(text).not.toContain("jobs:");
  });

  it("control health: not running, a receiver without the age field, one polling, one never polled", async () => {
    put(path.join(tmp, "config", "control.json"), {
      name: "box",
      folders: [],
      mode: "safe",
      receivers: [{ url: "https://rx.invalid", machine: "m", token: "t", keys: [] }],
    });
    const down = await run("status");
    expect(down.text).toContain("control:  daemon not running or not responding; polling: no");
    const now = Date.now();
    const close = await daemon({
      status: {
        op: "status",
        status: {
          receivers: [
            { url: "https://a", polling: false, last_poll: now - 3 * 60_000, last_error: "401" },
            { url: "https://b", polling: true, last_poll: now, last_error: null, last_poll_age_ms: 10 },
            { url: "https://c", polling: true, last_poll: null, last_error: null },
          ],
        },
      },
    });
    try {
      const up = await run("status", "--json");
      const control = JSON.parse(up.lines.join("\n")).control;
      expect(control.running).toBe(true);
      expect(control.receivers[0].last_poll_age_ms).toBeGreaterThanOrEqual(3 * 60_000);
      expect(control.receivers[1].last_poll_age_ms).toBe(10);
      expect(control.receivers[2].last_poll_age_ms).toBeNull();
      const text = (await run("status")).text;
      expect(text).toContain(
        "control:  https://a · polling: no · last successful poll: 3 minutes ago · last error: 401",
      );
      expect(text).toContain(
        "control:  https://b · polling: yes · last successful poll: 0 minutes ago · last error: none",
      );
      expect(text).toContain(
        "control:  https://c · polling: yes · last successful poll: never (unknown since start) · last error: none",
      );
    } finally {
      await close();
    }
  });
});

describe.skipIf(process.platform === "win32")("doctor", () => {
  it("a healthy machine: every section, no warnings; the JSON says the same", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    put(path.join(home, ".claude-second", "settings.json"), {});
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    writeConfig({
      sinks: [
        { name: "rx", url: "https://rx.invalid", tier: 2, max_tier: 3, token: "tok_secret" },
        { name: "kc", url: "https://kc.invalid", tier: 1, token_in: "keychain", paused: "HTTP 401" },
        { name: "out", url: "stdout", tier: 0 },
      ],
      harnesses: {},
    } as never);
    vi.mocked(sinkWithSecrets).mockImplementation((s) => ({ ...s, token: "x" }));
    await run("install", "--claude-code", "--backfill", "0");
    put(path.join(state, "timing.jsonl"), '{"ms":4}\n');
    const { text } = await run("doctor");
    expect(text).toContain(`sessionpipe ${VERSION} · node ${process.version} at `);
    expect(text).toContain(`config ${config} · state ${state}`);
    expect(text).toMatch(/claude-code {2}.*settings\.json +current/);
    expect(text).toContain("sink rx               tier 2 (receiver max 3)");
    expect(text).toContain("sink kc               tier 1 PAUSED HTTP 401");
    expect(text).toContain("control:  not paired");
    expect(text).toMatch(/hooks run .*sessionpipe-hook → node /);
    expect(text).toContain("key  sink rx                      a 0600 file\n");
    expect(text).toContain("key  sink kc                      the macOS Keychain\n");
    expect(text).toMatch(/claude .*\.claude +signed in\n/);
    expect(text).toMatch(/claude .*\.claude-second +NOT signed in from here\n/);
    expect(text).toContain("update not automatic");
    expect(text).toContain("hook wall clock (what the harness waits): p50 ");
    expect(text).toContain("ms over 8 spawns");
    expect(text).toContain("hook in-process: p50 4 ms · p95 4 ms over the last 1 runs");
    expect(text).toContain("no warnings");
    expect(text).not.toContain("tok_secret");

    const j = JSON.parse((await run("doctor", "--json")).lines.join("\n"));
    expect(j).toMatchObject({
      version: VERSION,
      sinks: [
        { name: "rx", token: "tok_…" },
        { name: "kc", token: "in keychain" },
        { name: "out", token: null },
      ],
      keys: [
        { what: "sink rx", where: "file", readable: true },
        { what: "sink kc", where: "keychain", readable: true },
      ],
      claude_accounts: [{ signed_in: true }, { signed_in: false }],
      launcher: { node_ok: true, version: VERSION },
      warnings: [],
    });
  });

  it("warns: a stopped daemon, a stalled poll, a failed update, a locked key, a signed-out account, a Linux logout", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    put(path.join(home, ".claude-second", "settings.json"), {});
    put(path.join(home, ".claude-odd", "settings.json"), {});
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    put(path.join(tmp, "config", "control.json"), {
      name: "box",
      folders: [],
      mode: "safe",
      receivers: [
        { url: "https://rx.invalid", machine: "m", token_in: "keychain", keys: [] },
        { url: "https://plain.invalid", machine: "p", token: "t", keys: [] },
      ],
    });
    writeConfig({
      sinks: [{ name: "kc", url: "https://kc.invalid", tier: 1, token_in: "keychain" }],
      harnesses: {},
    } as never);
    vi.mocked(sinkWithSecrets).mockReturnValue(null);
    put(path.join(state, "control", "update.json"), {
      failed: { version: "9.9.9", at: "2026-10-01T00:00:00Z", error: "EACCES" },
    });
    onPlatform("linux");
    vi.mocked(execFileSync).mockReturnValue("Linger=no\n");
    const down = await run("doctor");
    expect(down.text).toContain("! the control daemon is not running or not responding; polling is stopped");
    expect(down.text).toContain(
      "! the control daemon couldn't install sessionpipe 9.9.9: EACCES. It tries again tomorrow",
    );
    expect(down.text).toContain("! sink kc: its key is in the macOS Keychain, which this session can't read");
    expect(down.text).toContain(
      "! control rx.invalid: its key is in the macOS Keychain, which this session can't read",
    );
    expect(down.text).toContain("key  sink kc                      the macOS Keychain (unreadable here)");
    expect(down.text).toContain("key  control plain.invalid        a 0600 file\n");
    expect(down.text).toMatch(/! Claude Code .*\.claude-second isn't signed in from here: `CLAUDE_CONFIG_DIR=/);
    expect(down.text).toMatch(/claude .*\.claude-odd +can't tell/);
    expect(down.text).toContain(
      `! the control daemon stops when you log out: \`loginctl enable-linger ${os.userInfo().username}\``,
    );
    expect(down.text).toMatch(/hooks run .*sessionpipe-hook → node \? \(gone: PATH's node\)/);

    vi.mocked(execFileSync).mockReturnValue("Linger=yes\n");
    const now = Date.now();
    const close = await daemon({
      status: {
        op: "status",
        status: {
          receivers: [
            { url: "https://a", polling: true, last_poll: now - 2 * 60_000, last_error: null },
            { url: "https://b", polling: false, last_poll: null, last_error: null },
            { url: "https://c", polling: true, last_poll: now, last_error: null, last_poll_age_ms: 0 },
          ],
        },
      },
    });
    try {
      const j = JSON.parse((await run("doctor", "--json")).lines.join("\n"));
      expect(j.linger).toBe(true);
      expect(j.warnings).toContain("https://a: the daemon has not polled for 2 minutes: no successful poll response");
      expect(j.warnings).toContain("https://b: the daemon has never polled: polling stopped");
      expect(j.warnings.some((w: string) => w.startsWith("https://c"))).toBe(false);
      expect(j.warnings.some((w: string) => w.includes("stops when you log out"))).toBe(false);
    } finally {
      await close();
    }
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("no loginctl");
    });
    expect(JSON.parse((await run("doctor", "--json")).lines.join("\n")).linger).toBeNull();
  });

  it("warns about hooks a harness won't run, stale or misplaced ones, a slow hook, and a broken launcher", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    put(path.join(home, ".codex", "config.toml"), "");
    writeConfig({ sinks: [], harnesses: { "claude-code": { enabled: true } } } as never);
    vi.spyOn(claudeCode, "installed").mockReturnValue([
      { file: path.join(home, ".claude", "settings.json"), state: "inactive", note: "hooks are off" },
      { file: path.join(home, ".claude-second", "settings.json"), state: "inactive" },
      { file: path.join(home, ".claude", "settings.json"), state: "stale" },
    ]);
    vi.spyOn(codex, "installed").mockReturnValue([
      { file: path.join(home, ".codex", "config.toml"), state: "misplaced" },
    ]);
    let tick = 0n;
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => (tick += 200_000_000n));
    const { text } = await run("doctor");
    expect(text).toContain("! claude-code: hooks are written but the harness will not run them — hooks are off");
    expect(text).toContain("! claude-code: hooks are written but the harness will not run them — \n");
    expect(text).toMatch(/! claude-code: the hook in .*settings\.json points at an old node or script path/);
    expect(text).toMatch(/! codex: the notify line in .*config\.toml sits inside a \[table\]/);
    expect(text).toContain("! the harness waits 200 ms per hook (p50, target < 150)");
    expect(text).toContain("! the hook launcher is missing; run `sessionpipe install` again");
    expect(text).toContain("hooks run ");
    expect(text).toContain("→ node ? (gone: PATH's node)");
  });

  it("a hook that can't be spawned, or fails: no wall clock; the in-process timing survives a bad line", async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "", stderr: "" } as never);
    put(path.join(state, "timing.jsonl"), "garbage\n");
    onPlatform("win32");
    const failed = await run("doctor");
    expect(failed.text).toContain("hook wall clock: could not spawn dist/hook.js");
    expect(failed.text).toContain("hook in-process: no runs yet");
    expect(failed.text).not.toContain("hooks run");
    vi.mocked(spawnSync).mockImplementation(() => {
      throw new Error("EACCES");
    });
    put(path.join(state, "timing.jsonl"), '{"ms":-5}\n');
    const j = JSON.parse((await run("doctor", "--json")).lines.join("\n"));
    expect(j.hook_wall_ms).toBeNull();
    expect(j.timing).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("tail, backfill, forget, replay", () => {
  it("tail follows the outbox from its end, one line per event, filtered to a tier, a harness and a session", async () => {
    const outbox = new Outbox(state);
    const old = { harness: "claude-code", session: "0123456789abcdef" };
    outbox.append(old, [event("session.heartbeat", {})]);
    outbox.append({ harness: "codex", session: "other" }, [event("session.heartbeat", {})]);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const lines: string[] = [];
      void cli.main(["tail", "--tier", "3", "--harness", "claude-code", "--session", "0123"], {
        out: (s = "") => void lines.push(s),
        err: vi.fn(),
        exit: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(600);
      expect(lines).toEqual([`sessionpipe tail · tier 3 · ${state}/outbox (Ctrl-C to stop)`]);
      outbox.append(old, [
        event("session.started", { source: "startup" }, { cwd: "/p", branch: "main" }),
        event("session.started", { source: "resume" }),
        event("turn.started", { prompt_chars: 12 }),
        event("turn.started", { submitted_by: "loop_wakeup", injected: true, prompt_chars: 406 }),
        event("turn.started", {}),
        event("tool.started", { tool: "Bash" }),
        event("tool.started", {}),
        event("tool.ended", { tool: "Bash", ok: true, ms: 5 }),
        event("tool.ended", { tool: "Edit", ok: false }),
        event("attention.needed", { kind: "permission", tool: "Bash", message: "may I?" }),
        event("attention.needed", { kind: "idle" }),
        event("turn.ended", { reason: "done" }),
        event("turn.ended", {}),
        event("session.ended", { reason: "exit" }),
        event("turn.transcript", { turn: 1, user: "hello\n  there", assistant: "hi" }),
        event("turn.progress", { turn: 2, assistant: "so far" }),
        event("turn.progress", { turn: 2 }),
        event("session.backfill", { started_at: "x" }, { title: "T" }),
        event("session.backfill", { started_at: "x" }),
        event("custom.thing", { n: 1 }),
      ]);
      outbox.append({ harness: "codex", session: "other" }, [event("tool.started", { tool: "x" })]);
      outbox.append({ harness: "claude-code", session: "zzzz" }, [event("tool.started", { tool: "x" })]);
      await vi.advanceTimersByTimeAsync(500);
      const detail = lines.slice(1).map((l) =>
        l
          .slice(l.indexOf("…  ") + 3)
          .replace(/\s+/g, " ")
          .trim(),
      );
      expect(detail).toEqual([
        "session.started source=startup /p main",
        "session.started source=resume",
        "turn.started prompt_chars=12",
        "turn.started submitted_by=loop_wakeup injected prompt_chars=406",
        "turn.started",
        "tool.started Bash",
        "tool.started",
        "tool.ended Bash ok 5ms",
        "tool.ended Edit error",
        'attention.needed permission Bash "may I?"',
        "attention.needed idle",
        "turn.ended done",
        "turn.ended",
        "session.ended reason=exit",
        'turn.transcript #1 "hello there"',
        "turn.progress #2 6 chars so far",
        "turn.progress #2 0 chars so far",
        "session.backfill T",
        "session.backfill",
        'custom.thing {"n":1}',
      ]);
      expect(lines[1]).toMatch(/^\d\d:\d\d:\d\d claude-code 0123… {2}session\.started/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tail --all --json replays every file from its start as JSON, at tier 1 by default", async () => {
    const outbox = new Outbox(state);
    outbox.append({ harness: "claude-code", session: "s" }, [
      event("tool.started", { tool: "Bash" }),
      event("turn.transcript", { turn: 1, user: "secret prompt", assistant: "" }),
    ]);
    symlinkSync(path.join(state, "gone.jsonl"), path.join(state, "outbox", "claude-code", "dangling.jsonl"));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const lines: string[] = [];
      void cli.main(["tail", "--all", "--json"], { out: (s = "") => void lines.push(s), err: vi.fn(), exit: vi.fn() });
      await vi.advanceTimersByTimeAsync(10);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]!)).toMatchObject({ type: "tool.started", data: { tool: "Bash" } });
      expect(lines.join("\n")).not.toContain("secret prompt");
      // A session that starts after tail did is read from its first byte.
      outbox.append({ harness: "codex", session: "new" }, [event("tool.started", { tool: "Edit" })]);
      await vi.advanceTimersByTimeAsync(500);
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[2]!)).toMatchObject({ type: "tool.started", data: { tool: "Edit" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("backfill takes --days and the harness flags", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    const spy = vi.spyOn(claudeCode, "backfill").mockReturnValue([]);
    expect((await run("backfill", "--days", "2", "--claude-code")).lines).toEqual([
      "  ✓ Backfill: 0 sessions from the last 2 days queued as session.backfill",
    ]);
    expect(Date.now() - (spy.mock.calls[0]?.[0] as number)).toBeGreaterThanOrEqual(2 * 86_400_000 - 5000);
    expect((await run("backfill")).lines).toEqual([
      "  ✓ Backfill: 0 sessions from the last 30 days queued as session.backfill",
    ]);
  });

  it("forget asks every sink to delete the session and drops its outbox", async () => {
    const ok = await receiver();
    const outbox = new Outbox(state);
    outbox.append({ harness: "claude-code", session: "s1" }, [event("session.heartbeat", {})]);
    writeConfig({
      sinks: [
        { name: "ok", url: ok.url, tier: 1 },
        { name: "gone", url: "http://127.0.0.1:1", tier: 1 },
      ],
      harnesses: {},
    } as never);
    expect((await run("forget")).lines).toEqual(["usage: sessionpipe forget <harness> <session>"]);
    expect((await run("forget", "claude-code")).lines).toEqual(["usage: sessionpipe forget <harness> <session>"]);
    const { lines } = await run("forget", "claude-code", "s1");
    expect(lines).toEqual([
      "  ✓ ok: asked to delete claude-code:s1",
      "  ✗ gone: fetch failed",
      "  local outbox for the session removed",
    ]);
    expect(existsSync(outbox.file({ harness: "claude-code", session: "s1" }))).toBe(false);
    // A sink's refusal without a message: the status is what there is to say.
    vi.spyOn(HttpSink.prototype, "send").mockResolvedValue({
      ok: false,
      acknowledged: 0,
      status: 503,
      action: "retry",
    });
    expect((await run("forget", "claude-code", "s2")).lines[0]).toBe("  ✗ ok: 503");
  });

  it("replay sends what a sink has not taken yet, or everything again from the start", async () => {
    const rx = await receiver({ body: { accepted: 1 } });
    const outbox = new Outbox(state);
    outbox.append({ harness: "claude-code", session: "s1" }, [event("session.heartbeat", {})]);
    outbox.append({ harness: "claude-code", session: "s2" }, [
      event("session.heartbeat", {}),
      event("session.heartbeat", {}),
    ]);
    writeConfig({
      sinks: [
        { name: "rx", url: rx.url, tier: 1 },
        { name: "f", url: `file:${tmp}/sink.jsonl`, tier: 1 },
      ],
      harnesses: {},
    } as never);
    expect((await run("replay", "--sink", "nope")).lines).toEqual(["  no such sink"]);
    expect((await run("replay", "--sink", "f")).lines).toEqual(["  f: 3 events delivered"]);
    expect((await run("replay", "--sink", "f")).lines).toEqual(["  f: 0 events delivered"]);
    const all = await run("replay", "--from-start");
    expect(all.lines.sort()).toEqual(["  f: 3 events delivered", "  rx: 3 events delivered"]);
    outbox.append({ harness: "claude-code", session: "s3" }, [event("session.heartbeat", {})]);
    expect((await run("replay", "--sink", "f")).lines).toEqual(["  f: 1 event delivered"]);
  });
});

describe("titles", () => {
  it("on and off set remote_titles; with no word it says which holds", async () => {
    expect((await run("titles")).lines).toEqual([
      "  Session names come from this machine's files only, and no sign-in token is read. A session the Claude app started has a name there that never reaches this machine; `sessionpipe titles on` asks claude.ai for it.",
    ]);
    expect(cfg().remote_titles).toBeUndefined();
    expect((await run("titles", "on")).text).toContain(
      "✓ Claude Code sessions with a claude.ai link take claude.ai's name, as the Claude app shows it, unless you named them here. To ask, sessionpipe reads Claude Code's sign-in token on this machine and sends it to api.anthropic.com only",
    );
    expect(cfg().remote_titles).toBe(true);
    expect((await run("titles")).text).toMatch(/^ {2}Claude Code sessions with a claude\.ai link/);
    expect((await run("titles", "off")).text).toContain("✓ Session names come from this machine's files only");
    expect(cfg().remote_titles).toBe(false);
  });

  it("on and refresh send again, under claude.ai's name, each session already sent under another", async () => {
    const id = (n: number) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;
    const row = (n: number, transcript = `/t/${n}.jsonl`) => ({
      session: { id: id(n), title: "the first ask", title_source: "first-ask" as const },
      started_at: Date.now() - 1000,
      last_at: Date.now(),
      ...(transcript ? { transcript } : {}),
    });
    // 1 was backfilled and 6 sent live under the first ask; 2 went live under the name claude.ai
    // has; 3 was never sent; claude.ai has no name for 4; 5 has no transcript to ask about.
    vi.spyOn(claudeCode, "backfill").mockImplementation(() => [row(1), row(2), row(3), row(4), row(5, ""), row(6)]);
    vi.spyOn(claudeCode, "detect").mockReturnValue(true);
    const remote = vi
      .spyOn(claudeCode as Required<typeof claudeCode>, "remoteFacts")
      .mockImplementation(async (s) =>
        s.id === id(4) ? {} : { title: `claude.ai ${s.id.slice(-1)}`, title_source: "harness" as const },
      );
    const facts = factsState(state);
    facts.save("claude-code", id(1), { backfilled: true });
    facts.save("claude-code", id(2), { session: { title: "claude.ai 2", title_source: "harness" } });
    facts.save("claude-code", id(6), { session: { title: "the first ask", cwd: "/w" } });
    expect((await run("titles", "on")).lines[1]).toBe(
      "  Asked claude.ai about the last 30 days' sessions: 4 named there, 2 sent again under that name.",
    );
    expect(remote).toHaveBeenCalledTimes(5);
    const sent = (n: number) => new Outbox(state).read({ harness: "claude-code", session: id(n) }, 0).events;
    expect(sent(1)).toMatchObject([
      { type: "session.backfill", session: { title: "claude.ai 1", title_source: "harness" } },
    ]);
    expect(sent(6)).toMatchObject([{ type: "session.backfill", session: { title: "claude.ai 6" } }]);
    for (const n of [2, 3, 4, 5]) expect(sent(n)).toEqual([]);
    expect(facts.get("claude-code", id(6))).toMatchObject({
      backfilled: true,
      sent_title: "claude.ai 6",
      session: { title: "claude.ai 6", title_source: "harness", cwd: "/w" },
    });
    // Again: nothing new to send. Asking which holds asks claude.ai nothing.
    expect((await run("titles", "refresh", "--days", "7")).lines[1]).toBe(
      "  Asked claude.ai about the last 7 days' sessions: 4 named there, 0 sent again under that name.",
    );
    await run("titles");
    expect(remote).toHaveBeenCalledTimes(10);
    // A backfill takes claude.ai's names too; a harness with nothing to ask is left alone.
    vi.mocked(claudeCode.backfill).mockImplementation(() => [row(7)]);
    vi.spyOn(codex, "backfill").mockReturnValue([{ ...row(8), session: { id: "codex-8", title: "local" } }]);
    await run("backfill", "--claude-code", "--codex");
    expect(sent(7)).toMatchObject([{ type: "session.backfill", session: { title: "claude.ai 7" } }]);
    expect(new Outbox(state).read({ harness: "codex", session: "codex-8" }, 0).events).toMatchObject([
      { session: { title: "local" } },
    ]);
    // Off: nothing is asked, refresh or not.
    await run("titles", "off");
    await run("titles", "refresh");
    expect(remote).toHaveBeenCalledTimes(11);
    // On, with nothing it could name.
    vi.mocked(claudeCode.detect).mockReturnValue(false);
    expect((await run("titles", "on")).lines[1]).toMatch(
      /^ {2}None of the last 30 days' sessions has a name on claude\.ai that could be read here/,
    );
  });
});

describe.skipIf(process.platform === "win32")("update", () => {
  it("off and on set the daemon's daily check", async () => {
    expect((await run("update", "off")).text).toContain("✓ The control daemon no longer checks npm");
    expect(cfg().update_check).toBe(false);
    expect((await run("update", "on")).text).toContain("✓ The control daemon checks npm once a day");
    expect(cfg().update_check).toBe(true);
    vi.stubEnv("SESSIONPIPE_NO_UPDATE_CHECK", "1");
    expect((await run("update")).lines).toEqual(["  update check is off (SESSIONPIPE_NO_UPDATE_CHECK)"]);
    expect(latestVersion).not.toHaveBeenCalled();
  });

  it("asks npm: unreachable, current, or newer but not a global install", async () => {
    vi.mocked(latestVersion).mockRejectedValueOnce(new Error("ENOTFOUND"));
    expect((await run("update")).lines).toEqual(["  couldn't check npm: ENOTFOUND"]);
    vi.mocked(latestVersion).mockResolvedValue(VERSION);
    expect((await run("update")).lines).toEqual([`  sessionpipe ${VERSION} is current (npm latest: ${VERSION})`]);
    vi.mocked(latestVersion).mockResolvedValue("99.0.0");
    expect((await run("update")).text).toContain(
      `99.0.0 is available (you run ${VERSION}), but this copy isn't a global npm install (npx, a checkout or a dev build): \`npm install -g sessionpipe@99.0.0\` installs one.`,
    );
  });

  it("installs the release, then has the daemon restart onto it — or says how to, per platform", async () => {
    vi.mocked(latestVersion).mockResolvedValue("99.0.0");
    vi.mocked(globalPrefix).mockReturnValue(path.join(home, ".local"));
    writeConfig({ sinks: [], harnesses: { "claude-code": { enabled: true }, codex: { enabled: false } } } as never);
    vi.mocked(installVersion).mockResolvedValue({ ok: false, ms: 10, stage: "npm", error: "npm install: EACCES" });
    const failed = await run("update");
    expect(failed.text).toContain(`99.0.0 is available (you run ${VERSION}); installing into `);
    expect(failed.lines[1]).toBe("  ✗ npm install: EACCES");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(installVersion).toHaveBeenCalledWith("99.0.0", {
      node: process.execPath,
      distDir: realDist,
      harnesses: ["claude-code"],
    });

    vi.mocked(installVersion).mockResolvedValue({ ok: true, ms: 1234, hooks: "hooks re-armed for claude-code" });
    const noDaemon = await run("update");
    expect(noDaemon.lines[1]).toBe("  ✓ sessionpipe 99.0.0 installed in 1.2 s; hooks re-armed for claude-code");
    expect(noDaemon.lines).toHaveLength(2);

    let close = await daemon({ status: { op: "status", status: { version: "99.0.0" } } });
    expect((await run("update")).lines).toHaveLength(2);
    await close();
    close = await daemon({ status: { op: "status", status: { version: "0.1.0" } }, restart: { op: "ok" } });
    expect((await run("update")).lines[2]).toBe(
      "  The control daemon (0.1.0) restarts onto 99.0.0 as soon as nothing is in hand.",
    );
    await close();

    close = await daemon({ status: { op: "status", status: {} }, restart: { op: "none" } });
    try {
      onPlatform("darwin");
      expect((await run("update")).lines[2]).toBe(
        `  The control daemon still runs ? and can't restart itself: \`launchctl kickstart -k gui/${process.getuid?.()}/org.sessionpipe.control\` moves it (a run in progress stops).`,
      );
      const getuid = Object.getOwnPropertyDescriptor(process, "getuid") as PropertyDescriptor;
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
      try {
        expect((await run("update")).lines[2]).toContain("gui/$(id -u)/org.sessionpipe.control");
      } finally {
        Object.defineProperty(process, "getuid", getuid);
      }
      onPlatform("linux");
      expect((await run("update")).lines[2]).toContain(
        "`systemctl --user restart sessionpipe-control.service` moves it",
      );
      onPlatform("win32");
      expect((await run("update")).lines[2]).toContain("stop `sessionpipe control run` and start it again moves it");
    } finally {
      await close();
    }
  });
});

// A Claude Code session id is a UUID; the adapter drops a payload with any other shape
// and no transcript_path as another harness's (claude-code.ts notClaudeCode).
const JOB_SESSION = "7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
describe.skipIf(process.platform === "win32")("worker", () => {
  it("runs one queued job from its file and removes the file", async () => {
    expect((await run("worker")).lines).toEqual([]);
    const file = path.join(tmp, "jobs", "one.json");
    put(file, {
      harness: "claude-code",
      event: "SessionStart",
      argv: ["claude-code", "SessionStart"],
      stdin: JSON.stringify({ session_id: JOB_SESSION, hook_event_name: "SessionStart", cwd: tmp }),
      cwd: tmp,
      env: {},
      at: Date.now(),
    });
    await run("worker", file);
    expect(existsSync(file)).toBe(false);
    expect(new Outbox(state).sessions()).toEqual([{ harness: "claude-code", session: JOB_SESSION }]);
  });

  it.skipIf(process.getuid?.() === 0)("a job file it can't remove is still run", async () => {
    const dir = path.join(tmp, "ro");
    const file = path.join(dir, "job.json");
    put(file, { harness: "nope", event: "x", argv: [], stdin: "", cwd: tmp, env: {}, at: 0 });
    chmodSync(dir, 0o555);
    try {
      await run("worker", file);
      expect(existsSync(file)).toBe(true);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

// Last: this reloads the module graph, so the mocks and spies above are not its.
describe.skipIf(process.platform === "win32")("a copy under Homebrew's versioned node", () => {
  it("is warned about by doctor, with a hook path it can't resolve", async () => {
    vi.resetModules();
    dist.dir = "/opt/homebrew/Cellar/node/25.1.0/lib/node_modules/sessionpipe/dist";
    try {
      const brewed: Cli = await import("../src/cli.js");
      put(path.join(home, ".claude", "settings.json"), {});
      onPlatform("win32");
      const lines: string[] = [];
      await brewed.main(["doctor", "--json"], { out: (s = "") => void lines.push(s), err: vi.fn(), exit: vi.fn() });
      const j = JSON.parse(lines.join("\n"));
      expect(j.warnings).toContain(
        "sessionpipe is installed inside Homebrew's versioned node folder; `brew upgrade node` will delete it. Install with `npm install -g --prefix ~/.local sessionpipe`.",
      );
      expect(j.harnesses["claude-code"][0].state).toBe("missing");
    } finally {
      dist.dir = realDist;
    }
  });
});
