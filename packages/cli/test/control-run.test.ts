// SPDX-License-Identifier: Apache-2.0
// `sessionpipe control run`: how the daemon is wired at the terminal. The daemon, the
// updater and the SDK loader are stand-ins that keep what they were handed, so each
// hook the daemon is given (which claude, its login, a token read again, the updater's
// answers, a lost socket) and each way the process ends (a signal, a second daemon, a
// restart onto a new copy) can be driven in-process.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeConfig } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restartVia, supervise, UPDATE_EXIT } from "../src/control/autoupdate.js";
import { controlMain } from "../src/control/cli.js";
import { type DaemonDeps, DaemonRunning } from "../src/control/daemon.js";
import { loadSdk } from "../src/control/sdk.js";
import { controlFile, writeControl } from "../src/control/store.js";
import { drain } from "../src/run.js";
import { secretGet } from "../src/secrets.js";

const seen = vi.hoisted(() => ({
  daemons: [] as { cfg: unknown; deps: DaemonDeps; stopped: number; reloaded: unknown[] }[],
  updaters: [] as { deps: { restart: (from: string, to: string) => Promise<void> }; stopped: number }[],
  startFails: null as Error | null,
  onStart: null as null | ((deps: DaemonDeps) => void),
  watchers: [] as (() => void)[],
}));

vi.mock("../src/control/daemon.js", async (original) => {
  const real = await original<typeof import("../src/control/daemon.js")>();
  class ControlDaemon {
    stopped = 0;
    reloaded: unknown[] = [];
    constructor(
      readonly cfg: unknown,
      _dir: string,
      _sock: string,
      readonly deps: DaemonDeps,
    ) {
      seen.daemons.push(this);
    }
    async start() {
      seen.onStart?.(this.deps);
      if (seen.startFails) throw seen.startFails;
    }
    async stop() {
      this.stopped++;
    }
    reload(c: unknown) {
      this.reloaded.push(c);
    }
  }
  return { ...real, ControlDaemon };
});
vi.mock("../src/control/autoupdate.js", async (original) => {
  const real = await original<typeof import("../src/control/autoupdate.js")>();
  class AutoUpdater {
    stopped = 0;
    constructor(readonly deps: { restart: (from: string, to: string) => Promise<void> }) {
      seen.updaters.push(this);
    }
    start() {}
    stop() {
      this.stopped++;
    }
    restartWhenIdle() {
      return true;
    }
    record() {
      return { latest: "9.9.9" };
    }
  }
  return { ...real, AutoUpdater, supervise: vi.fn(() => ({ stop: vi.fn() })), restartVia: vi.fn(real.restartVia) };
});
vi.mock("../src/control/sdk.js", () => ({ loadSdk: vi.fn(async () => null) }));
vi.mock("../src/run.js", async (original) => ({
  ...(await original<typeof import("../src/run.js")>()),
  drain: vi.fn(async () => ({})),
}));
const updates = vi.hoisted(() => ({
  latestVersion: vi.fn(async () => "9.9.9"),
  installedVersion: vi.fn(async () => "1.0.0"),
  installVersion: vi.fn(async () => ({ ok: true as const, ms: 1 })),
}));
vi.mock("../src/update.js", async (original) => ({
  ...(await original<typeof import("../src/update.js")>()),
  ...updates,
}));
vi.mock("../src/secrets.js", async (original) => ({
  ...(await original<typeof import("../src/secrets.js")>()),
  secretGet: vi.fn(() => "from-the-keychain"),
}));
const core = vi.hoisted(() => ({
  findClaude: vi.fn((): string | null => null),
  detectCaps: vi.fn(() => ({ hasMode: true, modes: ["dontAsk"], promptsNone: false, fork: true })),
  claudeLogin: vi.fn(async () => ({ loggedIn: true as boolean | null })),
}));
vi.mock("@sessionpipe/core", async (original) => {
  const real = await original<typeof import("@sessionpipe/core")>();
  return {
    ...real,
    claudeControl: { ...real.claudeControl, ...core },
    codexControl: {
      ...real.codexControl,
      findCodex: () => null,
      codexLogin: async (bin: string) => ({ loggedIn: bin === "/codex" }),
    },
    antigravityControl: { ...real.antigravityControl, findAgy: () => null },
    acpControl: { ...real.acpControl, findAcpAgent: () => null },
    drivableHarnesses: () => [],
  };
});
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  return {
    ...real,
    watchFile: (_f: string, _o: unknown, cb: () => void) => seen.watchers.push(cb),
    unwatchFile: vi.fn(),
  };
});

let tmp: string;
let dist: string;
let out: string[];
type Listener = (...args: unknown[]) => void;
let signals: Map<string, Listener[]>;
const SIGS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
/** The process as a plain emitter: the signal overloads get in the way of listing listeners. */
const emitter = process as unknown as { listeners(e: string): Listener[]; off(e: string, l: Listener): void };
const added = (sig: string) => emitter.listeners(sig).filter((l) => !signals.get(sig)?.includes(l));
const daemon = () => seen.daemons.at(-1)!;
const run = () => controlMain(["control", "run"], (s) => out.push(s ?? ""), dist);

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-ctl-run-")));
  dist = path.join(tmp, "dist");
  vi.stubEnv("SESSIONPIPE_CONFIG", path.join(tmp, "config", "config.json"));
  vi.stubEnv("SESSIONPIPE_STATE", path.join(tmp, "state"));
  vi.stubEnv("SESSIONPIPE_SOCKET", path.join(tmp, "control.sock"));
  vi.stubEnv("SESSIONPIPE_SERVICE", "");
  out = [];
  seen.daemons.length = 0;
  seen.updaters.length = 0;
  seen.watchers.length = 0;
  seen.startFails = null;
  seen.onStart = null;
  signals = new Map(SIGS.map((s) => [s, emitter.listeners(s)]));
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  core.findClaude.mockReset().mockReturnValue(null);
  core.detectCaps.mockClear();
  core.claudeLogin.mockClear();
  vi.mocked(supervise).mockClear();
  vi.mocked(loadSdk).mockClear();
});
afterEach(() => {
  for (const sig of SIGS) for (const l of added(sig)) emitter.off(sig, l);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

function paired(): void {
  writeControl({
    name: "box",
    folders: [tmp],
    mode: "safe",
    receivers: [
      {
        url: "https://rx.test",
        control: "https://rx.test/control",
        rpId: "rx.test",
        machine: "m_0123456789abcdef",
        token: "",
        token_in: "keychain",
        keys: [],
        paired_at: "x",
      },
    ],
  });
}

describe("control run", () => {
  it("with nothing paired there is nothing to do", async () => {
    await run();
    expect(out).toEqual([
      "control isn't paired on this machine; nothing to do (`sessionpipe control pair <receiver>`)",
    ]);
    expect(seen.daemons).toEqual([]);
  });

  it("hands the daemon this machine's claude (found once per binary), its login, and a token read again", async () => {
    paired();
    const claude = path.join(tmp, "claude");
    writeFileSync(claude, "");
    await run();
    expect(loadSdk).toHaveBeenCalledWith(expect.objectContaining({ claudeBin: null }));
    const { deps } = daemon();
    expect(deps.claude()).toBeNull();
    expect(await deps.login?.("/cfg")).toEqual({ loggedIn: null });
    core.findClaude.mockReturnValue(claude);
    expect(deps.claude()).toMatchObject({ bin: claude });
    expect(deps.claude()).toMatchObject({ bin: claude });
    expect(core.detectCaps).toHaveBeenCalledTimes(1);
    // A path that isn't there yet is still a claude, told apart by its path alone.
    core.findClaude.mockReturnValue(path.join(tmp, "later"));
    expect(deps.claude()?.bin).toBe(path.join(tmp, "later"));
    expect(core.detectCaps).toHaveBeenCalledTimes(2);
    expect(await deps.login?.("/cfg")).toEqual({ loggedIn: true });
    expect(core.claudeLogin).toHaveBeenCalledWith(path.join(tmp, "later"), "/cfg");
    const r = (daemon().cfg as { receivers: { token_in?: string }[] }).receivers[0]!;
    expect(deps.token?.(r as never)).toBe("from-the-keychain");
    expect(secretGet).toHaveBeenCalledWith("keychain", "control:m_0123456789abcdef");
    expect(deps.token?.({ ...r, token_in: undefined } as never)).toBeNull();
    expect(deps.harnesses?.()).toEqual([]);
    expect(deps.codex?.()).toBeNull();
    expect(deps.agy?.()).toBeNull();
    expect(deps.acp?.("goose")).toBeNull();
    expect(deps.claudeDirs()).toContain(path.join(os.homedir(), ".claude"));
    expect(await deps.codexLogin?.("/codex")).toEqual({ loggedIn: true });
    expect(deps.updateStatus?.()).toEqual({ latest: "9.9.9" });
    expect(deps.onRestart?.()).toBe(true);
    deps.onLostSocket?.();
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(out.at(-1)).toBeUndefined();
  });

  it("the updater is given this copy's opt-out, the registry, the copy on disk and the installer", async () => {
    paired();
    vi.stubEnv("SESSIONPIPE_NO_UPDATE_CHECK", "1");
    await run();
    const deps = seen.updaters[0]!.deps as unknown as {
      off: () => string | null;
      latest: () => Promise<string>;
      installed: () => Promise<string | null>;
      install: (v: string) => Promise<unknown>;
    };
    expect(deps.off()).toBe("SESSIONPIPE_NO_UPDATE_CHECK is set");
    expect(await deps.latest()).toBe("9.9.9");
    expect(await deps.installed()).toBe("1.0.0");
    expect(await deps.install("9.9.9")).toEqual({ ok: true, ms: 1 });
    expect(updates.installVersion).toHaveBeenCalledWith(
      "9.9.9",
      expect.objectContaining({ distDir: dist, harnesses: [] }),
    );
  });

  it("before the updater exists, a restart asked over the socket is declined and there is no update status", async () => {
    paired();
    let early: [boolean | undefined, unknown] | null = null;
    seen.onStart = (deps) => {
      early = [deps.onRestart?.(), deps.updateStatus?.()];
    };
    await run();
    expect(early).toEqual([false, null]);
  });

  it("a drain that fails once a minute is left for the next minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      paired();
      writeConfig({ sinks: [{ name: "s", url: "https://rx.test", tier: 0, token: "t" }], harnesses: {} });
      vi.mocked(drain).mockRejectedValueOnce(new Error("EBUSY"));
      await run();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(drain).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(drain).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("control.json edited by hand reaches the running daemon; a broken one is ignored", async () => {
    paired();
    await run();
    expect(seen.watchers).toHaveLength(1);
    writeControl({ name: "renamed", folders: [], mode: "auto", receivers: [] });
    seen.watchers[0]!();
    expect(daemon().reloaded).toEqual([expect.objectContaining({ name: "renamed", mode: "auto" })]);
    writeFileSync(controlFile(), "{");
    seen.watchers[0]!();
    expect(daemon().reloaded).toHaveLength(1);
  });

  it("another daemon already serves this machine: this one says so and exits 0", async () => {
    paired();
    seen.startFails = new DaemonRunning({ pid: 7, version: "1.0.0" });
    await run();
    expect(out.at(-1)).toMatch(
      /another control daemon already serves this machine \(pid 7, sessionpipe 1.0.0\); this one exits$/,
    );
    expect(process.exit).toHaveBeenCalledWith(0);
    seen.startFails = new Error("EADDRINUSE");
    await expect(run()).rejects.toThrow("EADDRINUSE");
  });

  it("SIGTERM and SIGINT stop the updater and the daemon once, then exit 0", async () => {
    paired();
    await run();
    const bye = added("SIGTERM");
    expect(bye).toHaveLength(1);
    expect(added("SIGINT")).toHaveLength(1);
    await (bye[0] as () => Promise<void>)();
    await (added("SIGINT")[0] as () => Promise<void>)();
    expect(daemon().stopped).toBe(1);
    expect(seen.updaters[0]?.stopped).toBe(1);
    expect(process.exit).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("a restart under a service manager: stop everything and exit 75 for it to start the new copy", async () => {
    paired();
    vi.stubEnv("SESSIONPIPE_SERVICE", `supervisor:${process.ppid}`);
    await run();
    vi.mocked(process.exit).mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    await expect(seen.updaters[0]!.deps.restart("1.0.0", "1.1.0")).rejects.toThrow(`exit ${UPDATE_EXIT}`);
    expect(daemon().stopped).toBe(1);
    expect(added("SIGTERM")).toHaveLength(0);
    expect(out.at(-1)).toContain("exiting 75 so the supervising sessionpipe starts 1.1.0");
    expect(supervise).not.toHaveBeenCalled();
    // Under launchd or systemd, that manager is named.
    vi.mocked(restartVia).mockReturnValueOnce("launchd");
    await expect(seen.updaters[0]!.deps.restart("1.1.0", "1.2.0")).rejects.toThrow(`exit ${UPDATE_EXIT}`);
    expect(out.at(-1)).toContain("exiting 75 so launchd starts 1.2.0");
  });

  it("a restart with nobody to restart it: this process stays as the new daemon's parent", async () => {
    paired();
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "cli.js"), "");
    await run();
    await seen.updaters[0]!.deps.restart("1.0.0", "1.1.0");
    expect(out.at(-1)).toContain(
      `no service manager restarts this daemon: pid ${process.pid} now runs 1.1.0 as its child`,
    );
    expect(supervise).toHaveBeenCalledWith(
      expect.objectContaining({ node: process.execPath, args: [path.join(dist, "cli.js"), "control", "run"] }),
    );
    const sup = vi.mocked(supervise).mock.results[0]!.value as { stop: ReturnType<typeof vi.fn> };
    for (const sig of SIGS) {
      expect(added(sig)).toHaveLength(1);
      (added(sig)[0] as () => void)();
      expect(sup.stop).toHaveBeenLastCalledWith(sig);
    }
    expect(process.exit).not.toHaveBeenCalled();
  });
});
