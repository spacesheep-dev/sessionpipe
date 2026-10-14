// SPDX-License-Identifier: Apache-2.0
// `sessionpipe control pair | keys | off | run | status` and `sessionpipe wait`.
import { existsSync, realpathSync, unwatchFile, watchFile } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  antigravityControl,
  claudeControl,
  claudeDirs,
  codexControl,
  drivableHarnesses,
  Outbox,
  readConfig,
  stateDir,
  type Tier,
  writeConfig,
} from "@sessionpipe/core";

const { claudeLogin, detectCaps, findClaude, runClaude } = claudeControl;

import { isBroad } from "../connect.js";
import { drain, VERSION } from "../run.js";
import { rerunGlobally, stableNode, viaNpx } from "../runtime.js";
import { controlAccount, secretGet, sinkWithSecrets } from "../secrets.js";
import { installedVersion, installVersion, latestVersion } from "../update.js";
import { AutoUpdater, autoUpdateOff, restartVia, supervise, UPDATE_EXIT, updateFile } from "./autoupdate.js";
import { ControlDaemon, DaemonRunning } from "./daemon.js";
import { ask, socketPath } from "./local.js";
import { installService, off, pair, removeKey, uninstallService } from "./pair.js";
import { loadSdk } from "./sdk.js";
import { controlFile, controlState, readControl, writeControl } from "./store.js";
import { waitForMessage, waitSession } from "./wait.js";

export const CONTROL_HELP = `  sessionpipe control pair <receiver> [--folder DIR]… [--mode safe|auto] [--tier 0-3] [--token T] [--name N] [--no-service]
  sessionpipe control mode auto|safe                (how sessions run when you message them)
  sessionpipe control status | keys [remove <id>] | off [<receiver>] | run
  sessionpipe wait [--session <harness>:<id>]      (a session runs this in the background)`;

const MODE_TEXT = `  auto  Claude Code's auto mode: the session reads, edits and runs commands, and Claude Code's
        own safety check stops what looks dangerous. Pick this to get work done from your phone.
        (Codex runs with --approve-for-me, Antigravity with --mode accept-edits.)
  safe  Only what each folder's Claude Code settings already allow: with no allow rules, a
        session can't even read a file. Pick this if this machine holds things no agent
        should touch unattended. (Codex runs in its workspace-write sandbox and never
        escalates; Antigravity is denied every tool call that would need approval.)`;

/** Ask the person at this machine, once: auto or safe. Not a terminal (an agent ran the
 *  pair command): safe, and say how to change it. */
async function askMode(out: (s?: string) => void): Promise<"safe" | "auto"> {
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
      const a = (await rl.question("  auto or safe? [auto] ")).trim().toLowerCase();
      if (a === "" || a === "a" || a === "auto") return "auto";
      if (a === "s" || a === "safe") return "safe";
    }
  } finally {
    rl.close();
  }
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
      const mode: "safe" | "auto" =
        flag("--mode") === "auto" || flag("--mode") === "safe"
          ? (flag("--mode") as "safe" | "auto")
          : existing?.mode && existing.receivers.length
            ? existing.mode
            : await askMode(out);
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
        name: flag("--name") ?? existing?.name ?? cfg.machine ?? os.hostname(),
        out,
      });
      const c = readControl()!;
      out(`  Folders sessions may run in: ${c.folders.join(", ")}`);
      out(
        `  Mode: ${c.mode} (${c.mode === "safe" ? "nothing that needs approval runs unattended" : "Claude Code's auto mode"})`,
      );
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
      const want = argv[2];
      if (want !== "auto" && want !== "safe") {
        const c = readControl();
        return out(`  mode: ${c?.mode ?? "not set up"}\n  usage: sessionpipe control mode auto|safe\n${MODE_TEXT}`);
      }
      const c = readControl();
      if (!c) return out("  control isn't set up on this machine: run `sessionpipe control pair <receiver>` first");
      c.mode = want;
      writeControl(c);
      // The running daemon reads control.json again within seconds; the next run uses it.
      return out(
        `  ✓ Sessions you message now run in ${want} mode${want === "auto" ? " (Claude Code's auto mode decides what's safe)" : " (only what each folder's settings already allow)"}.`,
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
          out(`    ${k.id.slice(0, 16)}…  ${k.alg === -7 ? "ES256" : "RS256"}  added ${k.added_at.slice(0, 10)}`);
      }
      return;
    }
    case "off": {
      const c = await off({ out, ...(argv[2] ? { url: argv[2] } : {}) });
      if (c && !c.receivers.length) uninstallService();
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
  const cfg = readControl();
  if (!cfg?.receivers.length) {
    out("control isn't paired on this machine; nothing to do (`sessionpipe control pair <receiver>`)");
    return;
  }
  const log = (s: string) => out(`${new Date().toISOString()} ${s}`);
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
  const d = new ControlDaemon(cfg, controlState(), socketPath(stateDir()), {
    now: Date.now,
    fetch,
    log,
    claudeDirs: () => claudeDirs(),
    claude: claudeNow,
    codex: () => codexControl.findCodex(),
    agy: () => antigravityControl.findAgy(),
    codexLogin: (bin) => codexControl.codexLogin(bin),
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
