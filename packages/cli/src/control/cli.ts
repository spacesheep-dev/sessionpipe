// SPDX-License-Identifier: Apache-2.0
// `sessionpipe control pair | mode | folders | keys | off | run | status` and `sessionpipe wait`.
import { existsSync, realpathSync, statSync, unwatchFile, watchFile } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acpControl,
  antigravityControl,
  claudeControl,
  claudeDirs,
  codexControl,
  drivableHarnesses,
  machineName,
  Outbox,
  readConfig,
  stateDir,
  type Tier,
  writeConfig,
} from "@sessionpipe/core";

const { claudeLogin, detectCaps, findClaude, isUuid, runClaude } = claudeControl;

import { isBroad } from "../connect.js";
import { openPool, readPool } from "../pool/index.js";
import { appendObserved, drain, VERSION } from "../run.js";
import { rerunGlobally, stableNode, viaNpx } from "../runtime.js";
import { controlAccount, secretGet, sinkWithSecrets } from "../secrets.js";
import { installedVersion, installVersion, latestVersion } from "../update.js";
import { AutoUpdater, autoUpdateOff, restartVia, supervise, UPDATE_EXIT, updateFile } from "./autoupdate.js";
import { ControlDaemon, DaemonRunning } from "./daemon.js";
import { ask, socketPath } from "./local.js";
import { installService, off, pair, removeKey, uninstallService, withoutInherit } from "./pair.js";
import { loadSdk } from "./sdk.js";
import {
  type ControlConfig,
  type ControlMode,
  controlFile,
  controlState,
  parseMode,
  readControl,
  writeControl,
} from "./store.js";
import { waitForMessage, waitSession } from "./wait.js";

export const CONTROL_HELP = `  sessionpipe control pair <receiver> [--folder DIR]… [--mode safe|auto|inherit] [--tier 0-3] [--token T] [--name N] [--no-service]
  sessionpipe control mode auto|safe|inherit        (how sessions run when you message them)
  sessionpipe control folders [add|remove DIR…]     (where sessions you message may run)
  sessionpipe control status | keys [remove <id>] | off [<receiver>] | run
  sessionpipe wait [--session <harness>:<id>]      (a session runs this in the background)`;

const MODE_TEXT = `  auto    Claude Code's auto mode: the session reads, edits and runs commands, and Claude Code's
          own safety check stops what looks dangerous. Pick this to get work done from your phone.
          (Codex runs with --approve-for-me, Antigravity with --mode accept-edits.) Where Claude
          Code's settings turn auto mode off (permissions.disableAutoMode), Claude Code runs these
          sessions in its default mode instead, which refuses whatever needs approval; inherit
          runs them as your own sessions run.
  safe    Only what each folder's Claude Code settings already allow: with no allow rules, a
          session can't even read a file. Pick this if this machine holds things no agent
          should touch unattended. (Codex runs in its workspace-write sandbox and never
          escalates; Antigravity is denied every tool call that would need approval.)
  inherit As your own sessions here run: no permission flag, so each harness starts in its own
          default on this machine. Claude Code takes permissions.defaultMode from its settings,
          whatever you set there, bypassPermissions included. Pick this if sessions you message
          should run the way you run them. (Codex follows the approval_policy and sandbox_mode in
          its config.toml; Antigravity gets no flag, as in safe.)`;

/** What each mode means, in a few words: after pairing, and after `control mode` changes it. */
const MODE_IS: Record<ControlMode, string> = {
  safe: "nothing that needs approval runs unattended",
  auto: "Claude Code's auto mode",
  inherit: "each harness's own default mode on this machine",
};
const MODE_NOW: Record<ControlMode, string> = {
  safe: "only what each folder's settings already allow",
  auto: "Claude Code's auto mode decides what's safe",
  inherit: "as your own sessions here run: each harness's own default",
};

/** Ask the person at this machine, once: auto, safe or inherit. Inherit only by its whole
 *  name, never by a stray letter: it runs whatever the settings say, bypass included. Not
 *  a terminal (an agent ran the pair command): safe, and say how to change it. */
async function askMode(out: (s?: string) => void): Promise<ControlMode> {
  if (!process.stdin.isTTY) {
    out("  Mode: safe for now. Run `sessionpipe control mode auto` to let sessions you message work unattended.");
    return "safe";
  }
  out("");
  out("  When you message a session on this machine from your phone, how may it run?");
  out(MODE_TEXT);
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const a = (await rl.question("  auto, safe or inherit? [auto] ")).trim().toLowerCase();
      if (a === "" || a === "a" || a === "auto") return "auto";
      if (a === "s" || a === "safe") return "safe";
      if (a === "inherit") return "inherit";
    }
  } finally {
    rl.close();
  }
}

/** `control folders add|remove`: the new list, and a line per folder saying what became
 *  of it. A folder to add must exist and be a project, never the home folder or above
 *  it (pair's rule); folders are compared as real paths, as the daemon compares them. */
export function changeFolders(
  folders: string[],
  op: "add" | "remove",
  dirs: string[],
  home = os.homedir(),
): { folders: string[]; said: string[] } {
  const real = (d: string) => {
    try {
      return realpathSync.native(d);
    } catch {
      return path.resolve(d);
    }
  };
  const next = [...folders];
  const said: string[] = [];
  for (const d of dirs) {
    const abs = path.resolve(d);
    const at = next.findIndex((f) => real(f) === real(abs));
    if (op === "remove") {
      if (at < 0) said.push(`  · ${abs} wasn't allowed`);
      else said.push(`  ✓ No longer allowed: ${next.splice(at, 1)[0]}`);
      continue;
    }
    let dir = false;
    try {
      dir = statSync(abs).isDirectory();
    } catch {}
    if (!dir) said.push(`  ✗ ${abs} isn't a folder on this machine`);
    else if (isBroad(abs, home))
      said.push(
        `  ✗ Not allowing all of ${abs}: name a project folder inside it, so a message can't run anywhere you own`,
      );
    else if (at >= 0) said.push(`  · ${abs} is already allowed`);
    else {
      next.push(abs);
      said.push(`  ✓ Allowed ${abs}`);
    }
  }
  return { folders: next, said };
}

export async function controlMain(argv: string[], out: (s?: string) => void, distDir: string): Promise<void> {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flags = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1] as string] : []));
  const sub = argv[1];
  switch (sub) {
    case "pair": {
      // `spacesheep.dev` is enough: a bare host means https.
      const raw = argv[2];
      if (!raw || raw.startsWith("-")) return out(`usage:\n${CONTROL_HELP}`);
      if (viaNpx(distDir)) return rerunGlobally(argv, out);
      const url = (/^https?:\/\//.test(raw) ? raw : `https://${raw}`).replace(/\/$/, "");
      const cfg = readConfig();
      const sink = cfg.sinks.find((s) => s.url.replace(/\/$/, "") === url);
      // No token is fine where the receiver offers open pairing: the person approves the
      // link signed in, and that is the whole setup.
      const token = flag("--token") ?? (sink ? sinkWithSecrets(sink)?.token : undefined) ?? null;
      if (token !== null && !/^[\x21-\x7e]+$/.test(token))
        return out(
          "  That token has a character a key never has (a placeholder like ss_… pasted as is?). Leave --token out to pair with a link instead.",
        );
      const folders = flags("--folder");
      const existing = readControl();
      // The folder this ran in — unless that is the home folder or above it, which
      // would let a message start a session anywhere you own.
      if (!folders.length && !existing?.folders.length) {
        if (!isBroad(process.cwd(), os.homedir())) folders.push(process.cwd());
        else
          out(
            `  ! Not allowing all of ${process.cwd()}: sessions you message may run only in folders you name. Pass --folder <project>, or run this from inside one.`,
          );
      }
      // How sessions run when a message arrives is the person's call, asked once here at
      // the machine — never a default they find out about when a session can't read a file.
      const mode =
        parseMode(flag("--mode")) ?? (existing?.mode && existing.receivers.length ? existing.mode : await askMode(out));
      const tier = argv.includes("--tier") ? (Math.max(0, Math.min(3, Number(flag("--tier")) || 0)) as Tier) : 0;
      await pair({
        url,
        token,
        // The key the receiver handed over at pairing becomes this machine's sink for it,
        // at --tier (0 — session state only — unless given), unless one is configured.
        addSink: (t) => {
          const r = adoptSinkToken(url, t, tier);
          if (r === "kept") return;
          out(
            r === "filled"
              ? `  ✓ Sink ${new URL(url).host} now carries the key the receiver handed over.`
              : tier >= 2
                ? `  ✓ Sink ${new URL(url).host} added at tier ${tier}.`
                : `  ✓ Sink ${new URL(url).host} added (tier ${tier}: ${tier ? "tool activity" : "session state"}, no conversation text). \`sessionpipe sink add ${url} --tier 2\` sends transcripts too.`,
          );
        },
        folders,
        mode,
        name: flag("--name") ?? existing?.name ?? machineName(cfg, os.hostname()),
        out,
      });
      const c = readControl()!;
      out(`  Folders sessions may run in: ${c.folders.join(", ")}`);
      out(`  Mode: ${c.mode} (${MODE_IS[c.mode]})`);
      let cli = path.join(distDir, "cli.js");
      try {
        cli = realpathSync(cli);
      } catch {}
      if (argv.includes("--no-service"))
        out("  Daemon: not installed as a service (--no-service); run `sessionpipe control run` yourself");
      else out(`  Daemon: ${installService({ node: stableNode(process.execPath), cli })}`);
      return;
    }
    case "mode": {
      const want = parseMode(argv[2]);
      if (!want) {
        const c = readControl();
        return out(
          `  mode: ${c?.mode ?? "not set up"}\n  usage: sessionpipe control mode auto|safe|inherit\n${MODE_TEXT}`,
        );
      }
      const c = readControl();
      if (!c) return out("  control isn't set up on this machine: run `sessionpipe control pair <receiver>` first");
      // A receiver that doesn't know inherit would show this machine as safe (CONTROL.md §2).
      if (want === "inherit" && c.mode !== "inherit") {
        const no = await withoutInherit(c.receivers.map((r) => r.url));
        if (no.length) {
          for (const why of no) out(`  ✗ ${why}.`);
          out(`  Mode stays ${c.mode}. Inherit works once every receiver this machine is paired with knows it.`);
          process.exitCode = 1;
          return;
        }
      }
      c.mode = want;
      writeControl(c);
      // The running daemon reads control.json again within seconds; the next run uses it.
      return out(`  ✓ Sessions you message now run in ${want} mode (${MODE_NOW[want]}).`);
    }
    case "folders": {
      // The folders are the machine's own list, so they change here, at its keyboard, as
      // at pairing: no new pairing and no passkey. A message to a session in any other
      // folder is refused ("that session's folder isn't one this machine allows").
      const op = argv[2];
      const usage = "  usage: sessionpipe control folders [add|remove <folder>…]";
      if (op !== undefined && op !== "add" && op !== "remove") return out(usage);
      const c = readControl();
      if (!c) return out("  control isn't set up on this machine: run `sessionpipe control pair <receiver>` first");
      if (op) {
        const dirs = argv.slice(3);
        if (!dirs.length) return out(usage);
        const r = changeFolders(c.folders, op, dirs);
        for (const l of r.said) out(l);
        if (r.folders.join("\n") !== c.folders.join("\n")) {
          c.folders = r.folders;
          writeControl(c);
          // The running daemon reads control.json again within seconds and tells the
          // receiver the new list in a hello then.
          out("  The control daemon uses the new list within seconds.");
        }
      }
      return out(
        c.folders.length
          ? `  Sessions you message may run in:\n${c.folders.map((f) => `    ${f}`).join("\n")}`
          : "  No folder is allowed: a message to a session here is refused until you add one.",
      );
    }
    case "keys": {
      const c = readControl();
      if (argv[2] === "remove" && argv[3]) {
        const n = removeKey(argv[3]);
        return out(n ? `  removed ${n} key(s)` : "  no such key");
      }
      if (!c?.receivers.length)
        return out("  control isn't paired on this machine (`sessionpipe control pair <receiver>`)");
      for (const r of c.receivers) {
        out(`  ${r.url} · machine ${r.machine}`);
        for (const k of r.keys)
          out(
            `    ${k.id.slice(0, 16)}…  ${k.type === "device" ? "device " : "passkey"}  ${k.alg === -7 ? "ES256" : "RS256"}  added ${k.added_at.slice(0, 10)}${k.name ? `  ${k.name}` : ""}`,
          );
      }
      return;
    }
    case "off": {
      const c = await off({ out, ...(argv[2] ? { url: argv[2] } : {}) });
      // The service runs the pool too: while the pool is on, Claude Code here depends on it.
      if (c && !c.receivers.length) {
        if (readPool().on)
          out("  The daemon's service stays: the pool is on (`sessionpipe pool off` first to remove it).");
        else uninstallService();
      }
      return;
    }
    case "status": {
      const r = await ask(socketPath(stateDir()), { op: "status" }, 2000);
      if (r?.op !== "status") return out("  the control daemon isn't running");
      return out(JSON.stringify(r.status, null, 2));
    }
    case "run":
      return runDaemon(out, distDir);
    default:
      return out(CONTROL_HELP);
  }
}

/** The harnesses set up on this machine, whose hooks an update re-arms. */
export function enabledHarnesses(harnesses: Record<string, { enabled?: boolean }>): string[] {
  return Object.entries(harnesses)
    .filter(([, h]) => h?.enabled !== false)
    .map(([n]) => n)
    .filter((n) => /^[a-z][a-z0-9-]{0,40}$/.test(n));
}

async function runDaemon(out: (s?: string) => void, distDir: string): Promise<void> {
  const paired = readControl();
  const log = (s: string) => out(`${new Date().toISOString()} ${s}`);
  let d: ControlDaemon | null = null;
  const upstream = testUpstream(process.env);
  // The account pool (pool/index.ts) lives in this process: its listener, its pins,
  // its credentials. Opened first, since whether it is on decides whether there is a
  // daemon to run at all.
  const pool = openPool({
    log,
    env: process.env,
    onChange: () => d?.poolChanged(),
    // An account's numbers, read off a request a Claude Code session made: a tier-1
    // `limits.observed` on that session, through the outbox like a hook's, naming the
    // account. An idle poll names no session; its numbers stay in the hello.
    onLimits: (uuid, session, limits) => {
      if (!session || !isUuid(session) || !limits.windows.length) return;
      void appendObserved(stateDir(), "claude-code", session, { windows: limits.windows, account_id: uuid }).catch(
        (e: unknown) =>
          log(`limits.observed for ${session.slice(0, 8)} not written: ${String((e as Error)?.message || e)}`),
      );
    },
    ...(upstream ? { upstream } : {}),
  });
  if (upstream) log(`pool requests go to ${upstream} (SESSIONPIPE_POOL_UPSTREAM, tests only)`);
  if (!paired?.receivers.length) {
    if (!pool.config.on) {
      out("control isn't paired on this machine; nothing to do (`sessionpipe control pair <receiver>`)");
      return;
    }
    log("the pool is on; control isn't paired (`sessionpipe control pair <receiver>` adds messages)");
  }
  const cfg: ControlConfig = paired ?? {
    name: machineName(readConfig(), os.hostname()),
    folders: [],
    mode: "safe",
    receivers: [],
  };
  let claude: { bin: string; caps: ReturnType<typeof detectCaps>; sig: string } | null = null;
  const claudeNow = () => {
    const bin = findClaude();
    if (!bin) return null;
    const sig = `${bin}:${existsSync(bin) ? realpathSync(bin) : ""}`;
    if (claude?.sig !== sig) claude = { bin, caps: detectCaps(bin), sig };
    return claude;
  };
  const sdk = await loadSdk({ claudeBin: findClaude(), env: process.env, log });
  let updater: AutoUpdater | null = null;
  d = new ControlDaemon(cfg, controlState(), socketPath(stateDir()), {
    now: Date.now,
    fetch,
    log,
    claudeDirs: () => claudeDirs(),
    claude: claudeNow,
    codex: () => codexControl.findCodex(),
    agy: () => antigravityControl.findAgy(),
    codexLogin: (bin) => codexControl.codexLogin(bin),
    acp: (harness) => acpControl.findAcpAgent(harness),
    harnesses: () => drivableHarnesses(),
    run: runClaude,
    sdk,
    login: async (configDir) => {
      const c = claudeNow();
      return c ? claudeLogin(c.bin, configDir) : { loggedIn: null };
    },
    token: (r) => (r.token_in ? secretGet(r.token_in, controlAccount(r.machine)) : null),
    onRestart: () => updater?.restartWhenIdle() ?? false,
    updateStatus: () => (updater ? updater.record() : null),
    // Two daemons started at once and the other one holds the socket: leave it to it.
    onLostSocket: () => process.exit(0),
    pool,
  });
  try {
    await d.start();
  } catch (e) {
    if (!(e instanceof DaemonRunning)) throw e;
    // Exit 0: no service manager restarts a daemon that stepped aside on purpose.
    log(`${e.message}; this one exits`);
    process.exit(0);
  }
  // Retry pending events even when a session has no more hooks. This also drains
  // what workers with a locked keychain left. The shared drain honours each sink's
  // wait and the machine-wide delivery lock, wherever its token lives.
  const drainTimer = setInterval(() => {
    const sinks = readConfig().sinks.filter((s) => !s.paused);
    if (sinks.length) void drain(stateDir(), sinks, new Outbox(stateDir())).catch(() => {});
  }, 60_000);
  drainTimer.unref();
  watchFile(controlFile(), { interval: 5000 }, () => {
    const next = readControl();
    if (next) d.reload(next);
  });
  let stopping = false;
  const bye = async () => {
    if (stopping) return;
    stopping = true;
    updater?.stop();
    await d.stop();
    process.exit(0);
  };
  const signals = ["SIGTERM", "SIGINT"] as const;
  for (const sig of signals) process.on(sig, bye);

  // Restart onto the code now on disk. The daemon is stopped first (its socket closed,
  // its long-polls ended), so two never poll at once.
  const restart = async (_from: string, to: string): Promise<void> => {
    stopping = true;
    updater?.stop();
    clearInterval(drainTimer);
    unwatchFile(controlFile());
    for (const sig of signals) process.off(sig, bye);
    await d.stop();
    const via = restartVia({ env: process.env, platform: process.platform, pid: process.pid, ppid: process.ppid });
    if (via) {
      log(`exiting ${UPDATE_EXIT} so ${via === "supervisor" ? "the supervising sessionpipe" : via} starts ${to}`);
      process.exit(UPDATE_EXIT);
    }
    // Nobody restarts this process: it stays, as the new daemon's parent.
    let cli = path.join(distDir, "cli.js");
    try {
      cli = realpathSync(cli);
    } catch {}
    log(`no service manager restarts this daemon: pid ${process.pid} now runs ${to} as its child`);
    const sup = supervise({ node: process.execPath, args: [cli, "control", "run"], env: process.env, log });
    for (const sig of [...signals, "SIGHUP"] as const) process.on(sig, () => sup.stop(sig));
  };
  updater = new AutoUpdater({
    now: Date.now,
    log,
    version: VERSION,
    file: updateFile(),
    off: () => autoUpdateOff({ env: process.env, config: readConfig(), distDir }),
    latest: () => latestVersion(fetch),
    installed: () => installedVersion({ node: process.execPath, distDir }),
    install: (v) =>
      installVersion(v, { node: process.execPath, distDir, harnesses: enabledHarnesses(readConfig().harnesses) }),
    daemon: d,
    restart,
  });
  updater.start();
}

/** The pool's fake upstream for tests, and only there: honoured under vitest and only
 *  when it is a loopback address, so no plist, shell profile or .envrc in the daemon's
 *  real environment can send pooled requests (bearers included) anywhere else. */
export function testUpstream(env: NodeJS.ProcessEnv): string | null {
  const u = env.SESSIONPIPE_POOL_UPSTREAM;
  if (!u || !env.VITEST) return null;
  try {
    const host = new URL(u).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" ? u : null;
  } catch {
    return null;
  }
}

export async function waitMain(argv: string[], out: (s?: string) => void): Promise<void> {
  const i = argv.indexOf("--session");
  const session = waitSession(i >= 0 ? argv[i + 1] : undefined);
  if (!session) {
    out("sessionpipe wait: which session? Pass --session <harness>:<id> (Claude Code sets CLAUDE_CODE_SESSION_ID).");
    process.exitCode = 2;
    return;
  }
  out(await waitForMessage(session));
}

/** Give a sink the key a receiver handed over at pairing. A sink for the receiver that
 *  has a key keeps it ("kept"); one without a key gets this one ("filled"); otherwise a
 *  new sink at `tier` ("added"). */
export function adoptSinkToken(url: string, token: string, tier: Tier, file?: string): "kept" | "filled" | "added" {
  const now = file ? readConfig(file) : readConfig();
  const same = now.sinks.find((x) => x.url.replace(/\/$/, "") === url);
  if (same && (same.token || same.token_in)) return "kept";
  if (same) same.token = token;
  else now.sinks.push({ name: new URL(url).host, url, tier, pii: false, token });
  if (file) writeConfig(now, file);
  else writeConfig(now);
  return same ? "filled" : "added";
}
