// SPDX-License-Identifier: Apache-2.0
// `sessionpipe reinstall` as the command wires it: what it reads before it decides, the
// two screens, the one question, each way a run ends, and every effect it hands the run
// (run.ts has the run itself, plan.ts the plan, find.ts the look, ours.ts the removal).
// And what `doctor` and `status` say of the same look. The look, the run, the removal,
// npm, the service manager and the question are all stood in for at their module
// boundary: nothing here installs, removes or signals anything real.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { elsewhere, serviceLook } from "../src/control/health.js";
import { placeService, uninstallService } from "../src/control/pair.js";
import { bringCurrent, type CurrentDeps } from "../src/current.js";
import { installLauncher, launcherPath, launcherState } from "../src/launcher.js";
import { type Copy, type Inventory, type Looking, look } from "../src/reinstall/find.js";
import { remove } from "../src/reinstall/ours.js";
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
  uninstallService: vi.fn(),
}));
vi.mock("../src/control/health.js", async (original) => {
  const real = await original<typeof import("../src/control/health.js")>();
  return { ...real, serviceLook: vi.fn(() => null), elsewhere: vi.fn(real.elsewhere) };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const realDist = path.resolve(here, "../dist");
const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
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
});
afterEach(async () => {
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
  runs: true,
  wrong: null,
  bins: [binOf(prefix)],
  uses: [],
  writable: true,
  keeper: null,
  ...o,
});
/** The home the fresh copy goes to: `~/.local`, its bin folder first on PATH, or not on it. */
const home0 = (o: Partial<Inventory["homes"][number]> = {}): Inventory["homes"][number] => ({
  prefix: LOCAL(),
  shown: "~/.local",
  why: "where the one you type is",
  bin: path.join(LOCAL(), "bin"),
  pathAt: 0,
  blocked: null,
  ...o,
});
function inventory(o: Partial<Inventory> = {}): Inventory {
  return {
    platform: process.platform,
    reach: home,
    copies: [],
    dangling: [],
    strangers: [],
    onPath: [],
    homes: [home0()],
    prefixes: [LOCAL(), NVM()],
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
    ...o,
  });
/** One clean copy of the newest release, typed and run from: nothing to repair. */
const one = (o: Partial<Inventory> = {}): Inventory =>
  inventory({
    copies: [copy(LOCAL(), { uses: ["typed", "this"] })],
    onPath: [{ file: binOf(LOCAL()), dir: slotOf(LOCAL()), at: 0 }],
    ...o,
  });
/** The one you type is an old release, and nvm's Node has another: something to repair. */
const two = (o: Partial<Inventory> = {}): Inventory =>
  inventory({
    copies: [copy(LOCAL(), { version: "1.0.0", uses: ["typed", "this"] }), copy(NVM(), { version: "0.9.0" })],
    onPath: [{ file: binOf(LOCAL()), dir: slotOf(LOCAL()), at: 0 }],
    ...o,
  });
const ONE: Done = {
  state: "one",
  said: `This computer has one sessionpipe: ${NEWEST}, in ~/.local. Pairings and settings are as they were.`,
  warn: [],
};
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
/** The question, answered. */
function answer(text: string) {
  const rl = { question: vi.fn(async () => text), close: vi.fn() };
  vi.mocked(createInterface).mockReturnValue(rl as never);
  return rl;
}

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
    expect(looked()).toMatchObject({
      platform: process.platform,
      env: process.env,
      home,
      // This test's world keeps its files in a temp folder: its own home is all it may call its own.
      reach: home,
      execPath: process.execPath,
      distDir: realDist,
      npmPrefix: path.join(home, ".npm-global"),
      serviceCli: null,
      hooksVersion: null,
    });
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

  it("a copy is asked for its version by running it: what it prints is its version, or it doesn't run", async () => {
    vi.mocked(look).mockReturnValue(one());
    await run({}, "reinstall");
    const cli = path.join(slotOf(LOCAL()), "dist", "cli.js");
    const says = (r: { status: number | null; stdout?: string }) =>
      vi.mocked(spawnSync).mockReturnValueOnce({ stderr: "", ...r } as never);
    says({ status: 0, stdout: "1.2.3\n" });
    expect(looked().version(cli)).toBe("1.2.3");
    expect(spawnSync).toHaveBeenLastCalledWith(process.execPath, [cli, "--version"], {
      encoding: "utf8",
      timeout: 20_000,
    });
    says({ status: 0, stdout: "0.16.0-rc.1+build.5\n" });
    expect(looked().version(cli)).toBe("0.16.0-rc.1+build.5");
    // It failed, printed something that is no version, or could not be started at all.
    says({ status: 1, stdout: "1.2.3\n" });
    expect(looked().version(cli)).toBeNull();
    says({ status: 0, stdout: "SyntaxError: Unexpected token\n" });
    expect(looked().version(cli)).toBeNull();
    says({ status: 0, stdout: "" });
    expect(looked().version(cli)).toBeNull();
    says({ status: null });
    expect(looked().version(cli)).toBeNull();
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
    // Windows has no launcher: the hooks name this copy, and no release of their own.
    onPlatform("win32");
    await run({}, "reinstall");
    expect(facts().hooks.version).toBeNull();
    expect(facts().hooks.wrong.every((w) => w.startsWith("claude-code: "))).toBe(true);
    expect(facts().hookFiles).toEqual([path.join(home, ".claude", "settings.json")]);
    expect(looked().hooksVersion).toBeNull();
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
    vi.mocked(serviceLook).mockReturnValue(service({ installed: false, loaded: false, argv: null, pid: null }));
    await run({}, "reinstall");
    expect(facts()).toMatchObject({ wanted: true, service: null });
    expect(looked().serviceCli).toBeNull();
    // A file that names a node and a copy that are there.
    const cli = path.join(slotOf(LOCAL()), "dist", "cli.js");
    put(cli, "");
    const s = service();
    vi.mocked(serviceLook).mockReturnValue(s);
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
    vi.mocked(serviceLook).mockReturnValue(
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
    vi.mocked(serviceLook).mockReturnValue(service({ argv: null }));
    await run({}, "reinstall");
    expect(facts().service).toMatchObject({ node: null, nodeOk: false, cliOk: false });
    expect(looked().serviceCli).toBeNull();
    vi.mocked(serviceLook).mockReturnValue(service({ argv: [process.execPath] }));
    await run({}, "reinstall");
    expect(facts().service).toMatchObject({ node: process.execPath, nodeOk: true, cliOk: false });
    // The daemon that answers, by its own account.
    await daemon({ status: status("1.0.0") });
    await run({}, "reinstall");
    expect(facts()).toMatchObject({ daemon: { pid: 4242, version: "1.0.0" }, staleSocket: false });
  });

  it("a socket file with no daemon behind it is said; on Windows there is no such file", async () => {
    vi.mocked(look).mockReturnValue(one());
    put(process.env.SESSIONPIPE_SOCKET as string, "");
    const r = await run({}, "reinstall");
    expect(facts()).toMatchObject({ daemon: null, staleSocket: true });
    expect(r.text).toContain("a socket file is there with no daemon behind it");
    onPlatform("win32");
    await run({}, "reinstall");
    expect(facts().staleSocket).toBe(false);
  });

  it("a world of its own is said as that, with the line that runs this without it", async () => {
    vi.mocked(look).mockReturnValue(one());
    await run({}, "reinstall");
    const state = process.env.SESSIONPIPE_STATE as string;
    expect(facts().apart).toEqual({
      said: `This sessionpipe keeps its files in ${state}, not in this computer's usual place (${vi.mocked(elsewhere).mock.results.at(-1)?.value.usual})`,
      line: "env -u SESSIONPIPE_STATE -u SESSIONPIPE_CONFIG sessionpipe reinstall",
    });
    // A folder under the home is said as `~/…`.
    vi.mocked(elsewhere).mockReturnValue({ now: path.join(home, "st"), usual: path.join(home, "usual") });
    await run({}, "reinstall");
    expect(facts().apart?.said).toBe(
      "This sessionpipe keeps its files in ~/st, not in this computer's usual place (~/usual)",
    );
    // Windows has no `env`: there the command is said as it is.
    onPlatform("win32");
    await run({}, "reinstall");
    expect(facts().apart?.line).toBe("sessionpipe reinstall");
    // In this account's usual place there is nothing to say.
    vi.mocked(elsewhere).mockReturnValue(null);
    await run({}, "reinstall");
    expect(facts().apart).toBeNull();
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
      "✓ This computer has one sessionpipe: 9.9.9, in ~/.local, the newest release. Nothing to repair.",
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(r.exit).not.toHaveBeenCalled();
    expect(createInterface).not.toHaveBeenCalled();
    expect(carryOut).not.toHaveBeenCalled();
    // The same with every option, and at a terminal: green, bold, under its mark.
    for (const o of [["--yes"], ["-y"], ["--dry-run"], ["--dry-run", "--yes"]])
      expect((await run({}, "reinstall", ...o)).lines).toEqual(r.lines);
    const term = await run({ tty: true, columns: 80 }, "reinstall");
    expect(term.lines.slice(-2)).toEqual([
      `${ESC}[32m${ESC}[1m✓ This computer has one sessionpipe: 9.9.9, in ~/.local, the newest release.${ESC}[22m${ESC}[39m`,
      `${ESC}[32m${ESC}[1m  Nothing to repair.${ESC}[22m${ESC}[39m`,
    ]);
    expect(carryOut).not.toHaveBeenCalled();
  });

  it("nothing to repair, and something to say beside it: each note on its line, the last line yellow", async () => {
    paired();
    vi.mocked(look).mockReturnValue(one({ onPath: [], homes: [home0({ pathAt: null })] }));
    const r = await run({}, "reinstall");
    expect(r.lines.slice(2)).toEqual([
      // The folder is under the home: `~/…`, as everywhere on this page.
      "  ! ~/.local/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.",
      "  ! The background service isn't running, and nothing here starts it by itself: `sessionpipe control run` does.",
      "",
      "! This computer has one sessionpipe: 9.9.9, in ~/.local, the newest release. Nothing to repair.",
    ]);
    expect(process.exitCode).toBeUndefined();
    const term = await run({ tty: true, columns: 200 }, "reinstall");
    expect(term.lines.at(-1)).toBe(
      `${ESC}[33m${ESC}[1m! This computer has one sessionpipe: 9.9.9, in ~/.local, the newest release. Nothing to repair.${ESC}[22m${ESC}[39m`,
    );
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
    vi.mocked(look).mockReturnValue(inventory({ reach: null, homes: [] }));
    const r = await run({}, "reinstall", "--yes");
    expect(r.err).toHaveBeenCalledWith(
      expect.stringMatching(
        /^sessionpipe: This sessionpipe keeps its files in .*, not in this computer's usual place \(.*\), so it leaves this computer's copies alone\. Nothing was changed\. Next: env -u SESSIONPIPE_STATE -u SESSIONPIPE_CONFIG sessionpipe reinstall\n$/,
      ),
    );
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(carryOut).not.toHaveBeenCalled();
    // It looked nowhere, so it does not say it found no copy: only the refusal is said.
    expect(r.lines).toEqual([]);
  });

  it("one clean copy beside what npx fetched to run this, and a checkout: both found, both said to be left, nothing to repair", async () => {
    vi.mocked(look).mockReturnValue(
      one({
        copies: [copy(LOCAL(), { uses: ["typed"] }), npxEntry("0a1b2c3d4e5f6a7b", { uses: ["this"] }), checkout()],
      }),
    );
    const r = await run({}, "reinstall");
    // Three were found and one is this computer's: the sentence says what the others are.
    expect(r.lines).toEqual([
      "Found 3 copies of sessionpipe on this computer",
      "  · 9.9.9  ~/.local                        you type this",
      "  · 9.9.9  ~/.npm/_npx/0a1b2c3d4e5f6a7b    this command",
      "  · 9.9.9  ~/src/sessionpipe/packages/cli  nothing uses it · not an install: it is not a folder named node_modules/sessionpipe",
      "",
      "✓ This computer has one sessionpipe: 9.9.9, in ~/.local, the newest release. Nothing to repair. The copy in the npx cache is npm's own cache: it is left. What is no install of it is left alone.",
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(carryOut).not.toHaveBeenCalled();
    // The same through `npx … reinstall --yes`: run again, it is still nothing to repair.
    expect((await run({}, "reinstall", "--yes")).lines).toEqual(r.lines);
    expect(carryOut).not.toHaveBeenCalled();
  });

  it("a node and a copy the service file names that are gone are said under 'Also found', the node as a person reads it", async () => {
    paired();
    vi.mocked(look).mockReturnValue(one());
    vi.mocked(serviceLook).mockReturnValue(
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

  it("what stays on PATH behind the home's own bin folder is not what a shell finds first: no note; ahead of it, it is", async () => {
    // A fresh copy goes to ~/.local, which has none yet; a checkout's link stays on PATH.
    const stays = path.join(home, "bin", "sessionpipe");
    const world = (pathAt: number | null) =>
      inventory({
        copies: [checkout(), copy(NVM(), { version: "0.9.0" })],
        onPath: [{ file: stays, dir: checkout().dir, at: 1 }],
        homes: [home0({ why: "a folder of your own", pathAt })],
      });
    const behind = await ends(ONE, {}, world(0));
    expect(planned()).toMatchObject({ first: null, notes: [] });
    expect(behind.text).not.toContain("What a shell finds first");
    expect(behind.lines.at(-1)).toBe(`✓ ${ONE.said}`);
    // The same link ahead of the home's bin folder: said on the plan's screen and on the last line.
    const ahead = await ends(ONE, {}, world(2));
    expect(planned().first).toBe(stays);
    const note =
      "What a shell finds first is ~/bin/sessionpipe, which is not this copy: typing `sessionpipe` starts that one.";
    expect(ahead.lines).toContain(`  ! ${note}`);
    expect(ahead.lines.at(-1)).toBe(`! ${ONE.said} ${note}`);
    // And where the home's bin folder is not on PATH at all, with the note that says so first.
    const off = await ends(ONE, {}, world(null));
    expect(planned().notes).toEqual([
      "~/.local/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.",
      note,
    ]);
    expect(off.lines.at(-1)).toBe(`! ${ONE.said} ${planned().notes.join(" ")}`);
  });

  it("a file that is no install of sessionpipe where the fresh copy's link goes: nothing is done, and the one line moves it", async () => {
    // A script of someone's at ~/.local/bin/sessionpipe: npm will not put its link over
    // it, and it is not this command's to move.
    const script = binOf(LOCAL());
    const blocked = (o: Partial<Inventory>) =>
      two({
        strangers: [{ file: script, why: "a file of that name that npm didn't put there" }],
        onPath: [{ file: script, dir: null, at: 0 }],
        homes: [home0({ blocked: script })],
        ...o,
      });
    vi.mocked(look).mockReturnValue(blocked({}));
    const said = `sessionpipe: ~/.local/bin/sessionpipe is a file sessionpipe did not put there, and it sits where the link to the fresh copy goes: npm will not put its link over it. Nothing was changed. Move it out of the way, then run this again. Next: mv ${script} ${script}.old\n`;
    for (const flags of [[], ["--yes"], ["--dry-run"]]) {
      const r = await run({}, "reinstall", ...flags);
      expect(r.err).toHaveBeenCalledWith(said);
      expect(r.exit).toHaveBeenCalledWith(1);
      // What was found is shown; no plan is, for there is none.
      expect(r.lines).toContain("  ! ~/.local/bin/sessionpipe is a file of that name that npm didn't put there");
      expect(r.lines).not.toContain("What happens");
    }
    expect(planned()).toMatchObject({ steps: [], nothing: null, first: script });
    expect(carryOut).not.toHaveBeenCalled();
    expect(createInterface).not.toHaveBeenCalled();
    expect(npmDo).not.toHaveBeenCalled();
    // The same where the one copy there is would otherwise be nothing to repair.
    vi.mocked(look).mockReturnValue(blocked({ copies: [copy(LOCAL(), { uses: ["this"] })] }));
    const fine = await run({}, "reinstall");
    expect(fine.err).toHaveBeenCalledWith(said);
    expect(fine.text).not.toContain("Nothing to repair");
    // A path with a space in it is one word of the command; on Windows it is `move`.
    const spaced = path.join(home, "my tools", "bin", "sessionpipe");
    vi.mocked(look).mockReturnValue(blocked({ homes: [home0({ blocked: spaced })] }));
    expect((await run({}, "reinstall")).err).toHaveBeenCalledWith(
      expect.stringContaining(`Next: mv '${spaced}' '${spaced}.old'\n`),
    );
    onPlatform("win32");
    vi.mocked(look).mockReturnValue(blocked({ platform: "win32", homes: [home0({ blocked: spaced })] }));
    expect((await run({}, "reinstall")).err).toHaveBeenCalledWith(
      expect.stringContaining(`Next: move "${spaced}" "${spaced}.old"\n`),
    );
  });

  it("one clean copy, and what you type is something else that stays: said in place of 'Nothing to repair', in yellow; exit 0", async () => {
    // A checkout's link ahead of ~/.local/bin on PATH: not an install, never moved.
    const stays = path.join(home, "bin", "sessionpipe");
    vi.mocked(look).mockReturnValue(
      inventory({
        copies: [copy(LOCAL(), { uses: ["service"] }), checkout({ uses: ["typed", "this"] })],
        onPath: [
          { file: stays, dir: checkout().dir, at: 0 },
          { file: binOf(LOCAL()), dir: slotOf(LOCAL()), at: 1 },
        ],
        homes: [home0({ pathAt: 1 })],
      }),
    );
    const r = await run({}, "reinstall");
    expect(r.lines.slice(-3)).toEqual([
      "  ! What a shell finds first is ~/bin/sessionpipe, which is not this copy: typing `sessionpipe` starts that one.",
      "",
      "! This computer has one sessionpipe: 9.9.9, in ~/.local, the newest release. But what you type is ~/bin/sessionpipe, which is not it, and not sessionpipe's to move. What is no install of it is left alone.",
    ]);
    expect(r.text).not.toContain("Nothing to repair");
    expect(process.exitCode).toBeUndefined();
    expect(r.exit).not.toHaveBeenCalled();
    expect(r.err).not.toHaveBeenCalled();
    // No plan, no question, nothing run: at a terminal too.
    keyboard(true);
    const term = await run({ tty: true, columns: 200 }, "reinstall");
    const last = term.lines.slice(term.lines.lastIndexOf("") + 1);
    expect(last[0]?.startsWith(`${ESC}[33m${ESC}[1m! This computer has one sessionpipe`)).toBe(true);
    for (const l of last) expect(l.startsWith(`${ESC}[33m${ESC}[1m`)).toBe(true);
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
      "What happens",
      "  1. sessionpipe 9.9.9, the newest release, is fetched from npm. Until that has worked, nothing here is touched.",
      "  2. It is installed fresh in ~/.local (where the one you type is); sessionpipe 1.0.0, which is there now, is taken out first and put back if the install fails.",
      "  3. No agent is hooked here, so there are no hooks to write.",
      "  4. ~/.nvm/versions/node/v22.1.0 holds sessionpipe 0.9.0: it is removed, with its link.",
      "  5. Then it is checked: the fresh copy runs, a shell finds it, and nothing here names a copy that was removed.",
      "     Pairings, settings, keys and what waits to be sent are kept.",
      "",
    ];
    expect(dry.lines).toEqual([...page, "  Nothing was changed: this was a dry run. `sessionpipe reinstall` does it."]);
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
    expect(r.lines).toContain(`${ESC}[1mWhat happens${ESC}[22m`);
    expect(r.lines.at(-1)).toBe(
      `  Nothing was changed: this was a dry run. ${ESC}[36m\`sessionpipe reinstall\`${ESC}[39m does it.`,
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the colours this page writes
    for (const l of r.lines) expect(l.replace(/\u001b\[\d+m/g, "").length).toBeLessThan(80);
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
    expect(piped.lines).toContain("What happens");
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
    // A home with a space in its name: the prefix in the command is quoted, and inside
    // quotes a shell leaves `~` as it is and would look for a folder of that name.
    const spaced = path.join(tmp, "my home");
    mkdirSync(spaced);
    vi.stubEnv("HOME", spaced);
    const nvm = path.join(spaced, ".nvm", "versions", "node", "v22.1.0");
    const local = path.join(spaced, ".local");
    // And a folder elsewhere whose path only has the home's inside it.
    const mirror = path.join(tmp, `mirror${spaced}`, "bin", "sessionpipe");
    const script = path.join(spaced, "bin", "sessionpipe");
    vi.mocked(look).mockReturnValue(
      inventory({
        reach: spaced,
        copies: [
          copy(local, { where: "~/.local", version: "1.0.0", uses: ["this"] }),
          copy(nvm, { where: "~/.nvm/versions/node/v22.1.0", version: "0.9.0", writable: false }),
        ],
        dangling: [mirror, path.join(spaced, "old", "bin", "sessionpipe")],
        strangers: [{ file: script, why: "a file of that name that npm didn't put there" }],
        onPath: [{ file: script, dir: null, at: 0 }],
        homes: [
          {
            prefix: local,
            shown: "~/.local",
            why: "where this command runs from",
            bin: path.join(local, "bin"),
            pathAt: null,
            blocked: null,
          },
        ],
      }),
    );
    const r = await run({}, "reinstall", "--dry-run");
    const line = `sudo npm uninstall -g --prefix '${nvm}' sessionpipe`;
    const p = planned();
    // What the run is handed keeps every path whole: what it removes, and the command to paste.
    expect(p.left).toEqual([
      {
        where: "~/bin/sessionpipe",
        path: script,
        version: null,
        why: "a file of that name that npm didn't put there",
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
    expect(p.first).toBe(script);
    expect(p.steps.filter((s) => s.do === "remove").map((s) => (s as { path: string }).path)).toEqual([
      mirror,
      path.join(spaced, "old", "bin", "sessionpipe"),
    ]);
    // The command is printed as the plan has it: pasted, it names the folder that is there.
    expect(r.lines).toContain(`       ${line}`);
    expect(r.text).not.toContain("'~");
    // In a sentence the same home is `~/…`; a longer path that only has it inside is whole.
    expect(r.lines).toContain("  ! ~/old/bin/sessionpipe is a link to a sessionpipe that is gone");
    expect(r.lines).toContain(`  ! ${mirror} is a link to a sessionpipe that is gone`);
    expect(r.lines).toContain("  ! ~/bin/sessionpipe is a file of that name that npm didn't put there");
    expect(r.text).toContain("~/old/bin/sessionpipe leads to a sessionpipe that is gone: the link is removed.");
    expect(r.text).toContain(`${mirror} leads to a sessionpipe that is gone: the link is removed.`);
    expect(r.lines).toContain(
      "  ! ~/.local/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.",
    );
    expect(r.lines).toContain(
      "  ! What a shell finds first is ~/bin/sessionpipe, which is not this copy: typing `sessionpipe` starts that one.",
    );
    for (const l of r.lines.filter((x) => !x.includes(mirror))) expect(l).not.toContain(path.join(spaced, "bin"));
    // At a terminal a line breaks by what is printed, and a note's second line is under its words.
    const term = await run({ tty: true, columns: 80 }, "reinstall", "--dry-run");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the colours this page writes
    const bare = term.lines.map((l) => l.replace(/\u001b\[\d+m/g, ""));
    const at = bare.findIndex((l) => l.startsWith("  ! What a shell finds first is ~/bin/sessionpipe,"));
    expect(at).toBeGreaterThan(0);
    expect(bare[at + 1]).toMatch(/^ {4}\S.* starts that one\.$/);
    expect(`${bare[at]} ${(bare[at + 1] as string).trim()}`).toBe(
      "  ! What a shell finds first is ~/bin/sessionpipe, which is not this copy: typing `sessionpipe` starts that one.",
    );
    // (A path outside the home is as long as it is: nothing folds one.)
    for (const l of bare.filter((x) => !x.includes(tmp))) expect(l.length).toBeLessThan(80);
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
    // The last line, with what the run warned of.
    const r = await ends({ ...ONE, warn: [said] });
    expect(r.lines.at(-1)).toBe(`! ${ONE.said} ${short}`);
    // At a terminal it is shortened before it is folded: no line of it is cut short for
    // a path it no longer shows.
    const term = await ends(
      { ...ONE, warn: [`${under} still names ${under}, which was removed.`] },
      { tty: true, columns: 80 },
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the colours this page writes
    const bare = term.lines.map((l) => l.replace(/\u001b\[\d+m/g, ""));
    expect(bare.slice(-2)).toEqual([
      "! This computer has one sessionpipe: 9.9.9, in ~/.local. Pairings and settings",
      "  are as they were. ~/.nvm/lib still names ~/.nvm/lib, which was removed.",
    ]);
  });
});

describe.skipIf(process.platform === "win32")("sessionpipe reinstall: how a run ends", () => {
  it("one copy, in use everywhere: the steps as they happen, then one green line; exit 0", async () => {
    vi.mocked(look).mockReturnValue(two());
    vi.mocked(carryOut).mockImplementation(async (_p, d) => {
      d.say({ mark: "ok", text: `sessionpipe ${NEWEST} fetched from npm` });
      d.say({ mark: "warn", text: `${path.join(home, "old")} could not be removed: EBUSY` });
      return ONE;
    });
    const r = await run({}, "reinstall", "--yes");
    expect(r.lines.slice(-5)).toEqual([
      "",
      "  ✓ sessionpipe 9.9.9 fetched from npm",
      // A step names a folder under the home as the page does.
      "  ! ~/old could not be removed: EBUSY",
      "",
      "✓ This computer has one sessionpipe: 9.9.9, in ~/.local. Pairings and settings are as they were.",
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(r.exit).not.toHaveBeenCalled();
    const term = await run({ tty: true, columns: 200 }, "reinstall", "--yes");
    expect(term.lines.at(-1)).toBe(
      `${ESC}[32m${ESC}[1m✓ This computer has one sessionpipe: 9.9.9, in ~/.local. Pairings and settings are as they were.${ESC}[22m${ESC}[39m`,
    );
    expect(term.lines.at(-4)).toBe(`  ${ESC}[32m✓${ESC}[39m sessionpipe 9.9.9 fetched from npm`);
  });

  it("one copy, and something left to say: the run's warnings and the plan's notes on the last line, in yellow; exit 0", async () => {
    const warned: Done = {
      ...ONE,
      warn: [`What you type is still ${path.join(home, "bin", "sessionpipe")}, not the fresh copy.`],
    };
    const r = await ends(warned);
    expect(r.lines.slice(-2)).toEqual([
      "",
      "! This computer has one sessionpipe: 9.9.9, in ~/.local. Pairings and settings are as they were. What you type is still ~/bin/sessionpipe, not the fresh copy.",
    ]);
    expect(process.exitCode).toBeUndefined();
    // A note of the plan's alone makes it yellow too, and is said again at the end.
    const off = two({
      onPath: [],
      homes: [home0({ pathAt: null })],
    });
    const noted = await ends(ONE, {}, off);
    expect(noted.lines.at(-1)).toBe(
      "! This computer has one sessionpipe: 9.9.9, in ~/.local. Pairings and settings are as they were. ~/.local/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.",
    );
    const both = await ends(warned, { tty: true, columns: 200 }, off);
    expect(both.lines.at(-1)?.startsWith(`${ESC}[33m${ESC}[1m`)).toBe(true);
    expect(both.lines.slice(-3).join(" ")).toContain("not the fresh copy.");
    expect(both.lines.slice(-3).join(" ")).toContain("is not on your PATH");
    expect(both.exit).not.toHaveBeenCalled();
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
      error:
        "sessionpipe 9.9.9 is installed in ~/.local and in use, and one other copy is still there: /usr/local (you may not write where it is)",
      next: "sudo npm uninstall -g --prefix /usr/local sessionpipe",
    };
    const r = await ends(failed);
    expect(r.err).toHaveBeenCalledWith(
      "sessionpipe: sessionpipe 9.9.9 is installed in ~/.local and in use, and one other copy is still there: /usr/local (you may not write where it is). Next: sudo npm uninstall -g --prefix /usr/local sessionpipe\n",
    );
    expect(r.exit).toHaveBeenCalledWith(1);
    // No last line of its own: the failure is it.
    expect(r.lines.at(-1)).toBe("");
    const term = await ends(failed, { errTty: true, columns: 200 });
    expect(term.err).toHaveBeenCalledWith(
      expect.stringMatching(/try.* {4}.*sudo npm uninstall -g --prefix \/usr\/local sessionpipe.*\n$/),
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

  it("install: into the prefix it is given, checked by the copy in the home's own slot; no hooks are written by it", async () => {
    const { d } = await went();
    vi.mocked(installInto).mockResolvedValueOnce({ ok: true });
    expect(await d.install(LOCAL(), NEWEST)).toBeNull();
    expect(installInto).toHaveBeenCalledTimes(1);
    expect(installInto).toHaveBeenCalledWith(LOCAL(), NEWEST, {
      node: process.execPath,
      distDir: path.join(slotOf(LOCAL()), "dist"),
      harnesses: [],
    });
    vi.mocked(installInto).mockResolvedValueOnce({ ok: false, stage: "npm", error: "npm install: EACCES" });
    expect(await d.install(LOCAL(), NEWEST)).toBe("npm install: EACCES");
  });

  it("moves a folder aside by the file system's own rename, under a name npm itself would give it", async () => {
    const { d } = await went();
    expect(d.exists).toBe(existsSync);
    // The only change to a folder this command makes itself: one rename, nothing copied.
    expect(d.rename).toBe(renameSync);
    const ids = [d.id(), d.id(), d.id()];
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}$/);
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

  it("unserve: the service file goes by the service's own removal", async () => {
    const { d } = await went();
    expect(uninstallService).not.toHaveBeenCalled();
    d.unserve();
    expect(uninstallService).toHaveBeenCalledTimes(1);
    expect(uninstallService).toHaveBeenCalledWith();
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
      vi.mocked(serviceLook).mockReturnValue(s);
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

  it("serviceDir: the package folder the service file names now, asked afresh", async () => {
    const { d } = await went();
    expect(d.serviceDir()).toBeNull();
    vi.mocked(serviceLook).mockReturnValue(service());
    expect(d.serviceDir()).toBe(slotOf(LOCAL()));
    vi.mocked(serviceLook).mockReturnValue(
      service({ argv: [process.execPath, path.join(slotOf(NVM()), "dist", "cli.js"), "control", "run"] }),
    );
    expect(d.serviceDir()).toBe(slotOf(NVM()));
    vi.mocked(serviceLook).mockReturnValue(service({ argv: null }));
    expect(d.serviceDir()).toBeNull();
  });

  it("remove: ours.ts's one removal, with the reach and the prefixes of the look, and npm asked first by this node", async () => {
    const { d } = await went();
    expect(remove).not.toHaveBeenCalled();
    const gone = [slotOf(NVM()), binOf(NVM())];
    vi.mocked(remove).mockResolvedValue(gone);
    expect(await d.remove(slotOf(NVM()))).toBe(gone);
    expect(remove).toHaveBeenCalledTimes(1);
    const [what, o] = vi.mocked(remove).mock.calls[0] as Parameters<typeof remove>;
    // The path handed to the removal is the one asked for, inside this test's home; and
    // what may be removed is decided there, from the same reach the look had.
    expect(what).toBe(slotOf(NVM()));
    expect(what.startsWith(`${home}${path.sep}`)).toBe(true);
    expect(o).toEqual({
      platform: process.platform,
      reach: home,
      prefixes: [LOCAL(), NVM()],
      npm: expect.any(Function),
    });
    // npm takes it out of its own books: uninstall, from that prefix, by this node.
    vi.mocked(npmDo).mockResolvedValueOnce(null);
    await expect(o.npm?.(NVM())).resolves.toBeUndefined();
    expect(npmDo).toHaveBeenCalledTimes(1);
    expect(npmDo).toHaveBeenCalledWith(["uninstall", "--global", "--prefix", NVM(), "sessionpipe"], {
      node: process.execPath,
    });
    // npm failing is said as a failure: the removal goes on by itself, as ours.ts has it.
    vi.mocked(npmDo).mockResolvedValueOnce("npm error code EACCES");
    await expect(o.npm?.(NVM())).rejects.toThrow("npm error code EACCES");
    // The folder only (what a failed install left in the home's slot): said on, and only then.
    await d.remove(slotOf(LOCAL()), true);
    expect(vi.mocked(remove).mock.calls[1]).toEqual([
      slotOf(LOCAL()),
      { platform: process.platform, reach: home, prefixes: [LOCAL(), NVM()], npm: expect.any(Function), alone: true },
    ]);
    await d.remove(slotOf(NVM()), false);
    const third = vi.mocked(remove).mock.calls[2]?.[1] as object;
    expect("alone" in third).toBe(false);
    // What the removal refuses is the run's to hear.
    vi.mocked(remove).mockRejectedValueOnce(new Error("it was left alone"));
    await expect(d.remove(path.join(home, "project", "node_modules", "sessionpipe"))).rejects.toThrow(
      "it was left alone",
    );
  });

  it("a look that reached nothing hands the removal that: nothing is its to remove", async () => {
    // Steps can't come of such a look (the plan refuses it); the removal is told all the same.
    const { d } = await went(two({ reach: true, prefixes: [] }));
    vi.mocked(remove).mockResolvedValue([]);
    await d.remove(slotOf(NVM()));
    expect(vi.mocked(remove).mock.calls[0]?.[1]).toMatchObject({ reach: true, prefixes: [] });
  });

  it("relink: npm's own link made again where it is gone, in npm's words; never over anything that is there", async () => {
    const { d } = await went();
    // No bin folder to make it in: it is not there afterwards, and nothing was made.
    expect(d.relink(LOCAL())).toBe(false);
    expect(existsSync(path.join(LOCAL(), "bin"))).toBe(false);
    mkdirSync(path.join(LOCAL(), "bin"), { recursive: true });
    expect(d.relink(LOCAL())).toBe(true);
    expect(readlinkSync(binOf(LOCAL()))).toBe(path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"));
    // There already: left as it is.
    expect(d.relink(LOCAL())).toBe(true);
    // A link that leads to another copy is not this one's, and is not written over.
    mkdirSync(path.join(NVM(), "bin"), { recursive: true });
    const other = path.join(tmp, "other", "lib", "node_modules", "sessionpipe", "dist", "cli.js");
    symlinkSync(other, binOf(NVM()));
    expect(d.relink(NVM())).toBe(false);
    expect(readlinkSync(binOf(NVM()))).toBe(other);
    // Nor is a file someone put there under that name.
    const own = path.join(home, "own");
    put(path.join(own, "bin", "sessionpipe"), "#!/bin/sh\n");
    expect(d.relink(own)).toBe(false);
    expect(readFileSync(path.join(own, "bin", "sessionpipe"), "utf8")).toBe("#!/bin/sh\n");
  });

  it("relink on Windows only looks: npm's shim is npm's to write", async () => {
    onPlatform("win32");
    const { d } = await went(two({ platform: "win32" }));
    const prefix = path.join(home, "AppData", "Roaming", "npm");
    mkdirSync(prefix, { recursive: true });
    expect(d.relink(prefix)).toBe(false);
    expect(existsSync(path.join(prefix, "sessionpipe.cmd"))).toBe(false);
    expect(existsSync(path.join(prefix, "bin"))).toBe(false);
    put(path.join(prefix, "sessionpipe.cmd"), '@"%~dp0\\node_modules\\sessionpipe\\dist\\cli.js" %*\r\n');
    expect(d.relink(prefix)).toBe(true);
  });

  it("prove on Windows: the fresh copy is run through npm's shim in the prefix itself", async () => {
    onPlatform("win32");
    const { d } = await went(two({ platform: "win32" }));
    // There the package folder is `<prefix>\node_modules\sessionpipe`, and the command a `.cmd` beside it.
    const fresh = path.join(LOCAL(), "node_modules", "sessionpipe", "dist", "cli.js");
    vi.mocked(look).mockReturnValue(two({ platform: "win32", onPath: [] }));
    vi.mocked(spawnSync).mockImplementation(((_cmd: string, argv: string[]) =>
      argv[0] === fresh
        ? { status: 0, stdout: `${NEWEST}\n`, stderr: "" }
        : { status: 1, stdout: "", stderr: "" }) as never);
    expect((await d.prove([])).runs).toBeNull();
    // A link of the POSIX kind is not what starts it there.
    link(LOCAL());
    expect((await d.prove([])).runs).toBeNull();
    put(path.join(LOCAL(), "sessionpipe.cmd"), '@"%~dp0\\node_modules\\sessionpipe\\dist\\cli.js" %*\r\n');
    expect(await d.prove([])).toEqual({ runs: NEWEST, onPath: [], first: false, named: [] });
  });

  it("prove: the fresh copy run through npm's link, what a shell finds and whether this copy is first, and who still names what was removed", async () => {
    put(process.env.SESSIONPIPE_CONFIG as string, { harnesses: { "claude-code": { enabled: true } } });
    paired();
    const plist = service().file as string;
    const gone = [slotOf(NVM()), binOf(NVM())];
    put(plist, `<string>${path.join(slotOf(NVM()), "dist", "cli.js")}</string>`);
    put(path.join(home, ".claude", "settings.json"), { hooks: `${binOf(NVM())} hook` });
    vi.mocked(serviceLook).mockReturnValue(service());
    const { d } = await went();
    const fresh = path.join(slotOf(LOCAL()), "dist", "cli.js");
    const elsewhere = path.join(home, "bin", "sessionpipe");
    vi.mocked(look).mockClear();
    vi.mocked(look).mockReturnValue(
      two({
        onPath: [
          { file: binOf(LOCAL()), dir: slotOf(LOCAL()), at: 0 },
          { file: elsewhere, dir: null, at: 1 },
        ],
      }),
    );
    vi.mocked(spawnSync).mockImplementation(((_cmd: string, argv: string[]) =>
      argv[0] === fresh && argv[1] === "--version"
        ? { status: 0, stdout: `${NEWEST}\n`, stderr: "" }
        : { status: 1, stdout: "", stderr: "" }) as never);
    // No link leads to the fresh copy yet: it is not run by any other way.
    expect((await d.prove(gone)).runs).toBeNull();
    link(LOCAL());
    expect(await d.prove(gone)).toEqual({
      runs: NEWEST,
      onPath: [binOf(LOCAL()), elsewhere],
      first: true,
      named: [
        { file: plist, path: slotOf(NVM()) },
        { file: path.join(home, ".claude", "settings.json"), path: binOf(NVM()) },
      ],
    });
    // The look is taken again for it, by running each copy, with the service file as it is now.
    expect(looked()).toMatchObject({ npmPrefix: null, serviceCli: fresh, reach: home });
    expect(looked().version(fresh)).toBe(NEWEST);
    // Nothing was removed: nothing can name it. A hooks file that isn't there names nothing.
    rmSync(path.join(home, ".claude", "settings.json"));
    expect((await d.prove([])).named).toEqual([]);
    expect((await d.prove(gone)).named).toEqual([{ file: plist, path: slotOf(NVM()) }]);
    // No service file to read.
    vi.mocked(serviceLook).mockReturnValue(null);
    expect((await d.prove(gone)).named).toEqual([]);
    expect(looked().serviceCli).toBeNull();
  });

  it("prove: what a shell finds first is the fresh copy only where its link leads there", async () => {
    const { d } = await went();
    link(LOCAL());
    const first = async (found: { file: string; dir: string | null }[]) => {
      vi.mocked(look).mockReturnValue(two({ onPath: found.map((e, at) => ({ ...e, at })) }));
      const p = await d.prove([]);
      return { first: p.first, onPath: p.onPath };
    };
    const mine = { file: binOf(LOCAL()), dir: slotOf(LOCAL()) };
    const theirs = { file: binOf(NVM()), dir: slotOf(NVM()) };
    const stranger = { file: path.join(home, "bin", "sessionpipe"), dir: null };
    expect(await first([mine])).toEqual({ first: true, onPath: [mine.file] });
    expect(await first([theirs, mine])).toEqual({ first: false, onPath: [theirs.file, mine.file] });
    expect(await first([stranger, mine])).toEqual({ first: false, onPath: [stranger.file, mine.file] });
    expect(await first([])).toEqual({ first: false, onPath: [] });
  });

  it("prove and relink, run from inside the home's own package folder: no link is still no link", async () => {
    // An empty path resolves to the folder a command is run in: compared with the slot
    // as if it were where a link leads, it said yes to every question from in there.
    const slot = slotOf(LOCAL());
    mkdirSync(slot, { recursive: true });
    const { d } = await went();
    vi.mocked(look).mockReturnValue(two({ onPath: [] }));
    vi.mocked(spawnSync).mockImplementation((() => ({ status: 0, stdout: `${NEWEST}\n`, stderr: "" })) as never);
    const was = process.cwd();
    process.chdir(slot);
    try {
      expect(await d.prove([])).toEqual({ runs: null, onPath: [], first: false, named: [] });
      vi.mocked(look).mockReturnValue(
        two({ onPath: [{ file: path.join(home, "bin", "sessionpipe"), dir: null, at: 0 }] }),
      );
      expect((await d.prove([])).first).toBe(false);
      // No bin folder: no link can be made, and none is said to be there.
      expect(d.relink(LOCAL())).toBe(false);
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
    expect(j.copies).toEqual([{ dir: slotOf(LOCAL()), version: NEWEST, runs: true, uses: ["typed", "this"] }]);
    expect(j.warnings).toEqual([]);
    expect((await run({}, "status")).lines[0]).toBe("✓ All good");
  });

  it("two copies: one row that says where each is and what uses it, and one thing to run: reinstall; exit 1", async () => {
    vi.mocked(look).mockReturnValue(two());
    const r = await run({}, "doctor");
    expect(r.lines[0]).toBe("! 1 thing needs attention");
    expect(r.lines).toContain(
      "  ! copies              1.0.0 in ~/.local (you type this one); 0.9.0 in ~/.nvm/versions/node/v22.1.0 (nothing uses it)",
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
      { dir: slotOf(LOCAL()), version: "1.0.0", runs: true, uses: ["typed", "this"] },
      { dir: slotOf(NVM()), version: "0.9.0", runs: true, uses: [] },
    ]);
    expect(j.warnings).toEqual([
      `2 copies of sessionpipe are on this computer (1.0.0 in ${slotOf(LOCAL())}; 0.9.0 in ${slotOf(NVM())}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    // `status` says it in its one line, and counts it.
    const brief = await run({}, "status");
    expect(brief.lines[0]).toBe("! 1 thing needs attention");
    expect(brief.text).toContain(
      "copies: 1.0.0 in ~/.local (you type this one); 0.9.0 in ~/.nvm/versions/node/v22.1.0 (nothing uses it)",
    );
    expect(brief.lines.at(-1)).toBe("  `sessionpipe doctor` says what to do about it.");
  });

  it("which copy is used by what: the one typed, the one the service runs, the one that wrote the hooks, or nothing", async () => {
    vi.mocked(look).mockReturnValue(
      inventory({
        copies: [
          copy(LOCAL(), { uses: ["typed", "service", "this"] }),
          copy(NVM(), { version: "0.9.0", uses: ["service"] }),
          copy(path.join(home, ".npm-global"), { where: "~/.npm-global", version: "0.8.0", uses: ["hooks"] }),
          copy(path.join(home, ".old"), { where: "~/.old", version: "0.7.0", uses: [] }),
        ],
      }),
    );
    expect(row(await run({}, "doctor"))).toBe(
      "9.9.9 in ~/.local (you type this one); 0.9.0 in ~/.nvm/versions/node/v22.1.0 (the background service runs this one); 0.8.0 in ~/.npm-global (the hooks were written by this one); 0.7.0 in ~/.old (nothing uses it)",
    );
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
    expect(todo).toContain(
      `This command is sessionpipe ${VERSION}, and the background service runs 0.9.0 from another copy (in ~/.nvm/versions/node/v22.1.0), and the hooks run 0.8.0. 2 copies of sessionpipe are on this computer, and one is enough. One command puts it right:\n       sessionpipe reinstall`,
    );
    // One item for all of it: `update` would leave the second copy where it is.
    expect(todo).not.toContain("sessionpipe update");
    expect(todo.match(/sessionpipe reinstall$/gm)).toHaveLength(1);
    expect(process.exitCode).toBe(1);
    // The look was handed the service file's own copy: the manager is asked once, for both.
    expect(looked().serviceCli).toBe(other);
    expect(serviceLook).toHaveBeenCalledTimes(1);
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
    vi.mocked(look).mockReturnValue(
      one({ copies: [copy(LOCAL(), { runs: false, wrong: broken, uses: ["typed", "this"] })] }),
    );
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
    expect((await json()).warnings).toEqual([
      `the copy of sessionpipe on this computer is not whole (9.9.9 in ${slotOf(LOCAL())}: ${broken}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    // One whose package.json can't be read has no release to name.
    vi.mocked(look).mockReturnValue(
      one({
        copies: [copy(LOCAL(), { version: null, runs: false, wrong: "it doesn't run: `--version` printed nothing" })],
      }),
    );
    expect(row(await run({}, "doctor"))).toBe(
      "a broken copy in ~/.local (it doesn't run: `--version` printed nothing)",
    );
    expect((await json()).warnings[0]).toMatch(/^the copy of sessionpipe on this computer is not whole \(broken in /);
    // A clean copy, and a link somewhere that leads to one that is gone.
    const link = path.join(home, "bin", "sessionpipe");
    vi.mocked(look).mockReturnValue(one({ dangling: [link] }));
    const dangling = await run({}, "doctor");
    expect(row(dangling)).toBe("9.9.9 in ~/.local (you type this one); ~/bin/sessionpipe, a link to one that is gone");
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
            runs: false,
            wrong: "left behind by an install that was cut off",
            bins: [],
          }),
        ],
      }),
    );
    const r = await run({}, "doctor");
    expect(row(r)).toBe(
      "9.9.9 in ~/.local (you type this one); a leftover in ~/.local (left behind by an install that was cut off)",
    );
    expect(fix(r)[1]).toBe(
      "  1. 2 copies of sessionpipe are on this computer, and one is enough. One command puts it right:",
    );
    expect((await json()).warnings).toEqual([
      `2 copies of sessionpipe are on this computer (9.9.9 in ${slotOf(LOCAL())}; 0.9.0 in ${aside}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    // Of two, one whose package.json can't be read is named as broken.
    vi.mocked(look).mockReturnValue(
      two({
        copies: [
          copy(LOCAL(), { uses: ["typed", "this"] }),
          copy(NVM(), { version: null, runs: false, wrong: "it doesn't run: `--version` printed nothing" }),
        ],
      }),
    );
    expect((await json()).warnings).toEqual([
      `2 copies of sessionpipe are on this computer (9.9.9 in ${slotOf(LOCAL())}; broken in ${slotOf(NVM())}); \`sessionpipe reinstall\` leaves one clean copy`,
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
    expect(j.copies).toEqual([{ dir: slotOf(LOCAL()), version: NEWEST, runs: true, uses: ["typed"] }]);
    expect(j.warnings).toEqual([]);
    // An npx entry that something runs from is a copy like any other.
    const used = npxEntry("0a1b2c3d4e5f6a7b", { version: "0.9.0", uses: ["service"] });
    vi.mocked(look).mockReturnValue(one({ copies: [copy(LOCAL(), { uses: ["typed"] }), used] }));
    const second = await run({}, "doctor");
    expect(row(second)).toBe(
      "9.9.9 in ~/.local (you type this one); 0.9.0 in ~/.npm/_npx/0a1b2c3d4e5f6a7b (the background service runs this one)",
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

  it("doctor runs each copy to ask its version; status reads its package.json and starts nothing", async () => {
    vi.mocked(look).mockReturnValue(one());
    const dir = path.join(home, "copy");
    const cli = path.join(dir, "dist", "cli.js");
    put(path.join(dir, "package.json"), { name: "sessionpipe", version: "1.2.3" });
    await run({}, "doctor");
    expect(looked()).toMatchObject({ npmPrefix: null, serviceCli: null, reach: home, distDir: realDist });
    vi.mocked(spawnSync).mockClear();
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stdout: "1.2.4\n", stderr: "" } as never);
    expect(looked().version(cli)).toBe("1.2.4");
    expect(spawnSync).toHaveBeenCalledWith(process.execPath, [cli, "--version"], expect.anything());
    // npm is not asked where it installs by either: a look is all this is.
    expect(execCapture).not.toHaveBeenCalled();
    await run({}, "status");
    vi.mocked(spawnSync).mockClear();
    expect(looked().version(cli)).toBe("1.2.3");
    expect(looked().version(path.join(home, "none", "dist", "cli.js"))).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
    // With nothing here that needs the service, the manager is not asked for its file either.
    expect(serviceLook).not.toHaveBeenCalled();
  });
});
