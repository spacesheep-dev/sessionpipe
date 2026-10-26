// SPDX-License-Identifier: Apache-2.0
// Updating a copy from npm, and the control daemon doing it by itself: the version
// order, which copies may update, the install with npm and the registry stood in for
// (no test touches the network), the once-a-day clock kept on disk, every way to turn
// it off, the idle gate, and who restarts the daemon onto the new code.
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AutoUpdater,
  autoUpdateOff,
  DAY_MS,
  isDue,
  readUpdate,
  restartVia,
  supervise,
  UPDATE_EXIT,
  type UpdaterDeps,
  updateLine,
  updateSummary,
} from "../src/control/autoupdate.js";
import { serviceFiles } from "../src/control/pair.js";
import {
  compareVersions,
  type Exec,
  type ExecResult,
  execCapture,
  globalPrefix,
  installedVersion,
  installVersion,
  isNewer,
  latestVersion,
  npmArgv,
  prefixOf,
  REGISTRY_LATEST,
  unwritable,
} from "../src/update.js";

const posix = process.platform !== "win32";
let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-update-")));
});
afterEach(() => {
  try {
    chmodSync(path.join(tmp, "prefix", "lib", "node_modules"), 0o755);
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});

/** A global npm install of sessionpipe under <tmp>/prefix: its dist folder. */
function globalCopy(): { prefix: string; dist: string } {
  const prefix = path.join(tmp, "prefix");
  const dist = path.join(prefix, "lib", "node_modules", "sessionpipe", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, "cli.js"), "");
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  writeFileSync(path.join(prefix, "bin", "sessionpipe"), "");
  return { prefix, dist };
}

describe("versions", () => {
  it("orders releases numerically, a release above its own prereleases", () => {
    expect(isNewer("0.6.0", "0.5.0")).toBe(true);
    expect(isNewer("0.5.10", "0.5.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.5.0", "0.5.0")).toBe(false);
    expect(isNewer("0.4.2", "0.5.0")).toBe(false);
    expect(isNewer("v0.6.0", "0.5.0")).toBe(true);
    expect(isNewer("0.6.0", "0.6.0-beta.2")).toBe(true);
    expect(compareVersions("0.6.0-beta.10", "0.6.0-beta.2")).toBeGreaterThan(0);
  });
  it("never offers a prerelease, and garbage is never newer", () => {
    expect(isNewer("0.7.0-beta.1", "0.5.0")).toBe(false);
    expect(isNewer("latest", "0.5.0")).toBe(false);
    expect(isNewer("0.6", "0.5.0")).toBe(false);
    expect(isNewer("0.6.0", "dev")).toBe(false);
    expect(compareVersions("x", "0.1.0")).toBeNull();
  });
  it("setup can compare installed prereleases without offering them as auto-updates", () => {
    expect(isNewer("0.9.0-devin.1", "0.7.0", true)).toBe(true);
    expect(isNewer("0.9.0-devin.1", "0.7.0")).toBe(false);
    expect(isNewer("0.7.0", "0.9.0-devin.1")).toBe(false);
    expect(isNewer("0.9.0", "0.9.0-devin.1")).toBe(true);
    expect(isNewer("0.9.0-devin.2", "0.9.0-devin.1", true)).toBe(true);
    expect(isNewer("0.9.0-devin.1", "0.9.0", true)).toBe(false);
    expect(isNewer("0.9.0-devin.1", "0.9.0-devin.1", true)).toBe(false);
    expect(isNewer("garbage", "0.7.0", true)).toBe(false);
  });
});

describe("the registry", () => {
  it("reads `latest` with one GET", async () => {
    const asked: string[] = [];
    const f = (async (u: string | URL) => {
      asked.push(String(u));
      return new Response(JSON.stringify({ name: "sessionpipe", version: "0.6.0" }), { status: 200 });
    }) as typeof fetch;
    expect(await latestVersion(f)).toBe("0.6.0");
    expect(asked).toEqual([REGISTRY_LATEST]);
  });
  it("an error status or a body without a version is an error", async () => {
    const f500 = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await expect(latestVersion(f500)).rejects.toThrow(/HTTP 503/);
    const fBad = (async () => new Response(JSON.stringify({ version: "<script>" }))) as unknown as typeof fetch;
    await expect(latestVersion(fBad)).rejects.toThrow(/no version/);
  });
});

describe.runIf(posix)("which copies update themselves", () => {
  it("a global npm install: its prefix", () => {
    const { prefix, dist } = globalCopy();
    expect(globalPrefix(dist)).toBe(prefix);
    expect(autoUpdateOff({ env: {}, config: {}, distDir: dist })).toBeNull();
  });
  it("not the npx cache, a checkout, a project's node_modules, or a prefix without the bin link", () => {
    const npx = path.join(tmp, ".npm", "_npx", "abc", "node_modules", "sessionpipe", "dist");
    const checkout = path.join(tmp, "src", "sessionpipe", "packages", "cli", "dist");
    const project = path.join(tmp, "app", "node_modules", "sessionpipe", "dist");
    for (const d of [npx, checkout, project]) mkdirSync(d, { recursive: true });
    for (const d of [npx, checkout, project]) {
      expect(globalPrefix(d)).toBeNull();
      expect(autoUpdateOff({ env: {}, config: {}, distDir: d })).toMatch(/isn't a global npm install/);
    }
    const { prefix, dist } = globalCopy();
    rmSync(path.join(prefix, "bin", "sessionpipe"));
    expect(globalPrefix(dist)).toBeNull();
  });
  it("every opt-out: the env, the config, a prefix this user can't write", () => {
    const { prefix, dist } = globalCopy();
    expect(autoUpdateOff({ env: { SESSIONPIPE_NO_UPDATE_CHECK: "1" }, config: {}, distDir: dist })).toMatch(
      /SESSIONPIPE_NO_UPDATE_CHECK/,
    );
    expect(autoUpdateOff({ env: {}, config: { update_check: false }, distDir: dist })).toMatch(/update_check/);
    expect(autoUpdateOff({ env: {}, config: { update_check: true }, distDir: dist })).toBeNull();
    if (process.getuid?.() !== 0) {
      chmodSync(path.join(prefix, "lib", "node_modules"), 0o555);
      expect(autoUpdateOff({ env: {}, config: {}, distDir: dist })).toMatch(/isn't writable/);
    }
  });
  it("npm is run by this node, from beside it (launchd's PATH has neither)", () => {
    const bin = path.join(tmp, "node", "bin");
    const cli = path.join(tmp, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(bin, { recursive: true });
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, "");
    writeFileSync(path.join(bin, "node"), "");
    expect(npmArgv(path.join(bin, "node"))).toEqual([path.join(bin, "node"), cli]);
    symlinkSync(cli, path.join(bin, "npm"));
    expect(npmArgv(path.join(bin, "node"))[1]).toBe(cli);
    expect(npmArgv(path.join(tmp, "elsewhere", "node"))).toEqual(["npm"]);
  });
});

describe.runIf(posix)("installVersion (npm stood in for)", () => {
  function fakeExec(o: { npm?: number; version?: string; rearm?: number } = {}) {
    const calls: string[][] = [];
    const exec: Exec = async (argv) => {
      calls.push(argv);
      if (argv.includes("--global")) return { code: o.npm ?? 0, stdout: "", stderr: o.npm ? "npm ERR! EACCES" : "" };
      if (argv.includes("--version")) return { code: 0, stdout: `${o.version ?? "0.6.0"}\n`, stderr: "" };
      if (argv.includes("install")) return { code: o.rearm ?? 0, stdout: "  ✓ hook launcher", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    return { calls, exec };
  }

  it("installs into the running copy's prefix, checks the copy on disk, re-arms the harnesses set up here", async () => {
    const { prefix, dist } = globalCopy();
    const { calls, exec } = fakeExec();
    const r = await installVersion("0.6.0", {
      node: "/opt/node/bin/node",
      distDir: dist,
      harnesses: ["claude-code", "codex"],
      exec,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(r).toMatchObject({ ok: true, hooks: "hooks re-armed for claude-code, codex" });
    expect(calls[0]).toEqual(
      expect.arrayContaining(["install", "--global", "--prefix", prefix, "--ignore-scripts", "sessionpipe@0.6.0"]),
    );
    expect(calls[1]).toEqual(["/opt/node/bin/node", path.join(dist, "cli.js"), "--version"]);
    expect(calls[2]).toEqual([
      "/opt/node/bin/node",
      path.join(dist, "cli.js"),
      "install",
      "--backfill",
      "0",
      "--claude-code",
      "--codex",
    ]);
  });
  it("npm failing, or a copy on disk that isn't the version asked for, is a failure that says so", async () => {
    const { dist } = globalCopy();
    const npmFails = await installVersion("0.6.0", {
      node: "n",
      distDir: dist,
      harnesses: [],
      ...fakeExec({ npm: 1 }),
    });
    expect(npmFails).toMatchObject({ ok: false, stage: "npm", error: expect.stringContaining("EACCES") });
    const wrong = await installVersion("0.6.0", {
      node: "n",
      distDir: dist,
      harnesses: [],
      ...fakeExec({ version: "0.5.0" }),
    });
    expect(wrong).toMatchObject({ ok: false, stage: "verify" });
  });
  it("not a global install: npm never runs", async () => {
    const { calls, exec } = fakeExec();
    const r = await installVersion("0.6.0", {
      node: "n",
      distDir: path.join(tmp, "checkout", "dist"),
      harnesses: [],
      exec,
    });
    expect(r).toMatchObject({ ok: false, stage: "prefix" });
    expect(calls).toEqual([]);
  });
  it("no harness set up: the hooks are left alone", async () => {
    const { dist } = globalCopy();
    const { calls, exec } = fakeExec();
    const r = await installVersion("0.6.0", { node: "n", distDir: dist, harnesses: [], exec });
    expect(r).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
  });
});

describe.runIf(posix)("the install's edges", () => {
  it("npm's last words: its error, the tail of its stderr, or its exit code", async () => {
    const { dist } = globalCopy();
    const npm =
      (r: Partial<ExecResult>): Exec =>
      async (argv) =>
        argv.includes("--global")
          ? { code: 1, stdout: "", stderr: "", ...r }
          : { code: 0, stdout: "0.6.0", stderr: "" };
    const run = (exec: Exec) => installVersion("0.6.0", { node: "n", distDir: dist, harnesses: [], exec });
    expect(await run(npm({ code: null, error: "spawn npm ENOENT" }))).toMatchObject({
      error: "npm install: spawn npm ENOENT",
    });
    expect(await run(npm({ stderr: "npm WARN x\nnpm ERR! code EACCES\nnpm ERR! syscall mkdir\n" }))).toMatchObject({
      error: "npm install: npm ERR! code EACCES npm ERR! syscall mkdir",
    });
    expect(await run(npm({ code: 137 }))).toMatchObject({ error: "npm install: exit 137" });
  });

  it("a re-arm that fails is said, not fatal; a copy on disk that says nothing is `nothing`", async () => {
    const { dist } = globalCopy();
    const exec: Exec = async (argv) => {
      if (argv.includes("--version")) return { code: 0, stdout: "0.6.0\n", stderr: "" };
      if (argv.includes("install") && !argv.includes("--global")) return { code: 1, stdout: "", stderr: "no hooks" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await installVersion("0.6.0", { node: "n", distDir: dist, harnesses: ["codex"], exec });
    expect(r).toMatchObject({
      ok: true,
      hooks: "re-arming the hooks failed (no hooks); `sessionpipe install` does it",
    });
    const silent: Exec = async (argv) =>
      argv.includes("--version") ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    const v = await installVersion("0.6.0", { node: "n", distDir: dist, harnesses: [], exec: silent });
    expect(v).toMatchObject({ ok: false, stage: "verify", error: expect.stringContaining("says nothing, not 0.6.0") });
    const garbage: Exec = async () => ({ code: 0, stdout: "not a version", stderr: "" });
    expect(await installedVersion({ node: "n", distDir: dist, exec: garbage })).toBeNull();
  });

  it("with nothing stood in for: this node runs the built CLI for its version, and npm is not run for a checkout", async () => {
    const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
    expect(await installedVersion({ node: process.execPath, distDir: dist })).toBe(
      JSON.parse(readFileSync(path.resolve(dist, "../package.json"), "utf8")).version,
    );
    const r = await installVersion("0.6.0", {
      node: process.execPath,
      distDir: path.join(tmp, "src", "dist"),
      harnesses: [],
    });
    expect(r).toMatchObject({ ok: false, stage: "prefix" });
  });

  it("Windows: the prefix holds node_modules directly, sessionpipe.cmd beside it, and npm-cli.js under node's own folder", () => {
    const prefix = path.join(tmp, "npm");
    const dist = path.join(prefix, "node_modules", "sessionpipe", "dist");
    mkdirSync(dist, { recursive: true });
    expect(globalPrefix(dist, "win32")).toBeNull();
    writeFileSync(path.join(prefix, "sessionpipe.cmd"), "");
    expect(globalPrefix(dist, "win32")).toBe(prefix);
    expect(globalPrefix(`${prefix}\\node_modules\\sessionpipe\\dist`, "win32")).toBe(prefix);
    expect(unwritable(prefix, "win32")).toBeNull();
    expect(unwritable(path.join(tmp, "nowhere"), "win32")).toMatch(/isn't writable/);
    const node = path.join(tmp, "nodejs", "node.exe");
    const cli = path.join(tmp, "nodejs", "node_modules", "npm", "bin", "npm-cli.js");
    expect(npmArgv(node, "win32")).toEqual(["npm.cmd"]);
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, "");
    expect(npmArgv(node, "win32")).toEqual([node, cli]);
    expect(prefixOf(dist)).toBeNull();
  });

  it("runs a command to its end, keeping its output; a timeout, a missing command and a bad argument are results too", async () => {
    const node = process.execPath;
    const ok = await execCapture([node, "-e", "process.stdout.write('out'); process.stderr.write('err')"], {
      env: process.env,
      timeoutMs: 30_000,
    });
    expect(ok).toEqual({ code: 0, stdout: "out", stderr: "err" });
    const slow = await execCapture([node, "-e", "setTimeout(() => {}, 20000)"], { env: process.env, timeoutMs: 200 });
    expect(slow.code).toBeNull();
    const missing = await execCapture([path.join(tmp, "no-such-command")], { env: process.env, timeoutMs: 1000 });
    expect(missing).toMatchObject({ code: null, error: expect.stringContaining("ENOENT") });
    const empty = await execCapture([""], { env: process.env, timeoutMs: 1000 });
    expect(empty).toMatchObject({ code: null, error: expect.any(String) });
    // On Windows a .cmd needs a shell; here the shell just reports it missing.
    const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const cmd = await execCapture(["no-such-thing.cmd"], { env: process.env, timeoutMs: 5000 });
      expect(cmd.code).not.toBe(0);
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });
});

describe("the clock", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  it("due when never checked, a day or more ago, or stamped in the future", () => {
    expect(isDue({}, now)).toBe(true);
    expect(isDue({ checked_at: new Date(now - 3600_000).toISOString() }, now)).toBe(false);
    expect(isDue({ checked_at: new Date(now - DAY_MS + 60_000).toISOString() }, now)).toBe(false);
    expect(isDue({ checked_at: new Date(now - DAY_MS).toISOString() }, now)).toBe(true);
    expect(isDue({ checked_at: new Date(now + 3 * DAY_MS).toISOString() }, now)).toBe(true);
    expect(isDue({ checked_at: "garbage" }, now)).toBe(true);
  });
});

/** An updater against fakes: the registry, the copy on disk, npm, the daemon, restart. */
function harness(o: { latest?: string; onDisk?: string; busyFor?: number } = {}, over: Partial<UpdaterDeps> = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  let busyLeft = o.busyFor ?? 0;
  let clock = Date.parse("2026-10-04T12:00:00Z");
  let disk = o.onDisk ?? "0.5.0";
  const deps: UpdaterDeps = {
    now: () => clock,
    log: (l) => lines.push(l),
    version: "0.5.0",
    file: path.join(tmp, "control", "update.json"),
    off: () => null,
    latest: async () => {
      calls.push("latest");
      return o.latest ?? "0.6.0";
    },
    installed: async () => disk,
    install: async (v) => {
      calls.push(`install ${v}`);
      disk = v;
      return { ok: true, ms: 1, hooks: "hooks re-armed for claude-code" };
    },
    daemon: {
      busy: () => {
        if (busyLeft > 0) {
          busyLeft--;
          calls.push("busy");
          return "a headless Claude Code run";
        }
        return null;
      },
      pauseIntake: () => calls.push("pause"),
      resumeIntake: () => calls.push("resume"),
    },
    restart: async (from, to) => {
      calls.push(`restart ${from}→${to}`);
    },
    idlePollMs: 1,
    ...over,
  };
  return {
    u: new AutoUpdater(deps),
    deps,
    calls,
    lines,
    advance: (ms: number) => {
      clock += ms;
    },
    record: () => readUpdate(deps.file),
  };
}

describe("the daemon's auto-update", () => {
  it("current: one check, logged, remembered; not again within the day", async () => {
    const h = harness({ latest: "0.5.0" });
    await h.u.tick();
    expect(h.calls).toEqual(["latest"]);
    expect(h.lines[0]).toMatch(/^update check: 0\.5\.0 is current \(npm latest 0\.5\.0, \d+ ms\)$/);
    expect(h.record()).toMatchObject({ latest: "0.5.0", running: "0.5.0", error: null });
    h.advance(23 * 3600_000);
    await h.u.tick();
    expect(h.calls).toEqual(["latest"]);
    h.advance(3600_000);
    await h.u.tick();
    expect(h.calls).toEqual(["latest", "latest"]);
  });

  it("a restarted daemon reads the clock from disk: no second check that day", async () => {
    const a = harness({ latest: "0.5.0" });
    await a.u.tick();
    const b = harness({ latest: "0.5.0" });
    b.advance(3600_000);
    await b.u.tick();
    expect(b.calls).toEqual([]);
  });

  it("newer: waits while a run is in hand, pauses intake, installs, then restarts onto it", async () => {
    const h = harness({ busyFor: 3 });
    await h.u.tick();
    expect(h.calls).toEqual(["latest", "busy", "busy", "busy", "pause", "install 0.6.0", "restart 0.5.0→0.6.0"]);
    expect(h.lines.some((l) => /0\.6\.0 waits until the daemon is idle \(a headless Claude Code run\)/.test(l))).toBe(
      true,
    );
    expect(h.lines.at(-1)).toMatch(/^update: 0\.5\.0 → 0\.6\.0 in \d+ ms; hooks re-armed for claude-code; restarting$/);
    expect(h.record()).toMatchObject({ pending: null, failed: null, updated: { from: "0.5.0", to: "0.6.0" } });
  });

  it("never installs while busy: nothing happens until the daemon is idle", async () => {
    let busy: string | null = "1 message(s) in hand";
    const h = harness({}, { daemon: { busy: () => busy, pauseIntake: () => {}, resumeIntake: () => {} } });
    const done = h.u.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.calls).toEqual(["latest"]);
    expect(h.record().pending).toBe("0.6.0");
    busy = null;
    await done;
    expect(h.calls).toEqual(["latest", "install 0.6.0", "restart 0.5.0→0.6.0"]);
  });

  it("a failed install lets intake go, keeps running, says why, and waits a day to try again", async () => {
    const h = harness({}, { install: async () => ({ ok: false, error: "npm install: EACCES" }) });
    await h.u.tick();
    expect(h.calls).toEqual(["latest", "pause", "resume"]);
    expect(h.lines.at(-1)).toMatch(/update: 0\.5\.0 → 0\.6\.0 failed after \d+ ms: npm install: EACCES; still running/);
    expect(h.record().failed).toMatchObject({ version: "0.6.0", error: "npm install: EACCES" });
    h.advance(3600_000);
    await h.u.tick();
    expect(h.calls).toEqual(["latest", "pause", "resume"]);
  });

  it("a wait a restart cut short carries on without asking npm again", async () => {
    const h = harness();
    mkdirSync(path.dirname(h.deps.file), { recursive: true });
    writeFileSync(
      h.deps.file,
      JSON.stringify({
        checked_at: new Date(h.deps.now() - 3600_000).toISOString(),
        latest: "0.6.0",
        pending: "0.6.0",
      }),
    );
    h.u.start();
    expect(h.record().pending).toBeNull();
    h.u.stop();
    const g = harness();
    await g.u.tick();
    expect(g.calls).toEqual(["pause", "install 0.6.0", "restart 0.5.0→0.6.0"]);
  });

  it("already on disk (installed by hand, or newer): no npm, just the restart", async () => {
    const h = harness({ onDisk: "0.7.0" });
    await h.u.tick();
    expect(h.calls).toEqual(["latest", "pause", "restart 0.5.0→0.7.0"]);
  });

  it("off: no request at all, and the reason is remembered once", async () => {
    const h = harness({}, { off: () => "update_check is false in config.json" });
    await h.u.tick();
    await h.u.tick();
    expect(h.calls).toEqual([]);
    expect(h.lines).toEqual(["auto-update off: update_check is false in config.json"]);
    expect(h.record().off).toBe("update_check is false in config.json");
  });

  it("turned off while it waits: it stops waiting and installs nothing", async () => {
    let off: string | null = null;
    const h = harness({ busyFor: 1000 }, { off: () => off });
    const done = h.u.tick();
    await new Promise((r) => setTimeout(r, 20));
    off = "update_check is false in config.json";
    await done;
    expect(h.calls.filter((c) => c !== "busy")).toEqual(["latest"]);
    expect(h.record().pending).toBeNull();
  });

  it("a failed check is remembered and logged, and counts as the day's check", async () => {
    const h = harness(
      {},
      {
        latest: async () => {
          throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
        },
      },
    );
    await h.u.tick();
    expect(h.lines[0]).toMatch(/^update check: failed after \d+ ms: getaddrinfo ENOTFOUND/);
    expect(h.record()).toMatchObject({ latest: null, error: expect.stringContaining("ENOTFOUND") });
    expect(isDue(h.record(), h.deps.now())).toBe(false);
  });

  it("`sessionpipe update` installed a copy: restart onto it once idle; the same copy stays", async () => {
    const same = harness();
    expect(same.u.restartWhenIdle()).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(same.calls).toEqual([]);
    const h = harness({ onDisk: "0.6.0", busyFor: 2 });
    expect(h.u.restartWhenIdle()).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.calls).toEqual(["busy", "busy", "pause", "restart 0.5.0→0.6.0"]);
  });

  it("starts with a check about a minute in (shortened here)", async () => {
    const h = harness({ latest: "0.5.0" }, { firstCheckMs: 5, tickMs: 60_000 });
    h.u.start();
    await new Promise((r) => setTimeout(r, 40));
    h.u.stop();
    expect(h.calls).toEqual(["latest"]);
  });

  it("status says what it does and what it found", () => {
    const now = Date.parse("2026-10-04T12:00:00Z");
    const rec = { checked_at: new Date(now - 3 * 3600_000).toISOString(), latest: "0.6.0" };
    const on = updateSummary({ off: null, paired: true, rec });
    expect(on.auto).toBe(true);
    expect(updateLine(on, now)).toMatch(/^automatic .* · last check 3 h ago: latest 0\.6\.0$/);
    const noDaemon = updateSummary({ off: null, paired: false, rec: {} });
    expect(noDaemon.auto).toBe(false);
    expect(updateLine(noDaemon, now)).toMatch(/^not automatic: it runs in the control daemon, which isn't set up here/);
    const envOff = updateSummary({ off: null, paired: true, rec: { off: "SESSIONPIPE_NO_UPDATE_CHECK is set" } });
    expect(envOff.off).toMatch(/daemon's environment/);
  });
});

describe("who restarts the daemon", () => {
  const base = { pid: 4242, ppid: 1, platform: "darwin" as NodeJS.Platform };
  it("launchd: our label (or the plist's marker), and launchd as the parent", () => {
    expect(restartVia({ ...base, env: { XPC_SERVICE_NAME: "org.sessionpipe.control" } })).toBe("launchd");
    expect(restartVia({ ...base, env: { SESSIONPIPE_SERVICE: "launchd" } })).toBe("launchd");
    // A session the daemon started inherits the variable; it isn't launchd's job.
    expect(restartVia({ ...base, ppid: 999, env: { XPC_SERVICE_NAME: "org.sessionpipe.control" } })).toBeNull();
    expect(restartVia({ ...base, env: { XPC_SERVICE_NAME: "application.com.apple.Terminal.123" } })).toBeNull();
  });
  it("systemd: the process is our unit's main process (cgroup v2 and v1)", () => {
    const v2 = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/sessionpipe-control.service\n";
    const v1 =
      "12:pids:/user.slice\n1:name=systemd:/user.slice/user-1000.slice/user@1000.service/sessionpipe-control.service\n";
    const linux = { ...base, platform: "linux" as NodeJS.Platform, ppid: 777 };
    expect(restartVia({ ...linux, env: {}, cgroup: () => v2 })).toBe("systemd");
    expect(restartVia({ ...linux, env: { SYSTEMD_EXEC_PID: "4242" }, cgroup: () => v1 })).toBe("systemd");
    expect(restartVia({ ...linux, env: { SYSTEMD_EXEC_PID: "100" }, cgroup: () => v2 })).toBeNull();
    expect(restartVia({ ...linux, env: {}, cgroup: () => "0::/user.slice/session-3.scope\n" })).toBeNull();
    expect(
      restartVia({ ...linux, env: { SESSIONPIPE_SERVICE: "systemd" }, cgroup: () => "0::/init.scope\n" }),
    ).toBeNull();
  });
  it("a supervising sessionpipe, only as the actual parent; nobody otherwise", () => {
    expect(restartVia({ ...base, ppid: 31, env: { SESSIONPIPE_SERVICE: "supervisor:31" } })).toBe("supervisor");
    expect(restartVia({ ...base, ppid: 32, env: { SESSIONPIPE_SERVICE: "supervisor:31" } })).toBeNull();
    expect(restartVia({ ...base, platform: "win32", env: {} })).toBeNull();
    expect(restartVia({ ...base, platform: "linux", ppid: 1, env: {}, cgroup: () => "0::/\n" })).toBeNull();
  });
  it("the service files sessionpipe writes restart on the update's exit code", () => {
    const f = serviceFiles({ node: "/n", cli: "/c.js", logDir: "/l", home: "/h" });
    expect(f.plist.text).toContain("<key>SuccessfulExit</key><false/>");
    expect(f.plist.text).toContain("<key>SESSIONPIPE_SERVICE</key><string>launchd</string>");
    expect(f.unit.text).toContain("Restart=on-failure");
    expect(f.unit.text).toContain(`RestartForceExitStatus=${UPDATE_EXIT}`);
    expect(f.unit.text).toContain("Environment=SESSIONPIPE_SERVICE=systemd");
  });
});

describe("the supervisor (no service manager)", () => {
  it("runs the new daemon as a child, starts it again on the update's exit, and exits with it", async () => {
    // A stand-in `control run`: exits UPDATE_EXIT the first time, 0 the second.
    const script = path.join(tmp, "daemon.cjs");
    const runs = path.join(tmp, "runs.log");
    writeFileSync(
      script,
      `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(runs)}, process.env.SESSIONPIPE_SERVICE + " " + process.ppid + "\\n");
process.exit(fs.readFileSync(${JSON.stringify(runs)}, "utf8").trim().split("\\n").length === 1 ? ${UPDATE_EXIT} : 0);`,
    );
    const lines: string[] = [];
    const code = await new Promise<number>((resolve) => {
      supervise({ node: process.execPath, args: [script], env: process.env, log: (l) => lines.push(l), exit: resolve });
    });
    expect(code).toBe(0);
    const seen = readFileSync(runs, "utf8").trim().split("\n");
    expect(seen).toEqual([`supervisor:${process.pid} ${process.pid}`, `supervisor:${process.pid} ${process.pid}`]);
    expect(lines).toEqual(["the daemon is restarting onto its new version"]);
  });
  it("a crash is started again after a pause; a stop goes to the child and ends with it", async () => {
    const script = path.join(tmp, "crash.cjs");
    const runs = path.join(tmp, "crash.log");
    writeFileSync(
      script,
      `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(runs)}, "x\\n");
if (fs.readFileSync(${JSON.stringify(runs)}, "utf8").length === 2) process.exit(3);
process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);`,
    );
    const lines: string[] = [];
    let sup: { stop: (s?: NodeJS.Signals) => void } | null = null;
    const code = await new Promise<number>((resolve) => {
      sup = supervise({
        node: process.execPath,
        args: [script],
        env: process.env,
        log: (l) => lines.push(l),
        exit: resolve,
        failDelayMs: 10,
      });
      const t = setInterval(() => {
        const n = existsSync(runs) ? readFileSync(runs, "utf8").length : 0;
        if (n >= 4) {
          clearInterval(t);
          setTimeout(() => sup?.stop("SIGTERM"), 200);
        }
      }, 20);
    });
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/the daemon exited \(code 3\); starting it again/);
  });
});
