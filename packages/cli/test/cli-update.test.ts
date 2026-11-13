// SPDX-License-Identifier: Apache-2.0
// `sessionpipe update` as the command wires it (current.ts has the flow itself, each way
// it can go), and what `doctor` says when the three things that should be one version
// (the command, the background service, the hooks) are not.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceState } from "@sessionpipe/core/service";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { noService, serviceLook } from "../src/control/health.js";
import { placeService } from "../src/control/pair.js";
import { bringCurrent, type CurrentDeps, type Outcome } from "../src/current.js";
import { installLauncher } from "../src/launcher.js";
import { VERSION } from "../src/run.js";
import { rerunGlobally, viaNpx } from "../src/runtime.js";
import { globalPrefix, installEverywhere, latestVersion, rearmHooks } from "../src/update.js";

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
// Doctor times the hook by starting it eight times. Here it answers at once, and the
// clock that times it is the test's (`steadyHook`): how fast this machine starts node
// says nothing about what these tests are for.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: vi.fn((_cmd: string, args: string[]) => ({
    status: args.some((a) => a.endsWith("hook.js")) ? 0 : 1,
    stdout: "",
    stderr: "",
  })),
}));
vi.mock("../src/current.js", async (original) => ({
  ...(await original<typeof import("../src/current.js")>()),
  bringCurrent: vi.fn(),
}));
vi.mock("../src/update.js", async (original) => {
  const real = await original<typeof import("../src/update.js")>();
  return {
    ...real,
    globalPrefix: vi.fn(real.globalPrefix),
    latestVersion: vi.fn(),
    installEverywhere: vi.fn(),
    rearmHooks: vi.fn(),
  };
});
vi.mock("../src/runtime.js", async (original) => ({
  ...(await original<typeof import("../src/runtime.js")>()),
  viaNpx: vi.fn(() => false),
  rerunGlobally: vi.fn(),
}));
vi.mock("../src/control/pair.js", async (original) => ({
  ...(await original<typeof import("../src/control/pair.js")>()),
  placeService: vi.fn(),
}));
vi.mock("../src/control/health.js", async (original) => {
  const real = await original<typeof import("../src/control/health.js")>();
  return { ...real, serviceLook: vi.fn(() => null), noService: vi.fn(real.noService) };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const realDist = path.resolve(here, "../dist");
const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
let cli: Cli;
let tmp: string;
let home: string;
let stops: (() => Promise<void>)[];

beforeAll(async () => {
  dist.dir = realDist;
  cli = await import("../src/cli.js");
});
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-upd-")));
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
    SESSIONPIPE_CLAUDE: path.join(tmp, "claude"),
    SESSIONPIPE_NO_UPDATE_CHECK: undefined,
    SESSIONPIPE_SERVICE_LABEL: undefined,
    SSH_CONNECTION: undefined,
    FORCE_COLOR: undefined,
    NO_COLOR: undefined,
    npm_config_registry: undefined,
    // This runner's own npmrc is no part of the home that is looked in: npm names it to
    // all it starts (`npm test`, `npx vitest`), and doctor reads npm's prefix from the
    // file named there.
    npm_config_userconfig: undefined,
    NPM_CONFIG_REGISTRY: undefined,
  }))
    vi.stubEnv(k, v);
  // A `claude` that says it is signed in, so doctor asks no real one.
  writeFileSync(path.join(tmp, "claude"), `#!/bin/sh\necho '{"loggedIn":true}'\n`);
  chmodSync(path.join(tmp, "claude"), 0o755);
  vi.mocked(bringCurrent).mockReset();
  vi.mocked(viaNpx).mockReturnValue(false);
  vi.mocked(serviceLook).mockReturnValue(null);
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  process.exitCode = undefined;
  clock?.mockRestore();
  clock = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const stop of stops) await stop();
  rmSync(tmp, { recursive: true, force: true });
});

/** Each of the hook's eight timed runs takes one millisecond by this clock. */
let clock: { mockRestore: () => void } | undefined;
function steadyHook(): void {
  let tick = 0n;
  clock = vi.spyOn(process.hrtime, "bigint").mockImplementation(() => {
    tick += 1_000_000n;
    return tick;
  });
}
function put(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`);
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
  status: { version, pid: 7, name: "lab", receivers: [], busy: null, ...more },
});
const paired = () =>
  put(path.join(tmp, "config", "control.json"), {
    name: "lab",
    folders: [],
    mode: "safe",
    receivers: [
      {
        url: "https://r.example",
        control: "https://r.example/control",
        rpId: "r.example",
        machine: "m_1",
        token: "t",
        keys: [],
        paired_at: "2026-11-01T00:00:00.000Z",
      },
    ],
  });
/** The flow stood in for: what the command handed it, and the outcome it is given back. */
async function update(outcome: Outcome, where: Parameters<typeof run>[0] = {}) {
  vi.mocked(bringCurrent).mockResolvedValue(outcome);
  const r = await run(where, "update");
  return { ...r, deps: vi.mocked(bringCurrent).mock.calls.at(-1)?.[0] as CurrentDeps };
}

describe.skipIf(process.platform === "win32")("sessionpipe update", () => {
  it("everything current: the steps as they happen, then one green line; exit 0", async () => {
    vi.mocked(bringCurrent).mockImplementation(async (d) => {
      d.say({ mark: "ok", text: "sessionpipe 9.9.9 installed (it was 1.0.0)" });
      d.say({ mark: "info", text: "nothing to restart" });
      return {
        state: "current",
        version: "9.9.9",
        said: "This computer is up to date: sessionpipe 9.9.9 runs the command.",
      };
    });
    const plain = await run({}, "update");
    expect(plain.lines).toEqual([
      "  ✓ sessionpipe 9.9.9 installed (it was 1.0.0)",
      "  · nothing to restart",
      "",
      "✓ This computer is up to date: sessionpipe 9.9.9 runs the command.",
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(plain.exit).not.toHaveBeenCalled();
    const term = await run({ tty: true, columns: 60 }, "update");
    const ESC = String.fromCharCode(27);
    expect(term.lines.at(-2)).toBe(
      `${ESC}[32m${ESC}[1m✓ This computer is up to date: sessionpipe 9.9.9 runs the${ESC}[22m${ESC}[39m`,
    );
    expect(term.lines.at(-1)).toBe(`${ESC}[32m${ESC}[1m  command.${ESC}[22m${ESC}[39m`);
    expect(term.lines[0]).toBe(`  ${ESC}[32m✓${ESC}[39m sessionpipe 9.9.9 installed (it was 1.0.0)`);
  });

  it("the service finishes by itself: said in yellow with its mark, exit 3", async () => {
    const r = await update({
      state: "waiting",
      version: "9.9.9",
      said: "The background service is busy: a headless agent run. It restarts by itself onto sessionpipe 9.9.9 when that is done: nothing more to type.",
    });
    expect(r.lines).toEqual([
      "",
      "! The background service is busy: a headless agent run. It restarts by itself onto sessionpipe 9.9.9 when that is done: nothing more to type.",
    ]);
    expect(process.exitCode).toBe(3);
    expect(r.exit).not.toHaveBeenCalled();
  });

  it("up to date, and a receiver hasn't answered the service: one yellow line that says both; exit 0", async () => {
    const outcome = {
      state: "current" as const,
      version: "9.9.9",
      said: "This computer is up to date: sessionpipe 9.9.9 runs the command and the background service.",
      warn: "r.example hasn't answered the background service yet. `sessionpipe doctor` looks again.",
    };
    const r = await update(outcome);
    expect(r.lines).toEqual(["", `! ${outcome.said} ${outcome.warn}`]);
    expect(process.exitCode).toBeUndefined();
    expect(r.exit).not.toHaveBeenCalled();
    const ESC = String.fromCharCode(27);
    const term = await update(outcome, { tty: true, columns: 60 });
    // Every line of it yellow, under the warning's mark; nothing of it green.
    expect(term.lines[1]).toBe(
      `${ESC}[33m${ESC}[1m! This computer is up to date: sessionpipe 9.9.9 runs the${ESC}[22m${ESC}[39m`,
    );
    for (const l of term.lines.slice(1)) expect(l.startsWith(`${ESC}[33m${ESC}[1m`)).toBe(true);
    expect(term.lines.at(-1)).toContain("looks again.");
    expect(process.exitCode).toBeUndefined();
  });

  it("it couldn't: one line that says what is wrong, one with the command to run next; exit 1", async () => {
    const failed = {
      state: "failed" as const,
      error: "npm can't write /usr/local/lib/node_modules",
      next: "sudo npm install -g --prefix /usr/local sessionpipe@9.9.9 && sessionpipe update",
    };
    const r = await update(failed, { errTty: true, columns: 200 });
    expect(r.err).toHaveBeenCalledWith(
      expect.stringMatching(
        /error.* {2}npm can't write \/usr\/local\/lib\/node_modules\n.*try.* {4}.*sudo npm install -g --prefix \/usr\/local sessionpipe@9\.9\.9 && sessionpipe update.*\n$/,
      ),
    );
    expect(r.exit).toHaveBeenCalledWith(1);
    expect(r.lines).toEqual([]);
    // Into a pipe a failure is one line; the command to run next is said at its end, so
    // a script, an ssh session or an agent is told it too.
    const piped = await update(failed);
    expect(piped.err).toHaveBeenCalledWith(
      "sessionpipe: npm can't write /usr/local/lib/node_modules. Next: sudo npm install -g --prefix /usr/local sessionpipe@9.9.9 && sessionpipe update\n",
    );
    expect(piped.exit).toHaveBeenCalledWith(1);
  });

  it("hands the flow this copy, the harnesses set up here, and whether anything needs the service", async () => {
    put(process.env.SESSIONPIPE_CONFIG as string, {
      harnesses: { codex: { enabled: true }, devin: { enabled: false } },
    });
    const alone = (await update({ state: "current", version: VERSION, said: "ok" })).deps;
    expect(alone).toMatchObject({
      version: VERSION,
      distDir: realDist,
      cli: realpathSync(path.join(realDist, "cli.js")),
      prefix: null,
      unwritable: null,
      platform: process.platform,
      harnesses: ["codex"],
      wanted: false,
    });
    paired();
    expect((await update({ state: "current", version: VERSION, said: "ok" })).deps.wanted).toBe(true);
    // Where npm installed this copy, and whether this user can write there.
    vi.mocked(globalPrefix).mockReturnValueOnce(tmp);
    expect((await update({ state: "current", version: VERSION, said: "ok" })).deps).toMatchObject({
      prefix: tmp,
      unwritable: expect.stringContaining("isn't writable by this user"),
    });
  });

  it("with SESSIONPIPE_NO_UPDATE_CHECK set it changes nothing, and says how to update once without it; exit 0", async () => {
    vi.stubEnv("SESSIONPIPE_NO_UPDATE_CHECK", "1");
    const r = await run({}, "update");
    expect(r.lines).toEqual([
      "  Updating is off, because SESSIONPIPE_NO_UPDATE_CHECK is set: nothing was changed. To update once without it: `env -u SESSIONPIPE_NO_UPDATE_CHECK sessionpipe update`",
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(r.exit).not.toHaveBeenCalled();
    // Not from the npx cache either: handing over would install a copy.
    vi.mocked(rerunGlobally).mockClear();
    vi.mocked(viaNpx).mockReturnValue(true);
    await run({}, "update");
    expect(rerunGlobally).not.toHaveBeenCalled();
    expect(bringCurrent).not.toHaveBeenCalled();
    // Windows has no `env`: the line is one that cmd and PowerShell both run.
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect((await run({}, "update")).lines[0]).toContain(
      'To update once without it: `cmd /c "set SESSIONPIPE_NO_UPDATE_CHECK=&& sessionpipe update"`',
    );
    // Switching the daily update still works with it set.
    Object.defineProperty(process, "platform", platform);
    expect((await run({}, "update", "off")).text).toContain("no longer checks npm");
  });

  it("asks npm, and says in plain words why it couldn't", async () => {
    const { deps } = await update({ state: "current", version: VERSION, said: "ok" });
    vi.mocked(latestVersion).mockResolvedValueOnce("9.9.9");
    expect(await deps.latest()).toBe("9.9.9");
    const failing = (cause: unknown) => Object.assign(new TypeError("fetch failed"), { cause });
    vi.mocked(latestVersion).mockRejectedValueOnce(failing({ code: "ENOTFOUND" }));
    await expect(deps.latest()).rejects.toThrow("registry.npmjs.org can't be reached (ENOTFOUND)");
    vi.mocked(latestVersion).mockRejectedValueOnce(failing({ errors: [{ code: "ECONNREFUSED" }] }));
    await expect(deps.latest()).rejects.toThrow("registry.npmjs.org can't be reached (ECONNREFUSED)");
    vi.mocked(latestVersion).mockRejectedValueOnce(failing({ message: "bad port" }));
    await expect(deps.latest()).rejects.toThrow("registry.npmjs.org can't be reached (bad port)");
    vi.stubEnv("npm_config_registry", "http://127.0.0.1:4873");
    vi.mocked(latestVersion).mockRejectedValueOnce(new Error("the npm registry answered HTTP 503"));
    await expect(deps.latest()).rejects.toThrow("127.0.0.1:4873 can't be reached (the npm registry answered HTTP 503)");
  });

  it("installs, writes the hooks and places the service with this copy and this node", async () => {
    put(process.env.SESSIONPIPE_CONFIG as string, { harnesses: { codex: { enabled: true } } });
    const { deps } = await update({ state: "current", version: VERSION, said: "ok" });
    vi.mocked(installEverywhere).mockResolvedValueOnce({ ok: true, ms: 1, hooks: "x", rearmed: true });
    await deps.install("9.9.9", ["/other/dist"]);
    expect(installEverywhere).toHaveBeenCalledWith("9.9.9", {
      node: process.execPath,
      distDir: realDist,
      others: ["/other/dist"],
      harnesses: ["codex"],
    });
    vi.mocked(rearmHooks).mockResolvedValueOnce({ ok: true, said: "x" });
    await deps.rearm();
    expect(rearmHooks).toHaveBeenCalledWith({ node: process.execPath, distDir: realDist, harnesses: ["codex"] });
    // Placing throws where it can't, so nothing it says can be passed over.
    deps.place();
    expect(placeService).toHaveBeenCalledWith({ node: deps.node, cli: deps.cli });
    vi.mocked(placeService).mockImplementationOnce(() => {
      throw new Error("launchd refused it (launchctl answered 5)");
    });
    expect(() => deps.place()).toThrow("launchd refused it (launchctl answered 5)");
    // What an older service knew of who is mid-turn, left where the next one takes it.
    deps.seed(["claude-code:aaaa"]);
    expect(
      JSON.parse(readFileSync(path.join(process.env.SESSIONPIPE_STATE as string, "control", "turns-seed.json"), "utf8"))
        .sessions,
    ).toEqual(["claude-code:aaaa"]);
    deps.look();
    expect(serviceLook).toHaveBeenCalled();
    // This test's own world keeps its files in a temp folder: it has no service here, and why is handed on.
    expect(deps.apart).toMatch(/^this sessionpipe keeps its files somewhere other than this computer's usual place \(/);
    vi.mocked(noService).mockReturnValueOnce(null);
    expect((await update({ state: "current", version: VERSION, said: "ok" })).deps.apart).toBeNull();
  });

  it("reads the hooks' version from their own copy; on Windows they name this copy and have none", async () => {
    const { deps } = await update({ state: "current", version: VERSION, said: "ok" });
    expect(deps.hooks()).toBeNull();
    installLauncher({ distDir: realDist, node: process.execPath, version: "0.9.0" });
    expect(deps.hooks()).toBe("0.9.0");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(deps.hooks()).toBeNull();
  });

  it("asks the running service over its socket: its status, what it sees, and to restart", async () => {
    const { deps } = await update({ state: "current", version: VERSION, said: "ok" });
    expect(await deps.status()).toBeNull();
    expect(await deps.health()).toBeNull();
    expect(await deps.restart()).toBe(false);
    // No service, or one from before it knew the question: no answer to it.
    expect(await deps.quiesce()).toBeNull();
    const replies: Record<string, unknown> = {
      status: status("1.2.3"),
      restart: { op: "ok" },
      health: { op: "health", health: { accounts: [], copy: { cli: "/x/cli.js", via: null } } },
    };
    await daemon(replies);
    expect((await deps.status())?.version).toBe("1.2.3");
    expect((await deps.health())?.copy).toEqual({ cli: "/x/cli.js", via: null });
    expect(await deps.restart()).toBe(true);
    expect(await deps.quiesce()).toBeNull();
    // Paused and free; or it holds something, and nothing was paused.
    replies.quiesce = { op: "ok" };
    expect(await deps.quiesce()).toBe(true);
    replies.quiesce = { op: "none" };
    expect(await deps.quiesce()).toBe(false);
  });

  it("waits by the clock it is given", async () => {
    const { deps } = await update({ state: "current", version: VERSION, said: "ok" });
    vi.useFakeTimers();
    let woke = false;
    const slept = deps.sleep(5000).then(() => {
      woke = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await slept;
    expect(woke).toBe(true);
    // And reads the same clock: the five seconds it slept have passed by it.
    const t0 = Date.parse("2026-11-12T10:00:00.000Z");
    vi.setSystemTime(t0);
    expect(deps.now()).toBe(t0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deps.now()).toBe(t0 + 5000);
  });

  it("from the npx cache it hands over to the persistent copy, as install does", async () => {
    vi.mocked(viaNpx).mockReturnValue(true);
    await run({}, "update");
    expect(rerunGlobally).toHaveBeenCalledWith(["update"], expect.any(Function));
    expect(bringCurrent).not.toHaveBeenCalled();
  });

  it("off and on switch the service's own daily update; anything else is a usage error and installs nothing", async () => {
    expect((await run({}, "update", "off")).text).toContain(
      "✓ The background service no longer checks npm or updates by itself.",
    );
    expect(
      JSON.parse(require("node:fs").readFileSync(process.env.SESSIONPIPE_CONFIG as string, "utf8")).update_check,
    ).toBe(false);
    expect((await run({}, "update", "on")).text).toContain(
      "✓ The background service checks npm once a day and updates this computer by itself.",
    );
    for (const word of ["OFF", "of", "now"]) {
      expect((await run({}, "update", word)).lines).toEqual(["usage: sessionpipe update [off|on]"]);
      expect(process.exitCode).toBe(2);
    }
    expect(bringCurrent).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === "win32")("doctor: the command, the service and the hooks on one version", () => {
  const elsewhere = "/opt/other/lib/node_modules/sessionpipe/dist/cli.js";
  const service = (o: Partial<ServiceState> = {}): ServiceState => ({
    manager: "launchd",
    file: "/h/Library/LaunchAgents/org.sessionpipe.control.plist",
    installed: true,
    loaded: true,
    argv: [process.execPath, realpathSync(path.join(realDist, "cli.js")), "control", "run"],
    // The process the manager runs for it is the daemon that answers (`status`'s pid).
    pid: 7,
    ...o,
  });
  const fix = (text: string) => text.slice(text.indexOf("To fix"));
  beforeEach(() => {
    steadyHook();
    // A shell here looks where a copy's command would be: with no such folder on PATH,
    // doctor says `sessionpipe` is not found when typed, which is another test's to say
    // (cli-main.test.ts) and not what these are about.
    vi.stubEnv("PATH", path.join(home, ".local", "bin"));
  });

  it("one copy, one version: nothing to say", async () => {
    paired();
    vi.mocked(serviceLook).mockReturnValue(service());
    await daemon({ status: status(VERSION) });
    const r = await run({}, "doctor");
    expect(r.text).toMatch(/^ {2}✓ background service {2,}running$/m);
    expect(r.text).not.toContain("sessionpipe update");
    // The hook was timed by the test's clock, not by how fast this machine starts node.
    expect(r.text).toMatch(/^ {2}✓ hook speed {2,}1 ms each \(95 in 100 under 1 ms\)$/m);
    expect(r.lines[0]).toBe("✓ All good");
  });

  it("the service on another copy and version, and the hooks on a third: one thing to run", async () => {
    paired();
    put(process.env.SESSIONPIPE_CONFIG as string, { harnesses: { "claude-code": { enabled: true } } });
    installLauncher({ distDir: realDist, node: process.execPath, version: "0.8.0" });
    vi.mocked(serviceLook).mockReturnValue(service({ argv: [process.execPath, elsewhere, "control", "run"] }));
    await daemon({ status: status("0.9.0") });
    const r = await run({}, "doctor");
    expect(r.text).toMatch(
      /^ {2}! background service {2,}running sessionpipe 0\.9\.0 from another copy, in \/opt\/other$/m,
    );
    expect(r.text).toMatch(
      new RegExp(
        `^ {2}! hooks {2,}run sessionpipe 0\\.8\\.0, and this command is ${VERSION.replace(/\./g, "\\.")}$`,
        "m",
      ),
    );
    expect(fix(r.text)).toContain(
      `This command is sessionpipe ${VERSION}, and the background service runs 0.9.0 from another copy (in /opt/other), and the hooks run 0.8.0. One command puts it right:\n       sessionpipe update`,
    );
    // One item for all of it, and never `install` from what may be the older copy.
    expect(fix(r.text).match(/sessionpipe update/g)).toHaveLength(1);
    expect(fix(r.text)).not.toContain("sessionpipe install");
    expect(process.exitCode).toBe(1);
    expect(JSON.parse((await run({}, "doctor", "--json")).text).warnings).toContain(
      `the hooks run sessionpipe 0.8.0, this is ${VERSION}; run \`sessionpipe update\` to bring both up to date`,
    );
  });

  it("this copy's own service on another version: the same one thing", async () => {
    paired();
    vi.mocked(serviceLook).mockReturnValue(service());
    await daemon({ status: status("0.9.0") });
    const r = await run({}, "doctor");
    expect(r.text).toMatch(
      new RegExp(`running sessionpipe 0\\.9\\.0, and this command is ${VERSION.replace(/\./g, "\\.")}$`, "m"),
    );
    expect(fix(r.text)).toContain(
      `This command is sessionpipe ${VERSION}, and the background service runs 0.9.0. One command puts it right:`,
    );
  });

  it("another copy kept at this version is said, and is nothing to fix", async () => {
    paired();
    vi.mocked(serviceLook).mockReturnValue(
      service({ argv: [process.execPath, "/src/checkout/packages/cli/dist/cli.js", "control", "run"] }),
    );
    await daemon({ status: status(VERSION) });
    const r = await run({}, "doctor");
    // One npm didn't install has no prefix to name: its folder is.
    expect(r.text).toMatch(
      /^ {2}· background service {2,}running, from another copy kept at this version, in \/src\/checkout\/packages\/cli\/dist$/m,
    );
    expect(r.text).not.toContain("To fix");
  });

  /** A daemon (pid 7, this release) that answers `status`, and `health` as a test says:
   *  with who started it (`via`: null for someone by hand), without that word (one from
   *  before 0.15), or not at all (it closes the connection on a request it doesn't know). */
  type Word = { via: "launchd" | "systemd" | "supervisor" | null } | "no word" | "no answer";
  async function answering(release = VERSION): Promise<{ say: (w: Word) => void; asked: string[] }> {
    const asked: string[] = [];
    let word: Word = "no answer";
    const replies = {
      get status() {
        asked.push("status");
        return status(release);
      },
      get health() {
        asked.push("health");
        return word === "no answer"
          ? undefined
          : {
              op: "health",
              health: { accounts: [], ...(word === "no word" ? {} : { copy: { cli: "/x/cli.js", ...word } }) },
            };
      },
    };
    await daemon(replies);
    return {
      say: (w) => {
        word = w;
      },
      asked,
    };
  }
  const BY_HAND: Word = { via: null };
  const BY_LAUNCHD: Word = { via: "launchd" };
  /** Who launchd names for the service (the daemon that answers is pid 7), what the daemon
   *  says of who started it, and whether that is two daemons. One definition, plan.ts
   *  `twins`: `reinstall` goes by the same one, so the command doctor names does something. */
  const TABLE: [string, number | null, Word, boolean][] = [
    ["launchd names the daemon, which says launchd started it", 7, BY_LAUNCHD, false],
    ["launchd names the daemon, which doesn't say", 7, "no word", false],
    ["launchd names the daemon, which says it was started by hand", 7, BY_HAND, false],
    ["launchd names another process, and the daemon says it was started by hand", 4242, BY_HAND, true],
    ["launchd names another process, and the daemon says a supervisor started it", 4242, { via: "supervisor" }, false],
    ["launchd names another process, and the daemon says systemd started it", 4242, { via: "systemd" }, false],
    ["launchd names another process, and the daemon doesn't say", 4242, "no word", true],
    ["launchd names another process, and the daemon doesn't answer that question", 4242, "no answer", true],
    ["launchd names no process, and the daemon says it was started by hand", null, BY_HAND, true],
    ["launchd names no process, and the daemon says launchd started it", null, BY_LAUNCHD, false],
    ["launchd names no process, and the daemon doesn't say", null, "no word", false],
    ["launchd names no process, and the daemon doesn't answer that question", null, "no answer", false],
  ];

  it.each(TABLE)("two daemons or one: %s", async (_said, pid, word, two) => {
    paired();
    const d = await answering();
    d.say(word);
    vi.mocked(serviceLook).mockReturnValue(service({ pid }));
    const r = await run({}, "doctor");
    const json = JSON.parse((await run({}, "doctor", "--json")).text) as { warnings: string[] };
    const WARNING =
      "a daemon started by hand (pid 7) holds the socket the background service needs; `sessionpipe reinstall` stops it and lets the service take over";
    if (two) {
      // A warning row, a warning for a program, and `reinstall` as the one command.
      expect(r.text).toMatch(
        /^ {2}! background service {2,}a daemon someone started by hand \(pid 7\) answers, and holds the socket the service needs$/m,
      );
      expect(r.text).not.toMatch(/background service {2,}running/);
      expect(r.lines[0]).toBe("! 1 thing needs attention");
      // One item, one sentence, and the command that stops that daemon: `update` would not.
      expect(fix(r.text)).toContain(
        "A daemon someone started by hand holds the socket the background service needs. One command puts it right:\n       sessionpipe reinstall",
      );
      expect(fix(r.text)).not.toContain("sessionpipe update");
      expect(fix(r.text).match(/sessionpipe reinstall/g)).toHaveLength(1);
      expect(process.exitCode).toBe(1);
      expect(json.warnings).toContain(WARNING);
    } else {
      // The one daemon is the service's own, as far as anything says: nothing to say.
      expect(r.text).toMatch(/^ {2}✓ background service {2,}running$/m);
      expect(r.text).not.toContain("started by hand");
      expect(r.text).not.toContain("sessionpipe reinstall");
      expect(r.lines[0]).toBe("✓ All good");
      expect(process.exitCode).toBeUndefined();
      expect(json.warnings.filter((w) => /by hand|reinstall/.test(w))).toEqual([]);
    }
  });

  it("two daemons, and the one that answers is another release: the row says whose it is, and the one command is still `reinstall`", async () => {
    paired();
    vi.mocked(serviceLook).mockReturnValue(service({ pid: 4242 }));
    await daemon({ status: status("0.9.0") });
    const r = await run({}, "doctor");
    // Whose daemon it is comes first: which release it runs is said in the fix.
    expect(r.text).toMatch(/^ {2}! background service {2,}a daemon someone started by hand \(pid 7\) answers/m);
    expect(fix(r.text)).toContain(
      `A daemon someone started by hand holds the socket the background service needs. This command is sessionpipe ${VERSION}, and the background service runs 0.9.0. One command puts it right:\n       sessionpipe reinstall`,
    );
    expect(fix(r.text)).not.toContain("sessionpipe update");
  });

  it("with a service launchd doesn't have loaded, or no manager to ask, there are no two: the daemon that answers is the one, and it is not asked who started it", async () => {
    paired();
    const d = await answering();
    d.say(BY_HAND);
    /** How often the daemon was asked `health` by one doctor. */
    const healthAsks = async (): Promise<number> => {
      d.asked.length = 0;
      process.exitCode = undefined;
      const r = await run({}, "doctor");
      expect(r.text).toMatch(/^ {2}✓ background service {2,}running$/m);
      expect(r.text).not.toContain("started by hand");
      expect(r.text).not.toContain("sessionpipe reinstall");
      expect(process.exitCode).toBeUndefined();
      return d.asked.filter((op) => op === "health").length;
    };
    // A file launchd doesn't have loaded while a daemon answers that says it was started
    // by hand: nothing holds a socket against a service that is not there to need it.
    vi.mocked(serviceLook).mockReturnValue(service({ loaded: false, pid: null }));
    const unloaded = await healthAsks();
    // Nobody to ask (no manager from this shell).
    vi.mocked(serviceLook).mockReturnValue(null);
    expect(await healthAsks()).toBe(unloaded);
    // Loaded, and launchd names the daemon that answers: one daemon, and it was asked who
    // started it, once more than where there was no service for it to be in the way of.
    vi.mocked(serviceLook).mockReturnValue(service({ pid: 7 }));
    expect(await healthAsks()).toBe(unloaded + 1);
  });

  it("a service launchd should be running and isn't: `update` puts it back", async () => {
    paired();
    vi.mocked(serviceLook).mockReturnValue(service({ loaded: false }));
    const r = await run({}, "doctor");
    expect(r.text).toMatch(/^ {2}✗ background service {2,}not loaded: launchd doesn't have it$/m);
    expect(fix(r.text)).toContain(
      "The background service isn't running, so no message reaches this computer. One command puts it right:\n       sessionpipe update",
    );
  });

  it("loaded and silent: its log; no manager here, or no service anyone asked for: a person starts it", async () => {
    paired();
    vi.mocked(serviceLook).mockReturnValue(service());
    const silent = await run({}, "doctor");
    expect(silent.text).toMatch(/^ {2}✗ background service {2,}started but not answering$/m);
    expect(fix(silent.text)).toMatch(/Its log says why:\n {7}tail -n 20 .*daemon\.log/);
    vi.mocked(serviceLook).mockReturnValue(null);
    const none = await run({}, "doctor");
    expect(none.text).toMatch(/^ {2}✗ background service {2,}not running$/m);
    expect(fix(none.text)).toContain("Start it, and leave it running:\n       sessionpipe control run");
    // launchd is there and no service file is: `update` would install none, and says the same.
    vi.mocked(serviceLook).mockReturnValue(service({ installed: false, loaded: false, argv: null }));
    const byHand = await run({}, "doctor");
    expect(byHand.text).toMatch(/^ {2}✗ background service {2,}not loaded: launchd doesn't have it$/m);
    expect(fix(byHand.text)).toContain("Start it, and leave it running:\n       sessionpipe control run");
    expect(fix(byHand.text)).not.toContain("sessionpipe update");
  });

  it("with nothing that needs the service, nobody is asked about it", async () => {
    await run({}, "status");
    expect(serviceLook).not.toHaveBeenCalled();
  });
});
