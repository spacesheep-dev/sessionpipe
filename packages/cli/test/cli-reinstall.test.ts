// SPDX-License-Identifier: Apache-2.0
// `sessionpipe reinstall` as the command wires it: what it reads before it decides, the
// two screens, the one question, each way a run ends (what works in green, then a yellow
// line for each thing left to say, then the one command where there is one), and every
// effect it hands the run
// (run.ts has the run itself, plan.ts the plan, find.ts the look, ours.ts the removal).
// And what `doctor` and `status` say of the same look. The look, the run, the removal,
// npm, the service manager and the question are all stood in for at their module
// boundary: nothing here installs, removes or signals anything real.
//
// The last part runs the whole command on real folders, in this test's own home: there
// the look, the plan, the run and the removal are the real ones (the removal behind a
// tripwire that refuses any path outside the test's folder), and npm, the registry, the
// service manager and "ask this copy for its version" are still stood in for.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { ServiceState } from "@sessionpipe/core/service";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { elsewhere, serviceLook, serviceSeen } from "../src/control/health.js";
import { placeService } from "../src/control/pair.js";
import { bringCurrent, type CurrentDeps } from "../src/current.js";
import { installLauncher, launcherPath, launcherState } from "../src/launcher.js";
import { type Copy, type Home, type Inventory, type Looking, look } from "../src/reinstall/find.js";
import { ASIDE, type Proving, remove, same } from "../src/reinstall/ours.js";
import { type Facts, type Plan, plan } from "../src/reinstall/plan.js";
import { carryOut, type Doing, type Done } from "../src/reinstall/run.js";
import { VERSION } from "../src/run.js";
import { execCapture, installInto, latestVersion, npmArgv, npmDo } from "../src/update.js";

type Cli = typeof import("../src/cli.js");

const dist = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:url", async (original) => {
  const real = await original<typeof import("node:url")>();
  return {
    ...real,
    fileURLToPath: (u: string | URL, o?: { windows?: boolean }) =>
      dist.dir && String(u).endsWith("/src/cli.ts") ? `${dist.dir}/cli.ts` : real.fileURLToPath(u, o),
  };
});
// A copy asked for its version, and doctor's hook timed: both answered here.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));
// The one question: answered by the test.
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));
vi.mock("../src/reinstall/find.js", async (original) => ({
  ...(await original<typeof import("../src/reinstall/find.js")>()),
  look: vi.fn(),
}));
// The plan is the real one, watched: what it was handed is what the command read.
vi.mock("../src/reinstall/plan.js", async (original) => {
  const real = await original<typeof import("../src/reinstall/plan.js")>();
  return { ...real, plan: vi.fn(real.plan) };
});
vi.mock("../src/reinstall/run.js", async (original) => ({
  ...(await original<typeof import("../src/reinstall/run.js")>()),
  carryOut: vi.fn(),
}));
// The one function that deletes is never the real one here.
vi.mock("../src/reinstall/ours.js", async (original) => ({
  ...(await original<typeof import("../src/reinstall/ours.js")>()),
  remove: vi.fn(),
}));
vi.mock("../src/current.js", async (original) => ({
  ...(await original<typeof import("../src/current.js")>()),
  bringCurrent: vi.fn(),
}));
vi.mock("../src/update.js", async (original) => {
  const real = await original<typeof import("../src/update.js")>();
  return {
    ...real,
    execCapture: vi.fn(),
    npmDo: vi.fn(),
    installInto: vi.fn(),
    latestVersion: vi.fn(),
    installEverywhere: vi.fn(),
    rearmHooks: vi.fn(),
  };
});
vi.mock("../src/control/pair.js", async (original) => ({
  ...(await original<typeof import("../src/control/pair.js")>()),
  placeService: vi.fn(),
}));
// The service manager is never asked: `reinstall` reads the service through `serviceSeen`
// (its file, whether or not a manager answers), `doctor` through `serviceLook`.
vi.mock("../src/control/health.js", async (original) => {
  const real = await original<typeof import("../src/control/health.js")>();
  return {
    ...real,
    serviceSeen: vi.fn(() => null),
    serviceLook: vi.fn(() => null),
    elsewhere: vi.fn(real.elsewhere),
  };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const realDist = path.resolve(here, "../dist");
const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
/** The file this process was started as (vitest's own): put back after each test. */
const argv0 = [...process.argv];
/** The file a test's command was started as, unless the test says another: no link of
 *  npm's to anything (it isn't there), as a cli.js run by its path is none. */
const STARTED = () => path.join(tmp, "started", "cli.js");
const onPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p, configurable: true });
/** Someone is at the keyboard, or nobody is. */
const keyboard = (there: boolean) =>
  Object.defineProperty(process.stdin, "isTTY", { value: there, configurable: true, writable: true });
const ESC = String.fromCharCode(27);
const NEWEST = "9.9.9";

let cli: Cli;
let tmp: string;
let home: string;
let stops: (() => Promise<void>)[];

beforeAll(async () => {
  dist.dir = realDist;
  cli = await import("../src/cli.js");
});
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-rei-")));
  home = path.join(tmp, "home");
  mkdirSync(home);
  stops = [];
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
    GROK_HOME: path.join(home, ".grok"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_DATA: path.join(tmp, "data"),
    SESSIONPIPE_SOCKET: path.join(tmp, "ctl.sock"),
    SESSIONPIPE_SECRETS: "file",
    SESSIONPIPE_CLAUDE: path.join(tmp, "no-claude"),
    SESSIONPIPE_NO_UPDATE_CHECK: undefined,
    SESSIONPIPE_SERVICE_LABEL: undefined,
    SSH_CONNECTION: undefined,
    FORCE_COLOR: undefined,
    NO_COLOR: undefined,
    TERM: "xterm-256color",
    npm_config_registry: undefined,
    NPM_CONFIG_REGISTRY: undefined,
    // Whether npm or npx started the command is a test's to say: these tests are started
    // by npm themselves (`npm test`, `npx vitest`), which sets it for all it starts.
    npm_command: undefined,
  }))
    vi.stubEnv(k, v as string);
  vi.resetAllMocks();
  // This computer's name heads doctor's first column: a CI runner's is sixty characters.
  vi.spyOn(os, "hostname").mockReturnValue("test-box.local");
  // npm is there and says where it installs; its newest release is NEWEST; no copy runs
  // unless a test says so; the hook doctor times answers at once.
  vi.mocked(execCapture).mockResolvedValue({ code: 0, stdout: `${path.join(home, ".npm-global")}\n`, stderr: "" });
  vi.mocked(latestVersion).mockResolvedValue(NEWEST);
  vi.mocked(spawnSync).mockImplementation(((_cmd: string, argv: string[]) => ({
    status: argv.some((a) => a.endsWith("hook.js")) ? 0 : 1,
    stdout: "",
    stderr: "",
  })) as never);
  vi.mocked(look).mockReturnValue(inventory());
  process.argv[1] = STARTED();
});
afterEach(async () => {
  process.argv.splice(0, process.argv.length, ...argv0);
  Object.defineProperty(process, "platform", platform);
  if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  process.exitCode = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const stop of stops) await stop();
  rmSync(tmp, { recursive: true, force: true });
});

function put(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}
async function run(where: { tty?: boolean; columns?: number; errTty?: boolean }, ...argv: string[]) {
  const lines: string[] = [];
  const io = { out: (s = "") => void lines.push(s), err: vi.fn(), exit: vi.fn(), ...where };
  await cli.main(argv, io);
  return { lines, text: lines.join("\n"), err: io.err, exit: io.exit };
}
/** A daemon on the socket that answers each request by its op. */
function daemon(replies: Record<string, unknown>): Promise<void> {
  const server = net.createServer((socket) => {
    socket.once("data", (d) => {
      const r = replies[(JSON.parse(d.toString()) as { op: string }).op];
      if (r === undefined) socket.end();
      else socket.end(`${JSON.stringify(r)}\n`);
    });
  });
  stops.push(() => new Promise<void>((r) => server.close(() => r())));
  return new Promise((resolve) => server.listen(process.env.SESSIONPIPE_SOCKET, () => resolve()));
}
const status = (version: string, more: Record<string, unknown> = {}) => ({
  op: "status",
  status: { version, pid: 4242, name: "lab", receivers: [], busy: null, ...more },
});
/** This computer paired with one receiver: something here needs the background service. */
const paired = () =>
  put(path.join(tmp, "config", "control.json"), {
    name: "lab",
    folders: [],
    mode: "safe",
    receivers: [{ url: "https://r.example", machine: "m_1", token: "t", keys: [] }],
  });
const service = (o: Partial<ServiceState> = {}): ServiceState => ({
  manager: "launchd",
  file: path.join(home, "Library", "LaunchAgents", "org.sessionpipe.control.plist"),
  installed: true,
  loaded: true,
  argv: [process.execPath, path.join(slotOf(LOCAL()), "dist", "cli.js"), "control", "run"],
  pid: 4242,
  ...o,
});

// --- a computer, as the look would describe it ---------------------------------------------
/** Prefixes under the test's home: the one a person owns, and one of nvm's. */
const LOCAL = () => path.join(home, ".local");
const NVM = () => path.join(home, ".nvm", "versions", "node", "v22.1.0");
const slotOf = (prefix: string) => path.join(prefix, "lib", "node_modules", "sessionpipe");
const binOf = (prefix: string) => path.join(prefix, "bin", "sessionpipe");
const shown = (p: string) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
const copy = (prefix: string, o: Partial<Copy> = {}): Copy => ({
  dir: slotOf(prefix),
  where: shown(prefix),
  prefix,
  slot: "global",
  not: null,
  aside: false,
  version: NEWEST,
  wrong: null,
  bins: [binOf(prefix)],
  uses: [],
  // A shell looks in its command folder.
  onPath: true,
  writable: true,
  keeper: null,
  ...o,
});
/** The home the one copy lives in: `~/.local`, its bin folder on PATH, and this user's to write. */
const home0 = (o: Partial<Home> = {}): Home => ({
  prefix: LOCAL(),
  shown: "~/.local",
  why: "where the one you type is",
  bin: path.join(LOCAL(), "bin"),
  onPath: true,
  blocked: null,
  writable: true,
  ...o,
});
const NPX = () => path.join(home, ".npm", "_npx");
function inventory(o: Partial<Inventory> = {}): Inventory {
  return {
    reach: home,
    copies: [],
    dangling: [],
    strangers: [],
    onPath: [],
    typed: null,
    unsure: null,
    home: home0(),
    taken: null,
    prefixes: [LOCAL(), NVM()],
    npx: NPX(),
    ...o,
  };
}
/** An entry of npx's cache: what `npx sessionpipe …` fetched to run. */
const npxEntry = (id: string, o: Partial<Copy> = {}): Copy => {
  const entry = path.join(home, ".npm", "_npx", id);
  return copy(entry, {
    dir: path.join(entry, "node_modules", "sessionpipe"),
    where: `~/.npm/_npx/${id}`,
    prefix: null,
    slot: "npx",
    bins: [path.join(entry, "node_modules", ".bin", "sessionpipe")],
    onPath: false,
    ...o,
  });
};
/** A checkout someone builds and runs: no install of it, and never removed. */
const checkout = (o: Partial<Copy> = {}): Copy =>
  copy(path.join(home, "src", "sessionpipe"), {
    dir: path.join(home, "src", "sessionpipe", "packages", "cli"),
    where: "~/src/sessionpipe/packages/cli",
    prefix: null,
    slot: null,
    not: "it is not a folder named node_modules/sessionpipe",
    bins: [],
    onPath: false,
    ...o,
  });
/** One clean copy of the newest release, typed and run from: nothing to repair. */
const one = (o: Partial<Inventory> = {}): Inventory =>
  inventory({
    copies: [copy(LOCAL(), { uses: ["typed", "this"] })],
    onPath: [{ file: binOf(LOCAL()), dir: slotOf(LOCAL()) }],
    typed: slotOf(LOCAL()),
    ...o,
  });
/** The one you type is an old release, and nvm's Node has another: something to repair. */
const two = (o: Partial<Inventory> = {}): Inventory =>
  inventory({
    copies: [copy(LOCAL(), { version: "1.0.0", uses: ["typed", "this"] }), copy(NVM(), { version: "0.9.0" })],
    onPath: [{ file: binOf(LOCAL()), dir: slotOf(LOCAL()) }],
    typed: slotOf(LOCAL()),
    ...o,
  });
const ONE: Done = {
  state: "one",
  said: `This computer has one sessionpipe: ${NEWEST}, in ~/.local. Pairings and settings are as they were.`,
  warn: [],
};
/** The fresh copy is in use, and a copy that should have gone is still there: the line that
 *  removes it is the folder and its own link, and no word of npm's. */
const SUDO = "sudo rm -r /usr/local/lib/node_modules/sessionpipe /usr/local/bin/sessionpipe";
const LEFT: Extract<Done, { state: "left" }> = {
  state: "left",
  said: `sessionpipe ${NEWEST} is installed in ~/.local and in use. Pairings and settings are as they were.`,
  warn: [],
  still: "One other copy is still there: 1.0.0 in /usr/local (needs sudo).",
  next: SUDO,
};
/** The sentences the plan and the run write, as these tests meet them. */
const NOTHING = `Nothing to repair: one sessionpipe, ${NEWEST}, the newest release.`;
const ONE_COPY = `One sessionpipe on this computer: ${NEWEST}, the newest release.`;
const NOT_ON_PATH = "~/.local/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.";
const NOTHING_STARTS_IT =
  "The background service isn't running, and nothing here starts it by itself: `sessionpipe control run` does.";
const TYPED = "Typing `sessionpipe` starts ~/src/sessionpipe/packages/cli, which is no installed copy of it.";
const SAFE = `Nothing is touched until ${NEWEST} has been downloaded and seen to run.`;
const KEEP = "  = keep     pairings, settings, keys, messages waiting to be sent";
const DRY_RUN = "Dry run: nothing was changed. `sessionpipe reinstall` does it.";
/** A line that says how a command ended, as a terminal shows it: bold, in its colour. */
const green = (s: string) => `${ESC}[32m${ESC}[1m${s}${ESC}[22m${ESC}[39m`;
const yellow = (s: string) => `${ESC}[33m${ESC}[1m${s}${ESC}[22m${ESC}[39m`;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the colours this page writes
const bare = (lines: string[]): string[] => lines.map((l) => l.replace(/\u001b\[\d+m/g, ""));
/** What the command read, as it handed it to the plan; and the plan it got. */
const facts = (): Facts => vi.mocked(plan).mock.calls.at(-1)?.[1] as Facts;
const planned = (): Plan => vi.mocked(plan).mock.results.at(-1)?.value as Plan;
const looked = (): Looking => vi.mocked(look).mock.calls.at(-1)?.[0] as Looking;
/** What `update`'s own steps were last handed. */
const handed = (): CurrentDeps => vi.mocked(bringCurrent).mock.calls.at(-1)?.[0] as CurrentDeps;
/** A run that goes all the way: the effects it handed `carryOut`, and what it printed
 *  (which they add to, when called afterwards). */
async function went(inv: Inventory = two()): Promise<{ d: Doing; lines: string[] }> {
  vi.mocked(look).mockReturnValue(inv);
  vi.mocked(carryOut).mockResolvedValue(ONE);
  const r = await run({}, "reinstall", "--yes");
  return { d: vi.mocked(carryOut).mock.calls.at(-1)?.[1] as Doing, lines: r.lines };
}
/** How a run ends, given what carrying the plan out came to. */
async function ends(done: Done, where: Parameters<typeof run>[0] = {}, inv: Inventory = two()) {
  vi.mocked(look).mockReturnValue(inv);
  vi.mocked(carryOut).mockResolvedValue(done);
  return run(where, "reinstall", "--yes");
}
/** npm's own link for the copy in a prefix, as npm writes it. */
function link(prefix: string): string {
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  symlinkSync(path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"), binOf(prefix));
  return binOf(prefix);
}
/** Every file, folder and link under a folder, with what each holds: two of these that are
 *  equal say nothing was written, moved or removed in between. */
function tree(root: string): Record<string, string> {
  const all: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) all[p] = `-> ${readlinkSync(p)}`;
      else if (e.isDirectory()) {
        all[p] = "/";
        walk(p);
      } else all[p] = e.isFile() ? readFileSync(p, "utf8") : "?";
    }
  };
  walk(root);
  return all;
}
/** The question, answered. */
function answer(text: string) {
  const rl = { question: vi.fn(async () => text), close: vi.fn() };
  vi.mocked(createInterface).mockReturnValue(rl as never);
  return rl;
}

describe("sessionpipe reinstall on Windows", () => {
  it("Windows: it refuses before it looks at anything: exit 1 with `sessionpipe update` as the next command, nothing asked, nothing written", async () => {
    onPlatform("win32");
    // Not even what would stop it anywhere else is read: a control.json that is no JSON.
    put(path.join(tmp, "config", "control.json"), "{ not json");
    const before = tree(tmp);
    const said =
      "`sessionpipe reinstall` does not run on Windows yet: it removes folders, and that is not proven there. Nothing was changed. This brings this computer up to date";
    for (const flags of [[], ["--dry-run"], ["--yes"], ["-y"], ["--dry-run", "--yes"]]) {
      const r = await run({}, "reinstall", ...flags);
      // Into a pipe: the one line, and the command to run next ends it.
      expect(r.err).toHaveBeenCalledTimes(1);
      expect(r.err).toHaveBeenCalledWith(`sessionpipe: ${said}. Next: sessionpipe update\n`);
      expect(r.exit).toHaveBeenCalledWith(1);
      expect(r.lines).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    }
    // At a terminal: an error, and the command on a line of its own.
    const term = await run({ tty: true, errTty: true, columns: 200 }, "reinstall", "--yes");
    const shownErr = (bare([String(term.err.mock.calls[0]?.[0])])[0] as string).split("\n");
    expect(shownErr.slice(-2)).toEqual(["try    sessionpipe update", ""]);
    // (Folded under its own words where the terminal is narrower than the sentence.)
    expect(shownErr.slice(0, -2).join(" ").replace(/\s+/g, " ")).toBe(`error ${said}`);
    expect(term.exit).toHaveBeenCalledWith(1);
    expect(term.lines).toEqual([]);
    // Nothing was looked at, asked or started: no folder, no npm, no service manager, no copy.
    for (const asked of [
      look,
      plan,
      carryOut,
      remove,
      execCapture,
      npmDo,
      installInto,
      latestVersion,
      serviceSeen,
      serviceLook,
      bringCurrent,
      createInterface,
      spawnSync,
    ])
      expect(asked).not.toHaveBeenCalled();
    expect(tree(tmp)).toEqual(before);
    // A wrong word is a wrong word there too: exit 2, and the usage line.
    const usage = await run({}, "reinstall", "--nope");
    expect(usage.lines).toEqual(["usage: sessionpipe reinstall [--dry-run] [--yes]"]);
    expect(process.exitCode).toBe(2);
    expect(usage.exit).not.toHaveBeenCalled();
    expect(usage.err).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === "win32")("sessionpipe reinstall: before it does anything", () => {
  it("anything but its two options is a usage error: exit 2, and nothing is looked at", async () => {
    for (const word of ["--force", "now", "--dry"]) {
      const r = await run({}, "reinstall", word);
      expect(r.lines).toEqual(["usage: sessionpipe reinstall [--dry-run] [--yes]"]);
      expect(process.exitCode).toBe(2);
      process.exitCode = undefined;
    }
    // One wrong word beside a right one is still wrong.
    expect((await run({}, "reinstall", "--yes", "--all")).lines).toEqual([
      "usage: sessionpipe reinstall [--dry-run] [--yes]",
    ]);
    expect(look).not.toHaveBeenCalled();
    expect(execCapture).not.toHaveBeenCalled();
    expect(carryOut).not.toHaveBeenCalled();
  });

  it("a control.json that can't be read stops it: that file says whether this computer needs the service", async () => {
    const file = path.join(tmp, "config", "control.json");
    put(file, "{ not json");
    const r = await run({}, "reinstall", "--yes");
    expect(r.err).toHaveBeenCalledWith(
      `sessionpipe: ${file} can't be read, and it says whether this computer needs the background service. Nothing was changed. Next: sessionpipe doctor\n`,
    );
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.lines).toEqual([]);
    expect(look).not.toHaveBeenCalled();
    expect(carryOut).not.toHaveBeenCalled();
    // One that reads is no obstacle, and neither is none at all.
    paired();
    vi.mocked(look).mockReturnValue(one());
    expect((await run({}, "reinstall")).err).not.toHaveBeenCalled();
  });

  it("Linux: a service file whose manager can't be asked: nothing is done, and the one line says where to run it from (launchd and systemd by name)", async () => {
    // A `su -` or `sudo -u` shell: the file is on disk and names a copy, and no user
    // manager answers. What the plan would be is never found out: two copies to clear up.
    paired();
    vi.mocked(look).mockReturnValue(two());
    const cli = path.join(slotOf(NVM()), "dist", "cli.js");
    const files = {
      linux: path.join(home, ".config", "systemd", "user", "sessionpipe-control.service"),
      darwin: path.join(home, "Library", "LaunchAgents", "org.sessionpipe.control.plist"),
    };
    for (const f of Object.values(files)) put(f, `names ${cli}`);
    const before = tree(tmp);
    // The word is the platform's, set here: both are said on any computer these tests run on.
    for (const [os, manager, where] of [
      ["linux", "systemd", "~/.config/systemd/user/sessionpipe-control.service"],
      ["darwin", "launchd", "~/Library/LaunchAgents/org.sessionpipe.control.plist"],
    ] as const) {
      onPlatform(os);
      vi.mocked(serviceSeen).mockReturnValue(
        service({
          manager: null,
          file: files[os],
          loaded: false,
          pid: null,
          argv: [process.execPath, cli, "control", "run"],
        }),
      );
      for (const flags of [[], ["--yes"], ["--dry-run"]]) {
        const r = await run({}, "reinstall", ...flags);
        expect(r.err).toHaveBeenCalledTimes(1);
        expect(r.err).toHaveBeenCalledWith(
          `sessionpipe: the background service's file is there (${where}), and ${manager} can't be asked from this shell, so the service could not be moved. Nothing was changed. Run this from a terminal you opened on this computer yourself. Next: sessionpipe reinstall\n`,
        );
        expect(r.exit).toHaveBeenCalledWith(1);
        expect(r.lines).toEqual([]);
      }
      // At a terminal it is an error with the command under it.
      const term = await run({ errTty: true, columns: 200 }, "reinstall", "--yes");
      expect(bare([String(term.err.mock.calls[0]?.[0])])[0]).toMatch(
        new RegExp(
          `^error {2}the background service's file is there[\\s\\S]* ${manager} can't be asked[\\s\\S]*\\ntry {4}sessionpipe reinstall\\n$`,
        ),
      );
    }
    // It stopped before the look: no copy was found, counted or asked, npm was not run.
    for (const asked of [look, plan, carryOut, remove, execCapture, npmDo, installInto, latestVersion, bringCurrent])
      expect(asked).not.toHaveBeenCalled();
    expect(tree(tmp)).toEqual(before);
    Object.defineProperty(process, "platform", platform);
    // No file, and a manager that can't be asked: there is no service to leave on a copy
    // that goes. It goes on, with no service among what it read.
    vi.mocked(serviceSeen).mockReturnValue(
      service({ manager: null, installed: false, loaded: false, pid: null, argv: null }),
    );
    const none = await run({}, "reinstall", "--dry-run");
    expect(none.err).not.toHaveBeenCalled();
    expect(facts().service).toBeNull();
    expect(looked().serviceCli).toBeNull();
    expect(none.lines).toContain("This will");
    // The file, and a manager that answers: the service is among what it read, and the
    // copy its file names is handed to the look.
    vi.mocked(serviceSeen).mockReturnValue(service({ argv: [process.execPath, cli, "control", "run"] }));
    const asked = await run({}, "reinstall", "--dry-run");
    expect(asked.err).not.toHaveBeenCalled();
    expect(facts().service).toMatchObject({ file: service().file, loaded: true, pid: 4242 });
    expect(looked().serviceCli).toBe(cli);
  });
});

describe.skipIf(process.platform === "win32")("sessionpipe reinstall: what it reads", () => {
  it("asks npm where it installs, and takes the look with that, this copy and this home", async () => {
    vi.mocked(look).mockReturnValue(one());
    await run({}, "reinstall");
    expect(execCapture).toHaveBeenCalledWith([...npmArgv(process.execPath), "prefix", "-g"], {
      env: process.env,
      timeoutMs: 20_000,
    });
    expect(look).toHaveBeenCalledTimes(1);
    expect(looked()).toEqual({
      env: process.env,
      home,
      // This test's world keeps its files in a temp folder: its own home is all it may call its own.
      reach: home,
      execPath: process.execPath,
      distDir: realDist,
      // The file this command was started as: the look tells npm's link from a cli.js by its path.
      started: STARTED(),
      npmPrefix: path.join(home, ".npm-global"),
      serviceCli: null,
      hooksVersion: null,
      // How the one copy that typing starts may be asked for its version: `reinstall` hands it in.
      runs: expect.any(Function),
      tilde: expect.any(Function),
    });
    // No platform is handed over: this look is for POSIX only.
    expect("platform" in looked()).toBe(false);
    // Started as npm's link, it is that link the look is told: by its path as it was run.
    process.argv[1] = binOf(LOCAL());
    await run({}, "reinstall", "--dry-run");
    expect(looked().started).toBe(binOf(LOCAL()));
    // Started as no file at all (`node -e`, a REPL): no name, and nothing a link could be.
    process.argv.length = 1;
    await run({}, "reinstall", "--dry-run");
    expect(looked().started).toBe("");
    process.argv[1] = STARTED();
    expect(looked().tilde(path.join(home, "x"))).toBe("~/x");
    expect(facts().npm).toBe(true);
    // npm answering with nothing names no prefix; npm that can't be run names none either,
    // and is said not to be there.
    vi.mocked(execCapture).mockResolvedValue({ code: 0, stdout: "  \n", stderr: "" });
    await run({}, "reinstall");
    expect(looked().npmPrefix).toBeNull();
    expect(facts().npm).toBe(true);
    vi.mocked(execCapture).mockResolvedValue({ code: 127, stdout: "/not/asked\n", stderr: "npm: not found" });
    await run({}, "reinstall");
    expect(looked().npmPrefix).toBeNull();
    expect(facts().npm).toBe(false);
  });

  it("the one copy the look may ask is asked for its version by running it: what it prints is its version, or it doesn't run", async () => {
    vi.mocked(look).mockReturnValue(one());
    await run({}, "reinstall");
    // Handing the look the way to ask starts nothing by itself.
    expect(spawnSync).not.toHaveBeenCalled();
    const cli = path.join(slotOf(LOCAL()), "dist", "cli.js");
    const version = (file: string) => (looked().runs as NonNullable<Looking["runs"]>)(file);
    const says = (r: { status: number | null; stdout?: string }) =>
      vi.mocked(spawnSync).mockReturnValueOnce({ stderr: "", ...r } as never);
    says({ status: 0, stdout: "1.2.3\n" });
    expect(version(cli)).toBe("1.2.3");
    expect(spawnSync).toHaveBeenLastCalledWith(process.execPath, [cli, "--version"], {
      encoding: "utf8",
      timeout: 20_000,
    });
    says({ status: 0, stdout: "0.16.0-rc.1+build.5\n" });
    expect(version(cli)).toBe("0.16.0-rc.1+build.5");
    // It failed, printed something that is no version, or could not be started at all.
    says({ status: 1, stdout: "1.2.3\n" });
    expect(version(cli)).toBeNull();
    says({ status: 0, stdout: "SyntaxError: Unexpected token\n" });
    expect(version(cli)).toBeNull();
    says({ status: 0, stdout: "" });
    expect(version(cli)).toBeNull();
    says({ status: null });
    expect(version(cli)).toBeNull();
  });

  it("npm's newest release, or why it couldn't be asked", async () => {
    vi.mocked(look).mockReturnValue(one());
    await run({}, "reinstall");
    expect(facts().latest).toEqual({ version: NEWEST });
    vi.mocked(latestVersion).mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
    );
    await run({}, "reinstall");
    expect(facts().latest).toEqual({ error: "registry.npmjs.org can't be reached (ENOTFOUND)" });
  });

  it("the agents hooked here, the release that wrote the hooks, and what is wrong with them", async () => {
    vi.mocked(look).mockReturnValue(one());
    // Nobody hooked: no hooks to be wrong, whatever the launcher's own files say.
    installLauncher({ distDir: realDist, node: path.join(tmp, "gone", "node"), version: "0.8.0" });
    await run({}, "reinstall");
    expect(facts()).toMatchObject({ harnesses: [], hooks: { version: "0.8.0", wrong: [] } });
    expect(facts().hookFiles).toEqual([launcherPath()]);
    expect(looked().hooksVersion).toBe("0.8.0");
    // Claude Code is set up here and its settings call nothing: said, with the launcher's
    // node that is gone. That another release wrote them is the table's to say, not a fault.
    put(process.env.SESSIONPIPE_CONFIG as string, {
      harnesses: { "claude-code": { enabled: true }, codex: { enabled: false } },
    });
    await run({}, "reinstall");
    const f = facts();
    expect(f.harnesses).toEqual(["claude-code"]);
    expect(f.hooks.version).toBe("0.8.0");
    expect(f.hooks.wrong).toEqual([
      `the node the hook launcher names (${path.join(tmp, "gone", "node")}) is gone; it falls back to the node on PATH`,
      "claude-code: not hooked (~/.claude/settings.json)",
    ]);
    expect(f.hookFiles).toEqual([launcherPath(), path.join(home, ".claude", "settings.json")]);
    // Hooks that are as they should be are not among what is wrong.
    rmSync(launcherPath());
    await run({}, "install", "--claude-code", "--backfill", "0");
    await run({}, "reinstall");
    expect(facts().hooks).toEqual({ version: VERSION, wrong: [] });
    expect(looked().hooksVersion).toBe(VERSION);
  });

  it("what is wrong with the hooks' own files is said without the advice to run another command: this one does it", async () => {
    vi.mocked(look).mockReturnValue(one());
    put(process.env.SESSIONPIPE_CONFIG as string, { harnesses: { "claude-code": { enabled: true } } });
    /** What the launcher's own look says now, and what of it reached the plan. */
    const findings = async () => {
      const r = await run({}, "reinstall");
      const own = facts().hooks.wrong.filter((w) => !w.startsWith("claude-code: "));
      // On the screen each is one line under "Also found", with no command in it.
      for (const w of own) expect(r.lines).toContain(`  ! the hooks: ${w}`);
      for (const w of own) expect(w).not.toMatch(/`|sessionpipe install|; run /);
      return { said: launcherState(VERSION).problems, own };
    };
    const seen = new Set<string>();
    const kind = (problem: string) => problem.replace(/\(.*?\)/, "()").replace(/^\S+\.js /, "<file> ");
    // No launcher at all.
    const none = await findings();
    expect(none.said).toEqual(["the hook launcher is missing; run `sessionpipe install` again"]);
    expect(none.own).toEqual(["the hook launcher is missing"]);
    // Its node is gone, and so is each file it runs; another release wrote it.
    const node = path.join(tmp, "gone", "node");
    installLauncher({ distDir: realDist, node, version: "0.8.0" });
    for (const f of ["hook.js", "worker.js"]) rmSync(path.join(path.dirname(launcherPath()), f));
    const all = await findings();
    expect(all.said).toHaveLength(4);
    expect(all.own).toEqual([
      `the node the hook launcher names (${node}) is gone; it falls back to the node on PATH`,
      "worker.js is missing beside the hook launcher",
      "hook.js is missing beside the hook launcher",
    ]);
    // A launcher that names no node at all.
    writeFileSync(launcherPath(), "#!/bin/sh\n");
    const bare = await findings();
    expect(bare.own[0]).toBe("the node the hook launcher names (?) is gone; it falls back to the node on PATH");
    // A node under the home folder is said as a person reads it.
    installLauncher({ distDir: realDist, node: path.join(home, ".nvm", "gone", "bin", "node"), version: VERSION });
    const under = await findings();
    expect(under.own).toEqual([
      "the node the hook launcher names (~/.nvm/gone/bin/node) is gone; it falls back to the node on PATH",
    ]);
    for (const p of [...none.said, ...all.said, ...bare.said, ...under.said]) seen.add(kind(p));
    // Every sentence launcher.ts can say was tried above: a new one there is to be added
    // here, and looked at for advice the cut doesn't know.
    const source = readFileSync(path.join(here, "..", "src", "launcher.ts"), "utf8");
    expect(source.match(/problems\.push\(|problems: \[/g)).toHaveLength(seen.size);
    expect(seen.size).toBe(4);
  });

  it("whether anything here needs the service, its file as the manager has it, and who answers on the socket", async () => {
    vi.mocked(look).mockReturnValue(one());
    await run({}, "reinstall");
    expect(facts()).toMatchObject({ wanted: false, service: null, daemon: null, staleSocket: false });
    paired();
    // A manager that has no file for it is no service file.
    vi.mocked(serviceSeen).mockReturnValue(service({ installed: false, loaded: false, argv: null, pid: null }));
    await run({}, "reinstall");
    expect(facts()).toMatchObject({ wanted: true, service: null });
    expect(looked().serviceCli).toBeNull();
    // A file that names a node and a copy that are there.
    const cli = path.join(slotOf(LOCAL()), "dist", "cli.js");
    put(cli, "");
    const s = service();
    vi.mocked(serviceSeen).mockReturnValue(s);
    await run({}, "reinstall");
    expect(facts().service).toEqual({
      file: s.file,
      loaded: true,
      pid: 4242,
      node: process.execPath,
      nodeOk: true,
      cliOk: true,
    });
    expect(looked().serviceCli).toBe(cli);
    // One that names what is gone, and one that names nothing.
    vi.mocked(serviceSeen).mockReturnValue(
      service({ loaded: false, pid: null, argv: [path.join(tmp, "gone", "node"), path.join(tmp, "gone", "cli.js")] }),
    );
    await run({}, "reinstall");
    expect(facts().service).toMatchObject({
      loaded: false,
      pid: null,
      node: path.join(tmp, "gone", "node"),
      nodeOk: false,
      cliOk: false,
    });
    vi.mocked(serviceSeen).mockReturnValue(service({ argv: null }));
    await run({}, "reinstall");
    expect(facts().service).toMatchObject({ node: null, nodeOk: false, cliOk: false });
    expect(looked().serviceCli).toBeNull();
    vi.mocked(serviceSeen).mockReturnValue(service({ argv: [process.execPath] }));
    await run({}, "reinstall");
    expect(facts().service).toMatchObject({ node: process.execPath, nodeOk: true, cliOk: false });
    // The daemon that answers, by its own account: its process, its release, and who
    // started it. One that doesn't answer that question (from before 0.15) doesn't say.
    const replies: Record<string, unknown> = { status: status("1.0.0") };
    await daemon(replies);
    await run({}, "reinstall");
    expect(facts()).toMatchObject({ daemon: { pid: 4242, version: "1.0.0", byHand: null }, staleSocket: false });
    // One that answers and names no copy doesn't say either.
    replies.health = { op: "health", health: { accounts: [] } };
    await run({}, "reinstall");
    expect(facts().daemon).toEqual({ pid: 4242, version: "1.0.0", byHand: null });
    // Started by someone (no manager, no supervisor): by hand. By any of those: not.
    replies.health = { op: "health", health: { accounts: [], copy: { cli: "/x/cli.js", via: null } } };
    await run({}, "reinstall");
    expect(facts().daemon).toEqual({ pid: 4242, version: "1.0.0", byHand: true });
    for (const via of ["launchd", "systemd", "supervisor"]) {
      replies.health = { op: "health", health: { accounts: [], copy: { cli: "/x/cli.js", via } } };
      await run({}, "reinstall");
      expect(facts().daemon).toEqual({ pid: 4242, version: "1.0.0", byHand: false });
    }
  });

  it("with no daemon answering, none is asked who started it", async () => {
    vi.mocked(look).mockReturnValue(one());
    vi.mocked(serviceSeen).mockReturnValue(service());
    await run({}, "reinstall");
    expect(facts().daemon).toBeNull();
  });

  it("a socket file with no daemon behind it is said", async () => {
    vi.mocked(look).mockReturnValue(one());
    await run({}, "reinstall");
    expect(facts().staleSocket).toBe(false);
    put(process.env.SESSIONPIPE_SOCKET as string, "");
    const r = await run({}, "reinstall");
    expect(facts()).toMatchObject({ daemon: null, staleSocket: true });
    expect(r.text).toContain("a socket file is there with no daemon behind it");
  });

  it("a world of its own is said as that, with the line that runs this without it", async () => {
    vi.mocked(look).mockReturnValue(one());
    await run({}, "reinstall");
    const state = process.env.SESSIONPIPE_STATE as string;
    expect(facts().apart).toEqual({
      said: `This sessionpipe keeps its files in ${state}, not in this computer's usual place (${vi.mocked(elsewhere).mock.results.at(-1)?.value.usual})`,
      // Every variable that moves its files and is set in this test's world; the label is not.
      line: "env -u SESSIONPIPE_STATE -u SESSIONPIPE_CONFIG -u SESSIONPIPE_DATA -u XDG_STATE_HOME -u XDG_CONFIG_HOME -u XDG_DATA_HOME sessionpipe reinstall",
    });
    // A folder under the home is said as `~/…`.
    vi.mocked(elsewhere).mockReturnValue({ now: path.join(home, "st"), usual: path.join(home, "usual") });
    await run({}, "reinstall");
    expect(facts().apart?.said).toBe(
      "This sessionpipe keeps its files in ~/st, not in this computer's usual place (~/usual)",
    );
    // In this account's usual place there is nothing to say.
    vi.mocked(elsewhere).mockReturnValue(null);
    await run({}, "reinstall");
    expect(facts().apart).toBeNull();
  });

  it("L8: the line that runs it for this computer unsets the variables that are set, each of them and no other, in one order", async () => {
    vi.mocked(look).mockReturnValue(one());
    const ALL = [
      "SESSIONPIPE_STATE",
      "SESSIONPIPE_CONFIG",
      "SESSIONPIPE_DATA",
      "SESSIONPIPE_SERVICE_LABEL",
      "XDG_STATE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ];
    /** The line, with only these set: each to a folder inside this test's own. */
    const line = async (...set: string[]) => {
      for (const v of ALL)
        vi.stubEnv(
          v,
          (set.includes(v)
            ? v === "SESSIONPIPE_SERVICE_LABEL"
              ? "org.sessionpipe.racetest"
              : path.join(tmp, "apart", v)
            : undefined) as unknown as string,
        );
      await run({}, "reinstall");
      return facts().apart?.line;
    };
    // The folder that moved alone: the old line named SESSIONPIPE_CONFIG too, set or not.
    expect(await line("SESSIONPIPE_STATE")).toBe("env -u SESSIONPIPE_STATE sessionpipe reinstall");
    expect(await line("SESSIONPIPE_CONFIG")).toBe("env -u SESSIONPIPE_CONFIG sessionpipe reinstall");
    // Moved by XDG's variables: without them in the line the same refusal came back for ever.
    expect(await line("XDG_STATE_HOME")).toBe("env -u XDG_STATE_HOME sessionpipe reinstall");
    expect(await line("XDG_CONFIG_HOME", "XDG_DATA_HOME")).toBe(
      "env -u XDG_CONFIG_HOME -u XDG_DATA_HOME sessionpipe reinstall",
    );
    // The label names the service of the sessionpipe that keeps its files there: it goes
    // too, so the run for this computer looks at this computer's own service.
    expect(await line("SESSIONPIPE_STATE", "XDG_CONFIG_HOME", "SESSIONPIPE_SERVICE_LABEL")).toBe(
      "env -u SESSIONPIPE_STATE -u SESSIONPIPE_SERVICE_LABEL -u XDG_CONFIG_HOME sessionpipe reinstall",
    );
    // All of them, in the one order they are listed in; given the other way round it is the same.
    expect(await line(...ALL)).toBe(`env ${ALL.map((v) => `-u ${v}`).join(" ")} sessionpipe reinstall`);
    expect(await line(...[...ALL].reverse())).toBe(`env ${ALL.map((v) => `-u ${v}`).join(" ")} sessionpipe reinstall`);
    // One that is set to nothing is set: `env -u` takes it out all the same.
    vi.stubEnv("SESSIONPIPE_STATE", path.join(tmp, "apart", "state"));
    for (const v of ALL.filter((x) => x !== "SESSIONPIPE_STATE")) vi.stubEnv(v, undefined as unknown as string);
    vi.stubEnv("XDG_DATA_HOME", "");
    await run({}, "reinstall");
    expect(facts().apart?.line).toBe("env -u SESSIONPIPE_STATE -u XDG_DATA_HOME sessionpipe reinstall");
    // And the refusal a look that may reach nothing ends in carries that very line.
    vi.stubEnv("XDG_DATA_HOME", undefined as unknown as string);
    vi.mocked(look).mockReturnValue(inventory({ reach: null, home: null }));
    const r = await run({}, "reinstall", "--yes");
    expect(r.err).toHaveBeenCalledWith(
      expect.stringMatching(
        /^sessionpipe: This sessionpipe keeps its files in .*, so it leaves this computer's copies alone\. Nothing was changed\. Next: env -u SESSIONPIPE_STATE sessionpipe reinstall\n$/,
      ),
    );
  });
});

describe.skipIf(process.platform === "win32")("sessionpipe reinstall: what it shows, and the one question", () => {
  it("one clean copy of the newest release: said in one green line; exit 0, no question, nothing run", async () => {
    vi.mocked(look).mockReturnValue(one());
    const r = await run({}, "reinstall");
    expect(r.lines).toEqual([
      "Found one copy of sessionpipe on this computer",
      "  · 9.9.9  ~/.local  you type this",
      "",
      "✓ Nothing to repair: one sessionpipe, 9.9.9, the newest release.",
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(r.exit).not.toHaveBeenCalled();
    expect(r.err).not.toHaveBeenCalled();
    expect(createInterface).not.toHaveBeenCalled();
    expect(carryOut).not.toHaveBeenCalled();
    // Nothing is left alone, so nothing is said to be; and no plan, for there is none.
    expect(r.text).not.toMatch(/Left alone|This will|Dry run/);
    // The same with every option, and at a terminal: green, bold, under its mark.
    for (const o of [["--yes"], ["-y"], ["--dry-run"], ["--dry-run", "--yes"]])
      expect((await run({}, "reinstall", ...o)).lines).toEqual(r.lines);
    const term = await run({ tty: true, columns: 80 }, "reinstall");
    expect(term.lines.slice(-2)).toEqual(["", green(`✓ ${NOTHING}`)]);
    // A terminal too narrow for the sentence: each line of it green, the second under its words.
    const narrow = await run({ tty: true, columns: 50 }, "reinstall");
    expect(narrow.lines.slice(-3)).toEqual([
      "",
      green("✓ Nothing to repair: one sessionpipe, 9.9.9, the"),
      green("  newest release."),
    ]);
    expect(carryOut).not.toHaveBeenCalled();
  });

  it("one clean copy beside a service file nothing needs: nothing to repair, and no note about the file", async () => {
    // Not paired: nothing on this computer needs the background service. Its file is there
    // all the same and no daemon answers. The file is not this command's to remove, and it
    // is no finding: a note here made this "One sessionpipe on this computer…" on a
    // computer doctor calls all good.
    put(path.join(slotOf(LOCAL()), "dist", "cli.js"), "");
    vi.mocked(look).mockReturnValue(one({ copies: [copy(LOCAL(), { uses: ["typed", "service", "this"] })] }));
    for (const s of [service({ loaded: false, pid: null }), service()]) {
      vi.mocked(serviceSeen).mockReturnValue(s);
      const r = await run({}, "reinstall");
      expect(r.lines.at(-1)).toBe(`✓ ${NOTHING}`);
      expect(r.text).not.toMatch(/service file is there, and nothing here needs/);
      expect(r.lines.filter((l) => l.startsWith("! "))).toEqual([]);
      expect(planned()).toMatchObject({ nothing: NOTHING, notes: [], steps: [] });
      expect(process.exitCode).toBeUndefined();
      expect(r.err).not.toHaveBeenCalled();
      expect(carryOut).not.toHaveBeenCalled();
    }
    // Nor is anything found of it: "Also found ! the service is loaded, and nothing
    // answers" stood above the green line of a computer with nothing to repair.
    const loaded = await run({}, "reinstall");
    expect(loaded.lines).toEqual([
      "Found one copy of sessionpipe on this computer",
      "  · 9.9.9  ~/.local  you type this, the background service",
      "",
      `✓ ${NOTHING}`,
    ]);
    // Paired, the computer needs the service: the same file is then a finding, and the
    // plan's to put right.
    paired();
    const wanted = await run({}, "reinstall", "--dry-run");
    expect(wanted.lines).toContain("  ! the service is loaded, and nothing answers");
    expect(wanted.text).not.toContain("Nothing to repair");
  });

  it("one copy, and something to say beside it: what is here in green, then each note on a yellow line of its own; exit 0", async () => {
    paired();
    // Whole, the newest, and nothing on PATH leads to it: nobody types it.
    const untyped = () =>
      one({
        copies: [copy(LOCAL(), { uses: ["this"], onPath: false })],
        onPath: [],
        typed: null,
        home: home0({ why: "where this command runs from", onPath: false }),
      });
    vi.mocked(look).mockReturnValue(untyped());
    const r = await run({}, "reinstall");
    expect(r.lines.slice(0, 2)).toEqual([
      "Found one copy of sessionpipe on this computer",
      "  · 9.9.9  ~/.local  this command",
    ]);
    expect(r.lines.slice(2)).toEqual([
      "",
      // Not "nothing to repair" while there is something to look at: what is here, then what.
      `✓ ${ONE_COPY}`,
      // The folder is under the home: `~/…`, as everywhere on this page.
      `! ${NOT_ON_PATH}`,
      `! ${NOTHING_STARTS_IT}`,
    ]);
    expect(r.text).not.toContain("Nothing to repair");
    // Each note is said once: there is no plan's screen to say it a first time.
    expect(r.lines.filter((l) => l.includes("is not on your PATH"))).toHaveLength(1);
    expect(process.exitCode).toBeUndefined();
    expect(r.exit).not.toHaveBeenCalled();
    expect(carryOut).not.toHaveBeenCalled();
    // At a terminal: the first line green, every line of every note yellow, in the same order.
    const term = await run({ tty: true, columns: 200 }, "reinstall");
    expect(term.lines.slice(-5)).toEqual([
      "",
      green(`✓ ${ONE_COPY}`),
      yellow(`! ${NOT_ON_PATH}`),
      // Longer than the 100 columns a line is set to: it goes on under its own words.
      yellow("! The background service isn't running, and nothing here starts it by itself:"),
      yellow("  `sessionpipe control run` does."),
    ]);
    // npm out of reach is a note as any other, and the sentence calls nothing the newest.
    vi.mocked(latestVersion).mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
    );
    vi.mocked(look).mockReturnValue(one());
    const offline = await run({}, "reinstall");
    expect(offline.lines.slice(2)).toEqual([
      "",
      "✓ One sessionpipe on this computer: 9.9.9.",
      "! The background service isn't running, and nothing here starts it by itself: `sessionpipe control run` does.",
      "! npm couldn't be asked whether 9.9.9 is the newest release: registry.npmjs.org can't be reached (ENOTFOUND).",
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(offline.err).not.toHaveBeenCalled();
  });

  it("it won't act: what it found, then one line with what stands in the way and the command to run; exit 1", async () => {
    vi.mocked(look).mockReturnValue(two());
    vi.mocked(latestVersion).mockRejectedValue(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
    );
    const r = await run({}, "reinstall", "--yes");
    // What was found is shown first; the plan is not, for there is none.
    expect(r.lines).toEqual([
      "Found 2 copies of sessionpipe on this computer",
      "  · 1.0.0  ~/.local                      you type this",
      "  · 0.9.0  ~/.nvm/versions/node/v22.1.0  nothing uses it",
    ]);
    // Into a pipe the command to run next ends the one line.
    expect(r.err).toHaveBeenCalledWith(
      "sessionpipe: npm couldn't be asked for the newest release (registry.npmjs.org can't be reached (ENOTFOUND)), and a fresh copy comes from npm. Nothing was changed. Next: sessionpipe reinstall\n",
    );
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(carryOut).not.toHaveBeenCalled();
    // At a terminal: what is wrong, then the command on a line of its own.
    const term = await run({ errTty: true, columns: 200 }, "reinstall", "--yes");
    expect(term.err).toHaveBeenCalledWith(
      expect.stringMatching(
        /error.* {2}npm couldn't be asked for the newest release[\s\S]*and a fresh copy comes from npm\. Nothing was changed\n.*try.* {4}.*sessionpipe reinstall.*\n$/,
      ),
    );
    // npm that can't be run is the plan's own refusal too.
    vi.mocked(latestVersion).mockResolvedValue(NEWEST);
    vi.mocked(execCapture).mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const none = await run({}, "reinstall", "--yes");
    expect(none.err).toHaveBeenCalledWith(
      "sessionpipe: npm is not beside this Node nor on PATH, and a fresh copy comes from npm. Nothing was changed. Install npm, then run this again. Next: sessionpipe reinstall\n",
    );
    expect(carryOut).not.toHaveBeenCalled();
  });

  it("a world of its own whose home is this account's real one has no copies to call its own: it says how to run this for the computer", async () => {
    vi.mocked(look).mockReturnValue(inventory({ reach: null, home: null }));
    const r = await run({}, "reinstall", "--yes");
    expect(r.err).toHaveBeenCalledWith(
      expect.stringMatching(
        /^sessionpipe: This sessionpipe keeps its files in .*, not in this computer's usual place \(.*\), so it leaves this computer's copies alone\. Nothing was changed\. Next: env -u SESSIONPIPE_STATE -u SESSIONPIPE_CONFIG -u SESSIONPIPE_DATA -u XDG_STATE_HOME -u XDG_CONFIG_HOME -u XDG_DATA_HOME sessionpipe reinstall\n$/,
      ),
    );
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(carryOut).not.toHaveBeenCalled();
    // It looked nowhere, so it does not say it found no copy: only the refusal is said.
    expect(r.lines).toEqual([]);
  });

  it("one clean copy beside what npx fetched to run this, and a checkout: both found, both listed as left alone, nothing to repair", async () => {
    vi.mocked(look).mockReturnValue(
      one({
        copies: [copy(LOCAL(), { uses: ["typed"] }), npxEntry("0a1b2c3d4e5f6a7b", { uses: ["this"] }), checkout()],
      }),
    );
    const r = await run({}, "reinstall");
    // L10: a copy is a folder the proof accepts. The checkout is no copy of it: it is not
    // counted and has no row above, only its row under "Left alone", after an empty line
    // and before the one green line. What npx fetched is npm's cache: said there too.
    expect(r.lines).toEqual([
      "Found 2 copies of sessionpipe on this computer",
      "  · 9.9.9  ~/.local                      you type this",
      "  · 9.9.9  ~/.npm/_npx/0a1b2c3d4e5f6a7b  this command",
      "",
      "Left alone",
      "  · ~/src/sessionpipe/packages/cli  it is not a folder named node_modules/sessionpipe",
      "  · ~/.npm/_npx/0a1b2c3d4e5f6a7b    npm's cache of what npx ran",
      "",
      "✓ Nothing to repair: one sessionpipe, 9.9.9, the newest release.",
    ]);
    // What is left alone is no note: the line is green, and it is "nothing to repair".
    expect(planned()).toMatchObject({ notes: [], steps: [] });
    expect(planned().left.map((l) => l.ours)).toEqual([false, false]);
    expect(process.exitCode).toBeUndefined();
    expect(carryOut).not.toHaveBeenCalled();
    // The same through `npx … reinstall --yes`: run again, it is still nothing to repair.
    expect((await run({}, "reinstall", "--yes")).lines).toEqual(r.lines);
    expect(carryOut).not.toHaveBeenCalled();
    // At a terminal: the heading bold, each row under its mark, the last line green.
    const term = await run({ tty: true, columns: 80 }, "reinstall");
    expect(term.lines.slice(-7)).toEqual([
      "",
      `${ESC}[1mLeft alone${ESC}[22m`,
      // Why folds under its own column.
      `  ${ESC}[2m·${ESC}[22m ~/src/sessionpipe/packages/cli  it is not a folder named`,
      "                                    node_modules/sessionpipe",
      `  ${ESC}[2m·${ESC}[22m ~/.npm/_npx/0a1b2c3d4e5f6a7b    npm's cache of what npx ran`,
      "",
      green(`✓ ${NOTHING}`),
    ]);
    for (const l of bare(term.lines)) expect(l.length).toBeLessThan(80);
    // A file of the name that is no install is such a row too, and no finding above it.
    const script = path.join(home, "bin", "sessionpipe");
    vi.mocked(look).mockReturnValue(one({ strangers: [{ file: script, why: "a file npm didn't put there" }] }));
    expect((await run({}, "reinstall")).lines).toEqual([
      "Found one copy of sessionpipe on this computer",
      "  · 9.9.9  ~/.local  you type this",
      "",
      "Left alone",
      "  · ~/bin/sessionpipe  a file npm didn't put there",
      "",
      `✓ ${NOTHING}`,
    ]);
    // No copy the proof accepts at all (a checkout alone, npm out of reach): "no copy", never "0 copies".
    vi.mocked(look).mockReturnValue(inventory({ copies: [checkout({ uses: ["this"] })] }));
    vi.mocked(execCapture).mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    expect((await run({}, "reinstall")).lines).toEqual(["Found no copy of sessionpipe on this computer"]);
  });

  it("a node and a copy the service file names that are gone are said under 'Also found', the node as a person reads it", async () => {
    paired();
    vi.mocked(look).mockReturnValue(one());
    vi.mocked(serviceSeen).mockReturnValue(
      service({
        loaded: false,
        pid: null,
        argv: [path.join(home, ".nvm", "gone", "bin", "node"), path.join(slotOf(NVM()), "dist", "cli.js")],
      }),
    );
    const r = await run({}, "reinstall", "--dry-run");
    const at = r.lines.indexOf("Also found");
    expect(r.lines.slice(at, at + 4)).toEqual([
      "Also found",
      "  ! the service file names a node that is gone (~/.nvm/gone/bin/node)",
      "  ! the service file names a copy of sessionpipe that is gone",
      "  ! the service file is there, and the service is not loaded",
    ]);
  });

  it("M3: what typing starts is no installed copy: nothing is done, by any option, and the line names the one way on", async () => {
    // A checkout's link first on PATH, and a stray copy in nvm's Node: what a person types
    // would not be the one clean copy afterwards, so no copy is put anywhere.
    const stays = path.join(home, "bin", "sessionpipe");
    const world = (o: Partial<Inventory> = {}) =>
      inventory({
        copies: [checkout({ uses: ["typed", "this"] }), copy(NVM(), { version: "0.9.0" })],
        onPath: [{ file: stays, dir: checkout().dir }],
        typed: checkout().dir,
        // The look names no home where what is typed is no install of ours.
        home: null,
        ...o,
      });
    vi.mocked(look).mockReturnValue(world());
    const said =
      "sessionpipe: Typing `sessionpipe` starts ~/src/sessionpipe/packages/cli, which is no installed copy of it (it is not a folder named node_modules/sessionpipe): this command leaves it alone, so it can't put one clean copy in its place. Nothing was changed. Next: which -a sessionpipe\n";
    for (const flags of [[], ["--yes"], ["--dry-run"]]) {
      const r = await run({}, "reinstall", ...flags);
      expect(r.err).toHaveBeenCalledWith(said);
      expect(r.exit).toHaveBeenCalledWith(1);
      // What was found is shown: the one copy the proof accepts. The checkout is no row of it.
      expect(r.lines).toEqual([
        "Found one copy of sessionpipe on this computer",
        "  · 0.9.0  ~/.nvm/versions/node/v22.1.0  nothing uses it",
      ]);
    }
    expect(planned()).toMatchObject({ steps: [], nothing: null, home: null });
    // A file first on PATH that is no link of npm's, with this command started from no
    // installed copy (npx, a checkout): which copy it starts can't be told.
    const shim = path.join(home, ".asdf", "shims", "sessionpipe");
    vi.mocked(look).mockReturnValue(
      world({
        copies: [checkout({ uses: ["this"] }), copy(NVM(), { version: "0.9.0" })],
        strangers: [{ file: shim, why: "a file npm didn't put there" }],
        onPath: [{ file: shim, dir: null }],
        typed: null,
        unsure: shim,
      }),
    );
    const unsure = await run({}, "reinstall", "--yes");
    expect(unsure.err).toHaveBeenCalledWith(
      `sessionpipe: ~/.asdf/shims/sessionpipe is the first \`sessionpipe\` on your PATH and no link of npm's, and this command was not started through it: it can't tell which copy that file starts, so it can't tell where the one clean copy goes. Nothing was changed. Install it into the Node you use, then run it from there. Next: npm install -g sessionpipe@${NEWEST} && sessionpipe reinstall\n`,
    );
    expect(unsure.exit).toHaveBeenCalledWith(1);
    // The home's bin folder is on nobody's PATH, and nothing is typed: a fresh copy there
    // would not be found either.
    vi.mocked(look).mockReturnValue(
      inventory({
        copies: [copy(NVM(), { version: "0.9.0", bins: [], wrong: "npm's link to it is gone" })],
        home: home0({ why: "a folder of your own", onPath: false }),
      }),
    );
    const off = await run({}, "reinstall", "--yes");
    expect(off.err).toHaveBeenCalledWith(
      `sessionpipe: ~/.local/bin is not on your PATH, so \`sessionpipe\` would not be found when you type it. Nothing was changed. Add it, then run this again. Next: export PATH=${path.join(LOCAL(), "bin")}:"$PATH"\n`,
    );
    for (const never of [carryOut, createInterface, npmDo, installInto, remove]) expect(never).not.toHaveBeenCalled();
  });

  it("M3: a copy where this user may not write: whole and the newest it stays and the rest is done; older, nothing is done and the one line updates it in place", async () => {
    // As after `sudo npm install -g`: the one you type is in a prefix that is root's.
    const root = (version: string, o: Partial<Inventory> = {}) =>
      inventory({
        copies: [copy(NVM(), { version, uses: ["typed", "this"], writable: false })],
        onPath: [{ file: binOf(NVM()), dir: slotOf(NVM()) }],
        typed: slotOf(NVM()),
        home: home0({
          prefix: NVM(),
          shown: "~/.nvm/versions/node/v22.1.0",
          bin: path.join(NVM(), "bin"),
          writable: false,
        }),
        ...o,
      });
    // Whole and the newest, alone: nothing to repair, whoever may write there. Before, a
    // second copy was installed in ~/.local and the run ended asking for sudo.
    vi.mocked(look).mockReturnValue(root(NEWEST));
    const fine = await run({}, "reinstall", "--yes");
    expect(fine.lines.at(-1)).toBe(`✓ ${NOTHING}`);
    expect(fine.err).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(planned()).toMatchObject({ steps: [], stays: null });
    // Older: nothing is done, and no copy is put anywhere else.
    vi.mocked(look).mockReturnValue(root("1.0.0"));
    for (const flags of [[], ["--yes"], ["--dry-run"]]) {
      const r = await run({}, "reinstall", ...flags);
      expect(r.err).toHaveBeenCalledWith(
        `sessionpipe: ~/.nvm/versions/node/v22.1.0 holds the copy you type (1.0.0), and you may not write there. Nothing was changed. Update it there, then run this again. Next: sudo npm install -g --prefix ${NVM()} sessionpipe@${NEWEST}\n`,
      );
      expect(r.exit).toHaveBeenCalledWith(1);
      expect(r.text).not.toContain("This will");
    }
    expect(planned()).toMatchObject({ steps: [], nothing: null });
    expect(carryOut).not.toHaveBeenCalled();
    // Whole and the newest, with a stray beside it: it stays as it is, said as the first
    // row, and nothing is downloaded or installed: the run is the rest.
    vi.mocked(look).mockReturnValue(
      root(NEWEST, {
        copies: [copy(NVM(), { uses: ["typed", "this"], writable: false }), copy(LOCAL(), { version: "0.9.0" })],
      }),
    );
    const dry = await run({}, "reinstall", "--dry-run");
    expect(dry.lines.slice(dry.lines.indexOf("This will"))).toEqual([
      "This will",
      "  = keep     9.9.9 in ~/.nvm/versions/node/v22.1.0 as it is: whole, the newest, and not yours to write",
      "  - remove   0.9.0 in ~/.local",
      KEEP,
      "",
      DRY_RUN,
    ]);
    expect(planned().steps.map((s) => s.do)).toEqual(["use", "remove", "prove"]);
    // Nothing is to be downloaded, so the line that says nothing is touched until it has been is not there.
    expect(planned().safety).toEqual([]);
    expect(dry.text).not.toContain("Nothing is touched until");
  });

  it("a file that is no install of sessionpipe where the fresh copy's link goes: nothing is done, and the one line moves it", async () => {
    // A script of someone's at ~/.local/bin/sessionpipe, where the link of the copy in
    // ~/.local was: npm will not put its link over it, and it is not this command's to
    // move. As the look answers it (S2): no shim, so nothing is typed and nothing is
    // unsure, and the home is that copy's prefix, blocked by the file.
    const script = binOf(LOCAL());
    const gone = { bins: [], wrong: "npm's link to it is gone" };
    const blocked = (o: Partial<Inventory> = {}) =>
      inventory({
        copies: [copy(LOCAL(), { version: "1.0.0", uses: ["this"], ...gone }), copy(NVM(), { version: "0.9.0" })],
        strangers: [{ file: script, why: "a file npm didn't put there" }],
        onPath: [{ file: script, dir: null }],
        home: home0({ blocked: script, why: "where the copy is whose link is gone" }),
        ...o,
      });
    vi.mocked(look).mockReturnValue(blocked());
    // L7: `mv -n`, which never writes over a `….old` that is there already.
    const said = `sessionpipe: ~/.local/bin/sessionpipe is not sessionpipe's, and it is where the fresh copy's link goes: npm won't write over it. Nothing was changed. Move it aside, then run this again. Next: mv -n ${script} ${script}.old\n`;
    for (const flags of [[], ["--yes"], ["--dry-run"]]) {
      const r = await run({}, "reinstall", ...flags);
      expect(r.err).toHaveBeenCalledWith(said);
      expect(r.exit).toHaveBeenCalledWith(1);
      // What was found is shown; no plan is, for there is none. The file is no copy and
      // no finding: the one line that refuses is what names it, and says what to do with it.
      expect(r.lines).toEqual([
        "Found 2 copies of sessionpipe on this computer",
        "  ✗ 1.0.0  ~/.local                      this command · npm's link to it is gone",
        "  · 0.9.0  ~/.nvm/versions/node/v22.1.0  nothing uses it",
      ]);
      // Never the line that has npm install over the file.
      expect(String(r.err.mock.calls[0]?.[0])).not.toMatch(/npm install/);
    }
    expect(planned()).toMatchObject({ steps: [], nothing: null });
    expect(carryOut).not.toHaveBeenCalled();
    expect(createInterface).not.toHaveBeenCalled();
    expect(npmDo).not.toHaveBeenCalled();
    // The same where the one copy there is the newest: with no link of npm's it is not whole.
    vi.mocked(look).mockReturnValue(blocked({ copies: [copy(LOCAL(), { uses: ["this"], ...gone })] }));
    const fine = await run({}, "reinstall");
    expect(fine.err).toHaveBeenCalledWith(said);
    expect(fine.text).not.toContain("Nothing to repair");
    // A path with a space in it is one word of the command.
    const spaced = path.join(home, "my tools", "bin", "sessionpipe");
    vi.mocked(look).mockReturnValue(blocked({ home: home0({ blocked: spaced }) }));
    expect((await run({}, "reinstall")).err).toHaveBeenCalledWith(
      expect.stringContaining(`Next: mv -n '${spaced}' '${spaced}.old'\n`),
    );
  });

  it("one clean copy, and what you type is something else that stays: not 'Nothing to repair', and said in yellow under the green line; exit 0", async () => {
    // A checkout's link ahead of ~/.local/bin on PATH: not an install, never moved.
    const stays = path.join(home, "bin", "sessionpipe");
    vi.mocked(look).mockReturnValue(
      inventory({
        copies: [copy(LOCAL(), { uses: ["service"] }), checkout({ uses: ["typed", "this"] })],
        onPath: [
          { file: stays, dir: checkout().dir },
          { file: binOf(LOCAL()), dir: slotOf(LOCAL()) },
        ],
        typed: checkout().dir,
        home: null,
      }),
    );
    const r = await run({}, "reinstall");
    expect(r.lines).toEqual([
      "Found one copy of sessionpipe on this computer",
      "  · 9.9.9  ~/.local  the background service",
      "",
      // Why what is typed stays where it is: its own row.
      "Left alone",
      "  · ~/src/sessionpipe/packages/cli  it is not a folder named node_modules/sessionpipe",
      "",
      // What is here and works, in green; then what a person should still look at.
      `✓ ${ONE_COPY}`,
      `! ${TYPED}`,
    ]);
    expect(r.text).not.toContain("Nothing to repair");
    expect(process.exitCode).toBeUndefined();
    expect(r.exit).not.toHaveBeenCalled();
    expect(r.err).not.toHaveBeenCalled();
    // No plan, no question, nothing run: at a terminal too.
    keyboard(true);
    const term = await run({ tty: true, columns: 200 }, "reinstall");
    expect(term.lines.slice(term.lines.lastIndexOf("") + 1)).toEqual([green(`✓ ${ONE_COPY}`), yellow(`! ${TYPED}`)]);
    expect(createInterface).not.toHaveBeenCalled();
    expect(carryOut).not.toHaveBeenCalled();
  });

  it("--dry-run prints what a run would do, and does none of it", async () => {
    vi.mocked(look).mockReturnValue(two());
    const dry = await run({}, "reinstall", "--dry-run");
    const page = [
      "Found 2 copies of sessionpipe on this computer",
      "  · 1.0.0  ~/.local                      you type this",
      "  · 0.9.0  ~/.nvm/versions/node/v22.1.0  nothing uses it",
      "",
      // A row an action. No agent is hooked here and nothing runs in the background: there
      // is nothing to switch, and no row for it.
      "This will",
      "  + install  9.9.9, the newest release, fresh in ~/.local (replaces 1.0.0)",
      "  - remove   0.9.0 in ~/.nvm/versions/node/v22.1.0",
      KEEP,
      "",
      SAFE,
      "",
    ];
    // A dry run ends by saying that it was one, from the first column, and what does it.
    expect(dry.lines).toEqual([...page, DRY_RUN]);
    expect(process.exitCode).toBeUndefined();
    expect(dry.exit).not.toHaveBeenCalled();
    expect(carryOut).not.toHaveBeenCalled();
    expect(createInterface).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(npmDo).not.toHaveBeenCalled();
    expect(installInto).not.toHaveBeenCalled();
    // With --yes beside it, it is a dry run still.
    expect((await run({}, "reinstall", "--yes", "--dry-run")).lines).toEqual(dry.lines);
    expect(carryOut).not.toHaveBeenCalled();
    // A real run prints the same page before it does anything, and carries out the same plan.
    vi.mocked(carryOut).mockResolvedValue(ONE);
    const real = await run({}, "reinstall", "--yes");
    expect(real.lines.slice(0, page.length)).toEqual(page);
    expect(vi.mocked(carryOut).mock.calls[0]?.[0]).toBe(planned());
    expect(planned().steps.map((s) => s.do)).toEqual(["fetch", "install", "use", "remove", "prove"]);
  });

  it("at a terminal the page folds to it, and every line of it fits", async () => {
    vi.mocked(look).mockReturnValue(two());
    const r = await run({ tty: true, columns: 80 }, "reinstall", "--dry-run");
    expect(r.lines[0]).toBe(`${ESC}[1mFound 2 copies of sessionpipe on this computer${ESC}[22m`);
    expect(r.lines).toContain(`${ESC}[1mThis will${ESC}[22m`);
    // The rows in the colour of their kind: green for what is added, red and bold for what goes.
    expect(r.lines).toContain(
      `  ${ESC}[32m+ install${ESC}[39m  9.9.9, the newest release, fresh in ~/.local (replaces 1.0.0)`,
    );
    expect(r.lines).toContain(
      `  ${ESC}[1m${ESC}[31m- remove ${ESC}[39m${ESC}[22m  0.9.0 in ~/.nvm/versions/node/v22.1.0`,
    );
    expect(r.lines).toContain(`  ${ESC}[2m= keep   ${ESC}[22m  pairings, settings, keys, messages waiting to be sent`);
    expect(r.lines.slice(-3)).toEqual([
      SAFE,
      "",
      // The command that does it is shown as one, as on every other line.
      `Dry run: nothing was changed. ${ESC}[36m\`sessionpipe reinstall\`${ESC}[39m does it.`,
    ]);
    for (const l of bare(r.lines)) expect(l.length).toBeLessThan(80);
    // Without colour the page is the pipe's, line for line: nothing here is long enough to fold.
    const mono = await run({ tty: true, columns: 80 }, "reinstall", "--dry-run", "--no-color");
    expect(mono.text).not.toContain(ESC);
    expect(mono.lines).toEqual(bare(r.lines));
    expect(mono.lines).toEqual((await run({}, "reinstall", "--dry-run")).lines);
    // A terminal of 120 columns shows the same rows.
    expect(bare((await run({ tty: true, columns: 120 }, "reinstall", "--dry-run")).lines)).toEqual(mono.lines);
  });

  it("without --yes and with nobody to ask it changes nothing, and says how to run it unattended; exit 1", async () => {
    vi.mocked(look).mockReturnValue(two());
    const refused =
      "sessionpipe: nothing was changed: this is not a terminal, and it asks before it removes anything. Next: sessionpipe reinstall --yes\n";
    // Into a pipe, whoever is at the keyboard.
    keyboard(true);
    const piped = await run({}, "reinstall");
    expect(piped.err).toHaveBeenCalledWith(refused);
    expect(piped.exit).toHaveBeenCalledWith(1);
    // The page was shown all the same: it says what `--yes` would do.
    expect(piped.lines).toContain("This will");
    expect(piped.lines.slice(-3)).toEqual(["", SAFE, ""]);
    // To a terminal, with the keyboard closed (a script's stdin, `< /dev/null`).
    keyboard(false);
    const closed = await run({ tty: true, columns: 200 }, "reinstall");
    expect(closed.err).toHaveBeenCalledWith(refused);
    expect(closed.exit).toHaveBeenCalledWith(1);
    expect(createInterface).not.toHaveBeenCalled();
    expect(carryOut).not.toHaveBeenCalled();
  });

  it("at a terminal it asks once: Enter and yes go ahead, anything else leaves everything as it was", async () => {
    vi.mocked(look).mockReturnValue(two());
    vi.mocked(carryOut).mockResolvedValue(ONE);
    keyboard(true);
    for (const yes of ["", "y", "Y", " yes \n", "YES"]) {
      vi.mocked(carryOut).mockClear();
      const rl = answer(yes);
      const r = await run({ tty: true, columns: 200 }, "reinstall");
      expect(createInterface).toHaveBeenLastCalledWith({ input: process.stdin, output: process.stdout });
      expect(rl.question).toHaveBeenCalledTimes(1);
      expect(rl.question).toHaveBeenCalledWith("Go ahead? [Y/n] ");
      expect(rl.close).toHaveBeenCalledTimes(1);
      expect(carryOut).toHaveBeenCalledTimes(1);
      expect(r.lines.at(-1)).toContain("This computer has one sessionpipe: 9.9.9, in ~/.local.");
      expect(process.exitCode).toBeUndefined();
    }
    for (const no of ["n", "N", "no", "nope", "q", "yes please"]) {
      vi.mocked(carryOut).mockClear();
      const rl = answer(no);
      const r = await run({ tty: true, columns: 200 }, "reinstall");
      expect(rl.close).toHaveBeenCalledTimes(1);
      expect(carryOut).not.toHaveBeenCalled();
      expect(r.lines.at(-1)).toBe("  Nothing was changed.");
      expect(process.exitCode).toBeUndefined();
      expect(r.exit).not.toHaveBeenCalled();
    }
    // A keyboard that closes under the question: the terminal is let go, and nothing is done.
    const rl = { question: vi.fn(async () => Promise.reject(new Error("the keyboard was closed"))), close: vi.fn() };
    vi.mocked(createInterface).mockReturnValue(rl as never);
    const gone = await run({ tty: true, columns: 200 }, "reinstall");
    expect(rl.close).toHaveBeenCalledTimes(1);
    expect(gone.exit).toHaveBeenCalledWith(1);
    expect(carryOut).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("--yes, or -y, asks nobody: in a pipe and at a terminal alike", async () => {
    vi.mocked(look).mockReturnValue(two());
    vi.mocked(carryOut).mockResolvedValue(ONE);
    keyboard(true);
    for (const [where, flag] of [
      [{}, "--yes"],
      [{}, "-y"],
      [{ tty: true, columns: 200 }, "--yes"],
      [{ tty: true, columns: 200 }, "-y"],
    ] as const) {
      vi.mocked(carryOut).mockClear();
      await run(where, "reinstall", flag);
      expect(carryOut).toHaveBeenCalledTimes(1);
    }
    expect(createInterface).not.toHaveBeenCalled();
  });

  it("the page says a folder under the home as `~/…` in its sentences, and whole in what is to be pasted", async () => {
    // A home with a space in its name: a path in a command is quoted, and inside quotes a
    // shell leaves `~` as it is and would look for a folder of that name.
    const spaced = path.join(tmp, "my home");
    mkdirSync(spaced);
    vi.stubEnv("HOME", spaced);
    // Paired, and nothing runs the service: the plan has a note to say.
    paired();
    const nvm = path.join(spaced, ".nvm", "versions", "node", "v22.1.0");
    const local = path.join(spaced, ".local");
    // And a folder elsewhere whose path only has the home's inside it.
    const mirror = path.join(tmp, `mirror${spaced}`, "bin", "sessionpipe");
    const script = path.join(spaced, "bin", "sessionpipe");
    vi.mocked(look).mockReturnValue(
      inventory({
        reach: spaced,
        copies: [
          copy(local, { where: "~/.local", version: "1.0.0", uses: ["typed", "this"] }),
          copy(nvm, { where: "~/.nvm/versions/node/v22.1.0", version: "0.9.0", writable: false }),
        ],
        dangling: [mirror, path.join(spaced, "old", "bin", "sessionpipe")],
        strangers: [{ file: script, why: "a file npm didn't put there" }],
        // The script (a wrapper in a folder of its own) started this command as npm's link
        // to the copy in ~/.local: that copy is what is typed.
        onPath: [
          { file: script, dir: null },
          { file: binOf(local), dir: slotOf(local) },
        ],
        typed: slotOf(local),
        home: home0({ prefix: local, bin: path.join(local, "bin") }),
      }),
    );
    const r = await run({}, "reinstall", "--dry-run");
    // M2: the folder and its own link, by `rm`: never npm's uninstall, which takes
    // whatever is at the prefix's command path.
    const line = `sudo rm -r '${slotOf(nvm)}' '${binOf(nvm)}'`;
    const p = planned();
    // What the run is handed keeps every path whole: what it removes, and the command to paste.
    expect(p.left).toEqual([
      {
        where: "~/bin/sessionpipe",
        path: script,
        version: null,
        why: "a file npm didn't put there",
        line: null,
        ours: false,
      },
      {
        where: "~/.nvm/versions/node/v22.1.0",
        path: slotOf(nvm),
        version: "0.9.0",
        why: "you may not write where it is",
        line,
        ours: true,
      },
    ]);
    expect(p.steps.filter((s) => s.do === "remove").map((s) => (s as { path: string }).path)).toEqual([
      mirror,
      path.join(spaced, "old", "bin", "sessionpipe"),
    ]);
    // The plan's screen prints no command to paste: the copy that needs one is marked, and
    // a run ends with the line. So no quoted path is on the page at all.
    expect(r.text).not.toMatch(/sudo (rm|npm)/);
    expect(r.text).not.toContain("'~");
    expect(r.text).not.toContain(`'${nvm}`);
    // In a sentence the same home is `~/…`; a longer path that only has it inside is whole.
    expect(r.lines).toEqual([
      "Found 2 copies of sessionpipe on this computer",
      "  · 1.0.0  ~/.local                      you type this",
      "  · 0.9.0  ~/.nvm/versions/node/v22.1.0  nothing uses it",
      "",
      "Also found",
      `  ! ${mirror} is a link to a sessionpipe that is gone`,
      "  ! ~/old/bin/sessionpipe is a link to a sessionpipe that is gone",
      "",
      "This will",
      "  + install  9.9.9, the newest release, fresh in ~/.local (replaces 1.0.0)",
      // A link's row names the file as the findings above do.
      `  - remove   ${mirror} (a link to a copy that is gone)`,
      "  - remove   ~/old/bin/sessionpipe (a link to a copy that is gone)",
      KEEP,
      "",
      "Left alone",
      // The file that is no install is a row here, and no finding above.
      "  · ~/bin/sessionpipe             a file npm didn't put there",
      "  ! ~/.nvm/versions/node/v22.1.0  0.9.0 · needs sudo: a run ends with its line",
      "",
      `  ! ${NOTHING_STARTS_IT}`,
      "",
      SAFE,
      "",
      DRY_RUN,
    ]);
    for (const l of r.lines.filter((x) => !x.includes(mirror))) expect(l).not.toContain(path.join(spaced, "bin"));
    // At a terminal a line breaks by what is printed, and a note's second line is under its words.
    const term = bare((await run({ tty: true, columns: 80 }, "reinstall", "--dry-run")).lines);
    const at = term.findIndex((l) => l.startsWith("  ! The background service isn't running"));
    expect(term.slice(at, at + 3)).toEqual([
      "  ! The background service isn't running, and nothing here starts it by itself:",
      "    `sessionpipe control run` does.",
      "",
    ]);
    // A row too long for the line goes on under its own words, a folder in it broken
    // after a separator: put together again it names the whole path, never `~/…`.
    const row = term.findIndex((l) => l.startsWith("  - remove   "));
    const end = term.findIndex((l, n) => n > row && /^ {2}\S/.test(l));
    expect(end).toBeGreaterThan(row + 1);
    for (const l of term.slice(row + 1, end)) expect(l).toMatch(/^ {13}\S/);
    const pieces = term.slice(row, end).map((l) => l.slice(13));
    expect(pieces.reduce((whole, piece) => `${whole}${whole.endsWith(path.sep) ? "" : " "}${piece}`)).toBe(
      `${mirror} (a link to a copy that is gone)`,
    );
    // (A path outside the home is as long as it is: in a finding nothing folds one.)
    for (const l of term.filter((x) => !x.includes(tmp))) expect(l.length).toBeLessThan(80);
  });

  it("a sentence from elsewhere (the run's, `update`'s, the last line) has the home as `~/…` where it starts a word, and nowhere else", async () => {
    const spaced = path.join(tmp, "my home");
    mkdirSync(spaced);
    vi.stubEnv("HOME", spaced);
    const under = path.join(spaced, ".nvm", "lib");
    const mirror = path.join(tmp, `mirror${spaced}`, "lib");
    const said = `${under} could not be removed: ${under} was left alone (it holds src); try '${under}' or (${under}); ${mirror} stays`;
    const short = `~/.nvm/lib could not be removed: ~/.nvm/lib was left alone (it holds src); try '${under}' or (~/.nvm/lib); ${mirror} stays`;
    const { d, lines } = await went();
    // A step the run says.
    let at = lines.length;
    d.say({ mark: "warn", text: said });
    expect(lines.slice(at)).toEqual([`  ! ${short}`]);
    // A step `update` says.
    vi.mocked(bringCurrent).mockResolvedValue({ state: "current", version: NEWEST, said: "ok" });
    await d.use(NEWEST, true);
    at = lines.length;
    handed().say({ mark: "info", text: said });
    expect(lines.slice(at)).toEqual([`  · ${short}`]);
    // The line under the last one, with what the run warned of.
    const r = await ends({ ...ONE, warn: [said] });
    expect(r.lines.slice(-2)).toEqual([`✓ ${ONE.said}`, `! ${short}`]);
    // What works is the run's sentence too, and so is what is left: both as a person reads
    // a path. The command to run next is for a shell, which leaves `~` in quotes as it is:
    // it keeps the whole path.
    const next = `sudo rm -r '${under}'`;
    const stays = await ends({
      ...LEFT,
      said: `sessionpipe 9.9.9 is installed in ${path.join(spaced, ".local")} and in use.`,
      warn: [said],
      still: `One other copy is still there: 1.0.0 in ${under} (${under} can't be written).`,
      next,
    });
    expect(stays.lines.slice(-2)).toEqual(["✓ sessionpipe 9.9.9 is installed in ~/.local and in use.", `! ${short}`]);
    expect(stays.err).toHaveBeenCalledWith(
      `sessionpipe: One other copy is still there: 1.0.0 in ~/.nvm/lib (~/.nvm/lib can't be written). Next: ${next}\n`,
    );
    // A run that stopped says why the same way.
    const stopped = await ends({
      state: "failed",
      error: `sessionpipe 9.9.9 couldn't be installed in ${path.join(spaced, ".local")}: ${under} is in the way`,
      next: `mv -n '${under}' '${under}.old'`,
    });
    expect(stopped.err).toHaveBeenCalledWith(
      `sessionpipe: sessionpipe 9.9.9 couldn't be installed in ~/.local: ~/.nvm/lib is in the way. Next: mv -n '${under}' '${under}.old'\n`,
    );
    // And so does a service that finishes by itself.
    const waits = await ends({
      state: "waiting",
      said: `It still runs from ${under}, which stays until that is done.`,
    });
    expect(waits.lines.at(-1)).toBe("! It still runs from ~/.nvm/lib, which stays until that is done.");
    process.exitCode = undefined;
    // At a terminal it is shortened before it is folded: no line of it is cut short for
    // a path it no longer shows.
    const term = await ends(
      { ...ONE, warn: [`${under} still names ${under}, which was removed.`] },
      { tty: true, columns: 80 },
    );
    expect(bare(term.lines).slice(-3)).toEqual([
      "✓ This computer has one sessionpipe: 9.9.9, in ~/.local. Pairings and settings",
      "  are as they were.",
      "! ~/.nvm/lib still names ~/.nvm/lib, which was removed.",
    ]);
  });
});

describe.skipIf(process.platform === "win32")("sessionpipe reinstall: words that come from the disk", () => {
  it("L3: a word from the disk reaches no line raw: a folder's name, a hooks file's, the folder a world of its own keeps its files in, a sentence of the run's or of `update`'s", async () => {
    // A name that carries a colour of sessionpipe's own (which the painter lets through),
    // a clear-screen, a terminal title, and a line break before a made-up `error` line.
    const dirty = `x${ESC}[31mred${ESC}[39m${ESC}[2J${ESC}]0;title\u0007\nerror  made up`;
    const cleaned = "xred error  made up";
    put(process.env.SESSIONPIPE_CONFIG as string, { harnesses: { "claude-code": { enabled: true } } });
    // A folder of that name on the disk, set up as a second home of Claude Code's.
    mkdirSync(path.join(home, dirty));
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, dirty));
    vi.mocked(elsewhere).mockReturnValue({ now: path.join(home, dirty), usual: path.join(home, "usual") });
    const { d, lines } = await went();
    // How a path is shown: what the look, the plan and the run are each handed.
    expect(looked().tilde(path.join(home, dirty))).toBe(`~/${cleaned}`);
    expect(vi.mocked(plan).mock.calls.at(-1)?.[2]?.(path.join(home, dirty))).toBe(`~/${cleaned}`);
    expect(d.tilde(path.join(home, dirty))).toBe(`~/${cleaned}`);
    // What the command read: a hooks file in such a folder, and the folder its files are kept in.
    expect(facts().hooks.wrong).toContain(`claude-code: not hooked (~/${cleaned}/settings.json)`);
    expect(facts().apart?.said).toBe(
      `This sessionpipe keeps its files in ~/${cleaned}, not in this computer's usual place (~/usual)`,
    );
    // The page it printed: the finding is one line, and no line carries anything a terminal acts on.
    expect(lines).toContain(`  ! the hooks: claude-code: not hooked (~/${cleaned}/settings.json)`);
    for (const l of lines) expect([...l].filter((ch) => ch.charCodeAt(0) < 32)).toEqual([]);
    // A step the run says, with a folder in it and an `error` line someone wrote into a version.
    let at = lines.length;
    d.say({ mark: "ok", text: `removed 1.0.0\nerror  no such ${ESC}[31mthing in ${path.join(home, dirty)}` });
    expect(lines.slice(at)).toEqual([`  ✓ removed 1.0.0 error  no such thing in ~/${cleaned}`]);
    // A step `update` says.
    vi.mocked(bringCurrent).mockResolvedValue({ state: "current", version: NEWEST, said: "ok" });
    await d.use(NEWEST, true);
    at = lines.length;
    handed().say({ mark: "info", text: `the hooks run\ntry    ${ESC}[36mcurl x | sh${ESC}[39m` });
    expect(lines.slice(at)).toEqual(["  · the hooks run try    curl x | sh"]);
    // The endings: what works, each warning, and a service that finishes by itself.
    const one = await ends({
      ...ONE,
      said: `one copy\n${ESC}[31merror${ESC}[39m  not really`,
      warn: [`a warning\ntry    ${ESC}[36mcurl x | sh${ESC}[39m`],
    });
    expect(one.lines.slice(-2)).toEqual(["✓ one copy error  not really", "! a warning try    curl x | sh"]);
    const waits = await ends({ state: "waiting", said: `busy\n${ESC}[32m✓ All good${ESC}[39m` });
    expect(waits.lines.at(-1)).toBe("! busy ✓ All good");
    process.exitCode = undefined;
    // At a terminal too: one green line and one yellow one, with no colour inside but their own.
    const term = await ends(
      { ...ONE, said: `one copy\n${ESC}[31merror${ESC}[39m  not really`, warn: [`a warning ${ESC}[31mred${ESC}[39m`] },
      { tty: true, columns: 200 },
    );
    // (Folding to a terminal sets one space between two words.)
    expect(term.lines.slice(-2)).toEqual([green("✓ one copy error not really"), yellow("! a warning red")]);
    // What is left, and what failed, are one line each as every refusal is.
    const left = await ends({ ...LEFT, still: `One other copy is still there: 1.0.0\nerror  x in /usr/local.` });
    expect(left.err).toHaveBeenCalledWith(
      `sessionpipe: One other copy is still there: 1.0.0 error  x in /usr/local. Next: ${SUDO}\n`,
    );
    const failed = await ends({
      state: "failed",
      error: `it stopped\n${ESC}[32m✓ fine${ESC}[39m`,
      next: "sessionpipe doctor",
    });
    expect(failed.err).toHaveBeenCalledWith("sessionpipe: it stopped ✓ fine. Next: sessionpipe doctor\n");
  });
});

describe.skipIf(process.platform === "win32")("sessionpipe reinstall: how a run ends", () => {
  it("one copy, in use everywhere: the steps as they happen, then one green line; exit 0", async () => {
    vi.mocked(look).mockReturnValue(two());
    vi.mocked(carryOut).mockImplementation(async (_p, d) => {
      d.say({ mark: "ok", text: `sessionpipe ${NEWEST} downloaded` });
      d.say({
        mark: "info",
        text: `a shell finds this copy first; behind it: ${path.join(home, "bin", "sessionpipe")}`,
      });
      d.say({ mark: "warn", text: `${path.join(home, "old")} could not be removed: EBUSY` });
      return ONE;
    });
    const r = await run({}, "reinstall", "--yes");
    expect(r.lines.slice(-6)).toEqual([
      "",
      "  ✓ sessionpipe 9.9.9 downloaded",
      // A step names a folder under the home as the page does.
      "  · a shell finds this copy first; behind it: ~/bin/sessionpipe",
      "  ! ~/old could not be removed: EBUSY",
      "",
      "✓ This computer has one sessionpipe: 9.9.9, in ~/.local. Pairings and settings are as they were.",
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(r.exit).not.toHaveBeenCalled();
    expect(r.err).not.toHaveBeenCalled();
    const term = await run({ tty: true, columns: 200 }, "reinstall", "--yes");
    expect(term.lines.slice(-2)).toEqual(["", green(`✓ ${ONE.said}`)]);
    expect(term.lines.at(-5)).toBe(`  ${ESC}[32m✓${ESC}[39m sessionpipe 9.9.9 downloaded`);
    expect(term.lines.at(-4)).toBe(
      `  ${ESC}[2m·${ESC}[22m a shell finds this copy first; behind it: ~/bin/sessionpipe`,
    );
  });

  it("one copy, and something left to say: what works in green, then a yellow line for each warning of the run and each note of the plan; exit 0", async () => {
    const warned: Done = {
      ...ONE,
      warn: [
        `Typing \`sessionpipe\` does not start the copy in ~/.local (it starts ${path.join(home, "bin", "sessionpipe")}).`,
      ],
    };
    const typing = "Typing `sessionpipe` does not start the copy in ~/.local (it starts ~/bin/sessionpipe).";
    const r = await ends(warned);
    expect(r.lines.slice(-3)).toEqual(["", `✓ ${ONE.said}`, `! ${typing}`]);
    expect(process.exitCode).toBeUndefined();
    // A note of the plan's alone is a yellow line too: said on the plan's screen, and
    // again when it is done. What works is green all the same. (Paired, and nothing here
    // runs the service: that is the plan's note.)
    paired();
    const noted = await ends(ONE);
    expect(noted.lines.slice(-3)).toEqual(["", `✓ ${ONE.said}`, `! ${NOTHING_STARTS_IT}`]);
    expect(noted.lines.filter((l) => l.includes("isn't running"))).toEqual([
      `  ! ${NOTHING_STARTS_IT}`,
      `! ${NOTHING_STARTS_IT}`,
    ]);
    // Both: the run's warnings first, in the order it gave them, then the plan's notes.
    const several: Done = { ...ONE, warn: [...warned.warn, "A receiver hasn't answered."] };
    const all = await ends(several);
    expect(all.lines.slice(-5)).toEqual([
      "",
      `✓ ${ONE.said}`,
      `! ${typing}`,
      "! A receiver hasn't answered.",
      `! ${NOTHING_STARTS_IT}`,
    ]);
    // At a terminal each is a line of its own in its colour, and no line is a `try`.
    const both = await ends(several, { tty: true, columns: 200 });
    expect(both.lines.slice(-6)).toEqual([
      "",
      green(`✓ ${ONE.said}`),
      yellow(`! ${typing}`),
      yellow("! A receiver hasn't answered."),
      // Longer than the 100 columns a line is set to: it goes on under its own words.
      yellow("! The background service isn't running, and nothing here starts it by itself:"),
      yellow("  `sessionpipe control run` does."),
    ]);
    // Folded to 80 columns, every line of a sentence is in that sentence's colour.
    const narrow = await ends(warned, { tty: true, columns: 80 });
    expect(narrow.lines.slice(-6)).toEqual([
      green("✓ This computer has one sessionpipe: 9.9.9, in ~/.local. Pairings and settings"),
      green("  are as they were."),
      yellow("! Typing `sessionpipe` does not start the copy in ~/.local (it starts"),
      yellow("  ~/bin/sessionpipe)."),
      yellow("! The background service isn't running, and nothing here starts it by itself:"),
      yellow("  `sessionpipe control run` does."),
    ]);
    for (const x of [r, noted, all, both, narrow]) {
      expect(x.exit).not.toHaveBeenCalled();
      expect(x.err).not.toHaveBeenCalled();
      expect(x.text).not.toMatch(/^(\S*try\S*) {4}/m);
    }
    expect(process.exitCode).toBeUndefined();
  });

  it("L10: a copy that is still there: what works in green on the page, then what is left as a refusal that is no error: `!` over one `try` line at a terminal, the single `sessionpipe: … Next: …` line in a pipe; exit 1", async () => {
    const still = "One other copy is still there: 1.0.0 in /usr/local (needs sudo)";
    const r = await ends(LEFT);
    // The page ends with what works. What is left is not a line of the page's.
    expect(r.lines.slice(-2)).toEqual(["", `✓ ${LEFT.said}`]);
    expect(r.text).not.toContain("still there");
    expect(r.text).not.toContain(SUDO);
    // No `try` line was printed by the command itself: such a line is a refusal's alone.
    expect(r.lines.filter((l) => /^\S*try\S* {4}/.test(l))).toEqual([]);
    // Into a pipe: the one line every refusal is, with the command to run at its end. A
    // script, an ssh session or an agent reads it as it reads any other.
    expect(r.err).toHaveBeenCalledTimes(1);
    const piped = String(r.err.mock.calls[0]?.[0]);
    expect(piped).toBe(`sessionpipe: ${still}. Next: ${SUDO}\n`);
    expect(piped.split("\n")).toHaveLength(2);
    expect(piped).not.toContain("error");
    // The job is not done, and a script can tell: 1, not the 0 of one copy nor the 3 of a
    // service that finishes by itself. It is the refusal that ends the process.
    expect(r.exit).toHaveBeenCalledTimes(1);
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(process.exitCode).toBeUndefined();
    // At a terminal: green, then under a yellow `!` (not a red `error`) what is left, and
    // the line to run alone on its own, dim word and the command in its colour.
    const term = await ends(LEFT, { tty: true, errTty: true, columns: 200 });
    expect(term.lines.slice(-2)).toEqual(["", green(`✓ ${LEFT.said}`)]);
    expect(term.err).toHaveBeenCalledTimes(1);
    expect(term.err).toHaveBeenCalledWith(
      `${yellow("!")}      ${still}\n${ESC}[2mtry${ESC}[22m    ${ESC}[36m${SUDO}${ESC}[39m\n`,
    );
    expect(String(term.err.mock.calls[0]?.[0])).not.toContain("error");
    expect(term.exit).toHaveBeenCalledWith(1);
    // Without colour the mark and the word say it.
    const mono = await run({ tty: true, errTty: true, columns: 200 }, "reinstall", "--yes", "--no-color");
    expect(mono.err).toHaveBeenCalledWith(`!      ${still}\ntry    ${SUDO}\n`);
    // A run that stopped is an error, said as one: the same two lines under the other word.
    const failed = await ends(
      { state: "failed", error: "the copy in ~/.local doesn't run as it should", next: "sessionpipe doctor" },
      { tty: true, errTty: true, columns: 200 },
    );
    expect(failed.err).toHaveBeenCalledWith(
      `${ESC}[31m${ESC}[1merror${ESC}[22m${ESC}[39m  the copy in ~/.local doesn't run as it should\n${ESC}[2mtry${ESC}[22m    ${ESC}[36msessionpipe doctor${ESC}[39m\n`,
    );
  });

  it("L10: a copy that is still there, and more to say: each warning and each note on its yellow line of the page, what is left last, over its line", async () => {
    paired();
    const warned: Done = {
      ...LEFT,
      warn: [
        `Typing \`sessionpipe\` does not start the copy in ~/.local (it starts ${path.join(home, "bin", "sessionpipe")}).`,
        "A receiver hasn't answered.",
      ],
    };
    const r = await ends(warned);
    expect(r.lines.slice(-5)).toEqual([
      "",
      `✓ ${LEFT.said}`,
      "! Typing `sessionpipe` does not start the copy in ~/.local (it starts ~/bin/sessionpipe).",
      "! A receiver hasn't answered.",
      `! ${NOTHING_STARTS_IT}`,
    ]);
    expect(r.err).toHaveBeenCalledWith(
      `sessionpipe: One other copy is still there: 1.0.0 in /usr/local (needs sudo). Next: ${SUDO}\n`,
    );
    expect(r.exit).toHaveBeenCalledWith(1);
    // Several copies, each with a line: the lines joined into one, never folded, though it
    // is longer than the terminal is wide; the sentence above it folds under its own words.
    const chained = `${SUDO} && sudo rm -r /opt/node/lib/node_modules/sessionpipe /opt/node/bin/sessionpipe`;
    const several: Done = {
      ...LEFT,
      still: `3 other copies are still there: 1.0.0 in /usr/local (needs sudo); 1.0.0 in /opt/node (needs sudo); ${path.join(slotOf(NVM()))} (EBUSY: resource busy or locked).`,
      next: chained,
    };
    const left =
      "3 other copies are still there: 1.0.0 in /usr/local (needs sudo); 1.0.0 in /opt/node (needs sudo); ~/.nvm/versions/node/v22.1.0/lib/node_modules/sessionpipe (EBUSY: resource busy or locked)";
    expect(chained.length).toBeGreaterThan(100);
    for (const columns of [80, 120]) {
      const term = await ends(several, { tty: true, errTty: true, columns });
      const lines = bare([String(term.err.mock.calls[0]?.[0])])[0]?.split("\n") as string[];
      expect(lines.slice(-2)).toEqual([`try    ${chained}`, ""]);
      const said = lines.slice(0, -2);
      expect(said.length).toBeGreaterThan(1);
      expect(said[0]?.startsWith("!      3 other copies are still there: ")).toBe(true);
      for (const l of said.slice(1)) expect(l).toMatch(/^ {7}\S/);
      for (const l of said) expect(l.length).toBeLessThanOrEqual(Math.min(columns - 1, 100));
      expect(said.map((l) => l.slice(7)).join(" ")).toBe(left);
      expect(term.exit).toHaveBeenCalledWith(1);
    }
    // In a pipe it is one line all the same, however long.
    const piped = await ends(several);
    expect(piped.err).toHaveBeenCalledWith(`sessionpipe: ${left}. Next: ${chained}\n`);
    // With no line for what is left, the command is this one again.
    const again = await ends({
      ...LEFT,
      still: "One other copy is still there: ~/old (EBUSY).",
      next: "sessionpipe reinstall",
    });
    expect(again.err).toHaveBeenCalledWith(
      "sessionpipe: One other copy is still there: ~/old (EBUSY). Next: sessionpipe reinstall\n",
    );
    expect(again.exit).toHaveBeenCalledWith(1);
  });

  it("the background service finishes by itself: said in yellow, exit 3", async () => {
    const said =
      "The background service is busy: a headless agent run. It restarts by itself onto sessionpipe 9.9.9 when that is done: nothing more to type.";
    const r = await ends({ state: "waiting", said });
    expect(r.lines.slice(-2)).toEqual(["", `! ${said}`]);
    expect(process.exitCode).toBe(3);
    expect(r.exit).not.toHaveBeenCalled();
    process.exitCode = undefined;
    const term = await ends({ state: "waiting", said }, { tty: true, columns: 200 });
    expect(term.lines.at(-1)?.startsWith(`${ESC}[33m${ESC}[1m`)).toBe(true);
    expect(process.exitCode).toBe(3);
  });

  it("it stopped: one line with what is wrong and the command to run next; exit 1", async () => {
    const failed: Done = {
      state: "failed",
      error: "sessionpipe 9.9.9 couldn't be downloaded from npm (npm error code E404). Nothing was changed",
      next: "sessionpipe reinstall",
    };
    const r = await ends(failed);
    expect(r.err).toHaveBeenCalledWith(
      "sessionpipe: sessionpipe 9.9.9 couldn't be downloaded from npm (npm error code E404). Nothing was changed. Next: sessionpipe reinstall\n",
    );
    expect(r.exit).toHaveBeenCalledWith(1);
    // No last line of its own: the failure is it. And no `try` line among what was printed.
    expect(r.lines.at(-1)).toBe("");
    expect(r.lines.filter((l) => l.startsWith("try"))).toEqual([]);
    const term = await ends(failed, { errTty: true, columns: 200 });
    expect(term.err).toHaveBeenCalledWith(
      expect.stringMatching(
        /error.* {2}sessionpipe 9\.9\.9 couldn't be downloaded.*\n.*try.* {4}.*sessionpipe reinstall.*\n$/,
      ),
    );
    // Any other command a failure names is the one to try, as it names it.
    const other = await ends(
      { ...failed, next: "npx -y sessionpipe@latest reinstall" },
      { errTty: true, columns: 200 },
    );
    expect(other.err).toHaveBeenCalledWith(
      expect.stringMatching(/try.* {4}.*npx -y sessionpipe@latest reinstall.*\n$/),
    );
  });
});

describe.skipIf(process.platform === "win32")("sessionpipe reinstall: every effect it hands the run", () => {
  it("says a step under its mark, and shows a path as the page does", async () => {
    const { d, lines } = await went();
    const at = lines.length;
    d.say({ mark: "ok", text: `removed sessionpipe 0.9.0 (${slotOf(NVM())})` });
    d.say({ mark: "info", text: "nothing to restart" });
    expect(lines.slice(at)).toEqual([
      "  ✓ removed sessionpipe 0.9.0 (~/.nvm/versions/node/v22.1.0/lib/node_modules/sessionpipe)",
      "  · nothing to restart",
    ]);
    expect(d.tilde(slotOf(LOCAL()))).toBe("~/.local/lib/node_modules/sessionpipe");
    expect(d.tilde("/usr/local")).toBe("/usr/local");
  });

  it("fetch: the release into npm's own cache, by this node's npm; why it couldn't, or nothing", async () => {
    const { d } = await went();
    expect(npmDo).not.toHaveBeenCalled();
    vi.mocked(npmDo).mockResolvedValueOnce(null);
    expect(await d.fetch(NEWEST)).toBeNull();
    expect(npmDo).toHaveBeenCalledTimes(1);
    expect(npmDo).toHaveBeenCalledWith(["cache", "add", `sessionpipe@${NEWEST}`], { node: process.execPath });
    vi.mocked(npmDo).mockResolvedValueOnce("npm error code ETARGET");
    expect(await d.fetch("9.9.10")).toBe("npm error code ETARGET");
    expect(npmDo).toHaveBeenLastCalledWith(["cache", "add", "sessionpipe@9.9.10"], { node: process.execPath });
  });

  it("L1: install: npm is handed the folder beside the slot that the run names, and the copy is checked in there; never the home's prefix; no hooks are written by it", async () => {
    const { d } = await went();
    // The run names a folder beside the slot (run.ts): `<prefix>/lib/node_modules/.sessionpipe-<id>`.
    const stage = path.join(path.dirname(slotOf(LOCAL())), `.sessionpipe-${d.id()}`);
    vi.mocked(installInto).mockResolvedValueOnce({ ok: true });
    expect(await d.install(stage, NEWEST)).toBeNull();
    expect(installInto).toHaveBeenCalledTimes(1);
    expect(installInto).toHaveBeenCalledWith(stage, NEWEST, {
      node: process.execPath,
      // The copy that is asked for its version is the one npm unpacked in that folder, as
      // npm lays a prefix out: the slot itself is not touched while npm works.
      distDir: path.join(stage, "lib", "node_modules", "sessionpipe", "dist"),
      harnesses: [],
    });
    const [prefix, , o] = vi.mocked(installInto).mock.calls[0] as Parameters<typeof installInto>;
    expect(prefix).not.toBe(LOCAL());
    expect(o.distDir).not.toBe(path.join(slotOf(LOCAL()), "dist"));
    expect(o.distDir.startsWith(`${stage}${path.sep}`)).toBe(true);
    vi.mocked(installInto).mockResolvedValueOnce({ ok: false, stage: "npm", error: "npm install: EACCES" });
    expect(await d.install(stage, NEWEST)).toBe("npm install: EACCES");
    vi.mocked(installInto).mockResolvedValueOnce({
      ok: false,
      stage: "verify",
      error: `npm finished, but the copy in ${stage} says nothing, not ${NEWEST}`,
    });
    expect(await d.install(stage, NEWEST)).toBe(`npm finished, but the copy in ${stage} says nothing, not ${NEWEST}`);
    // npm is asked for nothing else by it: no uninstall, nothing into the prefix itself.
    expect(npmDo).not.toHaveBeenCalled();
  });

  it("L1: the swap is the file system's own rename, and a folder beside the slot gets a name the proof knows", async () => {
    const { d } = await went();
    expect(d.exists).toBe(existsSync);
    // The only change to a folder this command makes itself: a rename, nothing copied.
    expect(d.rename).toBe(renameSync);
    const ids = [d.id(), d.id(), d.id()];
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}$/);
      // What ours.ts knows as npm's own leftover, and as a folder npm was told to install into.
      expect(ASIDE.test(`.sessionpipe-${id}`)).toBe(true);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it("asks the daemon over its socket: its status, what it sees, and to stop taking messages", async () => {
    const { d } = await went();
    expect(await d.status()).toBeNull();
    expect(await d.health()).toBeNull();
    expect(await d.quiesce()).toBeNull();
    const replies: Record<string, unknown> = {
      status: status("1.0.0", { mid_turn: ["claude-code:aaaa"] }),
      health: { op: "health", health: { accounts: [], copy: { cli: "/x/cli.js", via: null } } },
    };
    await daemon(replies);
    expect(await d.status()).toMatchObject({ version: "1.0.0", pid: 4242, mid_turn: ["claude-code:aaaa"] });
    expect((await d.health())?.copy).toEqual({ cli: "/x/cli.js", via: null });
    // One from before it knew the question says nothing; one that does says whether it paused.
    expect(await d.quiesce()).toBeNull();
    replies.quiesce = { op: "ok" };
    expect(await d.quiesce()).toBe(true);
    replies.quiesce = { op: "none" };
    expect(await d.quiesce()).toBe(false);
  });

  it("seed: who is mid-turn, left where the next service takes it", async () => {
    const { d } = await went();
    d.seed(["claude-code:aaaa", "codex:bbbb"]);
    expect(
      JSON.parse(readFileSync(path.join(process.env.SESSIONPIPE_STATE as string, "control", "turns-seed.json"), "utf8"))
        .sessions,
    ).toEqual(["claude-code:aaaa", "codex:bbbb"]);
  });

  it("stop: the signal a daemon stops cleanly on, to the process it was told; one that is gone already has stopped", async () => {
    const { d } = await went();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    d.stop(4242);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    // No such process, or not this user's to signal: not this command's failure. Whether
    // it still answers is what the run looks at next.
    for (const code of ["ESRCH", "EPERM"]) {
      kill.mockImplementationOnce(() => {
        throw Object.assign(new Error(`kill ${code}`), { code });
      });
      expect(() => d.stop(4243)).not.toThrow();
    }
    expect(kill).toHaveBeenCalledTimes(3);
  });

  it("no effect removes a service file or asks where the service lives: the run has neither to call", async () => {
    const { d } = await went();
    expect(Object.keys(d).sort()).toEqual(
      [
        "say",
        "tilde",
        "fetch",
        "install",
        "exists",
        "rename",
        "id",
        "status",
        "health",
        "quiesce",
        "seed",
        "stop",
        "use",
        "runningFrom",
        "same",
        "remove",
        "relink",
        "prove",
        "sleep",
        "now",
      ].sort(),
    );
    // One folder by whatever name: ours.ts's own.
    expect(d.same).toBe(same);
  });

  it("use: `update`'s own steps from the fresh copy, told it is installed, with the hooks written whatever they say", async () => {
    installLauncher({ distDir: realDist, node: process.execPath, version: "0.8.0" });
    put(process.env.SESSIONPIPE_CONFIG as string, { harnesses: { codex: { enabled: true } } });
    const { d } = await went();
    const outcome = { state: "current" as const, version: NEWEST, said: "ok" };
    vi.mocked(bringCurrent).mockResolvedValue(outcome);
    expect(await d.use(NEWEST, true)).toBe(outcome);
    expect(bringCurrent).toHaveBeenCalledTimes(1);
    const [deps, how] = vi.mocked(bringCurrent).mock.calls[0] as [CurrentDeps, { installed?: boolean }];
    // npm is not asked again: the newest release is what was just installed.
    expect(how).toEqual({ installed: true });
    expect(deps).toMatchObject({
      version: NEWEST,
      distDir: path.join(slotOf(LOCAL()), "dist"),
      platform: process.platform,
      harnesses: ["codex"],
      wanted: false,
      stale: null,
    });
    // The launcher says 0.8.0; here that is not asked: they are written again all the same.
    expect(deps.hooks()).toBeNull();
    deps.place();
    expect(placeService).toHaveBeenCalledWith({ node: deps.node, cli: deps.cli });
    expect(deps.cli).toBe(path.join(slotOf(LOCAL()), "dist", "cli.js"));
  });

  it("use: a service file that names a node or a copy that is gone is written again though its service answers", async () => {
    paired();
    const stale = async (s: ServiceState | null) => {
      vi.mocked(serviceSeen).mockReturnValue(s);
      const { d } = await went();
      vi.mocked(bringCurrent).mockResolvedValue({ state: "current", version: NEWEST, said: "ok" });
      await d.use(NEWEST, true);
      return handed().stale;
    };
    const cli = path.join(slotOf(LOCAL()), "dist", "cli.js");
    put(cli, "");
    expect(await stale(null)).toBeNull();
    expect(await stale(service())).toBeNull();
    expect(await stale(service({ argv: [path.join(tmp, "gone", "node"), cli] }))).toBe("what it names is gone");
    expect(await stale(service({ argv: [process.execPath, path.join(tmp, "gone", "cli.js")] }))).toBe(
      "what it names is gone",
    );
    expect(await stale(service({ argv: null }))).toBe("what it names is gone");
  });

  it("use: with no service file and no daemon nothing is started, and `update`'s 'isn't set up' is not said of a computer that wants one", async () => {
    const setUp = {
      mark: "info" as const,
      text: "the background service isn't set up on this computer: nothing to restart",
    };
    const hooks = { mark: "ok" as const, text: `the hooks run sessionpipe ${NEWEST} (codex)` };
    /** What `update`'s steps were handed, and what of their lines reached the page. */
    const used = async (serve: boolean) => {
      const { d, lines } = await went();
      vi.mocked(bringCurrent).mockResolvedValue({ state: "current", version: NEWEST, said: "ok" });
      await d.use(NEWEST, serve);
      const deps = handed();
      const at = lines.length;
      deps.say(hooks);
      deps.say(setUp);
      return { wanted: deps.wanted, said: lines.slice(at) };
    };
    // Nothing here needs a service: none is wanted, and saying so is true.
    expect(await used(false)).toEqual({ wanted: false, said: [`  ✓ ${hooks.text}`, `  · ${setUp.text}`] });
    expect(await used(true)).toEqual({ wanted: false, said: [`  ✓ ${hooks.text}`, `  · ${setUp.text}`] });
    // Paired, with nothing to move: `update` is told to leave the service be, and the one
    // line of its that would be untrue is dropped (the plan's own note says how to start it).
    paired();
    expect(await used(false)).toEqual({ wanted: false, said: [`  ✓ ${hooks.text}`] });
    // Paired, with a service to move: everything `update` does and says.
    expect(await used(true)).toEqual({ wanted: true, said: [`  ✓ ${hooks.text}`, `  · ${setUp.text}`] });
  });

  it("L9: runningFrom: the copy a daemon runs from by its own word, else the one the service file names, else nothing", async () => {
    const { d } = await went();
    // No daemon answers and there is no service file: it can't be told.
    expect(await d.runningFrom()).toBeNull();
    // The service file's copy, read afresh, whether or not its manager can be asked.
    vi.mocked(serviceSeen).mockReturnValue(service());
    expect(await d.runningFrom()).toBe(slotOf(LOCAL()));
    vi.mocked(serviceSeen).mockReturnValue(
      service({
        manager: null,
        argv: [process.execPath, path.join(slotOf(NVM()), "dist", "cli.js"), "control", "run"],
      }),
    );
    expect(await d.runningFrom()).toBe(slotOf(NVM()));
    vi.mocked(serviceSeen).mockReturnValue(service({ argv: null }));
    expect(await d.runningFrom()).toBeNull();
    vi.mocked(serviceSeen).mockReturnValue(service({ argv: [process.execPath] }));
    expect(await d.runningFrom()).toBeNull();
    // A daemon from before 0.15, run by hand: it answers and names no copy. With no
    // service file either nothing says where it runs from, and the run removes no copy.
    const replies: Record<string, unknown> = {
      status: status("0.14.2"),
      health: { op: "health", health: { accounts: [] } },
    };
    await daemon(replies);
    vi.mocked(serviceSeen).mockReturnValue(null);
    expect(await d.runningFrom()).toBeNull();
    // One that says where it runs from: its own word, two folders above its cli.js, and
    // before the service file's (which may name another copy by now).
    const stray = path.join(home, ".npm-global", "lib", "node_modules", "sessionpipe");
    replies.health = {
      op: "health",
      health: { accounts: [], copy: { cli: path.join(stray, "dist", "cli.js"), via: null } },
    };
    expect(await d.runningFrom()).toBe(stray);
    vi.mocked(serviceSeen).mockReturnValue(service());
    expect(await d.runningFrom()).toBe(stray);
  });

  it("M2: remove: ours.ts's one removal, with the reach, the prefixes and the npx cache of the look, and the home's slot as what is never removed; npm is not asked", async () => {
    const { d } = await went();
    expect(remove).not.toHaveBeenCalled();
    const gone = [slotOf(NVM()), binOf(NVM())];
    vi.mocked(remove).mockReturnValue(gone);
    expect(await d.remove(slotOf(NVM()))).toBe(gone);
    expect(remove).toHaveBeenCalledTimes(1);
    const [what, o] = vi.mocked(remove).mock.calls[0] as Parameters<typeof remove>;
    // The path handed to the removal is the one asked for, inside this test's home; and
    // what may be removed is decided there, from the same reach the look had.
    expect(what).toBe(slotOf(NVM()));
    expect(what.startsWith(`${home}${path.sep}`)).toBe(true);
    // M1: `keep` is the slot the fresh copy is in: by whatever name a step asks for it,
    // ours.ts refuses to remove it. Nothing else is handed over: no npm, no "alone".
    expect(o).toEqual({ reach: home, prefixes: [LOCAL(), NVM()], npx: NPX(), keep: [slotOf(LOCAL())] });
    // Every removal of a run is told the same.
    await d.remove(path.join(path.dirname(slotOf(LOCAL())), ".sessionpipe-0a1b2c3d"));
    expect(vi.mocked(remove).mock.calls[1]?.[1]).toBe(o);
    // npm was asked nothing: it would take whatever is at the prefix's command path.
    expect(npmDo).not.toHaveBeenCalled();
    expect(execCapture).toHaveBeenCalledTimes(1);
    // What the removal refuses, or could only do in part, is the run's to hear: a promise that fails.
    vi.mocked(remove).mockImplementationOnce(() => {
      throw new Error("it was left alone");
    });
    const refused = d.remove(path.join(home, "project", "node_modules", "sessionpipe"));
    expect(refused).toBeInstanceOf(Promise);
    await expect(refused).rejects.toThrow("it was left alone");
  });

  it("a look that reached everything, or another home, hands the removal that: the proof is taken from the same look", async () => {
    const { d } = await went(two({ reach: true, prefixes: [], npx: "/nowhere/_npx" }));
    vi.mocked(remove).mockReturnValue([]);
    await d.remove(slotOf(NVM()));
    expect(vi.mocked(remove).mock.calls[0]?.[1]).toEqual({
      reach: true,
      prefixes: [],
      npx: "/nowhere/_npx",
      keep: [slotOf(LOCAL())],
    });
    // The home is the plan's: where the one you type is.
    const other = two({
      copies: [copy(NVM(), { version: "1.0.0", uses: ["typed", "this"] }), copy(LOCAL(), { version: "0.9.0" })],
      onPath: [{ file: binOf(NVM()), dir: slotOf(NVM()) }],
      typed: slotOf(NVM()),
      home: home0({ prefix: NVM(), shown: "~/.nvm/versions/node/v22.1.0", bin: path.join(NVM(), "bin") }),
    });
    const there = await went(other);
    await there.d.remove(slotOf(LOCAL()));
    expect(vi.mocked(remove).mock.calls.at(-1)?.[1]).toMatchObject({ keep: [slotOf(NVM())] });
  });

  it("L2: relink: npm's own link made where it is not there, its folder with it, in npm's words; never over anything that is there", async () => {
    const { d } = await went();
    // A prefix with no bin folder yet (the fresh copy was swapped into a prefix that never
    // had one): the folder is made, and the link in it.
    expect(existsSync(path.join(LOCAL(), "bin"))).toBe(false);
    expect(d.relink(LOCAL())).toBe(true);
    expect(lstatSync(binOf(LOCAL())).isSymbolicLink()).toBe(true);
    expect(readlinkSync(binOf(LOCAL()))).toBe(path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"));
    // There already: left as it is.
    expect(d.relink(LOCAL())).toBe(true);
    expect(readdirSync(path.join(LOCAL(), "bin"))).toEqual(["sessionpipe"]);
    // A link that leads to another copy is not this one's, and is not written over.
    mkdirSync(path.join(NVM(), "bin"), { recursive: true });
    const other = path.join(tmp, "other", "lib", "node_modules", "sessionpipe", "dist", "cli.js");
    symlinkSync(other, binOf(NVM()));
    expect(d.relink(NVM())).toBe(false);
    expect(readlinkSync(binOf(NVM()))).toBe(other);
    // Nor is a link of someone's own to somewhere that is no sessionpipe.
    const linked = path.join(home, "linked");
    mkdirSync(path.join(linked, "bin"), { recursive: true });
    symlinkSync("/usr/bin/true", path.join(linked, "bin", "sessionpipe"));
    expect(d.relink(linked)).toBe(false);
    expect(readlinkSync(path.join(linked, "bin", "sessionpipe"))).toBe("/usr/bin/true");
    // Nor is a file someone put there under that name.
    const own = path.join(home, "own");
    put(path.join(own, "bin", "sessionpipe"), "#!/bin/sh\n");
    expect(d.relink(own)).toBe(false);
    expect(readFileSync(path.join(own, "bin", "sessionpipe"), "utf8")).toBe("#!/bin/sh\n");
    // npm's link to this very copy, written by another name of its folder (an absolute
    // path through a link to the prefix): it leads there, so it is there, and is left.
    const real = path.join(home, "real");
    mkdirSync(slotOf(real), { recursive: true });
    mkdirSync(path.join(real, "bin"));
    symlinkSync(real, path.join(home, "real-too"));
    const byOtherName = path.join(slotOf(path.join(home, "real-too")), "dist", "cli.js");
    symlinkSync(byOtherName, binOf(real));
    expect(d.relink(real)).toBe(true);
    expect(readlinkSync(binOf(real))).toBe(byOtherName);
    // A prefix whose `bin` is a file: no folder can be made, and nothing is said to be there.
    const flat = path.join(home, "flat");
    put(path.join(flat, "bin"), "not a folder\n");
    expect(d.relink(flat)).toBe(false);
    expect(readFileSync(path.join(flat, "bin"), "utf8")).toBe("not a folder\n");
  });

  it("M1: prove: the copy in the home run through npm's own link, whether typing starts it, what a shell finds, and who still names what was removed", async () => {
    put(process.env.SESSIONPIPE_CONFIG as string, { harnesses: { "claude-code": { enabled: true } } });
    paired();
    const plist = service().file as string;
    const gone = [slotOf(NVM()), binOf(NVM())];
    put(plist, `<string>${path.join(slotOf(NVM()), "dist", "cli.js")}</string>`);
    put(path.join(home, ".claude", "settings.json"), { hooks: `${binOf(NVM())} hook` });
    vi.mocked(serviceSeen).mockReturnValue(service());
    const { d } = await went();
    const fresh = path.join(slotOf(LOCAL()), "dist", "cli.js");
    const elsewhere = path.join(home, "bin", "sessionpipe");
    vi.mocked(look).mockClear();
    vi.mocked(look).mockReturnValue(
      two({
        onPath: [
          { file: binOf(LOCAL()), dir: slotOf(LOCAL()) },
          { file: elsewhere, dir: null },
        ],
      }),
    );
    vi.mocked(spawnSync).mockImplementation(((_cmd: string, argv: string[]) =>
      argv[0] === fresh && argv[1] === "--version"
        ? { status: 0, stdout: `${NEWEST}\n`, stderr: "" }
        : { status: 1, stdout: "", stderr: "" }) as never);
    // No link leads to the copy in the home yet: it is not run by any other way.
    expect((await d.prove(gone)).runs).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
    link(LOCAL());
    expect(await d.prove(gone)).toEqual({
      runs: NEWEST,
      typed: true,
      onPath: [binOf(LOCAL()), elsewhere],
      named: [
        { file: plist, path: slotOf(NVM()) },
        { file: path.join(home, ".claude", "settings.json"), path: binOf(NVM()) },
      ],
    });
    // The one copy this asks for its version is the one in the home, by this node.
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(process.execPath, [fresh, "--version"], expect.anything());
    // M4: the look is taken again for it as it was before the run (npm's prefix, the
    // service file as it is now), and it is handed no way to run anything.
    expect(looked()).toEqual({
      env: process.env,
      home,
      reach: home,
      execPath: process.execPath,
      distDir: realDist,
      started: STARTED(),
      npmPrefix: path.join(home, ".npm-global"),
      serviceCli: fresh,
      hooksVersion: null,
      tilde: expect.any(Function),
    });
    expect("runs" in looked()).toBe(false);
    // Nothing was removed: nothing can name it. A hooks file that isn't there names nothing.
    rmSync(path.join(home, ".claude", "settings.json"));
    expect((await d.prove([])).named).toEqual([]);
    expect((await d.prove(gone)).named).toEqual([{ file: plist, path: slotOf(NVM()) }]);
    // A service file whose manager can't be asked is read all the same.
    vi.mocked(serviceSeen).mockReturnValue(service({ manager: null }));
    expect((await d.prove(gone)).named).toEqual([{ file: plist, path: slotOf(NVM()) }]);
    expect(looked().serviceCli).toBe(fresh);
    // No service file to read.
    vi.mocked(serviceSeen).mockReturnValue(null);
    expect((await d.prove(gone)).named).toEqual([]);
    expect(looked().serviceCli).toBeNull();
  });

  it("M1: prove: typing starts the copy in the home where the look says so, by whatever name it has for that folder", async () => {
    const slot = slotOf(LOCAL());
    mkdirSync(slot, { recursive: true });
    const { d } = await went();
    link(LOCAL());
    const typed = async (inv: Partial<Inventory>) => {
      vi.mocked(look).mockReturnValue(two(inv));
      const p = await d.prove([]);
      return { typed: p.typed, onPath: p.onPath };
    };
    const mine = { file: binOf(LOCAL()), dir: slot };
    const theirs = { file: binOf(NVM()), dir: slotOf(NVM()) };
    const stranger = { file: path.join(home, "bin", "sessionpipe"), dir: null };
    expect(await typed({ onPath: [mine], typed: slot })).toEqual({ typed: true, onPath: [mine.file] });
    // Another copy is first: that is what is typed.
    expect(await typed({ onPath: [theirs, mine], typed: theirs.dir })).toEqual({
      typed: false,
      onPath: [theirs.file, mine.file],
    });
    // A file of someone's first, which starts this copy (this command was started through it).
    expect(await typed({ onPath: [stranger, mine], typed: slot })).toEqual({
      typed: true,
      onPath: [stranger.file, mine.file],
    });
    // The same file, and it can't be told what it starts; and nothing on PATH at all.
    expect(await typed({ onPath: [stranger, mine], typed: null, unsure: stranger.file })).toEqual({
      typed: false,
      onPath: [stranger.file, mine.file],
    });
    expect(await typed({ onPath: [], typed: null })).toEqual({ typed: false, onPath: [] });
    // The folder under another name (a link to the prefix): one folder, so it is typed.
    const also = path.join(home, "also");
    symlinkSync(LOCAL(), also);
    expect((await typed({ onPath: [mine], typed: slotOf(also) })).typed).toBe(true);
    // A folder that only looks alike is another folder.
    mkdirSync(slotOf(NVM()), { recursive: true });
    expect((await typed({ onPath: [mine], typed: slotOf(NVM()) })).typed).toBe(false);
  });

  it("prove and relink, run from inside the home's own package folder: no link is still no link", async () => {
    // An empty path resolves to the folder a command is run in: compared with the slot
    // as if it were where a link leads, it said yes to every question from in there.
    const slot = slotOf(LOCAL());
    mkdirSync(slot, { recursive: true });
    const { d } = await went();
    vi.mocked(look).mockReturnValue(two({ onPath: [], typed: null }));
    vi.mocked(spawnSync).mockImplementation((() => ({ status: 0, stdout: `${NEWEST}\n`, stderr: "" })) as never);
    const was = process.cwd();
    process.chdir(slot);
    try {
      expect(await d.prove([])).toEqual({ runs: null, typed: false, onPath: [], named: [] });
      // A file of someone's where the link goes: nothing is made over it, and none is said to be there.
      put(binOf(LOCAL()), "#!/bin/sh\n");
      expect(d.relink(LOCAL())).toBe(false);
      expect((await d.prove([])).runs).toBeNull();
      expect(readFileSync(binOf(LOCAL()), "utf8")).toBe("#!/bin/sh\n");
    } finally {
      process.chdir(was);
    }
  });

  it("waits by the clock it is given", async () => {
    const { d } = await went();
    vi.useFakeTimers();
    let woke = false;
    const slept = d.sleep(500).then(() => {
      woke = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await slept;
    expect(woke).toBe(true);
    const t0 = Date.parse("2026-11-12T10:00:00.000Z");
    vi.setSystemTime(t0);
    expect(d.now()).toBe(t0);
    // The waits themselves are the run's own: none is set here.
    expect(d.settleMs).toBeUndefined();
    expect(d.stopMs).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("doctor and status: the copies of sessionpipe on this computer", () => {
  const REPAIR =
    "  If `sessionpipe` itself stops working, this repairs it from scratch: `npx -y sessionpipe@latest reinstall`";
  /** Doctor's "To fix", from its heading on. */
  const fix = (r: { lines: string[] }): string[] =>
    r.lines.includes("To fix") ? r.lines.slice(r.lines.indexOf("To fix")) : [];
  /** What the row says, whatever the width of the labels beside it. */
  const row = (r: { lines: string[] }): string | undefined =>
    r.lines.map((l) => /^ {2}(.) copies +(.*)$/.exec(l)).find(Boolean)?.[2];
  const json = async () => JSON.parse((await run({}, "doctor", "--json")).text);
  beforeEach(() => {
    // Each of the hook's eight timed runs takes one millisecond by this clock.
    let tick = 0n;
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => {
      tick += 1_000_000n;
      return tick;
    });
  });

  it("one clean copy: no row, nothing to fix, and no closing line; the JSON lists it", async () => {
    vi.mocked(look).mockReturnValue(one());
    const r = await run({}, "doctor");
    expect(r.lines[0]).toBe("✓ All good");
    expect(row(r)).toBeUndefined();
    expect(fix(r)).toEqual([]);
    // The way back in is said only where there is something to fix.
    expect(r.lines).not.toContain(REPAIR);
    expect(r.text).not.toContain("reinstall");
    expect(process.exitCode).toBeUndefined();
    const j = await json();
    // For a program: whether each is whole, as far as reading it tells. Nothing was run to say so.
    expect(j.copies).toEqual([{ dir: slotOf(LOCAL()), version: NEWEST, whole: true, uses: ["typed", "this"] }]);
    expect("runs" in j.copies[0]).toBe(false);
    expect(j.warnings).toEqual([]);
    expect((await run({}, "status")).lines[0]).toBe("✓ All good");
  });

  it("two copies: one row that says where each is and what uses it, and one thing to run: reinstall; exit 1", async () => {
    vi.mocked(look).mockReturnValue(two());
    const r = await run({}, "doctor");
    expect(r.lines[0]).toBe("! 1 thing needs attention");
    expect(r.lines).toContain(
      "  ! copies              1.0.0 in ~/.local (you type this); 0.9.0 in ~/.nvm/versions/node/v22.1.0 (nothing uses it)",
    );
    expect(fix(r)).toEqual([
      "To fix",
      "  1. 2 copies of sessionpipe are on this computer, and one is enough. One command puts it right:",
      "       sessionpipe reinstall",
      "",
      REPAIR,
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    // A program reads the same: every install, and one warning that names the command.
    const j = await json();
    expect(j.copies).toEqual([
      { dir: slotOf(LOCAL()), version: "1.0.0", whole: true, uses: ["typed", "this"] },
      { dir: slotOf(NVM()), version: "0.9.0", whole: true, uses: [] },
    ]);
    expect(j.warnings).toEqual([
      `2 copies of sessionpipe are on this computer (1.0.0 in ${slotOf(LOCAL())}; 0.9.0 in ${slotOf(NVM())}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    // `status` says it in its one line, and counts it.
    const brief = await run({}, "status");
    expect(brief.lines[0]).toBe("! 1 thing needs attention");
    expect(brief.text).toContain(
      "copies: 1.0.0 in ~/.local (you type this); 0.9.0 in ~/.nvm/versions/node/v22.1.0 (nothing uses it)",
    );
    expect(brief.lines.at(-1)).toBe("  `sessionpipe doctor` says what to do about it.");
  });

  it("which copy is used by what, in the words `reinstall` has for it: typed, the service, the hooks, this command, or nothing", async () => {
    const used = async (...copies: Copy[]) => {
      vi.mocked(look).mockReturnValue(inventory({ copies }));
      return row(await run({}, "doctor"));
    };
    expect(
      await used(
        copy(LOCAL(), { uses: ["typed"] }),
        copy(NVM(), { version: "0.9.0", uses: ["service"] }),
        copy(path.join(home, ".npm-global"), { where: "~/.npm-global", version: "0.8.0", uses: ["hooks"] }),
        copy(path.join(home, ".fnm"), { where: "~/.fnm", version: "0.7.5", uses: ["this"] }),
        copy(path.join(home, ".old"), { where: "~/.old", version: "0.7.0", uses: [] }),
      ),
    ).toBe(
      "9.9.9 in ~/.local (you type this); 0.9.0 in ~/.nvm/versions/node/v22.1.0 (the background service); 0.8.0 in ~/.npm-global (the hooks); 0.7.5 in ~/.fnm (this command); 0.7.0 in ~/.old (nothing uses it)",
    );
    // Every use of a copy is said, not only the first; "this command" only of one nobody types.
    expect(
      await used(
        copy(LOCAL(), { uses: ["typed", "service", "this"] }),
        copy(NVM(), { version: "0.9.0", uses: ["service", "this", "hooks"] }),
      ),
    ).toBe(
      "9.9.9 in ~/.local (you type this, the background service); 0.9.0 in ~/.nvm/versions/node/v22.1.0 (the background service, this command, the hooks)",
    );
    // The same words as the table `reinstall` prints of the same look.
    const table = (await run({}, "reinstall", "--dry-run")).lines.slice(1, 3);
    expect(table).toEqual([
      "  · 9.9.9  ~/.local                      you type this, the background service",
      "  · 0.9.0  ~/.nvm/versions/node/v22.1.0  the background service, this command, the hooks",
    ]);
  });

  it("with the versions apart as well it is still one thing to run, and that is reinstall: never update beside it", async () => {
    paired();
    put(process.env.SESSIONPIPE_CONFIG as string, { harnesses: { "claude-code": { enabled: true } } });
    installLauncher({ distDir: realDist, node: process.execPath, version: "0.8.0" });
    const other = path.join(slotOf(NVM()), "dist", "cli.js");
    vi.mocked(serviceLook).mockReturnValue(service({ argv: [process.execPath, other, "control", "run"] }));
    vi.mocked(look).mockReturnValue(
      inventory({
        copies: [copy(LOCAL(), { uses: ["typed", "this"] }), copy(NVM(), { version: "0.9.0", uses: ["service"] })],
      }),
    );
    await daemon({ status: status("0.9.0") });
    const r = await run({}, "doctor");
    const todo = fix(r).join("\n");
    // The fix is said by the number of copies alone: which release runs where is in the
    // rows above it, and is not said a second time.
    expect(fix(r).slice(0, 3)).toEqual([
      "To fix",
      "  1. 2 copies of sessionpipe are on this computer, and one is enough. One command puts it right:",
      "       sessionpipe reinstall",
    ]);
    expect(todo).not.toContain("This command is sessionpipe");
    expect(todo).not.toMatch(/runs 0\.9\.0|run 0\.8\.0/);
    const above = r.lines.slice(0, r.lines.indexOf("To fix")).join("\n");
    expect(above).toMatch(
      /^ {2}! background service +running sessionpipe 0\.9\.0 from another copy, in ~\/\.nvm\/versions\/node\/v22\.1\.0$/m,
    );
    expect(above).toContain(`run sessionpipe 0.8.0, and this command is ${VERSION}`);
    expect(row(r)).toBe(
      "9.9.9 in ~/.local (you type this); 0.9.0 in ~/.nvm/versions/node/v22.1.0 (the background service)",
    );
    // One item for all of it: `update` would leave the second copy where it is.
    expect(todo).not.toContain("sessionpipe update");
    expect(todo.match(/sessionpipe reinstall$/gm)).toHaveLength(1);
    expect(process.exitCode).toBe(1);
    // The look was handed the service file's own copy: the manager is asked once, for both.
    expect(looked().serviceCli).toBe(other);
    expect(serviceLook).toHaveBeenCalledTimes(1);
    // With one copy and the same releases apart there is no row of copies to say it, and
    // the fix is `update`: there the sentence still says which release runs where.
    vi.mocked(look).mockReturnValue(inventory({ copies: [copy(LOCAL(), { uses: ["typed", "this"] })] }));
    const apart = await run({}, "doctor");
    expect(row(apart)).toBeUndefined();
    expect(fix(apart).slice(0, 3)).toEqual([
      "To fix",
      `  1. This command is sessionpipe ${VERSION}, and the background service runs 0.9.0 from another copy (in ~/.nvm/versions/node/v22.1.0), and the hooks run 0.8.0. One command puts it right:`,
      "       sessionpipe update",
    ]);
    expect(fix(apart).join("\n")).not.toContain("sessionpipe reinstall\n");
  });

  it("a service that isn't running and a second copy: one item, reinstall", async () => {
    paired();
    vi.mocked(serviceLook).mockReturnValue(service({ loaded: false, pid: null }));
    vi.mocked(look).mockReturnValue(two());
    const r = await run({}, "doctor");
    expect(fix(r).slice(0, 3)).toEqual([
      "To fix",
      "  1. The background service isn't running, so no message reaches this computer. 2 copies of sessionpipe are on this computer, and one is enough. One command puts it right:",
      "       sessionpipe reinstall",
    ]);
    expect(fix(r).join("\n")).not.toContain("sessionpipe update");
  });

  it("one copy that is not whole, or a link to one that is gone: said as that, with the same one command", async () => {
    const broken = "its dist/cli.js is missing (an install that was cut off?)";
    vi.mocked(look).mockReturnValue(one({ copies: [copy(LOCAL(), { wrong: broken, uses: ["typed", "this"] })] }));
    const cut = await run({}, "doctor");
    // What is wrong with it is said in place of what uses it.
    expect(row(cut)).toBe(`9.9.9 in ~/.local (${broken})`);
    expect(fix(cut).slice(0, 3)).toEqual([
      "To fix",
      "  1. The copy of sessionpipe on this computer is not whole. One command puts it right:",
      "       sessionpipe reinstall",
    ]);
    expect(fix(cut).at(-1)).toBe(REPAIR);
    // A program is told what is wrong with the one copy, not that there are "1 copies".
    const cutJson = await json();
    expect(cutJson.warnings).toEqual([
      `the copy of sessionpipe on this computer is not whole (9.9.9 in ${slotOf(LOCAL())}: ${broken}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    expect(cutJson.copies).toEqual([{ dir: slotOf(LOCAL()), version: NEWEST, whole: false, uses: ["typed", "this"] }]);
    // A folder an install left behind, alone: it has a name of its own, not a release's.
    const aside = path.join(LOCAL(), "lib", "node_modules", ".sessionpipe-Ab12Cd34");
    const leftover = copy(LOCAL(), {
      dir: aside,
      aside: true,
      wrong: "left behind by an install that was cut off",
      bins: [],
    });
    vi.mocked(look).mockReturnValue(inventory({ copies: [leftover] }));
    expect(row(await run({}, "doctor"))).toBe("a leftover in ~/.local (left behind by an install that was cut off)");
    expect((await json()).warnings).toEqual([
      `the copy of sessionpipe on this computer is not whole (a leftover in ${aside}: left behind by an install that was cut off); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    // A clean copy, and a link somewhere that leads to one that is gone.
    const link = path.join(home, "bin", "sessionpipe");
    vi.mocked(look).mockReturnValue(one({ dangling: [link] }));
    const dangling = await run({}, "doctor");
    expect(row(dangling)).toBe("9.9.9 in ~/.local (you type this); ~/bin/sessionpipe, a link to one that is gone");
    expect(fix(dangling)[1]).toBe(
      "  1. The copy of sessionpipe on this computer is not whole. One command puts it right:",
    );
    expect(fix(dangling)[2]).toBe("       sessionpipe reinstall");
    expect((await json()).warnings).toEqual([
      `the copy of sessionpipe on this computer is not whole (${link} is a link to one that is gone); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    // No install at all (this command runs from a checkout), and such a link.
    vi.mocked(look).mockReturnValue(inventory({ dangling: [link] }));
    expect(row(await run({}, "doctor"))).toBe("~/bin/sessionpipe, a link to one that is gone");
    const none = await json();
    expect(none.copies).toEqual([]);
    expect(none.warnings).toEqual([
      `the copy of sessionpipe on this computer is not whole (${link} is a link to one that is gone); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
  });

  it("npm's leftover beside the copy is a second thing in the slot: a leftover, by that name", async () => {
    const aside = path.join(LOCAL(), "lib", "node_modules", ".sessionpipe-Ab12Cd34");
    vi.mocked(look).mockReturnValue(
      one({
        copies: [
          copy(LOCAL(), { uses: ["typed", "this"] }),
          copy(LOCAL(), {
            dir: aside,
            aside: true,
            version: "0.9.0",
            wrong: "left behind by an install that was cut off",
            bins: [],
          }),
        ],
      }),
    );
    const r = await run({}, "doctor");
    expect(row(r)).toBe(
      "9.9.9 in ~/.local (you type this); a leftover in ~/.local (left behind by an install that was cut off)",
    );
    expect(fix(r)[1]).toBe(
      "  1. 2 copies of sessionpipe are on this computer, and one is enough. One command puts it right:",
    );
    // To a program it is a leftover too, by its folder; and it is not whole.
    const j = await json();
    expect(j.warnings).toEqual([
      `2 copies of sessionpipe are on this computer (9.9.9 in ${slotOf(LOCAL())}; a leftover in ${aside}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    expect(j.copies.map((c: { whole: boolean }) => c.whole)).toEqual([true, false]);
    // Of two, the one that is not whole is said by what is wrong with it; the count is what is to fix.
    vi.mocked(look).mockReturnValue(
      two({
        copies: [
          copy(LOCAL(), { uses: ["typed", "this"] }),
          copy(NVM(), { version: "0.9.0", bins: [], wrong: "npm's link to it is gone" }),
        ],
      }),
    );
    expect(row(await run({}, "doctor"))).toBe(
      "9.9.9 in ~/.local (you type this); 0.9.0 in ~/.nvm/versions/node/v22.1.0 (npm's link to it is gone)",
    );
    expect((await json()).warnings).toEqual([
      `2 copies of sessionpipe are on this computer (9.9.9 in ${slotOf(LOCAL())}; 0.9.0 in ${slotOf(NVM())}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
  });

  it("what is no install of it, and what npx keeps in its cache for itself, is no second copy", async () => {
    const volta = copy(path.join(home, ".volta"), {
      slot: null,
      not: "Volta keeps it",
      keeper: "volta uninstall sessionpipe",
    });
    // The entry `npx sessionpipe …` once left, and the one this very command runs from.
    vi.mocked(look).mockReturnValue(
      one({
        copies: [
          copy(LOCAL(), { uses: ["typed"] }),
          checkout({ uses: ["this"] }),
          volta,
          npxEntry("0a1b2c3d4e5f6a7b"),
          npxEntry("ffffffffffffffff", { uses: ["this"] }),
        ],
      }),
    );
    const r = await run({}, "doctor");
    expect(r.lines[0]).toBe("✓ All good");
    expect(row(r)).toBeUndefined();
    const j = await json();
    expect(j.copies).toEqual([{ dir: slotOf(LOCAL()), version: NEWEST, whole: true, uses: ["typed"] }]);
    expect(j.warnings).toEqual([]);
    // An npx entry that something runs from is a copy like any other.
    const used = npxEntry("0a1b2c3d4e5f6a7b", { version: "0.9.0", uses: ["service"] });
    vi.mocked(look).mockReturnValue(one({ copies: [copy(LOCAL(), { uses: ["typed"] }), used] }));
    const second = await run({}, "doctor");
    expect(row(second)).toBe(
      "9.9.9 in ~/.local (you type this); 0.9.0 in ~/.npm/_npx/0a1b2c3d4e5f6a7b (the background service)",
    );
    expect(fix(second)[2]).toBe("       sessionpipe reinstall");
    // And so is one that wrote the hooks, or that is typed.
    for (const uses of [["hooks"], ["typed", "this"]] as const) {
      vi.mocked(look).mockReturnValue(
        one({ copies: [copy(LOCAL()), npxEntry("0a1b2c3d4e5f6a7b", { uses: [...uses] })] }),
      );
      expect((await json()).copies).toHaveLength(2);
    }
  });

  /** Who launchd names for the service (the daemon that answers is pid 4242), what that
   *  daemon answers of who started it (`via`: null for someone by hand; no word: one from
   *  before 0.15), and whether that is two daemons. */
  const TWO: [string, number | null, { via: string | null } | null, boolean][] = [
    ["launchd names the daemon, which says launchd started it", 4242, { via: "launchd" }, false],
    ["launchd names the daemon, which doesn't say", 4242, null, false],
    ["launchd names the daemon, which says it was started by hand", 4242, { via: null }, false],
    ["launchd names another process, and the daemon says it was started by hand", 100, { via: null }, true],
    ["launchd names another process, and the daemon says a supervisor started it", 100, { via: "supervisor" }, false],
    ["launchd names another process, and the daemon doesn't say", 100, null, true],
    ["launchd names no process, and the daemon says it was started by hand", null, { via: null }, true],
    ["launchd names no process, and the daemon says launchd started it", null, { via: "launchd" }, false],
    ["launchd names no process, and the daemon doesn't say", null, null, false],
  ];

  it.each(TWO)("two daemons, for doctor and for reinstall alike: %s", async (_said, pid, word, two) => {
    // One definition (plan.ts `twins`) for both. They read "launchd names no process"
    // apart once: doctor named `sessionpipe reinstall`, and reinstall answered "Nothing
    // to repair" under its own "Also found: a daemon someone started by hand…".
    paired();
    put(path.join(slotOf(LOCAL()), "dist", "cli.js"), "");
    vi.mocked(latestVersion).mockResolvedValue(VERSION);
    vi.mocked(look).mockReturnValue(
      one({ copies: [copy(LOCAL(), { version: VERSION, uses: ["typed", "service", "this"] })] }),
    );
    const state = service({ pid });
    vi.mocked(serviceLook).mockReturnValue(state);
    vi.mocked(serviceSeen).mockReturnValue(state);
    await daemon({
      status: status(VERSION),
      health: { op: "health", health: { accounts: [], ...(word ? { copy: { cli: "/x/cli.js", ...word } } : {}) } },
    });
    const doctor = await run({}, "doctor");
    const doctored = process.exitCode;
    process.exitCode = undefined;
    const warnings = (JSON.parse((await run({}, "doctor", "--json")).text) as { warnings: string[] }).warnings;
    process.exitCode = undefined;
    const dry = await run({}, "reinstall", "--dry-run");
    const ALSO = "  ! a daemon someone started by hand (pid 4242) holds the socket the service needs";
    const STOP = "  ~ stop     the daemon started by hand (pid 4242), once it holds nothing";
    if (two) {
      // Doctor: the row, the warning, and `reinstall` as the one command.
      expect(doctor.text).toMatch(
        /^ {2}! background service {2,}a daemon someone started by hand \(pid 4242\) answers, and holds the socket the service needs$/m,
      );
      expect(fix(doctor).join("\n")).toContain(
        "A daemon someone started by hand holds the socket the background service needs. One command puts it right:\n       sessionpipe reinstall",
      );
      expect(doctored).toBe(1);
      expect(warnings.filter((w) => w.includes("by hand"))).toHaveLength(1);
      // Reinstall: it finds the same thing, and its plan stops that daemon.
      expect(dry.lines).toContain(ALSO);
      expect(dry.lines).toContain(STOP);
      expect(dry.text).not.toContain("Nothing to repair");
      expect(planned().steps.map((s) => s.do)).toEqual(["fetch", "install", "stop", "use", "prove"]);
    } else {
      // Doctor: one daemon, the service's own as far as anything says.
      expect(doctor.text).not.toContain("started by hand");
      expect(doctor.text).not.toContain("sessionpipe reinstall");
      expect(doctored).toBeUndefined();
      expect(warnings.filter((w) => /by hand|reinstall/.test(w))).toEqual([]);
      // Reinstall: nothing found of it, and nothing to repair.
      expect(dry.lines).toEqual([
        "Found one copy of sessionpipe on this computer",
        `  · ${VERSION}  ~/.local  you type this, the background service`,
        "",
        `✓ Nothing to repair: one sessionpipe, ${VERSION}, the newest release.`,
      ]);
      expect(planned()).toMatchObject({ steps: [], refuse: null });
    }
    expect(facts().daemon).toEqual({ pid: 4242, version: VERSION, byHand: word ? word.via === null : null });
    expect(carryOut).not.toHaveBeenCalled();
  });

  it("what is left of a copy that was emptied is a leftover in doctor's row and its warning too (it said `null in …`); in the home's own slot it is no copy that the fresh one replaces", async () => {
    // An empty folder of the name in a slot is ours, of no release: the look calls it a
    // folder left behind, and every sentence goes by that.
    const LEFT = "left behind by an install that was cut off";
    const emptied = copy(NVM(), { aside: true, version: null, wrong: LEFT, onPath: false });
    vi.mocked(look).mockReturnValue(one({ copies: [copy(LOCAL(), { uses: ["typed", "this"] }), emptied] }));
    expect(row(await run({}, "doctor"))).toBe(
      `9.9.9 in ~/.local (you type this); a leftover in ~/.nvm/versions/node/v22.1.0 (${LEFT})`,
    );
    expect((await json()).warnings).toEqual([
      `2 copies of sessionpipe are on this computer (9.9.9 in ${slotOf(LOCAL())}; a leftover in ${slotOf(NVM())}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    // reinstall's own page for the same computer names it the same way.
    const dry = await run({}, "reinstall", "--dry-run");
    expect(dry.lines).toContain(`  ✗ left over  ~/.nvm/versions/node/v22.1.0  nothing uses it · ${LEFT}`);
    expect(dry.lines).toContain("  - remove   a leftover folder in ~/.nvm/versions/node/v22.1.0");
    expect(dry.text).not.toContain("null");
    // The emptied folder in the home's own slot, nothing typed: the fresh copy goes there
    // for the home's own reason ("replaces null" was said), and no row removes the folder.
    vi.mocked(look).mockReturnValue(
      inventory({
        copies: [copy(LOCAL(), { aside: true, version: null, wrong: LEFT, bins: [] })],
        home: home0({ why: "a folder of your own" }),
      }),
    );
    const there = await run({}, "reinstall", "--dry-run");
    expect(there.lines).toContain("  + install  9.9.9, the newest release, fresh in ~/.local (a folder of your own)");
    expect(there.lines.filter((l) => l.startsWith("  - remove"))).toEqual([]);
    expect(there.text).not.toContain("null");
    const alone = await run({}, "doctor");
    expect(row(alone)).toBe(`a leftover in ~/.local (${LEFT})`);
    expect(alone.text).not.toContain("null");
  });

  it("M4: doctor and status read the copies and run none: the look is handed no way to ask a copy anything", async () => {
    vi.mocked(look).mockReturnValue(two());
    for (const argv of [["doctor"], ["doctor", "--json"], ["status"]]) {
      vi.mocked(look).mockClear();
      vi.mocked(spawnSync).mockClear();
      await run({}, ...argv);
      expect(look).toHaveBeenCalledTimes(1);
      expect(looked()).toEqual({
        env: process.env,
        home,
        reach: home,
        execPath: process.execPath,
        distDir: realDist,
        started: STARTED(),
        npmPrefix: null,
        serviceCli: null,
        hooksVersion: null,
        tilde: expect.any(Function),
      });
      // Left out, nothing is run at all (find.ts).
      expect("runs" in looked()).toBe(false);
      // The only thing doctor starts is its own hook, to time it: no copy's cli.js.
      for (const [, args] of vi.mocked(spawnSync).mock.calls) {
        expect(args).not.toContain("--version");
        expect((args as string[]).some((a) => a.endsWith("cli.js"))).toBe(false);
      }
      process.exitCode = undefined;
    }
    // npm is not asked where it installs by either: a look is all this is.
    expect(execCapture).not.toHaveBeenCalled();
    // With nothing here that needs the service, the manager is not asked for its file either.
    expect(serviceLook).not.toHaveBeenCalled();
    expect(serviceSeen).not.toHaveBeenCalled();
    // A path the look shows a person has nothing in it a terminal acts on.
    expect(looked().tilde(path.join(home, `a${ESC}[31mb\nc`))).toBe("~/ab c");
  });

  it("M3: what typing starts, where that is known to be no installed copy a shell finds: a row that says it as `reinstall` does, a warning for a program, a thing to fix with no command; what can't be told is nothing to doctor, and nothing to repair", async () => {
    // One clean copy, and a checkout's link ahead of it on PATH.
    const stays = path.join(home, "bin", "sessionpipe");
    vi.mocked(look).mockReturnValue(
      inventory({
        copies: [copy(LOCAL(), { uses: ["service"] }), checkout({ uses: ["typed", "this"] })],
        onPath: [
          { file: stays, dir: checkout().dir },
          { file: binOf(LOCAL()), dir: slotOf(LOCAL()) },
        ],
        typed: checkout().dir,
        home: null,
      }),
    );
    const r = await run({}, "doctor");
    // The finding alone: the one copy is whole, so it is not listed as one to clear away.
    expect(row(r)).toBe(TYPED);
    expect(r.lines.some((l) => /^ {2}! copies /.test(l))).toBe(true);
    // It is counted, and said among what is to fix, with nothing to type under it: no
    // `reinstall`, and exit 0 (doctor exits 1 only where there is a command to run).
    expect(r.lines[0]).toBe("! 1 thing needs attention");
    expect(fix(r)).toEqual(["To fix", `  1. ${TYPED}`, "", REPAIR]);
    expect(r.text).not.toContain("sessionpipe reinstall");
    expect(process.exitCode).toBeUndefined();
    const j = await json();
    expect(j.warnings).toEqual([TYPED]);
    expect(j.copies).toEqual([{ dir: slotOf(LOCAL()), version: NEWEST, whole: true, uses: ["service"] }]);
    // The very sentence `reinstall` ends with for the same look: the two never disagree.
    const same = await run({}, "reinstall");
    expect(same.lines.at(-1)).toBe(`! ${TYPED}`);
    expect(same.text).not.toContain("Nothing to repair");
    // A file first on PATH that is no link of npm's, with this command not started through
    // it: which copy it starts can't be known, and it may be the right one. That is
    // nothing to doctor (all good, no row, no warning), and `reinstall` says "Nothing to
    // repair" with what it can't tell beside it: the two agree here too.
    const shim = path.join(home, ".asdf", "shims", "sessionpipe");
    vi.mocked(look).mockReturnValue(
      inventory({
        copies: [copy(LOCAL()), checkout({ uses: ["this"] })],
        strangers: [{ file: shim, why: "a file npm didn't put there" }],
        onPath: [{ file: shim, dir: null }],
        unsure: shim,
        home: null,
      }),
    );
    const unsure =
      "Typing `sessionpipe` starts ~/.asdf/shims/sessionpipe, which is no link of npm's: which copy it starts can't be told from here.";
    const unknown = await run({}, "doctor");
    expect(unknown.lines[0]).toBe("✓ All good");
    expect(row(unknown)).toBeUndefined();
    expect(fix(unknown)).toEqual([]);
    expect((await json()).warnings).toEqual([]);
    const told = await run({}, "reinstall");
    expect(told.lines.slice(-2)).toEqual([`✓ ${NOTHING}`, `! ${unsure}`]);
    expect(told.err).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    // Nothing is typed, and the folder a copy's command is in is on nobody's PATH: a
    // finding for both, in the same words.
    vi.mocked(look).mockReturnValue(
      inventory({ copies: [copy(LOCAL(), { uses: ["this"], onPath: false })], home: home0({ onPath: false }) }),
    );
    const off = await run({}, "doctor");
    expect(row(off)).toBe(NOT_ON_PATH);
    expect(off.lines[0]).toBe("! 1 thing needs attention");
    expect(fix(off)).toEqual(["To fix", `  1. ${NOT_ON_PATH}`, "", REPAIR]);
    expect(process.exitCode).toBeUndefined();
    expect((await json()).warnings).toEqual([NOT_ON_PATH]);
    const said = await run({}, "reinstall");
    expect(said.lines.slice(-2)).toEqual([`✓ ${ONE_COPY}`, `! ${NOT_ON_PATH}`]);
    expect(said.text).not.toContain("Nothing to repair");
    // The copy's own folder is the one named, wherever a fresh copy would go: one whole
    // copy in nvm's Node, that folder off PATH, and an empty ~/.local/bin that is on PATH
    // (the home, then). Both said all was well of this computer.
    const NVM_OFF =
      "~/.nvm/versions/node/v22.1.0/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.";
    vi.mocked(look).mockReturnValue(
      inventory({
        copies: [copy(NVM(), { uses: ["this"], onPath: false })],
        home: home0({ why: "a folder of your own" }),
      }),
    );
    const elsewhere = await run({}, "doctor");
    expect(row(elsewhere)).toBe(NVM_OFF);
    expect(elsewhere.lines[0]).toBe("! 1 thing needs attention");
    expect((await json()).warnings).toEqual([NVM_OFF]);
    const also = await run({}, "reinstall");
    expect(also.lines.slice(-2)).toEqual([`✓ ${ONE_COPY}`, `! ${NVM_OFF}`]);
    // With no copy installed there is nothing to say of PATH: not for someone who runs
    // doctor through npx before installing, whatever folder a fresh copy would go to.
    vi.mocked(look).mockReturnValue(
      inventory({ copies: [npxEntry("0a1b2c3d4e5f6a7b", { uses: ["this"] })], home: home0({ onPath: false }) }),
    );
    const none = await run({}, "doctor");
    expect(none.lines[0]).toBe("✓ All good");
    expect(row(none)).toBeUndefined();
    expect((await json()).warnings).toEqual([]);
    // With copies to clear away as well: they are listed first, the finding last, and the
    // command is `reinstall` (whose run puts it right: the one copy goes where a shell looks).
    vi.mocked(look).mockReturnValue(
      inventory({
        copies: [copy(LOCAL(), { onPath: false }), copy(NVM(), { version: "0.9.0", onPath: false })],
        home: home0({ onPath: false }),
      }),
    );
    const both = await run({}, "doctor");
    expect(row(both)).toBe(
      `9.9.9 in ~/.local (nothing uses it); 0.9.0 in ~/.nvm/versions/node/v22.1.0 (nothing uses it); ${NOT_ON_PATH}`,
    );
    expect(fix(both)[2]).toBe("       sessionpipe reinstall");
    expect((await json()).warnings).toEqual([
      NOT_ON_PATH,
      `2 copies of sessionpipe are on this computer (9.9.9 in ${slotOf(LOCAL())}; 0.9.0 in ${slotOf(NVM())}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    // Where one copy is typed and whole, there is nothing to say: no row.
    vi.mocked(look).mockReturnValue(one());
    expect(row(await run({}, "doctor"))).toBeUndefined();
  });

  it("Windows: doctor and status take no look at the copies: no row, no command that does not run there, an empty list for a program", async () => {
    onPlatform("win32");
    // Whatever a look would find: two copies and a link that leads nowhere.
    vi.mocked(look).mockReturnValue(two({ dangling: [path.join(home, "bin", "sessionpipe")] }));
    const r = await run({}, "doctor");
    expect(look).not.toHaveBeenCalled();
    expect(row(r)).toBeUndefined();
    expect(r.text).not.toContain("reinstall");
    const j = await json();
    expect(j.copies).toEqual([]);
    expect(j.warnings.filter((w: string) => /cop(y|ies)|Typing/.test(w))).toEqual([]);
    await run({}, "status");
    expect(look).not.toHaveBeenCalled();
  });
});

// --- the whole command on real folders -------------------------------------------------------
// Each test builds a home of its own on the disk and runs `main(["reinstall", …])` over it
// with the real look, plan, run and removal. What is still stood in for: npm (it is never
// run: "install" unpacks a copy the test makes), the registry, the service manager, `update`'s
// own steps, and asking a copy for its version (answered from its package.json, and written
// down: nothing a test finds is ever started). Every copy's cli.js would add a line to one
// marker file if node ran it; after each test that file must not be there.

type Fn<T extends (...a: never[]) => unknown> = ReturnType<typeof vi.mocked<T>>;
/** One instance of the command, and the stand-ins it was loaded with. */
interface Loaded {
  cli: Cli;
  look: Fn<typeof look>;
  carryOut: Fn<typeof carryOut>;
  remove: Fn<typeof remove>;
  execCapture: Fn<typeof execCapture>;
  npmDo: Fn<typeof npmDo>;
  installInto: Fn<typeof installInto>;
  latestVersion: Fn<typeof latestVersion>;
  bringCurrent: Fn<typeof bringCurrent>;
  spawnSync: Fn<typeof spawnSync>;
}
/** What a run on real folders did, as its stand-ins saw it. */
interface World {
  m: Loaded;
  /** Every cli.js that was asked for its version, in order: by the look (the one copy it
   *  may ask), by npm's stand-in (the copy it has just unpacked), by the proof. */
  ran: string[];
  /** Every npm command, by its words. */
  npm: string[][];
  /** Every folder npm was told to install into. */
  installs: { prefix: string; version: string; distDir: string }[];
  /** What each look was handed, and what it answered. */
  looks: Looking[];
  seen: Inventory[];
  /** What the one removal was asked for, and what it was told may go. */
  removals: { what: string; o: Proving }[];
  /** What npm answers when asked where it installs. */
  npmPrefix: string;
  run: (where: Parameters<typeof run>[0], ...argv: string[]) => ReturnType<typeof run>;
}

describe.skipIf(process.platform === "win32")("sessionpipe reinstall on real folders", () => {
  let actual: { look: typeof look; carryOut: typeof carryOut; remove: typeof remove };
  beforeAll(async () => {
    actual = {
      look: (await vi.importActual<typeof import("../src/reinstall/find.js")>("../src/reinstall/find.js")).look,
      carryOut: (await vi.importActual<typeof import("../src/reinstall/run.js")>("../src/reinstall/run.js")).carryOut,
      remove: (await vi.importActual<typeof import("../src/reinstall/ours.js")>("../src/reinstall/ours.js")).remove,
    };
  });
  const marker = () => path.join(tmp, "RAN");
  afterEach(() => {
    dist.dir = realDist;
    // No file a test found was ever started: by this command, or by anything it started.
    expect(existsSync(marker())).toBe(false);
  });

  /** The command as the rest of this file has it: run from this repository's own build,
   *  which is outside every test's home, so it is no copy the look finds. */
  const here0 = (): Loaded => ({
    cli,
    look: vi.mocked(look),
    carryOut: vi.mocked(carryOut),
    remove: vi.mocked(remove),
    execCapture: vi.mocked(execCapture),
    npmDo: vi.mocked(npmDo),
    installInto: vi.mocked(installInto),
    latestVersion: vi.mocked(latestVersion),
    bringCurrent: vi.mocked(bringCurrent),
    spawnSync: vi.mocked(spawnSync),
  });
  /** The command loaded as the copy in one package folder: what `sessionpipe` is when that
   *  copy is the one that was started. */
  async function from(mine: string): Promise<Loaded> {
    vi.resetModules();
    dist.dir = path.join(mine, "dist");
    const loaded = await import("../src/cli.js");
    const find = await import("../src/reinstall/find.js");
    const runs = await import("../src/reinstall/run.js");
    const ours = await import("../src/reinstall/ours.js");
    const update = await import("../src/update.js");
    const current = await import("../src/current.js");
    const child = await import("node:child_process");
    return {
      cli: loaded,
      look: vi.mocked(find.look),
      carryOut: vi.mocked(runs.carryOut),
      remove: vi.mocked(ours.remove),
      execCapture: vi.mocked(update.execCapture),
      npmDo: vi.mocked(update.npmDo),
      installInto: vi.mocked(update.installInto),
      latestVersion: vi.mocked(update.latestVersion),
      bringCurrent: vi.mocked(current.bringCurrent),
      spawnSync: vi.mocked(child.spawnSync),
    };
  }

  const inside = (p: string): boolean => p === tmp || path.resolve(p).startsWith(`${tmp}${path.sep}`);
  const versionOf = (dir: string): string | null => {
    try {
      return (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string }).version;
    } catch {
      return null;
    }
  };
  /** A published sessionpipe, as npm unpacks one: the five entries and nothing else. */
  function unpack(dir: string, version: string, manifest: Record<string, unknown> = {}): string {
    put(path.join(dir, "package.json"), { name: "sessionpipe", version, ...manifest });
    put(
      path.join(dir, "dist", "cli.js"),
      `require("node:fs").appendFileSync(${JSON.stringify(marker())}, __filename + "\\n");\n`,
    );
    for (const f of ["README.md", "LICENSE", "NOTICE"]) put(path.join(dir, f), `${f}\n`);
    return dir;
  }
  /** A global install: the package folder in a prefix, and npm's link to it. */
  function installed(prefix: string, version: string): string {
    unpack(slotOf(prefix), version);
    link(prefix);
    return slotOf(prefix);
  }
  const onPath = (...dirs: string[]) => vi.stubEnv("PATH", dirs.join(path.delimiter));
  /** The folder beside a slot that npm is told to install into. */
  const staging = (prefix: string) =>
    new RegExp(`^${path.join(prefix, "lib", "node_modules").replace(/[.\\/]/g, "\\$&")}/\\.sessionpipe-[0-9a-f]{8}$`);

  /** Hand the command the real look, run and removal, and stand in for the rest. */
  function onDisk(m: Loaded = here0()): World {
    // Nothing of the computer these tests run on: npm sets these for the scripts it starts.
    for (const v of [
      "npm_config_cache",
      "npm_config_prefix",
      "npm_command",
      "N_PREFIX",
      "NVM_DIR",
      "FNM_DIR",
      "ASDF_DATA_DIR",
    ])
      vi.stubEnv(v, undefined as unknown as string);
    vi.stubEnv("VOLTA_HOME", undefined as unknown as string);
    const w: World = {
      m,
      ran: [],
      npm: [],
      installs: [],
      looks: [],
      seen: [],
      removals: [],
      npmPrefix: LOCAL(),
      run: async (where, ...argv) => {
        const lines: string[] = [];
        const io = { out: (s = "") => void lines.push(s), err: vi.fn(), exit: vi.fn(), ...where };
        await m.cli.main(argv, io);
        return { lines, text: lines.join("\n"), err: io.err, exit: io.exit };
      },
    };
    const words = npmArgv(process.execPath).length;
    m.execCapture.mockImplementation(async (argv) => {
      w.npm.push(argv.slice(words));
      return { code: 0, stdout: `${w.npmPrefix}\n`, stderr: "" };
    });
    m.latestVersion.mockResolvedValue(NEWEST);
    m.npmDo.mockImplementation(async (said) => {
      w.npm.push(said);
      return null;
    });
    // npm's install: the release unpacked in the prefix it was handed, as npm lays one
    // out, then the copy there asked for its version (as update.ts `installInto` does).
    m.installInto.mockImplementation(async (prefix, version, how) => {
      if (!inside(prefix)) throw new Error(`npm was told to install outside this test's folder: ${prefix}`);
      w.npm.push(["install", "--global", "--prefix", prefix, `sessionpipe@${version}`]);
      w.installs.push({ prefix, version, distDir: how.distDir });
      unpack(slotOf(prefix), version);
      put(path.join(prefix, "lib", "node_modules", ".package-lock.json"), { name: "lib", lockfileVersion: 3 });
      link(prefix);
      w.ran.push(path.join(how.distDir, "cli.js"));
      return { ok: true };
    });
    m.bringCurrent.mockImplementation(async (deps) => ({ state: "current", version: deps.version, said: "ok" }));
    // "Run this cli.js and say what it prints": written down, and answered from the
    // package.json beside it. Nothing is started.
    m.spawnSync.mockImplementation(((_cmd: string, argv: string[]) => {
      if (argv[1] !== "--version")
        return { status: argv.some((a) => a.endsWith("hook.js")) ? 0 : 1, stdout: "", stderr: "" };
      w.ran.push(argv[0] as string);
      const v = versionOf(path.dirname(path.dirname(argv[0] as string)));
      return { status: v ? 0 : 1, stdout: v ? `${v}\n` : "", stderr: "" };
    }) as never);
    m.look.mockImplementation((asked) => {
      w.looks.push(asked);
      const inv = actual.look(asked);
      // A tripwire: this test's home is all the look may name.
      for (const p of [
        ...inv.copies.map((c) => c.dir),
        ...inv.dangling,
        ...inv.strangers.map((s) => s.file),
        ...inv.onPath.map((e) => e.file),
        ...inv.prefixes,
        inv.npx,
        ...(inv.home ? [inv.home.prefix] : []),
      ])
        if (!inside(p)) throw new Error(`the look named a path outside this test's folder: ${p}`);
      w.seen.push(inv);
      return inv;
    });
    m.carryOut.mockImplementation(actual.carryOut);
    // The one function that deletes, behind a tripwire: nothing outside this test's folder.
    m.remove.mockImplementation((what, proving) => {
      if (!inside(what) || typeof proving.reach !== "string" || !inside(proving.reach))
        throw new Error(`a removal outside this test's folder was asked for: ${what}`);
      w.removals.push({ what, o: proving });
      return actual.remove(what, proving);
    });
    return w;
  }
  /** Does the disk this test's folder is on take another case of a name for the same folder? */
  const ignoresCase = (): boolean => {
    mkdirSync(path.join(tmp, "CaseProbe"));
    const yes = existsSync(path.join(tmp, "caseprobe"));
    rmSync(path.join(tmp, "CaseProbe"), { recursive: true });
    return yes;
  };

  /** The page of one clean copy in `~/.local`, and nothing to repair. */
  const CLEAN = [
    "Found one copy of sessionpipe on this computer",
    "  · 9.9.9  ~/.local  you type this",
    "",
    `✓ ${NOTHING}`,
  ];
  const beside = (prefix: string) => readdirSync(path.join(prefix, "lib", "node_modules")).sort();

  it("M1: one healthy copy, and PATH names its folder through a link to the home: found once, nothing to repair, nothing touched", async () => {
    const w = onDisk();
    installed(LOCAL(), NEWEST);
    // Two names for one folder, as a home reached through a link has: PATH and npm say
    // the one, the look's own list of places the other.
    const alias = path.join(tmp, "also-home");
    symlinkSync(home, alias);
    onPath(path.join(alias, ".local", "bin"));
    w.npmPrefix = path.join(alias, ".local");
    const before = tree(tmp);
    for (const flags of [[], ["--dry-run"], ["--yes"]]) {
      const r = await w.run({}, "reinstall", ...flags);
      expect(r.lines).toEqual(CLEAN);
      expect(r.err).not.toHaveBeenCalled();
      expect(r.exit).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    }
    // One folder is one copy, under one name everywhere in what was found.
    for (const inv of w.seen) {
      expect(inv.copies.map((c) => c.dir)).toEqual([slotOf(LOCAL())]);
      expect(inv.onPath).toEqual([{ file: binOf(LOCAL()), dir: slotOf(LOCAL()) }]);
      expect(inv.typed).toBe(slotOf(LOCAL()));
      expect(inv.home?.prefix).toBe(LOCAL());
      expect(new Set(inv.prefixes).size).toBe(inv.prefixes.length);
    }
    // Nothing was planned, so nothing was fetched, installed or removed.
    expect(w.npm).toEqual([
      ["prefix", "-g"],
      ["prefix", "-g"],
      ["prefix", "-g"],
    ]);
    expect(w.installs).toEqual([]);
    expect(w.removals).toEqual([]);
    expect(tree(tmp)).toEqual(before);
    // The same where the home itself is named through the link ($HOME is a link to the
    // real folder): one copy, nothing to repair, nothing touched.
    vi.stubEnv("HOME", alias);
    onPath(path.join(home, ".local", "bin"));
    const linked = await w.run({}, "reinstall", "--yes");
    // And the page reads `~` there too: the look spells a folder by where it really is,
    // which is not how $HOME names it (the whole real path was printed).
    expect(linked.lines).toEqual(CLEAN);
    expect(w.seen.at(-1)?.copies.map((c) => c.dir)).toEqual([slotOf(LOCAL())]);
    expect(w.installs).toEqual([]);
    expect(w.removals).toEqual([]);
    expect(tree(tmp)).toEqual(before);
  });

  it("M1: the same copy with PATH in another case of its folder, on a disk that ignores case: one copy, never a second one to remove", async (ctx) => {
    if (!ignoresCase()) ctx.skip();
    const w = onDisk();
    installed(LOCAL(), NEWEST);
    // The review's proof: PATH says ~/.Local/bin, npm's prefix is ~/.local. It was "Found 2
    // copies", a fresh install, and then the removal of that very copy as "another" one.
    onPath(path.join(home, ".Local", "bin"));
    const before = tree(tmp);
    for (const flags of [["--dry-run"], ["--yes"]]) {
      const r = await w.run({}, "reinstall", ...flags);
      expect(r.lines).toEqual(CLEAN);
      expect(r.err).not.toHaveBeenCalled();
    }
    expect(w.seen[0]?.copies.map((c) => c.dir)).toEqual([slotOf(LOCAL())]);
    expect(w.installs).toEqual([]);
    expect(w.removals).toEqual([]);
    expect(tree(tmp)).toEqual(before);
    // An older copy there: it is replaced where it is, and nothing is removed as another copy.
    put(path.join(slotOf(LOCAL()), "package.json"), { name: "sessionpipe", version: "1.0.0" });
    const r = await w.run({}, "reinstall", "--yes");
    expect(r.lines[0]).toBe("Found one copy of sessionpipe on this computer");
    expect(r.lines.filter((l) => l.includes("removed"))).toEqual([]);
    expect(r.lines.at(-1)).toBe(`✓ ${ONE.said}`);
    expect(r.err).not.toHaveBeenCalled();
    expect(versionOf(slotOf(LOCAL()))).toBe(NEWEST);
    expect(versionOf(slotOf(path.join(home, ".Local")))).toBe(NEWEST);
    expect(readlinkSync(binOf(LOCAL()))).toBe(path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"));
    // What the run asked to have removed is only what it made beside the slot itself.
    for (const x of w.removals) expect(path.basename(x.what)).toMatch(ASIDE);
    // And asked by that other case, the removal refuses the copy the run put in place.
    const d = w.m.carryOut.mock.calls.at(-1)?.[1] as Doing;
    await expect(d.remove(slotOf(path.join(home, ".Local")))).rejects.toThrow("it is the copy this run put in place");
    expect(versionOf(slotOf(LOCAL()))).toBe(NEWEST);
  });

  it("M1: an older copy reached by two names: the fresh one goes where it is, nothing is removed as 'another copy', and the removal refuses that folder by either name", async () => {
    const w = onDisk();
    installed(LOCAL(), "1.0.0");
    const alias = path.join(tmp, "also-home");
    symlinkSync(home, alias);
    onPath(path.join(alias, ".local", "bin"));
    const r = await w.run({}, "reinstall", "--yes");
    expect(r.lines).toEqual([
      "Found one copy of sessionpipe on this computer",
      "  · 1.0.0  ~/.local  you type this",
      "",
      "This will",
      "  + install  9.9.9, the newest release, fresh in ~/.local (replaces 1.0.0)",
      KEEP,
      "",
      SAFE,
      "",
      "  ✓ sessionpipe 9.9.9 downloaded",
      "  ✓ installed fresh in ~/.local, and it runs (what was there is gone)",
      "  ✓ the copy in ~/.local runs: `--version` says 9.9.9",
      "  ✓ typing `sessionpipe` starts it: ~/.local/bin/sessionpipe",
      "",
      `✓ ${ONE.said}`,
    ]);
    expect(r.err).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    // The fresh copy is in the slot, by either name of it, with npm's link as it was.
    expect(versionOf(slotOf(LOCAL()))).toBe(NEWEST);
    expect(versionOf(slotOf(path.join(alias, ".local")))).toBe(NEWEST);
    expect(readlinkSync(binOf(LOCAL()))).toBe(path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"));
    // L1: npm was handed a folder beside the slot, never the prefix; and what the run made
    // beside the slot (that folder, and the old copy stepped aside) is gone again.
    expect(w.installs).toHaveLength(1);
    expect(w.installs[0]?.prefix).toMatch(staging(LOCAL()));
    expect(w.installs[0]?.distDir).toBe(path.join(slotOf(w.installs[0]?.prefix as string), "dist"));
    expect(beside(LOCAL())).toEqual(["sessionpipe"]);
    expect(w.removals.map((x) => path.dirname(x.what))).toEqual(Array(2).fill(path.dirname(slotOf(LOCAL()))));
    for (const x of w.removals) {
      expect(path.basename(x.what)).toMatch(ASIDE);
      // Every removal is told the look's own reach, prefixes and npx cache, and which
      // folder is never to go: the slot the fresh copy is in.
      expect(x.o).toEqual({
        reach: home,
        prefixes: w.seen[0]?.prefixes,
        npx: path.join(home, ".npm", "_npx"),
        keep: [slotOf(LOCAL())],
      });
    }
    // The run's own removal, asked for that slot by another name inside the home (a link
    // to the prefix): refused as the copy this run put in place. Without `keep` the proof
    // accepts it (a published copy in a global slot) and the one working copy would go.
    const d = w.m.carryOut.mock.calls[0]?.[1] as Doing;
    const also = path.join(home, "also");
    symlinkSync(LOCAL(), also);
    await expect(d.remove(slotOf(also))).rejects.toThrow(
      `${slotOf(also)} was left alone: it is the copy this run put in place`,
    );
    await expect(d.remove(slotOf(LOCAL()))).rejects.toThrow("it is the copy this run put in place");
    expect(versionOf(slotOf(LOCAL()))).toBe(NEWEST);
  });

  it("M2: a stray copy beside a script of the user's under the command's name: the copy goes, the script stays byte for byte and is listed as left alone, and npm is never asked to uninstall", async () => {
    const w = onDisk();
    installed(LOCAL(), NEWEST);
    // nvm's Node holds an old copy, and where npm's link to it would be the user's own wrapper.
    unpack(slotOf(NVM()), "0.15.0");
    const script = binOf(NVM());
    const wrapper = '#!/bin/sh\nexec my-own-tool "$@"\n';
    put(script, wrapper);
    onPath(path.join(LOCAL(), "bin"), path.join(NVM(), "bin"));
    const r = await w.run({}, "reinstall", "--yes");
    expect(r.lines).toEqual([
      "Found 2 copies of sessionpipe on this computer",
      "  · 9.9.9   ~/.local                      you type this",
      "  ✗ 0.15.0  ~/.nvm/versions/node/v22.1.0  nothing uses it · npm's link to it is gone",
      "",
      "This will",
      "  + install  9.9.9, the newest release, fresh in ~/.local (replaces 9.9.9)",
      "  - remove   0.15.0 in ~/.nvm/versions/node/v22.1.0",
      KEEP,
      "",
      "Left alone",
      "  · ~/.nvm/versions/node/v22.1.0/bin/sessionpipe",
      "      a file npm didn't put there",
      "",
      SAFE,
      "",
      "  ✓ sessionpipe 9.9.9 downloaded",
      "  ✓ installed fresh in ~/.local, and it runs (what was there is gone)",
      "  ✓ removed 0.15.0 in ~/.nvm/versions/node/v22.1.0",
      "  ✓ the copy in ~/.local runs: `--version` says 9.9.9",
      "  · typing `sessionpipe` starts it; behind it on PATH: ~/.nvm/versions/node/v22.1.0/bin/sessionpipe",
      "  ✓ nothing here names a removed copy any more",
      "",
      `✓ ${ONE.said}`,
    ]);
    expect(r.err).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    // The stray's folder is gone; what the screen listed under "Left alone" is still there, as it was.
    expect(existsSync(slotOf(NVM()))).toBe(false);
    expect(beside(NVM())).toEqual([]);
    expect(lstatSync(script).isFile()).toBe(true);
    expect(readFileSync(script, "utf8")).toBe(wrapper);
    // Every word npm was ever given: where it installs, the download, and one install
    // into the folder beside the home's slot. No uninstall, nothing in nvm's prefix.
    expect(w.npm).toEqual([
      ["prefix", "-g"],
      ["cache", "add", `sessionpipe@${NEWEST}`],
      ["install", "--global", "--prefix", expect.stringMatching(staging(LOCAL())), `sessionpipe@${NEWEST}`],
    ]);
    expect(w.npm.flat().filter((x) => /uninstall|^un$|^rm$|^remove$/.test(x))).toEqual([]);
    expect(w.npm.flat().some((x) => x.startsWith(NVM()))).toBe(false);
    // What was removed went through the one function, proven: the two folders the run
    // made beside the slot, then the stray, and nothing else.
    expect(w.removals.map((x) => x.what)).toEqual([
      expect.stringMatching(staging(LOCAL())),
      expect.stringMatching(staging(LOCAL())),
      slotOf(NVM()),
    ]);
    // L1: nothing of the run's own is left beside the slot.
    expect(beside(LOCAL())).toEqual(["sessionpipe"]);
    expect(versionOf(slotOf(LOCAL()))).toBe(NEWEST);
  });

  it.skipIf(process.getuid?.() === 0)(
    "M2, L10: a stray this user may not write stays, and the run ends with the line that removes exactly it: `sudo rm -r` of the folder and its own link, no word of npm's; exit 1 as a refusal that is no error",
    async () => {
      const w = onDisk();
      installed(LOCAL(), NEWEST);
      installed(NVM(), "0.15.0");
      onPath(path.join(LOCAL(), "bin"));
      const locked = path.join(NVM(), "lib", "node_modules");
      chmodSync(locked, 0o555);
      try {
        const line = `sudo rm -r ${slotOf(NVM())} ${binOf(NVM())}`;
        const still = "One other copy is still there: 0.15.0 in ~/.nvm/versions/node/v22.1.0 (needs sudo)";
        const r = await w.run({}, "reinstall", "--yes");
        expect(r.lines.slice(r.lines.indexOf("This will"))).toEqual([
          "This will",
          "  + install  9.9.9, the newest release, fresh in ~/.local (replaces 9.9.9)",
          KEEP,
          "",
          "Left alone",
          "  ! ~/.nvm/versions/node/v22.1.0  0.15.0 · needs sudo: a run ends with its line",
          "",
          SAFE,
          "",
          "  ✓ sessionpipe 9.9.9 downloaded",
          "  ✓ installed fresh in ~/.local, and it runs (what was there is gone)",
          "  ✓ the copy in ~/.local runs: `--version` says 9.9.9",
          "  ✓ typing `sessionpipe` starts it: ~/.local/bin/sessionpipe",
          "",
          `✓ sessionpipe ${NEWEST} is installed in ~/.local and in use. Pairings and settings are as they were.`,
        ]);
        // In a pipe: the one line, with the command at its end.
        expect(r.err).toHaveBeenCalledTimes(1);
        expect(r.err).toHaveBeenCalledWith(`sessionpipe: ${still}. Next: ${line}\n`);
        expect(r.exit).toHaveBeenCalledWith(1);
        expect(line).not.toContain("npm");
        // The stray was not touched, nor asked to be: the proof would have taken it.
        expect(versionOf(slotOf(NVM()))).toBe("0.15.0");
        expect(w.removals.map((x) => x.what).filter((x) => x.startsWith(NVM()))).toEqual([]);
        expect(w.npm.flat()).not.toContain("uninstall");
        // At a terminal (a second run finds the same): under `!`, then the line alone.
        const term = await w.run({ tty: true, errTty: true, columns: 200 }, "reinstall", "--yes", "--no-color");
        expect(term.err).toHaveBeenCalledWith(`!      ${still}\ntry    ${line}\n`);
        // Pasted, the line removes the folder and the link, and nothing beside them.
        expect(line.split(" ").slice(0, 3)).toEqual(["sudo", "rm", "-r"]);
        expect(line.split(" ").slice(3)).toEqual([slotOf(NVM()), binOf(NVM())]);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  /** The usual `sudo npm install -g`: one copy, typed, in a prefix this user may not write. */
  function asRoot(version: string): { prefix: string; unlock: () => void } {
    const prefix = path.join(home, "opt", "node");
    installed(prefix, version);
    onPath(path.join(prefix, "bin"));
    const locked = [
      path.join(prefix, "lib", "node_modules", "sessionpipe"),
      path.join(prefix, "lib", "node_modules"),
      path.join(prefix, "bin"),
    ];
    for (const d of locked) chmodSync(d, 0o555);
    return {
      prefix,
      unlock: () => {
        for (const d of locked) chmodSync(d, 0o755);
      },
    };
  }

  it.skipIf(process.getuid?.() === 0)(
    "M3: the usual sudo install, whole and the newest: nothing to repair, and no second copy is put anywhere",
    async () => {
      const w = onDisk();
      const { prefix, unlock } = asRoot(NEWEST);
      w.npmPrefix = prefix;
      try {
        const before = tree(tmp);
        for (const flags of [[], ["--dry-run"], ["--yes"]]) {
          const r = await w.run({}, "reinstall", ...flags);
          expect(r.lines).toEqual([
            "Found one copy of sessionpipe on this computer",
            "  · 9.9.9  ~/opt/node  you type this",
            "",
            `✓ ${NOTHING}`,
          ]);
          expect(r.err).not.toHaveBeenCalled();
          expect(process.exitCode).toBeUndefined();
        }
        // The look saw that it may not be written, and where the one copy lives all the same.
        expect(w.seen[0]?.copies[0]).toMatchObject({ dir: slotOf(prefix), writable: false, wrong: null });
        expect(w.seen[0]?.home).toMatchObject({ prefix, writable: false, onPath: true });
        // Before, a second copy went to ~/.local and the run ended asking for sudo.
        expect(existsSync(LOCAL())).toBe(false);
        expect(w.installs).toEqual([]);
        expect(w.removals).toEqual([]);
        expect(w.npm.every((x) => x.join(" ") === "prefix -g")).toBe(true);
        expect(tree(tmp)).toEqual(before);
      } finally {
        unlock();
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "M3: the usual sudo install, a release behind: nothing is changed, and the one line updates it where it is",
    async () => {
      const w = onDisk();
      const { prefix, unlock } = asRoot("1.0.0");
      w.npmPrefix = prefix;
      // ~/.local/bin is on PATH behind it, as on most computers: no copy goes there.
      mkdirSync(path.join(LOCAL(), "bin"), { recursive: true });
      onPath(path.join(prefix, "bin"), path.join(LOCAL(), "bin"));
      try {
        const before = tree(tmp);
        for (const flags of [[], ["--dry-run"], ["--yes"]]) {
          const r = await w.run({}, "reinstall", ...flags);
          expect(r.lines).toEqual([
            "Found one copy of sessionpipe on this computer",
            "  · 1.0.0  ~/opt/node  you type this",
          ]);
          expect(r.err).toHaveBeenCalledTimes(1);
          expect(r.err).toHaveBeenCalledWith(
            `sessionpipe: ~/opt/node holds the copy you type (1.0.0), and you may not write there. Nothing was changed. Update it there, then run this again. Next: sudo npm install -g --prefix ${prefix} sessionpipe@${NEWEST}\n`,
          );
          expect(r.exit).toHaveBeenCalledWith(1);
        }
        expect(w.installs).toEqual([]);
        expect(w.removals).toEqual([]);
        expect(w.npm.every((x) => x.join(" ") === "prefix -g")).toBe(true);
        expect(readdirSync(LOCAL())).toEqual(["bin"]);
        expect(tree(tmp)).toEqual(before);
      } finally {
        unlock();
      }
    },
  );

  /** A version manager's shims folder first on PATH, the one copy in the Node it manages,
   *  and ~/.local/bin on PATH behind. */
  function shimmed(version: string): { copy: string; shim: string; prefix: string } {
    const prefix = path.join(home, ".asdf", "installs", "nodejs", "22.1.0");
    const shim = path.join(home, ".asdf", "shims", "sessionpipe");
    put(shim, '#!/bin/sh\nexec asdf exec "sessionpipe" "$@"\n');
    mkdirSync(path.join(LOCAL(), "bin"), { recursive: true });
    onPath(path.dirname(shim), path.join(LOCAL(), "bin"));
    return { copy: installed(prefix, version), shim, prefix };
  }

  it("M3: a shim manager, the command started through its shim from the one healthy copy: nothing to repair, nothing installed, nothing removed", async () => {
    const { copy: mine, prefix } = shimmed(NEWEST);
    const w = onDisk(await from(mine));
    // A shim runs npm's own link to the copy: that is the file this command was started as.
    process.argv[1] = binOf(prefix);
    const before = tree(tmp);
    for (const flags of [[], ["--dry-run"], ["--yes"]]) {
      const r = await w.run({}, "reinstall", ...flags);
      expect(r.lines).toEqual([
        "Found one copy of sessionpipe on this computer",
        "  · 9.9.9  ~/.asdf/installs/nodejs/22.1.0  you type this",
        "",
        "Left alone",
        "  · ~/.asdf/shims/sessionpipe  a file npm didn't put there",
        "",
        `✓ ${NOTHING}`,
      ]);
      expect(r.err).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    }
    // The shim is what started this copy: that copy is what is typed, and where it lives
    // is the home. Never ~/.local because a shell would find a link there.
    expect(w.seen[0]).toMatchObject({ typed: mine, unsure: null });
    expect(w.seen[0]?.home?.prefix).toBe(prefix);
    expect(w.seen[0]?.copies.map((c) => [c.dir, c.uses])).toEqual([[mine, ["typed", "this"]]]);
    // Before: a fresh copy in ~/.local, the copy behind the shim removed, and the shim failing.
    expect(readdirSync(LOCAL())).toEqual(["bin"]);
    expect(readdirSync(path.join(LOCAL(), "bin"))).toEqual([]);
    expect(w.installs).toEqual([]);
    expect(w.removals).toEqual([]);
    expect(tree(tmp)).toEqual(before);
    // M4: the copy that is running was not started a second time to be asked what it is.
    expect(w.ran).toEqual([]);
  });

  it("M3: the same computer, the command started from no installed copy (npx, a checkout): which copy the shim starts can't be told, so nothing is changed", async () => {
    // Something to repair: the copy behind the shim is a release behind.
    const { copy: theirs } = shimmed("1.0.0");
    const w = onDisk();
    const before = tree(tmp);
    for (const flags of [[], ["--dry-run"], ["--yes"]]) {
      const r = await w.run({}, "reinstall", ...flags);
      expect(r.lines).toEqual([
        "Found one copy of sessionpipe on this computer",
        "  · 1.0.0  ~/.asdf/installs/nodejs/22.1.0  nothing uses it",
      ]);
      expect(r.err).toHaveBeenCalledWith(
        `sessionpipe: ~/.asdf/shims/sessionpipe is the first \`sessionpipe\` on your PATH and no link of npm's, and this command was not started through it: it can't tell which copy that file starts, so it can't tell where the one clean copy goes. Nothing was changed. Install it into the Node you use, then run it from there. Next: npm install -g sessionpipe@${NEWEST} && sessionpipe reinstall\n`,
      );
      expect(r.exit).toHaveBeenCalledWith(1);
    }
    expect(w.seen[0]).toMatchObject({
      typed: null,
      unsure: path.join(home, ".asdf", "shims", "sessionpipe"),
      home: null,
    });
    expect(w.installs).toEqual([]);
    expect(w.removals).toEqual([]);
    expect(tree(tmp)).toEqual(before);
    // M4: a copy nobody is known to type is not started to be asked anything, and the shim never is.
    expect(w.ran).toEqual([]);
    // With nothing to repair it says so, and what it can't tell beside it: the shim may
    // well be what starts this very copy, and nothing was found that is not as it should be.
    put(path.join(theirs, "package.json"), { name: "sessionpipe", version: NEWEST });
    const fine = await w.run({}, "reinstall", "--yes");
    expect(fine.lines.slice(-2)).toEqual([
      `✓ ${NOTHING}`,
      "! Typing `sessionpipe` starts ~/.asdf/shims/sessionpipe, which is no link of npm's: which copy it starts can't be told from here.",
    ]);
    expect(fine.err).not.toHaveBeenCalled();
    expect(w.installs).toEqual([]);
    expect(w.removals).toEqual([]);
  });

  it("S4: the same shim, and the installed copy started as its cli.js by its path: the shim did not start it, so which copy it starts can't be told, and nothing is changed", async () => {
    // The end-to-end run's S4. A file first on PATH that leads to no folder counted as
    // what started this command whenever this command ran from an installed copy. Run by
    // its path (`node …/dist/cli.js reinstall`) it was not: the file may start anything.
    const { copy: mine, prefix } = shimmed("1.0.0");
    const w = onDisk(await from(mine));
    const before = tree(tmp);
    const unsure = `sessionpipe: ~/.asdf/shims/sessionpipe is the first \`sessionpipe\` on your PATH and no link of npm's, and this command was not started through it: it can't tell which copy that file starts, so it can't tell where the one clean copy goes. Nothing was changed. Install it into the Node you use, then run it from there. Next: npm install -g sessionpipe@${NEWEST} && sessionpipe reinstall\n`;
    for (const started of [
      path.join(mine, "dist", "cli.js"),
      STARTED(),
      path.join(home, ".asdf", "shims", "sessionpipe"),
    ]) {
      process.argv[1] = started;
      const r = await w.run({}, "reinstall", "--yes");
      expect(r.err, started).toHaveBeenCalledWith(unsure);
      expect(r.exit).toHaveBeenCalledWith(1);
      expect(w.seen.at(-1)).toMatchObject({ typed: null, unsure: path.join(home, ".asdf", "shims", "sessionpipe") });
      expect(w.looks.at(-1)?.started).toBe(started);
    }
    expect(w.installs).toEqual([]);
    expect(w.removals).toEqual([]);
    expect(tree(tmp)).toEqual(before);
    // Started as npm's link to that copy, which is what a shim runs: it is what is typed,
    // and the copy is repaired where it is.
    process.argv[1] = binOf(prefix);
    const through = await w.run({}, "reinstall", "--dry-run");
    expect(through.err).not.toHaveBeenCalled();
    expect(w.seen.at(-1)).toMatchObject({ typed: mine, unsure: null });
    expect(w.seen.at(-1)?.home?.prefix).toBe(prefix);
    expect(through.lines).toContain(
      "  + install  9.9.9, the newest release, fresh in ~/.asdf/installs/nodejs/22.1.0 (replaces 1.0.0)",
    );
  });

  it("S2: a script of the person's own where the installed copy's link was: it is moved aside by the one line, never installed over, whether the command was started by its path or through npx", async () => {
    // The end-to-end run's S2. `~/.local/bin/sessionpipe` is a script, the copy is whole
    // in `~/.local/lib/node_modules`. Taken for a shim nobody can see through, the answer
    // was `npm install -g sessionpipe@<v> && sessionpipe reinstall`, and run there npm
    // wrote its link over the script.
    const script = '#!/bin/sh\n# mine\nexec /opt/tools/sp "$@"\n';
    const mine = unpack(slotOf(LOCAL()), "1.0.0");
    put(binOf(LOCAL()), script);
    chmodSync(binOf(LOCAL()), 0o755);
    onPath(path.join(LOCAL(), "bin"));
    const said = `sessionpipe: ~/.local/bin/sessionpipe is not sessionpipe's, and it is where the fresh copy's link goes: npm won't write over it. Nothing was changed. Move it aside, then run this again. Next: mv -n ${binOf(LOCAL())} ${binOf(LOCAL())}.old\n`;
    const refused = async (w: World, how: string) => {
      const before = tree(tmp);
      for (const flags of [["--yes"], ["--dry-run"], []]) {
        const r = await w.run({}, "reinstall", ...flags);
        expect(r.err, how).toHaveBeenCalledWith(said);
        expect(String(r.err.mock.calls[0]?.[0]), how).not.toMatch(/npm install/);
        expect(r.exit).toHaveBeenCalledWith(1);
      }
      // The look's own answer: no shim, nothing typed, nothing unsure, the home that
      // prefix ("where the copy is whose link is gone"), blocked by the file.
      expect(w.seen.at(-1), how).toMatchObject({
        typed: null,
        unsure: null,
        strangers: [{ file: binOf(LOCAL()), why: "a file npm didn't put there" }],
        home: { prefix: LOCAL(), why: "where the copy is whose link is gone", blocked: binOf(LOCAL()), onPath: true },
      });
      expect(w.installs).toEqual([]);
      expect(w.removals).toEqual([]);
      expect(w.npm.every((x) => x.join(" ") === "prefix -g")).toBe(true);
      expect(tree(tmp)).toEqual(before);
      expect(readFileSync(binOf(LOCAL()), "utf8")).toBe(script);
    };
    // Started from that copy, as its cli.js by its path.
    process.argv[1] = path.join(mine, "dist", "cli.js");
    await refused(onDisk(await from(mine)), "by its path");
    // Started through npx, from its cache, with that run's own `.bin` first on PATH.
    const entry = path.join(home, ".npm", "_npx", "0a1b2c3d4e5f6a7b", "node_modules");
    const cached = unpack(path.join(entry, "sessionpipe"), NEWEST);
    mkdirSync(path.join(entry, ".bin"));
    symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), path.join(entry, ".bin", "sessionpipe"));
    const byNpx = onDisk(await from(cached));
    vi.stubEnv("npm_command", "exec");
    onPath(path.join(entry, ".bin"), path.join(LOCAL(), "bin"));
    process.argv[1] = path.join(entry, ".bin", "sessionpipe");
    await refused(byNpx, "through npx");
    // And from a checkout that is no copy the look finds (this repository's own build).
    vi.stubEnv("npm_command", undefined as unknown as string);
    onPath(path.join(LOCAL(), "bin"));
    process.argv[1] = STARTED();
    await refused(onDisk(), "from a checkout");
  });

  it("a project's own `.bin` that a person put on PATH is looked in: what it starts is no installed copy, and the line shows what PATH finds; the same folder on PATH for npm's own run is passed over", async () => {
    // npm and npx put `node_modules/.bin` folders on PATH for the run they start and say
    // so (`npm_command`). Without that word the folder is the person's own PATH entry:
    // what is in it is what they type.
    const project = path.join(home, "work", "app");
    put(path.join(project, "package.json"), { name: "app", dependencies: { sessionpipe: "^0.15.0" } });
    const dep = unpack(path.join(project, "node_modules", "sessionpipe"), "0.15.9");
    mkdirSync(path.join(project, "node_modules", ".bin"));
    const own = path.join(project, "node_modules", ".bin", "sessionpipe");
    symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), own);
    installed(LOCAL(), "1.0.0");
    onPath(path.join(project, "node_modules", ".bin"), path.join(LOCAL(), "bin"));
    const w = onDisk();
    const before = tree(tmp);
    const r = await w.run({}, "reinstall", "--yes");
    expect(w.seen[0]?.onPath).toEqual([
      { file: own, dir: dep },
      { file: binOf(LOCAL()), dir: slotOf(LOCAL()) },
    ]);
    expect(w.seen[0]).toMatchObject({ typed: dep, unsure: null, home: null });
    expect(r.err).toHaveBeenCalledWith(
      "sessionpipe: Typing `sessionpipe` starts ~/work/app/node_modules/sessionpipe, which is no installed copy of it (it is not a global install or an npx cache entry (a project's own dependency?)): this command leaves it alone, so it can't put one clean copy in its place. Nothing was changed. Next: which -a sessionpipe\n",
    );
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(w.installs).toEqual([]);
    expect(w.removals).toEqual([]);
    expect(tree(tmp)).toEqual(before);
    // M4: what is typed is a folder the proof refuses: it was not started to be asked anything.
    expect(w.ran).toEqual([]);
    // The same PATH in a run npm started (`npm exec`, `npx`, a package script): that
    // `.bin` is the run's own, nobody types it, and the copy in ~/.local is what is typed.
    for (const word of ["exec", "run-script"]) {
      vi.stubEnv("npm_command", word);
      const dry = await w.run({}, "reinstall", "--dry-run");
      expect(dry.err).not.toHaveBeenCalled();
      expect(w.seen.at(-1)?.onPath).toEqual([{ file: binOf(LOCAL()), dir: slotOf(LOCAL()) }]);
      expect(w.seen.at(-1)).toMatchObject({ typed: slotOf(LOCAL()), unsure: null });
      expect(dry.lines).toContain("  + install  9.9.9, the newest release, fresh in ~/.local (replaces 1.0.0)");
    }
    expect(tree(tmp)).toEqual(before);
  });

  /** One typed copy in ~/.local, and three folders that only look like one: another
   *  package under the name in a prefix that is not on PATH, an npx cache folder that
   *  holds a Makefile, and a folder someone linked into a Node's global folder. Each has
   *  a dist/cli.js. */
  function lookalikes(version: string): { typed: string; refused: string[] } {
    const typed = path.join(installed(LOCAL(), version), "dist", "cli.js");
    onPath(path.join(LOCAL(), "bin"));
    const other = unpack(slotOf(path.join(home, ".npm-global")), "1.3.0", { name: "left-pad" });
    const cached = unpack(path.join(home, ".npm", "_npx", "0a1b2c3d4e5f6a7b", "node_modules", "sessionpipe"), "0.15.0");
    put(path.join(cached, "Makefile"), "all:\n\ttrue\n");
    const source = unpack(path.join(home, "src", "sp"), "0.14.0");
    const asdf = path.join(home, ".asdf", "installs", "nodejs", "22.1.0");
    mkdirSync(path.join(asdf, "lib", "node_modules"), { recursive: true });
    symlinkSync(source, slotOf(asdf));
    return { typed, refused: [other, cached, slotOf(asdf), source].map((d) => path.join(d, "dist", "cli.js")) };
  }

  it("M4: the look starts nothing it has not proven: on a dry run, a refusal and 'nothing to repair' only the one copy typing starts is asked; from doctor and status none is", async () => {
    const { typed, refused } = lookalikes("1.0.0");
    const w = onDisk();
    // All four were found, and three are refused, each with why: they are in the look to be named.
    const dry = await w.run({}, "reinstall", "--dry-run");
    expect(w.seen[0]?.copies.map((c) => [c.where, c.slot, c.not])).toEqual(
      expect.arrayContaining([
        ["~/.local", "global", null],
        ["~/.npm-global/lib/node_modules/sessionpipe", null, 'its package.json says it is "left-pad", not sessionpipe'],
        [
          "~/.npm/_npx/0a1b2c3d4e5f6a7b/node_modules/sessionpipe",
          null,
          "it holds Makefile, which no published sessionpipe has (a checkout or a build?)",
        ],
        // A slot that is a link to a folder is that folder, listed once, by its own name.
        ["~/src/sp", null, "it is not a folder named node_modules/sessionpipe"],
      ]),
    );
    expect(w.seen[0]?.copies).toHaveLength(4);
    expect(w.seen[0]?.copies.map((c) => c.dir)).not.toContain(
      slotOf(path.join(home, ".asdf", "installs", "nodejs", "22.1.0")),
    );
    // L10: one copy was found. The other three are no copies of it: under "Left alone", each.
    expect(dry.lines[0]).toBe("Found one copy of sessionpipe on this computer");
    expect(dry.lines.filter((l) => /left-pad|Makefile|not a folder named node_modules/.test(l))).toHaveLength(3);
    expect(dry.lines.at(-1)).toBe(DRY_RUN);
    // A dry run asked the one copy that typing starts, once, and nothing else.
    expect(w.ran).toEqual([typed]);
    // A run that refuses (npm can't be run, and a fresh copy comes from npm): the same one.
    w.ran.length = 0;
    w.m.execCapture.mockResolvedValueOnce({ code: 127, stdout: "", stderr: "npm: not found" });
    const refusal = await w.run({}, "reinstall", "--yes");
    expect(refusal.err).toHaveBeenCalledWith(expect.stringContaining("npm is not beside this Node nor on PATH"));
    expect(refusal.exit).toHaveBeenCalledWith(1);
    expect(w.ran).toEqual([typed]);
    // Nothing to repair: the same one.
    w.ran.length = 0;
    put(path.join(slotOf(LOCAL()), "package.json"), { name: "sessionpipe", version: NEWEST });
    const fine = await w.run({}, "reinstall", "--yes");
    expect(fine.lines.at(-1)).toBe(`✓ ${NOTHING}`);
    expect(w.ran).toEqual([typed]);
    for (const cli of refused) expect(w.ran).not.toContain(cli);
    // Every look of `reinstall` before a run is handed the way to ask; it used it for that one copy.
    for (const asked of w.looks) expect(asked.runs).toBeTypeOf("function");
    // `doctor` and `status` read the same computer and start no copy at all.
    w.ran.length = 0;
    const at = w.looks.length;
    vi.spyOn(process.hrtime, "bigint").mockReturnValue(1n);
    await w.run({}, "doctor");
    await w.run({}, "doctor", "--json");
    await w.run({}, "status");
    expect(w.looks.length).toBe(at + 3);
    for (const asked of w.looks.slice(at)) expect("runs" in asked).toBe(false);
    expect(w.ran).toEqual([]);
    process.exitCode = undefined;
    // A copy whose cli.js prints nothing is said so by the look that asked it; one that
    // was not asked is taken as its package.json has it.
    w.m.spawnSync.mockImplementation(((_c: string, argv: string[]) => {
      w.ran.push(argv[0] as string);
      return { status: 1, stdout: "", stderr: "" };
    }) as never);
    const dead = await w.run({}, "reinstall", "--dry-run");
    expect(dead.lines[1]).toBe("  ✗ 9.9.9  ~/.local  you type this · it doesn't run: `--version` printed nothing");
    expect(w.ran).toEqual([typed]);
  });

  it("M4: a real run starts two things beside itself: the copy npm has just unpacked beside the slot, and the copy in the home for the proof; the look inside the proof is handed no way to run anything", async () => {
    const { typed, refused } = lookalikes("1.0.0");
    const w = onDisk();
    const r = await w.run({}, "reinstall", "--yes");
    expect(r.lines.at(-1)).toBe(`✓ ${ONE.said}`);
    expect(r.err).not.toHaveBeenCalled();
    const stage = w.installs[0]?.prefix as string;
    expect(stage).toMatch(staging(LOCAL()));
    expect(w.ran).toEqual([
      // The look before the plan: the one copy typing starts.
      typed,
      // npm's own check of what it unpacked, in the folder beside the slot.
      path.join(stage, "lib", "node_modules", "sessionpipe", "dist", "cli.js"),
      // The proof at the end: the copy in the home, through npm's link. (No copy was to be
      // removed here, so there was no proof before a removal.)
      typed,
    ]);
    for (const cli of refused) expect(w.ran).not.toContain(cli);
    // Two looks: the one before the plan may ask that one copy; the one inside the proof may ask nothing.
    expect(w.looks).toHaveLength(2);
    expect(w.looks[0]?.runs).toBeTypeOf("function");
    expect("runs" in (w.looks[1] as Looking)).toBe(false);
    // The proof's look is the same look otherwise: npm's prefix, the reach, this copy.
    const { runs: _runs, ...first } = w.looks[0] as Looking;
    expect(w.looks[1]).toEqual({ ...first, tilde: expect.any(Function) });
    // The three that are no copies were not touched.
    for (const cli of refused) expect(existsSync(cli)).toBe(true);
    expect(w.removals.every((x) => ASIDE.test(path.basename(x.what)))).toBe(true);
  });

  it("M4: with a copy to remove, the proof is taken before the first removal as well: the copy in the home is asked twice, and no other", async () => {
    const typed = path.join(installed(LOCAL(), "1.0.0"), "dist", "cli.js");
    const stray = installed(NVM(), "0.15.0");
    onPath(path.join(LOCAL(), "bin"));
    const w = onDisk();
    const r = await w.run({}, "reinstall", "--yes");
    expect(r.lines.at(-1)).toBe(`✓ ${ONE.said}`);
    expect(w.ran).toEqual([typed, path.join(slotOf(w.installs[0]?.prefix as string), "dist", "cli.js"), typed, typed]);
    expect(w.ran).not.toContain(path.join(stray, "dist", "cli.js"));
    expect(w.looks.map((l) => "runs" in l)).toEqual([true, false, false]);
    // The stray went with its own link, after that proof.
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(binOf(NVM()))).toBe(false);
    expect(r.lines).toContain("  ✓ removed 0.15.0 in ~/.nvm/versions/node/v22.1.0, with its link");
  });

  it("M5: started from a project's own dependency in a folder named lib: it is left alone and named, never removed, and nothing is installed into the project", async () => {
    // ~/work/app/lib is a project (its own package.json and lock) that depends on
    // sessionpipe; `npx sessionpipe reinstall` there starts the project's copy, with the
    // project's `.bin` first on PATH.
    const project = path.join(home, "work", "app", "lib");
    put(path.join(project, "package.json"), { name: "app-lib", dependencies: { sessionpipe: "^0.15.0" } });
    put(path.join(project, "package-lock.json"), { name: "app-lib", lockfileVersion: 3 });
    const dep = unpack(path.join(project, "node_modules", "sessionpipe"), "0.15.9");
    mkdirSync(path.join(project, "node_modules", ".bin"));
    symlinkSync(
      path.join("..", "sessionpipe", "dist", "cli.js"),
      path.join(project, "node_modules", ".bin", "sessionpipe"),
    );
    mkdirSync(path.join(LOCAL(), "bin"), { recursive: true });
    onPath(path.join(project, "node_modules", ".bin"), path.join(LOCAL(), "bin"));
    const w = onDisk(await from(dep));
    // npx started it: it says so to all it starts, and its own `.bin` is on PATH for this run alone.
    vi.stubEnv("npm_command", "exec");
    const before = tree(path.join(home, "work"));
    const r = await w.run({}, "reinstall", "--yes");
    // By its path alone it sits where a prefix `~/work/app` would keep a global package.
    // It was shown as "0.15.9 ~/work/app · you type this" and removed by npm from there.
    expect(w.seen[0]?.copies).toEqual([
      expect.objectContaining({
        dir: dep,
        slot: null,
        not: "it is not a global install or an npx cache entry (a project's own dependency?)",
        uses: ["this"],
      }),
    ]);
    expect(w.seen[0]?.prefixes).not.toContain(path.join(home, "work", "app"));
    // npx's own entry on PATH for this run is nobody's to type.
    expect(w.seen[0]?.onPath).toEqual([]);
    expect(w.seen[0]?.typed).toBeNull();
    expect(r.lines).toEqual([
      "Found no copy of sessionpipe on this computer",
      "",
      "This will",
      "  + install  9.9.9, the newest release, fresh in ~/.local (npm's global folder)",
      KEEP,
      "",
      "Left alone",
      "  · ~/work/app/lib/node_modules/sessionpipe",
      "      it is not a global install or an npx cache entry (a project's own dependency?)",
      "",
      SAFE,
      "",
      "  ✓ sessionpipe 9.9.9 downloaded",
      "  ✓ installed fresh in ~/.local, and it runs",
      "  ✓ the copy in ~/.local runs: `--version` says 9.9.9",
      "  ✓ typing `sessionpipe` starts it: ~/.local/bin/sessionpipe",
      "",
      `✓ ${ONE.said}`,
    ]);
    expect(r.text).not.toContain("you type this");
    expect(r.err).not.toHaveBeenCalled();
    // The project is as it was, byte for byte: its dependency, its `.bin` link, its lock.
    expect(tree(path.join(home, "work"))).toEqual(before);
    // npm made no `bin` in what it took for a prefix, and was handed nothing in the project.
    expect(existsSync(path.join(home, "work", "app", "bin"))).toBe(false);
    expect(w.installs.map((i) => i.prefix)).toEqual([expect.stringMatching(staging(LOCAL()))]);
    expect(w.npm.flat().some((x) => x.startsWith(path.join(home, "work")))).toBe(false);
    expect(w.removals.map((x) => x.what)).toEqual([expect.stringMatching(staging(LOCAL()))]);
    // The one clean copy is where a shell finds it, with the link the run made for it (L2:
    // the prefix had a `bin` and no link; npm's stand-in put its link in the folder beside the slot).
    expect(versionOf(slotOf(LOCAL()))).toBe(NEWEST);
    expect(readlinkSync(binOf(LOCAL()))).toBe(path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"));
    expect(beside(LOCAL())).toEqual(["sessionpipe"]);
    // Asked outright, the removal refuses the project's copy, by the run's own proof.
    const d = w.m.carryOut.mock.calls[0]?.[1] as Doing;
    await expect(d.remove(dep)).rejects.toThrow("a project's own dependency?");
    expect(tree(path.join(home, "work"))).toEqual(before);
    // The same `.bin` on a person's own PATH, with no npm about: what is typed is the
    // project's dependency. It is left alone, and the line names nothing that installs:
    // it was `npm install -g --prefix ~/work/app sessionpipe@9.9.9` (the folder above a
    // `lib` taken for a prefix), and pasted, npm wrote over the dependency.
    vi.stubEnv("npm_command", undefined as unknown as string);
    // Beside the one clean copy the run has just made, that is a finding and no refusal.
    const noted = await w.run({}, "reinstall", "--yes");
    expect(noted.err).not.toHaveBeenCalled();
    expect(noted.lines.slice(-2)).toEqual([
      `✓ ${ONE_COPY}`,
      "! Typing `sessionpipe` starts ~/work/app/lib/node_modules/sessionpipe, which is no installed copy of it.",
    ]);
    // With something to repair (that copy a release behind) nothing is done.
    put(path.join(slotOf(LOCAL()), "package.json"), { name: "sessionpipe", version: "1.0.0" });
    const typed = await w.run({}, "reinstall", "--yes");
    expect(w.seen.at(-1)?.typed).toBe(dep);
    expect(w.seen.at(-1)?.copies.find((c) => c.dir === dep)?.prefix).toBeNull();
    expect(typed.err).toHaveBeenCalledWith(
      "sessionpipe: Typing `sessionpipe` starts ~/work/app/lib/node_modules/sessionpipe, which is no installed copy of it (it is not a global install or an npx cache entry (a project's own dependency?)): this command leaves it alone, so it can't put one clean copy in its place. Nothing was changed. Next: which -a sessionpipe\n",
    );
    expect(typed.exit).toHaveBeenCalledWith(1);
    expect(w.npm.flat().some((x) => x.startsWith(path.join(home, "work")))).toBe(false);
    expect(tree(path.join(home, "work"))).toEqual(before);
  });

  it("M5: the same project where npm itself names its parent folder as its prefix: a package.json beside node_modules says whose it is, and it is left alone", async () => {
    const project = path.join(home, "work", "app", "lib");
    put(path.join(project, "package.json"), { name: "app-lib", dependencies: { sessionpipe: "^0.15.0" } });
    const dep = unpack(path.join(project, "node_modules", "sessionpipe"), "0.15.9");
    mkdirSync(path.join(LOCAL(), "bin"), { recursive: true });
    onPath(path.join(LOCAL(), "bin"));
    const w = onDisk(await from(dep));
    // `npm prefix -g` answers ~/work/app: the dependency then sits exactly where that
    // prefix keeps a global package, in a folder that was looked in as a prefix.
    w.npmPrefix = path.join(home, "work", "app");
    const before = tree(path.join(home, "work"));
    const r = await w.run({}, "reinstall", "--yes");
    expect(w.seen[0]?.prefixes).toContain(path.join(home, "work", "app"));
    expect(w.seen[0]?.copies).toEqual([
      expect.objectContaining({
        dir: dep,
        slot: null,
        not: "the node_modules folder it is in is a project's own (a package.json is beside it)",
      }),
    ]);
    // The one copy does not go into a prefix whose slot holds what is not ours.
    expect(w.seen[0]?.home?.prefix).toBe(LOCAL());
    expect(r.lines.slice(0, 9)).toEqual([
      "Found no copy of sessionpipe on this computer",
      "",
      "This will",
      "  + install  9.9.9, the newest release, fresh in ~/.local (a folder of your own)",
      KEEP,
      "",
      "Left alone",
      "  · ~/work/app/lib/node_modules/sessionpipe",
      "      the node_modules folder it is in is a project's own (a package.json is beside it)",
    ]);
    expect(r.lines.at(-1)).toBe(`✓ ${ONE.said}`);
    expect(r.err).not.toHaveBeenCalled();
    expect(tree(path.join(home, "work"))).toEqual(before);
    expect(existsSync(path.join(home, "work", "app", "bin"))).toBe(false);
    expect(w.installs.map((i) => i.prefix)).toEqual([expect.stringMatching(staging(LOCAL()))]);
    expect(w.removals.map((x) => x.what)).toEqual([expect.stringMatching(staging(LOCAL()))]);
    expect(versionOf(slotOf(LOCAL()))).toBe(NEWEST);
  });

  it("a home that is a link ($HOME names it by another spelling than the disk): every line of a whole run reads `~`, the plan's and the run's, and no line has the real path", async () => {
    const w = onDisk();
    installed(LOCAL(), "1.0.0");
    installed(NVM(), "0.9.0");
    const alias = path.join(tmp, "also-home");
    symlinkSync(home, alias);
    vi.stubEnv("HOME", alias);
    onPath(path.join(alias, ".local", "bin"));
    const r = await w.run({}, "reinstall", "--yes");
    expect(r.lines).toEqual([
      "Found 2 copies of sessionpipe on this computer",
      "  · 1.0.0  ~/.local                      you type this",
      "  · 0.9.0  ~/.nvm/versions/node/v22.1.0  nothing uses it",
      "",
      "This will",
      "  + install  9.9.9, the newest release, fresh in ~/.local (replaces 1.0.0)",
      "  - remove   0.9.0 in ~/.nvm/versions/node/v22.1.0",
      KEEP,
      "",
      SAFE,
      "",
      "  ✓ sessionpipe 9.9.9 downloaded",
      "  ✓ installed fresh in ~/.local, and it runs (what was there is gone)",
      "  ✓ removed 0.9.0 in ~/.nvm/versions/node/v22.1.0, with its link",
      "  ✓ the copy in ~/.local runs: `--version` says 9.9.9",
      "  ✓ typing `sessionpipe` starts it: ~/.local/bin/sessionpipe",
      "  ✓ nothing here names a removed copy any more",
      "",
      `✓ ${ONE.said}`,
    ]);
    expect(r.text).not.toContain(tmp);
    expect(r.err).not.toHaveBeenCalled();
    // A refusal's sentence too (the home's own folder, by the look's spelling of it).
    put(binOf(NVM()), "#!/bin/sh\n");
    rmSync(binOf(LOCAL()));
    put(binOf(LOCAL()), "#!/bin/sh\n");
    put(path.join(slotOf(LOCAL()), "package.json"), { name: "sessionpipe", version: "1.0.0" });
    const refused = await w.run({}, "reinstall", "--yes");
    const said = String(refused.err.mock.calls[0]?.[0]);
    expect(said).toMatch(/^sessionpipe: ~\/\.local\/bin\/sessionpipe is not sessionpipe's/);
    // The line to paste keeps the whole path, by the disk's own name for it.
    expect(said).toContain(`Next: mv -n ${binOf(LOCAL())} ${binOf(LOCAL())}.old\n`);
  });

  it("L4: what a killed `npm install -g` left where the typed copy was: nothing is removed or installed, and the one line moves that folder aside (no line of npm's: run for real, it failed there); moved, the next run finishes the job", async () => {
    // npm's tarball has package.json last: cut off, the folder holds what a published copy
    // holds and no package.json. npm's own link to it is still in place, so it is what
    // typing starts; it is not provably ours, so it is never this command's to remove.
    const w = onDisk();
    const dir = unpack(slotOf(LOCAL()), "1.0.0");
    rmSync(path.join(dir, "package.json"));
    link(LOCAL());
    installed(NVM(), "0.9.0");
    onPath(path.join(LOCAL(), "bin"));
    const before = tree(tmp);
    const said = `sessionpipe: Typing \`sessionpipe\` starts ~/.local/lib/node_modules/sessionpipe, which is no installed copy of it (it has no package.json that can be read (an install that was cut off?)): this command leaves it alone, so it can't put one clean copy in its place. Nothing was changed. Move it aside, then run this again. Next: mv -n ${dir} ${dir}.old\n`;
    for (const flags of [["--yes"], ["--dry-run"], []]) {
      const r = await w.run({}, "reinstall", ...flags);
      expect(r.err).toHaveBeenCalledWith(said);
      expect(r.exit).toHaveBeenCalledWith(1);
      // What was found: the one copy the proof accepts. What was cut off is no row of it.
      expect(r.lines).toEqual([
        "Found one copy of sessionpipe on this computer",
        "  · 0.9.0  ~/.nvm/versions/node/v22.1.0  nothing uses it",
      ]);
    }
    expect(said).not.toMatch(/npm install|sudo/);
    expect(w.seen[0]?.copies.find((c) => c.dir === dir)).toMatchObject({
      slot: null,
      prefix: null,
      aside: false,
      version: null,
      uses: ["typed"],
    });
    expect(w.seen[0]).toMatchObject({ typed: dir, home: null, taken: null });
    // M4: a folder the proof refuses is not started to be asked anything.
    expect(w.ran).toEqual([]);
    expect(w.installs).toEqual([]);
    expect(w.removals).toEqual([]);
    expect(w.npm.every((x) => x.join(" ") === "prefix -g")).toBe(true);
    expect(tree(tmp)).toEqual(before);
    // Doctor says the same of it, in the plan's own sentence, with nothing to type.
    const doctor = await w.run({}, "doctor", "--json");
    expect((JSON.parse(doctor.text) as { warnings: string[] }).warnings).toContain(
      "Typing `sessionpipe` starts ~/.local/lib/node_modules/sessionpipe, which is no installed copy of it.",
    );
    // The person does as the line says. Then npm's link leads nowhere, its prefix is
    // where a link already is, and the run installs there and removes the stray: one copy.
    renameSync(dir, `${dir}.old`);
    const again = await w.run({}, "reinstall", "--yes");
    expect(again.err).not.toHaveBeenCalled();
    expect(again.lines.at(-1)).toBe(`✓ ${ONE.said}`);
    expect(versionOf(slotOf(LOCAL()))).toBe(NEWEST);
    expect(existsSync(slotOf(NVM()))).toBe(false);
    // What was moved aside is the person's, and is still there as they left it.
    expect(readdirSync(`${dir}.old`).sort()).toEqual(["LICENSE", "NOTICE", "README.md", "dist"]);
  });

  it("L4: nothing is typed, and the one place the copy could go holds what a killed install left: the folder in the way is named with why, and the one line moves it aside; moved, the run installs there", async () => {
    const w = onDisk();
    const dir = unpack(slotOf(LOCAL()), "1.0.0");
    rmSync(path.join(dir, "package.json"));
    mkdirSync(path.join(LOCAL(), "bin"), { recursive: true });
    onPath(path.join(LOCAL(), "bin"));
    const before = tree(tmp);
    const r = await w.run({}, "reinstall", "--yes");
    expect(r.err).toHaveBeenCalledWith(
      `sessionpipe: ~/.local/lib/node_modules/sessionpipe is not provably sessionpipe's (it has no package.json that can be read (an install that was cut off?)), and it is where the one copy goes. Nothing was changed. Move it aside, then run this again. Next: mv -n ${dir} ${dir}.old\n`,
    );
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.lines).toEqual(["Found no copy of sessionpipe on this computer"]);
    expect(w.seen[0]).toMatchObject({
      typed: null,
      home: null,
      taken: { dir, why: "it has no package.json that can be read (an install that was cut off?)" },
    });
    expect(w.installs).toEqual([]);
    expect(w.removals).toEqual([]);
    expect(tree(tmp)).toEqual(before);
    renameSync(dir, `${dir}.old`);
    const again = await w.run({}, "reinstall", "--yes");
    expect(again.err).not.toHaveBeenCalled();
    expect(again.lines.at(-1)).toBe(`✓ ${ONE.said}`);
    expect(versionOf(slotOf(LOCAL()))).toBe(NEWEST);
  });

  it("L6: what is left of a copy that could only be emptied (an empty folder in a slot, its link still beside it) is found as a leftover and taken by the next run", async () => {
    const w = onDisk();
    installed(LOCAL(), NEWEST);
    onPath(path.join(LOCAL(), "bin"));
    // What a removal that stopped at the folder itself leaves: nothing in it, npm's link there.
    mkdirSync(slotOf(NVM()), { recursive: true });
    link(NVM());
    const r = await w.run({}, "reinstall", "--yes");
    expect(r.lines).toEqual([
      "Found 2 copies of sessionpipe on this computer",
      "  · 9.9.9      ~/.local                      you type this",
      "  ✗ left over  ~/.nvm/versions/node/v22.1.0  nothing uses it · left behind by an install that was cut off",
      "",
      "This will",
      "  + install  9.9.9, the newest release, fresh in ~/.local (replaces 9.9.9)",
      "  - remove   a leftover folder in ~/.nvm/versions/node/v22.1.0",
      KEEP,
      "",
      SAFE,
      "",
      "  ✓ sessionpipe 9.9.9 downloaded",
      "  ✓ installed fresh in ~/.local, and it runs (what was there is gone)",
      "  ✓ removed a leftover folder in ~/.nvm/versions/node/v22.1.0, with its link",
      "  ✓ the copy in ~/.local runs: `--version` says 9.9.9",
      "  ✓ typing `sessionpipe` starts it: ~/.local/bin/sessionpipe",
      "  ✓ nothing here names a removed copy any more",
      "",
      `✓ ${ONE.said}`,
    ]);
    expect(r.err).not.toHaveBeenCalled();
    expect(existsSync(slotOf(NVM()))).toBe(false);
    expect(existsSync(binOf(NVM()))).toBe(false);
    // And a second run has nothing to repair.
    expect((await w.run({}, "reinstall", "--yes")).lines).toEqual(CLEAN);
    // The same folder in the HOME's own slot (the typed copy was emptied, its link still
    // there): doctor calls it a leftover, and the run installs over it where it is.
    rmSync(slotOf(LOCAL()), { recursive: true });
    mkdirSync(slotOf(LOCAL()));
    const doctor = await w.run({}, "doctor");
    expect(doctor.text).toMatch(/copies +a leftover in ~\/\.local \(left behind by an install that was cut off\)/);
    expect(doctor.text).not.toContain("null");
    const mended = await w.run({}, "reinstall", "--yes");
    expect(mended.lines).toContain(
      "  + install  9.9.9, the newest release, fresh in ~/.local (where the one you type is)",
    );
    expect(mended.text).not.toContain("null");
    expect(mended.err).not.toHaveBeenCalled();
    expect(mended.lines.at(-1)).toBe(`✓ ${ONE.said}`);
    expect(versionOf(slotOf(LOCAL()))).toBe(NEWEST);
    expect(beside(LOCAL())).toEqual(["sessionpipe"]);
  });

  it("M3: one whole copy of the newest release that no folder on PATH leads to, beside an empty folder of one's own that is on PATH: not 'Nothing to repair': the copy's own folder is named, by reinstall and by doctor", async () => {
    // Typing `sessionpipe` finds nothing here. Nothing was typed, the home (the first
    // place a shell looks in) was on PATH, the one copy was whole: "Nothing to repair",
    // and doctor "All good".
    const w = onDisk();
    const prefix = path.join(home, ".npm-global");
    installed(prefix, NEWEST);
    mkdirSync(path.join(LOCAL(), "bin"), { recursive: true });
    onPath(path.join(LOCAL(), "bin"));
    w.npmPrefix = prefix;
    const before = tree(tmp);
    const OFF = "~/.npm-global/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.";
    const r = await w.run({}, "reinstall", "--yes");
    expect(r.lines).toEqual([
      "Found one copy of sessionpipe on this computer",
      "  · 9.9.9  ~/.npm-global  nothing uses it",
      "",
      `✓ ${ONE_COPY}`,
      `! ${OFF}`,
    ]);
    expect(r.err).not.toHaveBeenCalled();
    expect(w.seen[0]?.copies.map((c) => c.onPath)).toEqual([false]);
    const doctor = await w.run({}, "doctor");
    expect(doctor.lines[0]).toBe("! 1 thing needs attention");
    expect(doctor.text).toContain(OFF);
    expect(tree(tmp)).toEqual(before);
    // Its folder on PATH: typed, nothing to repair, all good.
    onPath(path.join(LOCAL(), "bin"), path.join(prefix, "bin"));
    expect((await w.run({}, "reinstall", "--yes")).lines.at(-1)).toBe(`✓ ${NOTHING}`);
    expect((await w.run({}, "doctor")).lines[0]).toBe("✓ All good");
  });

  it("L1: an install that fails has touched nothing: the copy that was there is in its slot byte for byte, with its link, and what npm left beside it is gone", async () => {
    const w = onDisk();
    installed(LOCAL(), "1.0.0");
    onPath(path.join(LOCAL(), "bin"));
    const before = tree(tmp);
    // npm unpacks half a copy into the folder it was handed, and fails.
    w.m.installInto.mockImplementationOnce(async (prefix) => {
      w.installs.push({ prefix, version: NEWEST, distDir: "" });
      put(path.join(slotOf(prefix), "package.json"), { name: "sessionpipe", version: NEWEST });
      put(path.join(prefix, "lib", "node_modules", ".package-lock.json"), {});
      // While npm works the slot still holds the copy that was there, whole: a run cut
      // off here leaves a computer that works.
      expect(versionOf(slotOf(LOCAL()))).toBe("1.0.0");
      expect(readlinkSync(binOf(LOCAL()))).toBe(
        path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"),
      );
      expect(beside(LOCAL())).toEqual([path.basename(prefix), "sessionpipe"]);
      return { ok: false, stage: "npm", error: "npm install: npm error code E404" };
    });
    const r = await w.run({}, "reinstall", "--yes");
    expect(r.err).toHaveBeenCalledWith(
      "sessionpipe: sessionpipe 9.9.9 couldn't be installed in ~/.local: npm install: npm error code E404. Nothing was changed. Next: sessionpipe reinstall\n",
    );
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(w.installs[0]?.prefix).toMatch(staging(LOCAL()));
    // The folder npm was handed is a shape the proof knows: the one removal took it.
    expect(w.removals.map((x) => x.what)).toEqual([w.installs[0]?.prefix]);
    expect(tree(tmp)).toEqual(before);
  });

  it("L2: the fresh copy is in its place and a file of someone's has taken the place of its link: the run stops, and names the way in that does not need the installed command", async () => {
    const w = onDisk();
    installed(LOCAL(), "1.0.0");
    onPath(path.join(LOCAL(), "bin"));
    const standIn = w.m.installInto.getMockImplementation() as typeof installInto;
    // While npm works, something writes a script where npm's link was.
    w.m.installInto.mockImplementationOnce(async (prefix, version, how) => {
      rmSync(binOf(LOCAL()));
      put(binOf(LOCAL()), "#!/bin/sh\n");
      return standIn(prefix, version, how);
    });
    const r = await w.run({}, "reinstall", "--yes");
    // `sessionpipe reinstall` may not start any more: the line is npx's.
    expect(r.err).toHaveBeenCalledWith(
      "sessionpipe: sessionpipe 9.9.9 couldn't be installed in ~/.local: the fresh copy is in its place, and the link that starts it couldn't be made. Next: npx -y sessionpipe@latest reinstall\n",
    );
    expect(r.exit).toHaveBeenCalledWith(1);
    // The file was not written over, and the fresh copy is whole in the slot.
    expect(readFileSync(binOf(LOCAL()), "utf8")).toBe("#!/bin/sh\n");
    expect(versionOf(slotOf(LOCAL()))).toBe(NEWEST);
    expect(beside(LOCAL())).toEqual(["sessionpipe"]);
  });
});
