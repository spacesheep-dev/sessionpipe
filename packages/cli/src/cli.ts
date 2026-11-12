#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// sessionpipe: install once, hook everything, choose per sink what leaves.
//   connect · install · uninstall · sink add|list|remove|test · secrets · status ·
//   doctor · tail · backfill · forget · replay · update · control · wait · ask · hook · worker
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTERS,
  adapterByName,
  assertConfigWritable,
  type BackfillRow,
  type Config,
  Cursors,
  claudeControl,
  claudeDirs,
  configFile,
  type Event,
  filterEvent,
  type HookCommand,
  machineName,
  makeEvent,
  Outbox,
  readConfig,
  type Session,
  type SinkConfig,
  stateDir,
  type Tier,
  takeLock,
  tilde,
  waitNamedLock,
  writeConfig,
} from "@sessionpipe/core";
import { askMain } from "./ask.js";
import { connectFolders, connectTier, tierArg } from "./connect.js";
import { ago, autoUpdateOff, readUpdate, updateFile, updateSummary } from "./control/autoupdate.js";
import { channelIo, channelMain, controlMain, enabledHarnesses, waitMain } from "./control/cli.js";
import type { Status } from "./control/daemon.js";
import {
  askHealth,
  DISK_FULL_BYTES,
  freeBytes,
  logTroubles,
  serviceLog,
  serviceLook,
  type Trouble,
} from "./control/health.js";
import { ask, type Health, socketPath } from "./control/local.js";
import { moveControlSecrets, pairedCount, parseMode, readControl, writeControl } from "./control/store.js";
import { heardAgo, hostOf, isLive } from "./control/view.js";
import { isToolsMode, ToolClock, type ToolsMode, toolsMode } from "./fold.js";
import { helpFor } from "./help.js";
import { installLauncher, launcherPath, launcherState, removeLauncher, usesLauncher } from "./launcher.js";
import { poolMain, poolOffForUninstall } from "./pool/cli.js";
import { readPool } from "./pool/index.js";
import { Refusal } from "./refusal.js";
import { brief, type Group, inOrder, page, type Todo, verdict } from "./report.js";
import { buildSinks, drain, factsState, flush, jobsDir, runJob, VERSION } from "./run.js";
import { assertSetupVersion, rerunGlobally, stableNode, viaNpx } from "./runtime.js";
import {
  bestStore,
  dropSinkSecrets,
  fileKept,
  keysFileNote,
  moveSinkSecrets,
  type StoreName,
  sinkWithSecrets,
  storeLabel,
} from "./secrets.js";
import { shq, shqPath } from "./shell.js";
import { clean, commands, failure, fold, makeUi, PLAIN, paint, span, table, type Ui } from "./style.js";
import { globalPrefix, installVersion, isNewer, latestVersion } from "./update.js";
import { overview, usage } from "./usage.js";
import { applyWellKnown, readWellKnown } from "./wellknown.js";

const print = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};
// One command per process: `main` sets these for the run, every command reads them.
let args: string[] = [];
let out: (s?: string) => void = print;
/** Lines already set for this run's terminal (report.ts, usage.ts): written as they are. */
let say: (s?: string) => void = print;
let state = "";
/** How this run's output looks: a terminal's colour and width, or a pipe's whole lines. */
let ui: Ui = PLAIN;
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(name);
const distDir = path.dirname(fileURLToPath(import.meta.url));

export interface Io {
  /** One line of output. */
  out: (s?: string) => void;
  /** What a failed command says, then `exit(1)`. */
  err: (s: string) => void;
  exit: (code: number) => void;
  /** The output is a terminal, and its width. Left out: a pipe. */
  tty?: boolean;
  columns?: number | undefined;
  /** Where errors go is a terminal. */
  errTty?: boolean;
}

const processIo = (): Io => ({
  out: print,
  err: (s) => void process.stderr.write(s),
  exit: (c) => process.exit(c),
  tty: !!process.stdout.isTTY,
  columns: process.stdout.columns,
  errTty: !!process.stderr.isTTY,
});

/** What these commands write is read by a program, so it is never coloured or folded:
 *  the daemon's log, a session's events, a waiter's message, an agent's answer. */
const FOR_PROGRAMS = ["tail", "wait", "channel", "worker", "hook", "version", "--version", "-v"];

/** Whether this run's lines are for a person to read (style.ts `paint`). */
function forPeople(a: readonly string[], tty: boolean): boolean {
  if (a.includes("--help") || a.includes("-h")) return true;
  if (a.includes("--json") || FOR_PROGRAMS.includes(a[0] as string)) return false;
  // The daemon's log, and its status where a script reads it (a pipe gets JSON).
  if (a[0] === "control") return a[1] !== "run" && (a[1] !== "status" || tty);
  // `ask <agent> "<task>"` prints the agent's answer.
  if (a[0] === "ask") return ["on", "off", "status", "setup", undefined].includes(a[1]);
  return true;
}

/** Run one command: `argv` is what follows `sessionpipe`; `io` is this process by default. */
export async function main(argv: string[], io: Io = processIo()): Promise<void> {
  const noColor = argv.includes("--no-color");
  args = argv.filter((a) => a !== "--no-color");
  ui = makeUi({ isTTY: io.tty, columns: io.columns, noColor });
  const people = forPeople(args, ui.tty);
  if (!people) ui = PLAIN;
  // The one way a line reaches a person: whatever a command put in it, nothing a
  // terminal acts on is left but the colours style.ts wrote itself (style.ts `clean`).
  const write = (s = ""): void => io.out(clean(s, { breaks: true, colour: true }));
  out = people ? (s = "") => write(paint(ui, s)) : io.out;
  say = write;
  state = stateDir();
  try {
    await command(args[0] ?? "help");
  } catch (e) {
    const about = helpFor(args);
    io.err(
      failure(
        makeUi({ isTTY: io.errTty, columns: io.columns, noColor }),
        (e as Error).message,
        e instanceof Refusal ? e.next : `sessionpipe ${about ? `${about} ` : ""}--help`,
      ),
    );
    io.exit(1);
  }
}

/** Is this file the process entrypoint? By real path: npm's bin link to it counts. */
export function isEntrypoint(argv1: string | undefined, url: string): boolean {
  try {
    return !!argv1 && realpathSync(argv1) === fileURLToPath(url);
  } catch {
    return false;
  }
}

/** The command a hook entry runs: the launcher, which outlives node upgrades
 *  (launcher.ts); on Windows, this node by a stable absolute path and hook.js by its
 *  real path. */
function hookCommand(): HookCommand {
  if (usesLauncher()) {
    const l = launcherPath();
    return (a) => ({ argv: [l, ...a], command: `${JSON.stringify(l)} ${a.join(" ")}` });
  }
  const node = stableNode(process.execPath);
  let script = path.join(distDir, "hook.js");
  try {
    script = realpathSync(script);
  } catch {}
  return (a) => ({
    argv: [node, script, ...a],
    command: `${JSON.stringify(node)} ${JSON.stringify(script)} ${a.join(" ")}`,
  });
}

/** install, uninstall and backfill take options only, and name a harness as --<harness>.
 *  A bare word was ignored, so `uninstall codex` unhooked every harness. A word that is
 *  not the value of one of the command's `valued` options is refused before any work. */
function strayWord(valued: readonly string[] = []): boolean {
  // args[i] is the word before args.slice(1)[i].
  const word = args.slice(1).find((a, i) => !a.startsWith("-") && !valued.some((v) => v === args[i]));
  if (word === undefined) return false;
  const harness = ADAPTERS.some((a) => a.name === word) ? `; to name that harness, pass --${word}` : "";
  out(`  ! \`sessionpipe ${args[0]}\` takes options only, and "${word}" is not one${harness}.`);
  out(`  Nothing was changed. See \`sessionpipe ${args[0]} --help\`.`);
  process.exitCode = 2;
  return true;
}

function selectedAdapters(): typeof ADAPTERS {
  const named = ADAPTERS.filter((a) => has(`--${a.name}`));
  if (named.length) return named;
  return ADAPTERS.filter((a) => a.detect());
}

async function command(cmd: string): Promise<void> {
  // Help wins over every command and argument, before any command can do work.
  if (has("--help") || has("-h"))
    return say(
      usage(
        ui,
        args,
        ADAPTERS.map((a) => a.name),
      ) ?? overview(ui, VERSION),
    );
  // A --tier that is not a whole number stops these commands here, before any work: an npx
  // re-run, a hook written, a sink stored. `sink add`, `install --sink`, `connect`,
  // `control pair` and `tail` read it; their sibling subcommands refuse it too, rather than
  // ignore a typo. Other commands ignore --tier, as before.
  if (["connect", "install", "sink", "control", "tail"].includes(cmd)) tierArg(args, 0);
  switch (cmd) {
    case "connect":
      return connect();
    case "install":
      return install();
    case "secrets":
      return secrets();
    case "uninstall":
      return uninstall();
    case "sink":
      return sink();
    case "status":
      return status();
    case "doctor":
      return await doctor();
    case "tail":
      return tail();
    case "backfill":
      return backfill();
    case "forget":
      return forget();
    case "replay":
      return replay();
    case "update":
      return update();
    case "titles":
      return titles();
    case "worker":
      return workerFromArgv();
    case "control":
      return controlMain(args, out, distDir, { ui, say });
    case "pool":
      return poolMain(args, out, distDir, {}, ui);
    case "wait":
      return waitMain(args, out);
    case "ask": {
      const code = await askMain(args, { out, err: (s) => void process.stderr.write(s) }, { distDir });
      if (code) process.exitCode = code;
      return;
    }
    case "channel":
      return channelMain(args, channelIo);
    case "hook":
      out("sessionpipe hook is dist/hook.js; harnesses run it directly");
      return;
    case "--version":
    case "-v":
    case "version":
      out(VERSION);
      return;
    default:
      return help();
  }
}

function help(): void {
  say(overview(ui, VERSION));
}

/** --machine names a first install. A repeat setup must not split sessions from control. */
function setupConfig(): Config {
  assertConfigWritable();
  const cfg = readConfig();
  const requested = flag("--machine");
  if ((has("--machine") || has("--rename-machine")) && (!requested || requested.startsWith("-")))
    throw new Error("--machine NAME is required when naming or renaming a machine");
  const machine = requested?.slice(0, 80);
  const control = readControl();
  const hooksName = existsSync(configFile()) ? machineName(cfg, os.hostname()) : undefined;
  // A daemon paired as `<host>.local` (what `control pair` did before 0.9.0 on a Mac) is
  // this machine under the hooks' name, `<host>`: that name keeps a receiver's sessions
  // in one place, and the daemon is renamed to it below, which costs nothing since
  // receivers key a pairing by id. A daemon named on purpose keeps its name.
  const pairedName =
    control && hooksName && machineName({} as Config, control.name) === hooksName ? hooksName : control?.name;
  const current = cfg.machine || pairedName || hooksName;
  if (current && machine && machine !== current && !has("--rename-machine")) {
    out(
      `  Keeping configured machine name ${current}; ignoring --machine ${machine}. Use --rename-machine with --machine NAME for an explicit rename.`,
    );
    cfg.machine = current;
  } else {
    const name = machine || current || machineName(cfg, os.hostname());
    // The daemon goes by the same name as the hooks, or a receiver shows one machine
    // twice. An explicit rename renames the paired daemon too: control.json carries the
    // name, the daemon re-reads it and says it in its next hello (receivers key machines
    // by id, so the pairing holds). receivers[].machine is that id, not the name.
    if (control && control.name !== name && (machine || name === pairedName)) {
      writeControl({ ...control, name });
      out(`  Renamed the background service ${control.name} → ${name}; its next hello tells each receiver.`);
    }
    cfg.machine = name;
  }
  return cfg;
}

async function install(): Promise<void> {
  if (strayWord(["--machine", "--backfill", "--sink", "--tier", "--name", "--token", "--secret"])) return;
  const cfg = setupConfig();
  if (viaNpx(distDir)) return rerunGlobally(args, out, { allowDowngrade: has("--allow-downgrade") });
  assertSetupVersion(has("--allow-downgrade"));
  // A sink URL given here is added first, so the install knows whether it needs
  // every tool event or only the heartbeat's one.
  const sinkUrl = flag("--sink");
  if (sinkUrl) await sinkAdd(sinkUrl, cfg);
  const adapters = selectedAdapters();
  if (!adapters.length) {
    out(
      "  No coding agent found on this computer (Claude Code, Codex, Gemini CLI, Antigravity, Devin, Grok Build). Pass --<harness> to force one.",
    );
    return;
  }
  out(`  This computer: ${machineName(cfg, os.hostname())}`);
  const lean = isLean(cfg);
  if (lean)
    out(
      "  No sink above tier 0: hooking one tool event per harness (the heartbeat's). `sink add … --tier 1` or higher hooks the rest.",
    );
  const skipped = installHarnesses(adapters, cfg, lean);
  writeConfig(cfg);
  const days = Number(flag("--backfill") ?? 30);
  if (days > 0) await backfillRows(adapters, days, cfg);
  out("");
  // Every harness it worked on was left alone: a script reading the exit code must see that.
  if (skipped.length === adapters.length) {
    process.exitCode = 1;
    return out(
      `  ✗ Nothing was hooked: ${skipped.join(", ")} ${skipped.length > 1 ? "were" : "was"} left alone, for the reason above. Fix that and run \`sessionpipe install\` again.`,
    );
  }
  const live = cfg.sinks.filter((s) => !s.paused);
  if (live.length) out(`  Reporting to ${live.map((s) => `${s.name} (tier ${s.tier})`).join(", ")}.`);
  else
    out(
      "  Nothing leaves this computer yet: events go to the local outbox. `sessionpipe tail` shows them; `sessionpipe sink add <url> --tier N` sends them.",
    );
  out("  Sessions already running pick up hooks on their next start (Claude Code ≥ 2.1.280 picks them up live).");
}

/** No sink takes tier ≥ 1: the harness only needs one tool event (issue #12). */
function isLean(cfg: Config): boolean {
  return !cfg.sinks.some((s) => !s.paused && Math.min(s.tier, s.max_tier ?? 3) >= 1);
}

/** A sink crossing tier 0 changes which events the hooks watch (isLean): rewrite the
 *  hooks of every harness that has them, as `install` promised when it hooked the lean set. */
function rehook(cfg: Config, wasLean: boolean): void {
  const lean = isLean(cfg);
  if (lean === wasLean) return;
  const hc = hookCommand();
  const hooked = ADAPTERS.filter((a) =>
    a.installed(hc, process.env, { lean: wasLean }).some((r) => r.state !== "missing"),
  );
  if (!hooked.length) return;
  // The guards `install` runs before it writes hooks: no hook path into the npx cache, no
  // downgrade of hooks a newer sessionpipe wrote. The sink stays either way; `install` rehooks.
  if (viaNpx(distDir)) {
    out(
      "  The hooks need rewriting now, but this copy runs from the npx cache: run `sessionpipe install` to rewrite them from a persistent one.",
    );
    return;
  }
  try {
    assertSetupVersion(false);
  } catch (e) {
    // Its advice to pass --allow-downgrade is install's: here the sink is already saved, so a
    // second run would find nothing to rewrite.
    const why = (e as Error).message.replace(/; this command would install .*$/s, "");
    out(
      `  The hooks need rewriting now and were left alone: ${why}. Rewrite them with the newer sessionpipe's \`install\`, or with this one's \`sessionpipe install --allow-downgrade\`.`,
    );
    return;
  }
  out(
    lean
      ? "  No sink above tier 0 now: hooking one tool event per harness (the heartbeat's)."
      : "  A sink above tier 0: hooking every event.",
  );
  installHarnesses(hooked, cfg, lean);
  writeConfig(cfg);
}

/** Write the hooks for these harnesses; remember which files sessionpipe created. Returns
 *  the harnesses whose every file was left alone (`skipped`), so nothing of theirs is hooked. */
function installHarnesses(adapters: readonly (typeof ADAPTERS)[number][], cfg: Config, lean: boolean): string[] {
  const skipped: string[] = [];
  if (usesLauncher()) {
    const node = stableNode(process.execPath);
    const l = installLauncher({ distDir, node, version: VERSION });
    if (l.changed)
      out(`  ✓ hook launcher: ${tilde(l.launcher)} (node ${tilde(node)}, or any node on PATH once that one is gone)`);
  }
  const hc = hookCommand();
  const wantLine = has("--status-line") ? true : has("--no-status-line") ? false : undefined;
  for (const a of adapters) {
    const prev = cfg.harnesses[a.name] ?? {};
    const created = new Set(prev.created ?? []);
    const statusLine = wantLine ?? prev.status_line;
    const reports = a.install(hc, process.env, { lean, created: [...created], statusLine });
    for (const r of reports) {
      if (r.created) created.add(r.file);
      const mark = r.skipped ? "!" : r.changed ? "✓" : "=";
      out(
        `  ${mark} ${a.name}: ${tilde(r.file)}${r.note ? ` — ${r.note}` : r.changed ? " written" : " already current"}`,
      );
    }
    cfg.harnesses[a.name] = {
      enabled: true,
      ...(created.size ? { created: [...created] } : {}),
      ...(statusLine && a.name === "claude-code" ? { status_line: true } : {}),
    };
    if (a.name === "gemini-cli")
      out("    note: Gemini CLI's own telemetry defaults logPrompts on; that is Google's setting, not sessionpipe's.");
    if (a.name === "devin" && !reports.some((r) => r.skipped))
      out(
        "    note: Devin ignores a hooks file whole if it holds one event name it doesn't know; run `/hooks` in `devin` to see what loaded.",
      );
    if (a.name === "codex" && !reports.some((r) => r.skipped))
      out(
        "    note: Codex runs non-managed hooks only after you approve them: start `codex` and accept the hook review. The notify fallback reports turn ends meanwhile.",
      );
    if (reports.every((r) => r.skipped)) skipped.push(a.name);
  }
  return skipped;
}

/** `sessionpipe connect <receiver>`: everything a machine needs, in one command and one
 *  approval — the hooks for every agent and every Claude Code account here, a sink at
 *  tier 2, signed messages (the daemon, paired with open pairing), the keys moved into
 *  the keychain when there is one, the daemon kept running past logout, the last 30
 *  days backfilled. Run it again and it only fixes what's missing. Asks nothing: the
 *  mode is --mode or safe, the folders are --folder, this one, or where your recent
 *  sessions ran — never the home folder. */
async function connect(): Promise<void> {
  const raw = args[1];
  if (!raw || raw.startsWith("-"))
    return out(
      "usage: sessionpipe connect <receiver> [--machine NAME] [--rename-machine] [--allow-downgrade] [--tier 0-3] [--mode safe|auto|inherit] [--folder DIR]… [--status-line|--no-status-line] [--no-service]",
    );
  const cfg = setupConfig();
  if (viaNpx(distDir)) return rerunGlobally(args, out, { allowDowngrade: has("--allow-downgrade") });
  assertSetupVersion(has("--allow-downgrade"));
  const url = (/^https?:\/\//.test(raw) ? raw : `https://${raw}`).replace(/\/$/, "");
  const host = new URL(url).host;
  const name = machineName(cfg, os.hostname());
  const before = cfg.sinks.find((x) => x.url.replace(/\/$/, "") === url);
  const tier = connectTier(has("--tier") ? tierArg(args, 0) : undefined, before?.tier);
  out(`  Connecting ${name} to ${host}.`);

  // 1. The hooks, for every agent on this machine (and every Claude Code account).
  const adapters = ADAPTERS.filter((a) => a.detect());
  if (!adapters.length)
    out(
      "  ! No coding agent here yet (Claude Code, Codex, Gemini CLI, Antigravity, Devin, Grok Build): run `sessionpipe install` once you have one.",
    );
  else installHarnesses(adapters, cfg, tier < 1);
  writeConfig(cfg);
  await reportClaudeAccounts();
  const rows = collectRows(adapters, 30);

  // 2. One approval on any signed-in device: the machine's control token and its
  //    sessions key together.
  const control = readControl();
  const paired = control?.receivers.find((r) => r.url === url);
  const sinkNow = readConfig().sinks.find((x) => x.url.replace(/\/$/, "") === url);
  if (paired && sinkNow && (sinkNow.token || sinkNow.token_in)) {
    out(`  ✓ Already paired with ${host} as ${paired.machine}: nothing to approve.`);
  } else {
    const recent = rows
      .slice()
      .sort((a, b) => b.row.last_at - a.row.last_at)
      .map((r) => r.row.session.cwd ?? "");
    const choice = connectFolders({
      cwd: process.cwd(),
      home: os.homedir(),
      flags: argsAll("--folder"),
      existing: control?.folders ?? [],
      recent,
      exists: (d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      },
    });
    if (choice.from === "recent")
      out(`  Folders from your recent sessions: ${choice.folders.map((d) => tilde(d)).join(", ")}`);
    if (choice.from === "none")
      out(
        "  ! No folder for sessions you message yet (this ran from your home folder, and no recent session ran anywhere else). Run `sessionpipe control pair` again from a project folder, or with --folder.",
      );
    const mode = parseMode(flag("--mode")) ?? control?.mode ?? "safe";
    await controlMain(
      [
        "control",
        "pair",
        url,
        "--mode",
        mode,
        "--tier",
        String(tier),
        "--name",
        control?.name ?? name,
        ...choice.folders.flatMap((d) => ["--folder", d]),
        ...(has("--no-service") ? ["--no-service"] : []),
      ],
      out,
      distDir,
      { ui, say },
    );
    if (mode === "safe")
      out(
        "  Safe mode: `sessionpipe control mode auto` lets sessions you message work unattended (Claude Code's auto mode).",
      );
  }

  // 3. The sink at the tier asked for, with the receiver's cap and endpoints.
  const after = readConfig();
  const sink = after.sinks.find((x) => x.url.replace(/\/$/, "") === url);
  if (sink) {
    const old = sink.tier;
    sink.tier = tier;
    await learnReceiver(sink, tier);
    writeConfig(after);
    const eff = Math.min(sink.tier, sink.max_tier ?? 3) as Tier;
    out(`  ✓ Sink ${sink.name}: tier ${eff}${old !== tier ? ` (was ${old})` : ""} — sends ${TIER_TEXT[eff]}`);
  } else out(`  ! No sink for ${host}: \`sessionpipe sink add ${shq(url)} --token <key> --tier ${tier}\``);

  // 4. Keys into the keychain, when this session has one unlocked.
  const store = bestStore();
  if (store !== "file") {
    const a = moveSinkSecrets(store);
    const b = moveControlSecrets(store);
    const kept = [...a.kept, ...b.kept];
    out(`  ✓ Keys: in ${storeLabel(store)}${kept.length ? ` (left in the file: ${kept.join(", ")})` : ""}`);
  } else out(`  Keys: in ${tilde(path.dirname(configFile()))} ${keysFileNote()}`);

  // 5. The last 30 days, now that there is somewhere to send them.
  if (rows.length) queueBackfill(rows, 30, readConfig());
  out("");
  out(`  Done: ${name} reports to ${host} and takes messages you sign on a device it trusts.`);
  out("  Run this again any time; it only fixes what's missing. `sessionpipe doctor` checks everything.");
}

function argsAll(name: string): string[] {
  return args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1] as string] : []));
}

/** Each Claude Code account on this machine, and whether Claude Code says it's signed
 *  in from here (a message's headless run uses this login). */
async function reportClaudeAccounts(): Promise<void> {
  const bin = claudeControl.findClaude();
  if (!bin) return;
  const dirs = claudeDirs();
  const answers = await Promise.all(dirs.map((d) => claudeControl.claudeLogin(bin, d)));
  dirs.forEach((d, i) => {
    const l = answers[i] as claudeControl.Login;
    if (l.loggedIn === true)
      out(
        `  ✓ Claude Code ${tilde(d)}: signed in${l.method ? ` (${[l.method, l.subscription].filter(Boolean).join(", ")})` : ""}`,
      );
    else if (l.loggedIn === false)
      out(
        `  ! Claude Code ${tilde(d)}: not signed in as this shell sees it — \`${loginRun(d)}\`${process.platform === "darwin" && process.env.SSH_CONNECTION ? " (over ssh a Mac's keychain login can't be read; log in at the screen)" : ""}`,
      );
  });
}

/** The command that signs one Claude Code account in, to paste: the account's folder is
 *  a word of it, quoted when a shell would read it as anything else. */
function loginRun(dir: string): string {
  const usual = path.resolve(dir) === path.resolve(os.homedir(), ".claude");
  return usual ? "claude auth login" : `CLAUDE_CONFIG_DIR=${shqPath(dir)} claude auth login`;
}

/** `sessionpipe secrets [move <store>]`: where this machine's keys live. */
function secrets(): void {
  const sub = args[1];
  if (sub === "move") {
    const to = args[2] as StoreName | undefined;
    if (to !== "keychain" && to !== "secret-service" && to !== "file") {
      out("usage: sessionpipe secrets move keychain|secret-service|file");
      return;
    }
    const a = moveSinkSecrets(to);
    const b = moveControlSecrets(to);
    const moved = [...a.moved, ...b.moved];
    const kept = [...a.kept, ...b.kept];
    out(
      moved.length ? `  ✓ moved to ${storeLabel(to)}: ${moved.join(", ")}` : `  nothing to move to ${storeLabel(to)}`,
    );
    if (kept.length)
      out(`  ! left where they are (unreadable here, or ${storeLabel(to)} refused them): ${kept.join(", ")}`);
    return;
  }
  const cfg = readConfig();
  const where = (s: SinkConfig): string =>
    s.token_in
      ? `${storeLabel(s.token_in)}${sinkWithSecrets(s) ? "" : " — can't be read from this session (locked?)"}`
      : s.token || s.secret
        ? `${tilde(configFile())} (${fileKept()})`
        : "no key";
  for (const s of cfg.sinks) out(`  sink ${s.name.padEnd(20)} ${where(s)}`);
  for (const r of readControl()?.receivers ?? [])
    out(
      `  control ${new URL(r.url).host.padEnd(17)} ${r.token_in ? `${storeLabel(r.token_in)}${r.token ? "" : " — can't be read from this session (locked?)"}` : `control.json (${fileKept()})`}`,
    );
  if (!cfg.sinks.length && !readControl()?.receivers.length) out("  no keys on this machine");
  out(`  best store from this session: ${storeLabel(bestStore())}`);
}

/** The one env var that moves a harness's config off the real home (`antigravity`
 *  lives under Gemini CLI's). A harness with none (null) can never be isolated. */
const AWAY_FROM_HOME: Record<string, string | null> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  "gemini-cli": "GEMINI_CLI_HOME",
  antigravity: "GEMINI_CLI_HOME",
  devin: "XDG_CONFIG_HOME",
  "grok-build": "GROK_HOME",
};
/** Harnesses this process would read out of the real home although SESSIONPIPE_CONFIG
 *  or SESSIONPIPE_STATE say "not this machine". Setting those is how a test or an agent
 *  sandboxes sessionpipe — but they only cover sessionpipe's own files, so an
 *  all-harnesses uninstall under them still empties the live hooks files (measured
 *  twice on a reporting machine, 8 Oct 2026: six config files rewritten, every `status`
 *  row `missing`). */
function unisolated(): string[] {
  if (!process.env.SESSIONPIPE_CONFIG && !process.env.SESSIONPIPE_STATE) return [];
  return ADAPTERS.filter((a) => {
    const v = AWAY_FROM_HOME[a.name];
    return v === null || (typeof v === "string" && !process.env[v]);
  }).map((a) => a.name);
}

async function uninstall(): Promise<void> {
  if (strayWord()) return;
  // `install` has had a per-harness selector all along; uninstall taking every harness
  // with no way to say otherwise is how one harness's test strips the other four.
  const named = ADAPTERS.filter((a) => has(`--${a.name}`));
  const all = !named.length;
  if (all && !has("--all")) {
    const exposed = unisolated();
    if (exposed.length) {
      out(
        `  ! Refusing an uninstall of every harness: SESSIONPIPE_CONFIG/SESSIONPIPE_STATE point away from this machine, but ${exposed.join(", ")} still resolve from ${tilde(os.homedir())}.`,
      );
      out(`  Nothing was changed. Name what to remove (${exposed.map((n) => `--${n}`).join(" ")}),`);
      out("  pass --all if you do mean every harness on this machine, or unset SESSIONPIPE_CONFIG/SESSIONPIPE_STATE.");
      process.exitCode = 2;
      return;
    }
  }
  // Before any hook comes out: an unreadable config.json can't say which files were ours.
  assertConfigWritable();
  // The pool's env block goes first (DESIGN §2.4): Claude Code must not be left pointed
  // at a daemon this uninstall is about to take away.
  if (all || named.some((a) => a.name === "claude-code")) await poolOffForUninstall(out);
  const cfg = readConfig();
  for (const a of all ? ADAPTERS : named) {
    const created = cfg.harnesses[a.name]?.created ?? [];
    for (const r of a.uninstall(process.env, { created }))
      if (r.skipped) out(`  ! ${a.name}: ${tilde(r.file)} — ${r.note}`);
      else if (r.changed) out(`  ✓ ${a.name}: ${r.note ?? `hooks removed from ${tilde(r.file)}`}`);
    delete cfg.harnesses[a.name];
  }
  writeConfig(cfg);
  // The launcher is shared: removing it while another harness still has hook entries
  // would leave that harness running a path that is gone.
  if (all && usesLauncher()) removeLauncher();
  if (!all) {
    out(`  Still installed: ${Object.keys(cfg.harnesses).join(", ") || "nothing"}.`);
    return;
  }
  if (!has("--keep-state"))
    out(
      `  Outbox and state kept under ${tilde(state)} (delete it yourself, or pass nothing: it prunes after ${readConfig().keep_days ?? 30} days).`,
    );
  out("  Done. Every config file is byte-identical except for the entries sessionpipe wrote.");
}

async function sink(): Promise<void> {
  const sub = args[1];
  const cfg = readConfig();
  if (sub === "add" && args[2]) {
    const wasLean = isLean(cfg);
    await sinkAdd(args[2], cfg);
    rehook(cfg, wasLean);
    return;
  }
  if (sub === "list") {
    if (!cfg.sinks.length) out("  no sinks");
    const rest = (s: SinkConfig): string =>
      `tier ${s.tier}${s.max_tier !== undefined && s.max_tier < s.tier ? ` (capped ${s.max_tier})` : ""}${s.pii ? " pii" : ""}${s.control ? " control" : ""}${s.paused ? ` PAUSED ${clean(s.paused)}` : ""}${toolsNote(s.tier, s.max_tier, toolsMode(s))}`;
    // A pipe keeps the line it always had. A terminal gets columns as wide as they need,
    // the last one folded under itself: the old line is over 80 columns before it says much.
    if (ui.width === Number.POSITIVE_INFINITY)
      for (const s of cfg.sinks) out(`  ${s.name.padEnd(16)} ${s.url.padEnd(44)} ${rest(s)}`);
    else
      for (const l of table(
        ui,
        cfg.sinks.map((s) => [s.name, s.url, rest(s)]),
      ))
        say(l);
    return;
  }
  if (sub === "remove" && args[2]) {
    const n = cfg.sinks.length;
    const wasLean = isLean(cfg);
    for (const s of cfg.sinks) if (s.name === args[2]) dropSinkSecrets(s);
    cfg.sinks = cfg.sinks.filter((s) => s.name !== args[2]);
    writeConfig(cfg);
    out(cfg.sinks.length < n ? `  ✓ removed ${args[2]}` : `  no sink named ${args[2]}`);
    rehook(cfg, wasLean);
    return;
  }
  if (sub === "test" && args[2]) {
    const s = cfg.sinks.find((x) => x.name === args[2]);
    if (!s) return out(`  no sink named ${args[2]}`);
    const [sk] = buildSinks([s]);
    if (!sk) return out("  sink type not supported yet");
    // One heartbeat, then its forget: the receiver sees the round trip and keeps no row.
    const session = { id: `test-${Date.now()}`, machine: machineName(cfg, os.hostname()) };
    const mk = (type: string, seq: number) =>
      makeEvent(
        { type, harnessEvent: "test", data: {} },
        { harness: { name: "sessionpipe" }, session: { ...session, seq } },
      );
    const r = await sk.send([
      filterEvent(mk("session.heartbeat", 0), sk.tier, sk.pii) as Event,
      filterEvent(mk("session.forgotten", 1), sk.tier, sk.pii) as Event,
    ]);
    out(
      r.ok
        ? `  ✓ ${s.name}: ${r.status ?? "ok"} accepted ${r.accepted ?? 2} (a heartbeat and its forget)`
        : `  ✗ ${s.name}: ${r.status ?? ""} ${clean(r.error ?? "")} (${r.action})`,
    );
    return;
  }
  out(
    "usage: sessionpipe sink add <url|file:PATH|stdout> [--tier N] [--token T] [--pii] [--tools all|main|beat] [--name N] | list | remove <name> | test <name>",
  );
}

async function sinkAdd(url: string, cfg: Config): Promise<void> {
  // Before the receiver is asked anything: its answer could not be saved.
  assertConfigWritable();
  const tier = Math.max(0, Math.min(3, Number(flag("--tier") ?? 0))) as Tier;
  const name = flag("--name") ?? (url === "stdout" ? "stdout" : url.startsWith("file:") ? "file" : new URL(url).host);
  // Control is not a property of a sink: it is set up per machine, with keys enrolled
  // at this terminal (spec/CONTROL.md §2, `sessionpipe control pair`). A sink never
  // carries `control: true`.
  if (has("--control"))
    out("  --control is ignored: control is set up per machine (`sessionpipe control pair <url>`, spec/CONTROL.md)");
  const tools = flag("--tools");
  if (tools !== undefined && !isToolsMode(tools)) {
    out(`  ! --tools takes all, main or beat (got ${JSON.stringify(tools)}): nothing was changed`);
    process.exitCode = 2;
    return;
  }
  const s: SinkConfig = { name, url, tier, pii: has("--pii") };
  // Changing a sink's tier keeps the key it has (pairing may have handed it over, and
  // it may live in a keychain): only --token / --secret replace one. Its --tools stays
  // too, unless given again.
  const prev = cfg.sinks.find((x) => x.name === name && x.url === url);
  const keptTools = tools ?? prev?.tools;
  if (keptTools) s.tools = keptTools;
  const token = flag("--token");
  const secret = flag("--secret");
  if (prev?.token_in && !token && !secret) s.token_in = prev.token_in;
  else {
    const kept = prev ? sinkWithSecrets(prev) : null;
    const t = token ?? kept?.token;
    const sec = secret ?? kept?.secret;
    if (t) s.token = t;
    if (sec) s.secret = sec;
    if (prev?.token_in) dropSinkSecrets(prev);
  }
  await learnReceiver(s, tier);
  cfg.sinks = cfg.sinks.filter((x) => x.name !== name).concat([s]);
  writeConfig(cfg);
  out(`  ✓ sink ${name}: ${url} at tier ${Math.min(tier, s.max_tier ?? 3)}${s.pii ? ", pii" : ""}`);
  out(`    tier ${tier} sends: ${TIER_TEXT[Math.min(tier, s.max_tier ?? 3) as Tier]}`);
  if (Math.min(tier, s.max_tier ?? 3) >= 1) out(`    tool events: ${TOOLS_TEXT[toolsMode(s)]}`);
}
/** Read the receiver's well-known file onto the sink: its tier cap and endpoints. */
async function learnReceiver(s: SinkConfig, tier: Tier): Promise<void> {
  if (!/^https?:\/\//.test(s.url)) return;
  try {
    for (const note of applyWellKnown(s, await readWellKnown(s.url, 8000), tier)) out(`  ${note}`);
  } catch (e) {
    out(
      `  ! ${s.url} has no readable /.well-known/sessionpipe (${(e as Error).message}); added anyway, at tier ${tier}`,
    );
  }
}

const TIER_TEXT: Record<Tier, string> = {
  0: "session state and timing, machine, folder, repo, branch, model, title, link, the KIND of attention needed — no tool names, no words",
  1: "tier 0 + tool names, durations, ok/error, file paths, the attention message, subagents, compactions, account limits — no prompts",
  2: "tier 1 + your prompts and the assistant's text, secrets removed",
  3: "everything, including tool input and output",
};
/** ` · tools main` on a sink's line, for a sink that is sent tool events at all (tier ≥ 1). */
function toolsNote(tier: number, maxTier: number | null | undefined, mode: ToolsMode): string {
  return Math.min(tier, maxTier ?? 3) >= 1 ? ` · tools ${mode}` : "";
}
const TOOLS_TEXT: Record<ToolsMode, string> = {
  all: "every tool call (--tools main: a subagent's at most one a minute)",
  main: "the main thread's tool calls as they happen; a subagent's at most one a minute per session (--tools all: every one)",
  beat: "at most one tool call a minute per session (--tools all: every one)",
};

/** Each harness's sessions of the last `days` days, as the backfill reads them. */
function collectRows(
  adapters: readonly (typeof ADAPTERS)[number][],
  days: number,
): { harness: string; row: BackfillRow }[] {
  const since = Date.now() - days * 86_400_000;
  const rows: { harness: string; row: BackfillRow }[] = [];
  for (const a of adapters) {
    try {
      for (const row of a.backfill(since)) rows.push({ harness: a.name, row });
    } catch {}
  }
  return rows;
}

async function backfillRows(adapters: readonly (typeof ADAPTERS)[number][], days: number, cfg: Config): Promise<void> {
  await queueBackfill(collectRows(adapters, days), days, cfg);
}

/** Queue each row as session.backfill: every session not backfilled before; or, with
 *  `renames` (`sessionpipe titles on`), only each one already sent, live or backfilled,
 *  under another name than its harness's service now gives it, again, with its next seq,
 *  so a receiver shows that name without waiting for the session's next event. With
 *  remote titles on, a row takes that name first (an adapter's remoteFacts: claude.ai's,
 *  for Claude Code). Four sessions at a time, each under its own lock, as the worker takes
 *  it: a live session's seq and facts are the worker's too. One a hook holds right now is
 *  left to its own events, which carry the name as well. */
async function queueBackfill(
  rows: { harness: string; row: BackfillRow }[],
  days: number,
  cfg: Config,
  renames = false,
): Promise<{ named: number; renamed: number }> {
  const outbox = new Outbox(state);
  const facts = factsState(state);
  const machine = machineName(cfg, os.hostname());
  let n = 0;
  let named = 0;
  let renamed = 0;
  const one = async ({ harness, row }: { harness: string; row: BackfillRow }): Promise<void> => {
    const ref = { harness, session: row.session.id };
    const release = takeLock(state, ref);
    if (!release) return;
    try {
      const adapter = ADAPTERS.find((a) => a.name === harness);
      let remote = false;
      if (cfg.remote_titles && adapter?.remoteFacts && row.transcript) {
        const got = await adapter.remoteFacts(row.session, row.session, row.transcript, facts);
        if (got.title) {
          Object.assign(row.session, got);
          remote = true;
          named++;
        }
      }
      const mem = facts.get(harness, row.session.id);
      const known = mem.session as Partial<Session> | undefined;
      const rename = remote && (mem.backfilled || known) && row.session.title !== (known?.title ?? mem.sent_title);
      if (renames ? !rename : mem.backfilled) return;
      const { id, ...rest } = row.session;
      const e = makeEvent(
        {
          type: "session.backfill",
          harnessEvent: "backfill",
          data: {
            started_at: new Date(row.started_at).toISOString(),
            last_at: new Date(row.last_at).toISOString(),
            ...(row.turns !== undefined ? { turns: row.turns } : {}),
          },
        },
        {
          harness: { name: harness },
          session: { ...rest, id, seq: outbox.nextSeq(ref), machine, ...(rest.cwd ? { cwd: tilde(rest.cwd) } : {}) },
          now: row.last_at,
        },
      );
      outbox.append(ref, [e]);
      // What was sent is what a later rename compares with; a live session's next light
      // event (which reads no facts) carries it too.
      facts.save(harness, row.session.id, {
        backfilled: true,
        sent_title: row.session.title,
        ...(known ? { session: { ...known, title: row.session.title, title_source: row.session.title_source } } : {}),
      });
      if (rename) renamed++;
      else n++;
    } finally {
      release();
    }
  };
  for (let i = 0; i < rows.length; i += 4) await Promise.all(rows.slice(i, i + 4).map(one));
  if (!renames)
    out(`  ✓ Backfill: ${n} session${n === 1 ? "" : "s"} from the last ${days} days queued as session.backfill`);
  void drain(state, cfg.sinks, outbox);
  return { named, renamed };
}

async function backfill(): Promise<void> {
  if (strayWord(["--days"])) return;
  return backfillRows(selectedAdapters(), Number(flag("--days") ?? 30), readConfig());
}

/** The drain's `flush` lock, waited for: a drain holds every sink's cursor map and
 *  writes it back, so a command that writes a cursor goes under the same lock, and
 *  takes it before it does anything, so a busy lock changes nothing. A drain takes
 *  seconds; past 10 s the command says so, exits non-zero and gets null. */
async function flushLock(): Promise<(() => void) | null> {
  const release = await waitNamedLock(state, "flush", 10_000);
  if (!release) {
    process.exitCode = 1;
    out("  ✗ a drain is running (the flush lock is held); nothing was changed, try again in a moment");
  }
  return release;
}

/** What `drain` does once it has let the lock go: a worker that found it held left
 *  its events and this mark, and a command that held it sends them before it ends. */
async function drainIfMarked(cfg: Config, outbox: Outbox): Promise<void> {
  if (existsSync(path.join(state, "locks", "flush.more"))) await drain(state, cfg.sinks, outbox);
}

async function forget(): Promise<void> {
  const [, harness, session] = args;
  if (!harness || !session) return out("usage: sessionpipe forget <harness> <session>");
  const cfg = readConfig();
  const outbox = new Outbox(state);
  const ref = { harness, session };
  // Under the lock: the session's keys go out of every sink's cursor (Outbox.delete),
  // and nothing is sent or removed when the lock stays held.
  const release = await flushLock();
  if (!release) return;
  try {
    const e = makeEvent(
      { type: "session.forgotten", harnessEvent: "forget", data: {} },
      {
        harness: { name: harness },
        session: { id: session, seq: outbox.nextSeq(ref), machine: machineName(cfg, os.hostname()) },
      },
    );
    const sinks = buildSinks(cfg.sinks);
    for (const s of sinks) {
      const r = await s.send([filterEvent(e, s.tier, s.pii) as Event]);
      out(
        r.ok
          ? `  ✓ ${s.name}: asked to delete ${harness}:${session}`
          : `  ✗ ${s.name}: ${clean(String(r.error ?? r.status))}`,
      );
    }
    outbox.delete(ref);
    out("  local outbox for the session removed, and every sink's cursor into it");
  } finally {
    release();
  }
  await drainIfMarked(cfg, outbox);
}

async function replay(): Promise<void> {
  const name = flag("--sink");
  const tools = flag("--tools");
  if (tools !== undefined && !isToolsMode(tools)) {
    out(`  ! --tools takes all, main or beat (got ${JSON.stringify(tools)}): nothing was sent`);
    process.exitCode = 2;
    return;
  }
  const cfg = readConfig();
  const chosen = name ? cfg.sinks.filter((s) => s.name === name) : cfg.sinks;
  if (!chosen.length) return out("  no such sink");
  // --tools is for this replay only: a receiver rebuilt from the outbox may want every
  // tool event once, and go back to its own setting after.
  const sinks = tools ? chosen.map((s) => ({ ...s, tools })) : chosen;
  // Under the lock, like a drain: the rewind and the flush both write the cursors.
  const release = await flushLock();
  if (!release) return;
  const outbox = new Outbox(state);
  try {
    for (const s of sinks) {
      if (has("--from-start")) {
        new Cursors(state, s.name).write({});
        new ToolClock(state, s.name).write({});
      }
    }
    const thinned: Record<string, number> = {};
    const d = await flush(state, sinks, outbox, undefined, { force: true, thinned });
    for (const [k, v] of Object.entries(d)) {
      const t = thinned[k] ?? 0;
      out(
        `  ${k}: ${v} event${v === 1 ? "" : "s"} delivered${t ? `, ${t} tool event${t === 1 ? "" : "s"} thinned (--tools all sends every one)` : ""}`,
      );
    }
  } finally {
    release();
  }
  await drainIfMarked(cfg, outbox);
}

type ControlHealth = {
  running: boolean;
  receivers: (Pick<Status["receivers"][number], "url" | "polling" | "last_poll" | "last_error"> & {
    last_poll_age_ms: number | null;
  })[];
};

/** The running background service's own account of itself; null when none answers. */
async function serviceStatus(): Promise<Status | null> {
  const reply = await ask(socketPath(state), { op: "status" }, 1500);
  return reply?.op === "status" ? (reply.status as Status) : null;
}

function controlHealth(status: Status | null): ControlHealth | null {
  if (!pairedCount()) return null;
  if (!status) return { running: false, receivers: [] };
  return {
    running: true,
    receivers: status.receivers.map((r) => ({
      url: r.url,
      polling: r.polling,
      last_poll: r.last_poll,
      last_error: r.last_error,
      // An older daemon has no age field. Its last_poll still exposes a loop
      // that stopped long ago, and polling=false catches the terminal 401.
      last_poll_age_ms: r.last_poll_age_ms ?? (r.last_poll === null ? null : Math.max(0, Date.now() - r.last_poll)),
    })),
  };
}

/** How many of the outbox's session files hold events this sink has not been sent. */
function pendingFor(s: SinkConfig): number {
  const c = new Cursors(state, s.name).read();
  const outbox = new Outbox(state);
  let pending = 0;
  for (const ref of outbox.sessions()) {
    const f = outbox.file(ref);
    try {
      pending += Math.max(0, statSync(f).size - (c[`${ref.harness}/${ref.session}`] ?? 0)) > 0 ? 1 : 0;
    } catch {}
  }
  return pending;
}

/** The command that starts a service that isn't loaded, as this platform spells it.
 *  `sessionpipe control run` where no manager has it: it runs until the terminal closes. */
function startService(look: ReturnType<typeof serviceLook>, receiver: string | undefined): string {
  if (look?.installed && look.manager === "launchd")
    return `launchctl bootstrap gui/$(id -u) ${shq(look.file as string)}`;
  if (look?.installed) return `systemctl --user enable --now ${shq(path.basename(look.file as string))}`;
  return look && receiver ? `sessionpipe control pair ${shq(receiver)}` : "sessionpipe control run";
}

const HOOK_WORD = {
  current: "hooked",
  stale: "hooks out of date",
  missing: "not hooked",
  misplaced: "hooked in a place the agent never reads",
  inactive: "hooks written, but the agent won't run them",
} as const;

/** Everything `doctor` looks at (and, without `deep`, what `status` does: no hook is
 *  timed, no sign-in asked for, no log read). `report` is doctor's --json, unchanged in
 *  shape; `groups` and `todo` are the same findings for a person. */
async function checkup(deep: boolean): Promise<{ report: Record<string, unknown>; groups: Group[]; todo: Todo[] }> {
  const cfg = readConfig();
  const hc = hookCommand();
  const now = Date.now();
  const report: Record<string, unknown> = {
    version: VERSION,
    node: process.version,
    node_path: stableNode(process.execPath),
    machine: machineName(cfg, os.hostname()),
    state: state,
    config: configFile(),
    harnesses: {},
    sinks: [],
    timing: timing(),
    hook_wall_ms: deep ? hookWall() : null,
    update: updateState(cfg),
    warnings: [] as string[],
  };
  const warnings = report.warnings as string[];
  const todo: Todo[] = [];
  const computer: Group = { title: "This computer", rows: [] };
  const agents: Group = { title: "Agents", rows: [] };
  const reports: Group = { title: "Reports to", rows: [] };
  const messages: Group = { title: "Messages from", rows: [] };
  const accounts: Group = { title: "Accounts", rows: [] };
  const updates: Group = { title: "Updates", rows: [] };
  computer.rows.push({
    mark: "ok",
    label: report.machine as string,
    value: `sessionpipe ${VERSION} · node ${process.version}`,
    brief: `${report.machine} (sessionpipe ${VERSION})`,
  });

  // --- the background service ------------------------------------------------------
  const control = readControl();
  const poolCfg = readPool();
  const live = await serviceStatus();
  const health = controlHealth(live);
  report.control = health;
  const wanted = !!control?.receivers.length || poolCfg.on || control?.ask === true;
  if (health && !health.running)
    warnings.push("the control daemon is not running or not responding; polling is stopped");
  if (live) {
    // A service from before it said its version is an old one.
    const runs = live.version ?? "an older release";
    const other = runs !== VERSION;
    computer.rows.push({
      mark: other ? "warn" : "ok",
      label: "background service",
      value: other
        ? `running sessionpipe ${runs}, and this command is ${VERSION}`
        : `running${live.busy ? ` · busy with ${live.busy}` : ""}`,
    });
    if (other)
      todo.push({
        order: 1,
        say: `The background service runs sessionpipe ${runs} and this command is ${VERSION}. Bring both up to date:`,
        run: "sessionpipe update",
      });
  } else if (wanted) {
    const look = serviceLook();
    const loaded = look?.loaded === true;
    const log = shqPath(path.join(state, "control", "daemon.log"));
    computer.rows.push({
      mark: "bad",
      label: "background service",
      value: loaded
        ? "started but not answering"
        : look
          ? `not loaded: ${look.manager} doesn't have it, so nothing starts it`
          : "not running",
    });
    if (look && !loaded) warnings.push(`the background service isn't loaded: ${look.manager} doesn't have it`);
    todo.push(
      loaded
        ? {
            order: 1,
            say: "The background service was started and doesn't answer, so no message reaches this computer. Its log says why:",
            run: `tail -n 20 ${log}`,
          }
        : {
            order: 1,
            say: "The background service isn't running, so no message reaches this computer. Start it:",
            run: startService(look, control?.receivers[0]?.url),
          },
    );
  } else
    computer.rows.push({
      mark: "info",
      label: "background service",
      value: "not set up: nothing here needs it yet",
    });

  // --- the disk, and what only the service's log knew -------------------------------
  const troubles: Trouble[] = deep ? logTroubles(serviceLog(), now) : [];
  const free = freeBytes(state);
  const full = troubles.find((t) => t.kind === "disk");
  const fullNow = free !== null && free < DISK_FULL_BYTES;
  if (fullNow || full) {
    const said = fullNow
      ? `full: ${Math.floor(free / (1024 * 1024))} MB left`
      : `was full ${span(now - (full as Trouble).last)} ago, by the background service's log`;
    computer.rows.push({ mark: "bad", label: "disk", value: said });
    warnings.push(`this computer's disk ${fullNow ? "is " : ""}${said}`);
    todo.push(
      fullNow
        ? {
            order: 0,
            say: "This computer's disk is full, so events and messages can't be saved. Free some space, then look again:",
            run: "sessionpipe doctor",
          }
        : // It has room again: nothing is left to do, and nothing to type.
          {
            order: 0,
            say: `This computer's disk was full ${span(now - (full as Trouble).last)} ago, and events or messages from then may not have been saved. It has room now: nothing to type.`,
          },
    );
  }

  // --- the hooks' own home -----------------------------------------------------------
  const upd = report.update as ReturnType<typeof updateState>;
  if (upd.failed)
    warnings.push(
      `the control daemon couldn't install sessionpipe ${upd.failed.version}: ${upd.failed.error}. It tries again tomorrow; \`sessionpipe update\` tries now.`,
    );
  if (usesLauncher()) {
    const l = launcherState(VERSION);
    report.launcher = { file: tilde(l.file), node: l.node, node_ok: l.nodeOk, version: l.version };
    if (Object.keys(cfg.harnesses).length) {
      warnings.push(...l.problems);
      computer.rows.push(
        l.problems.length
          ? { mark: "warn", label: "hooks", value: hookTrouble(l) }
          : { mark: "ok", label: "hooks", value: `run sessionpipe ${l.version ?? VERSION}` },
      );
      if (l.problems.length)
        todo.push({
          order: 2,
          say: `The hooks ${hookTrouble(l)}. Write them again from this copy:`,
          run: "sessionpipe install",
        });
    }
  }
  const w = report.hook_wall_ms as { p50: number; p95: number; n: number } | null;
  if (w)
    computer.rows.push({
      mark: w.p50 > 150 ? "warn" : "ok",
      label: "hook speed",
      value: `${w.p50} ms each (95 in 100 under ${w.p95} ms)`,
    });
  else if (deep) {
    computer.rows.push({ mark: "warn", label: "hook speed", value: "the hook could not be started" });
    todo.push({
      order: 2,
      say: "The hook that agents run could not be started from this copy. Write the hooks again:",
      run: "sessionpipe install",
    });
  }

  // Where each key lives, and whether this session can read it.
  const keys: { what: string; where: string; readable: boolean }[] = [];
  for (const s of cfg.sinks)
    if (s.token_in || s.token || s.secret)
      keys.push({ what: `sink ${s.name}`, where: s.token_in ?? "file", readable: !!sinkWithSecrets(s) });
  for (const r of control?.receivers ?? [])
    keys.push({ what: `control ${new URL(r.url).host}`, where: r.token_in ?? "file", readable: !!r.token });
  report.keys = keys;
  for (const k of keys)
    if (!k.readable)
      warnings.push(
        `${k.what}: its key is in ${storeLabel(k.where as StoreName)}, which this session can't read (locked, or an ssh shell). Events wait; the control daemon sends them from your own session.`,
      );

  // --- accounts: each Claude Code sign-in, as the service sees it where it can be asked
  const claudeBin = deep ? claudeControl.findClaude() : null;
  const seen: Health | null = deep && live ? await askHealth(socketPath(state)) : null;
  if (claudeBin) {
    const dirs = claudeDirs();
    const logins = await Promise.all(
      dirs.map(async (d) => {
        const its = seen?.accounts.find((a) => a.dir === d)?.signed_in;
        return typeof its === "boolean"
          ? { service: true, signedIn: its as boolean | null }
          : { service: false, signedIn: (await claudeControl.claudeLogin(claudeBin, d)).loggedIn };
      }),
    );
    report.claude_accounts = dirs.map((d, i) => ({ dir: tilde(d), signed_in: logins[i]?.signedIn ?? null }));
    dirs.forEach((d, i) => {
      const l = logins[i] as (typeof logins)[number];
      const label = `Claude Code ${tilde(d)}`;
      const login = loginRun(d);
      if (l.signedIn === false && control?.receivers.length)
        warnings.push(`Claude Code ${tilde(d)} isn't signed in from here: ${claudeControl.loginCommand(d)}`);
      if (l.signedIn === true) accounts.rows.push({ mark: "ok", label, value: "signed in" });
      else if (l.signedIn === null)
        accounts.rows.push({ mark: "info", label, value: "couldn't tell: `claude auth status` gave no answer" });
      else if (l.service) {
        accounts.rows.push({ mark: "bad", label, value: "not signed in, as the background service sees it" });
        todo.push({
          order: 4,
          say:
            process.platform === "darwin"
              ? `${label} isn't signed in where the background service runs, so a message can't start a session with it. A Mac keeps the sign-in in the login keychain: log in at this computer's screen, then:`
              : `${label} isn't signed in, so a message can't start a session with it. Sign in:`,
          run: login,
        });
      } else if (process.platform === "darwin" && process.env.SSH_CONNECTION)
        // A Mac's login keychain can't be read over ssh: this shell's "no" says nothing.
        accounts.rows.push({
          mark: "info",
          label,
          value: "can't tell over ssh: a Mac keeps the sign-in in its login keychain",
        });
      else if (!control?.receivers.length)
        // Only a session started by a message needs it; this computer takes none.
        accounts.rows.push({ mark: "info", label, value: "not signed in, as this shell sees it" });
      else {
        accounts.rows.push({ mark: "warn", label, value: "not signed in, as this shell sees it" });
        todo.push({
          order: 4,
          say: `${label} isn't signed in, so a message can't start a session with it. Sign in:`,
          run: login,
        });
      }
    });
  }
  if (poolCfg.on || poolCfg.accounts.length) {
    const p = live?.pool;
    const none = poolCfg.on && !!p && p.accounts > 0 && p.with_room === 0;
    const refused = troubles.find((t) => t.kind === "pool");
    accounts.rows.push({
      mark: none || refused ? "warn" : poolCfg.on ? "ok" : "info",
      label: "pool",
      value: `${poolCfg.on ? "on" : "off"} · ${poolCfg.accounts.length} account${poolCfg.accounts.length === 1 ? "" : "s"}${
        p && poolCfg.on ? ` · ${p.with_room} with room left` : ""
      }${refused ? ` · had none to try ${refused.times} time${refused.times === 1 ? "" : "s"} in the last hour` : ""}`,
    });
    if (none || refused) {
      warnings.push("the pool has no account with room left: Claude Code sessions here are being refused");
      todo.push({
        order: 5,
        say: "Every pooled Claude account is at its limit or signed out, so Claude Code sessions here were refused. See which, and when each has room again:",
        run: "sessionpipe pool",
      });
    }
  }

  // A systemd user service stops at logout unless the user lingers.
  if (deep && process.platform === "linux" && control?.receivers.length) {
    let linger: boolean | null = null;
    try {
      linger = /^Linger=yes/m.test(
        execFileSync("loginctl", ["show-user", os.userInfo().username, "--property=Linger"], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch {}
    report.linger = linger;
    if (linger === false) {
      warnings.push(
        `the control daemon stops when you log out: \`loginctl enable-linger ${os.userInfo().username}\` (with sudo if refused) keeps it running`,
      );
      computer.rows.push({ mark: "warn", label: "after you log out", value: "the background service stops" });
      todo.push({
        order: 3,
        say: "The background service stops when you log out of this computer. Keep it running (with sudo if refused):",
        run: `loginctl enable-linger ${shq(os.userInfo().username)}`,
      });
    }
  }
  if (/\/Cellar\/node(?:@\d+)?\/[^/]+\//.test(distDir)) {
    warnings.push(
      "sessionpipe is installed inside Homebrew's versioned node folder; `brew upgrade node` will delete it. Install with `npm install -g --prefix ~/.local sessionpipe`.",
    );
    computer.rows.push({
      mark: "warn",
      label: "installed in",
      value: "Homebrew's node folder, which `brew upgrade node` deletes",
    });
    todo.push({
      order: 1,
      say: "sessionpipe is installed inside Homebrew's node folder, and `brew upgrade node` will delete it. Install it where it stays:",
      run: "npm install -g --prefix ~/.local sessionpipe",
    });
  }

  // --- agents ------------------------------------------------------------------------
  const rehook: string[] = [];
  for (const a of ADAPTERS) {
    if (!a.detect()) continue;
    const lean = isLean(cfg);
    const st = a.installed(hc, process.env, { lean });
    (report.harnesses as Record<string, unknown>)[a.name] = st.map((r) => ({
      file: tilde(r.file),
      state: r.state,
      ...(r.note ? { note: r.note } : {}),
    }));
    for (const r of st) {
      agents.rows.push({
        mark: r.state === "current" ? "ok" : r.state === "missing" && !cfg.harnesses[a.name] ? "info" : "warn",
        label: a.name,
        value: `${HOOK_WORD[r.state]} · ${tilde(r.file)}`,
      });
      // Hooks the agent itself won't run are not mended by writing them again: its own
      // setting has to change, and the note says which.
      if (r.state === "inactive")
        todo.push({
          order: 2,
          say: `${a.name} has its hooks and won't run them, so its sessions aren't reported: ${r.note ?? "its own settings turn hooks off"}.`,
        });
      else if (r.state === "missing" ? cfg.harnesses[a.name] : r.state !== "current") rehook.push(a.name);
    }
    for (const r of st)
      if (r.state === "inactive")
        warnings.push(`${a.name}: hooks are written but the harness will not run them — ${r.note ?? ""}`);
    for (const r of st)
      if (r.state === "stale") {
        // The same file read against the other hook set: stale only because a sink crossed
        // tier 0 since the hooks were written, not because a path moved.
        const otherSet =
          a.installed(hc, process.env, { lean: !lean }).find((x) => x.file === r.file)?.state === "current";
        warnings.push(
          otherSet
            ? `${a.name}: the hooks in ${tilde(r.file)} are the ${lean ? "full" : "lean"} set, but ${lean ? "no sink is above tier 0 now" : "a sink is above tier 0 now"}; run \`sessionpipe install\` again.`
            : `${a.name}: the hook in ${tilde(r.file)} points at an old node or script path; run \`sessionpipe install\` again.`,
        );
      }
    for (const r of st)
      if (r.state === "misplaced")
        warnings.push(
          `${a.name}: the notify line in ${tilde(r.file)} sits inside a [table], where Codex never reads it; run \`sessionpipe install\` again.`,
        );
  }
  // An agent that was hooked here and is no longer found (uninstalled, or its folder moved).
  for (const name of Object.keys(cfg.harnesses))
    if (!ADAPTERS.some((a) => a.name === name && a.detect()))
      agents.rows.push({
        mark: "info",
        label: name,
        value: "was hooked here, and is no longer found on this computer",
      });
  if (!agents.rows.length)
    agents.rows.push({ mark: "info", label: "none", value: "no coding agent was found on this computer" });
  if (rehook.length) {
    const names = [...new Set(rehook)];
    todo.push({
      order: 2,
      say: `The hooks for ${names.join(", ")} are missing or out of date, so not every session is reported. Write them again:`,
      run: "sessionpipe install",
    });
  }

  // --- where it reports ----------------------------------------------------------------
  for (const s of cfg.sinks) {
    (report.sinks as unknown[]).push({
      name: s.name,
      url: s.url,
      tier: s.tier,
      max_tier: s.max_tier ?? null,
      pii: !!s.pii,
      tools: toolsMode(s),
      control: !!s.control,
      paused: s.paused ?? null,
      token: s.token_in ? `in ${s.token_in}` : s.token ? `${s.token.slice(0, 4)}…` : null,
    });
    const pending = pendingFor(s);
    // A key this shell can't read (a keychain, over ssh) is the service's to send with.
    const locked =
      (s.token_in || s.token || s.secret) && !sinkWithSecrets(s) ? " · its key can't be read from this shell" : "";
    const tier = `tier ${Math.min(s.tier, s.max_tier ?? 3)}${locked}`;
    reports.rows.push(
      s.paused
        ? { mark: "bad", label: s.name, value: `${tier} · stopped: ${s.paused}` }
        : {
            mark: "ok",
            label: s.name,
            value: `${tier} · ${pending ? `${pending} session${pending === 1 ? "" : "s"} waiting to be sent` : "up to date"}`,
          },
    );
    if (s.paused)
      todo.push({
        order: 3,
        say: `${s.name} stopped taking events (${s.paused}); they wait on this computer. See what it answers now:`,
        run: `sessionpipe sink test ${shq(s.name)}`,
      });
  }
  if (!cfg.sinks.length)
    reports.rows.push({ mark: "info", label: "nowhere", value: "events stay on this computer until you add a sink" });
  const jobs = waitingJobs();
  if (jobs)
    reports.rows.push({
      mark: "info",
      label: "still to handle",
      value: `${jobs} hook event${jobs === 1 ? "" : "s"} waiting on this computer`,
    });

  // --- who can message it, and whether that is live --------------------------------------
  // Every receiver this computer is paired with, and any the service still asks that
  // control.json no longer lists (it reads the file again within seconds).
  const paired = control?.receivers ?? [];
  const asked = health?.receivers ?? [];
  for (const url of new Set([...paired.map((r) => r.url), ...asked.map((r) => r.url)])) {
    const r = { url, keys: paired.find((x) => x.url === url)?.keys ?? [] };
    const p = asked.find((x) => x.url === url);
    const label = hostOf(r.url);
    const trusted = `${r.keys.length} key${r.keys.length === 1 ? "" : "s"} trusted`;
    if (!p) {
      messages.rows.push({
        mark: live ? "info" : "bad",
        label,
        value: live
          ? `the background service is taking it up · ${trusted}`
          : "not live: the background service isn't running",
      });
      continue;
    }
    // A normal long-poll takes 25 s (35 s deadline). Allow one minute at startup
    // and between responses, but report a stopped/backing-off loop immediately.
    if (isLive(p)) {
      messages.rows.push({
        mark: "ok",
        label,
        value: `live · ${p.last_poll === null ? "just connected" : `heard ${heardAgo(p.last_poll_age_ms as number)}`} · ${trusted}`,
      });
      continue;
    }
    const age =
      p.last_poll_age_ms === null
        ? "never polled"
        : `not polled for ${Math.floor(p.last_poll_age_ms / 60_000)} minutes`;
    warnings.push(
      `${r.url}: the daemon has ${age}: ${p.last_error ?? (p.polling ? "no successful poll response" : "polling stopped")}`,
    );
    const forSpan = p.last_poll_age_ms === null ? "" : ` for ${span(p.last_poll_age_ms)}`;
    const err = p.last_error ?? "";
    if (/\(401\)/.test(err)) {
      messages.rows.push({ mark: "bad", label, value: "not live: it no longer knows this computer" });
      todo.push({
        order: 3,
        say: `${label} no longer knows this computer, so its messages can't arrive. Pair with it again:`,
        run: `sessionpipe control pair ${shq(r.url)}`,
      });
    } else if (err.startsWith("can't read this machine's token")) {
      messages.rows.push({
        mark: "bad",
        label,
        value: `not live${forSpan}: the background service can't read this computer's key`,
      });
      todo.push({
        order: 3,
        say: `The background service can't read this computer's key for ${label}: the keychain it is in is locked, or nobody is logged in at this computer's screen. Log in there once, or keep the keys in a file it can always read:`,
        run: "sessionpipe secrets move file",
      });
    } else {
      messages.rows.push({
        mark: "bad",
        label,
        value: `not live${forSpan}: ${err || "no answer"}`,
      });
      todo.push({
        order: 6,
        say: `${label} hasn't answered${forSpan}. Messages wait there, and the background service keeps trying: nothing to type unless it stays this way.`,
      });
    }
  }
  if (control?.receivers.length)
    messages.rows.push({
      mark: "info",
      label: "sessions you message",
      value: `run in ${control.mode} mode, in ${control.folders.length} folder${control.folders.length === 1 ? "" : "s"}`,
    });
  else messages.rows.push({ mark: "info", label: "nobody", value: "this computer takes no messages" });

  // --- updates ---------------------------------------------------------------------------
  updates.rows.push(
    upd.auto
      ? {
          mark: "ok",
          label: "automatic",
          value: upd.last_check
            ? upd.last_error
              ? `the check ${ago(upd.last_check, now)} failed: ${upd.last_error}`
              : `checked ${ago(upd.last_check, now)}: ${upd.latest ?? "?"} is the newest`
            : "once a day; not checked yet",
        }
      : // Why is a --json value too and keeps its old words there; a person reads this page's.
        { mark: "info", label: "by hand", value: `${upd.off}`.replace("the control daemon", "the background service") },
  );
  if (upd.pending)
    updates.rows.push({
      mark: "info",
      label: "waiting",
      value: `${upd.pending} is installed once the background service is idle`,
    });
  if (upd.failed) {
    updates.rows.push({
      mark: "warn",
      label: "failed",
      value: `installing ${upd.failed.version} ${ago(upd.failed.at, now)}: ${upd.failed.error}`,
    });
    todo.push({
      order: 1,
      say: `The background service couldn't install sessionpipe ${upd.failed.version} by itself. Do it now:`,
      run: "sessionpipe update",
    });
  } else if (upd.updated)
    updates.rows.push({
      mark: "info",
      label: "last update",
      value: `${upd.updated.from} → ${upd.updated.to}, ${ago(upd.updated.at, now)}`,
    });

  if (w && w.p50 > 150) {
    warnings.push(
      `the harness waits ${w.p50} ms per hook (p50, target < 150): that is Node's own startup on this machine. A lean install (no sink above tier 0) hooks fewer events.`,
    );
    todo.push({
      order: 6,
      say: `Each hook takes ${w.p50} ms, which is Node starting up on this computer; agents wait that long many times a turn. With no sink above tier 0, fewer events are hooked.`,
    });
  }
  return { report, groups: [computer, agents, reports, messages, accounts, updates], todo };
}

/** Hook events written down and not yet handled by a worker. */
function waitingJobs(): number {
  try {
    return readdirSync(jobsDir(state)).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/** What is wrong with the hooks' own copy, in a few words. */
function hookTrouble(l: ReturnType<typeof launcherState>): string {
  if (!l.present) return "have no launcher to run";
  if (l.version && l.version !== VERSION) return `run sessionpipe ${l.version}, and this command is ${VERSION}`;
  if (!l.nodeOk) return `name a node that is gone (${l.node ?? "?"})`;
  return "are missing a file";
}

async function status(): Promise<void> {
  if (!has("--json")) {
    const c = await checkup(false);
    say(verdict(ui, inOrder(c.todo).length));
    say("");
    for (const l of brief(ui, c.groups)) say(l);
    say("");
    for (const l of fold(
      ui,
      "  ",
      c.todo.length ? "`sessionpipe doctor` says what to do about it." : "`sessionpipe doctor` looks closer.",
    ))
      say(commands(ui, l));
    return;
  }
  const cfg = readConfig();
  const hc = hookCommand();
  const harnesses: Record<string, { file: string; state: string; note?: string }[]> = {};
  const sinks = [];
  for (const a of ADAPTERS) {
    if (!a.detect() && !cfg.harnesses[a.name]) continue;
    const installed = a.installed(hc, process.env, { lean: isLean(cfg) });
    harnesses[a.name] = installed.map((r) => ({
      file: tilde(r.file),
      state: r.state,
      ...(r.note ? { note: r.note } : {}),
    }));
  }
  for (const s of cfg.sinks)
    sinks.push({
      name: s.name,
      url: s.url,
      tier: s.tier,
      max_tier: s.max_tier ?? null,
      pii: !!s.pii,
      tools: toolsMode(s),
      control: !!s.control,
      paused: s.paused ?? null,
      pending_sessions: pendingFor(s),
    });
  const control = controlHealth(await serviceStatus());
  // The account pool, from its file alone (`sessionpipe pool` asks the daemon for the rest).
  const poolCfg = readPool();
  const pool =
    poolCfg.on || poolCfg.accounts.length
      ? { on: poolCfg.on, port: poolCfg.port, accounts: poolCfg.accounts.length }
      : null;
  out(
    JSON.stringify(
      {
        version: VERSION,
        machine: machineName(cfg, os.hostname()),
        state,
        config: configFile(),
        harnesses,
        sinks,
        timing: timing(),
        control,
        pool,
        update: updateState(cfg),
        jobs: waitingJobs(),
      },
      null,
      2,
    ),
  );
}

/** Spawn the hook the way a harness does and time the whole process (issue #12:
 *  the in-process clock misses Node's startup, ~200 ms on an older Intel Mac). */
function hookWall(runs = 8): { n: number; p50: number; p95: number } | null {
  const hook = path.join(distDir, "hook.js");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sessionpipe-doctor-"));
  const env = {
    ...process.env,
    SESSIONPIPE_STATE: tmp,
    SESSIONPIPE_CONFIG: path.join(tmp, "config.json"),
    SESSIONPIPE_NO_WORKER: "1",
  };
  const input = JSON.stringify({
    session_id: "doctor",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    cwd: process.cwd(),
  });
  const times: number[] = [];
  try {
    for (let i = 0; i < runs; i++) {
      const t0 = process.hrtime.bigint();
      const r = spawnSync(process.execPath, [hook, "claude-code", "PostToolUse"], { input, env, encoding: "utf8" });
      if (r.status !== 0) return null;
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  times.sort((a, b) => a - b);
  // `?? 0` satisfies noUncheckedIndexedAccess: the index is clamped to the last of `runs` entries.
  const q = (p: number) =>
    Math.round(/* v8 ignore next */ times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? 0);
  return { n: times.length, p50: q(0.5), p95: q(0.95) };
}

function timing(): { n: number; p50: number; p95: number } | null {
  try {
    const lines = readFileSync(path.join(state, "timing.jsonl"), "utf8").trim().split("\n").slice(-100);
    const ms = lines
      .map((l) => (JSON.parse(l) as { ms: number }).ms)
      .filter((x) => x >= 0)
      .sort((a, b) => a - b);
    if (!ms.length) return null;
    // `?? 0` satisfies noUncheckedIndexedAccess: the index is clamped to the last of a non-empty list.
    const q = (p: number) =>
      Math.round(/* v8 ignore next */ ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] ?? 0);
    return { n: ms.length, p50: q(0.5), p95: q(0.95) };
  } catch {
    return null;
  }
}

async function doctor(): Promise<void> {
  const c = await checkup(true);
  // For a program: it exits 0 whatever was found, as it always has. What was found is
  // in `warnings`.
  if (has("--json")) return out(JSON.stringify(c.report, null, 2));
  for (const l of page(ui, c)) say(l);
  // The exit code says whether there is a command for the person to run. A finding with
  // nothing to type (a slow hook, a receiver that hasn't answered yet, a disk that was
  // full) is on the page and counted in the verdict, and leaves the code alone: it
  // comes and goes with this computer's load and the network, and a script that reads
  // the code must not fail on that.
  if (c.todo.some((t) => t.run)) process.exitCode = 1;
}

/** Follow the local outbox: one event per line, filtered to a tier. The zero-server demo. */
async function tail(): Promise<void> {
  const tier: Tier = tierArg(args, 1);
  const onlySession = flag("--session");
  const onlyHarness = flag("--harness");
  const outbox = new Outbox(state);
  const offsets = new Map<string, number>();
  const fmt = (e: Event): string => {
    const t = e.time.slice(11, 19);
    const d = e.data as Record<string, unknown>;
    let detail = "";
    switch (e.type) {
      case "session.started":
        detail = `source=${d.source}  ${e.session.cwd ?? ""} ${e.session.branch ?? ""}`;
        break;
      case "turn.started":
        detail = [
          d.submitted_by !== undefined ? `submitted_by=${d.submitted_by}` : "",
          d.injected ? "injected" : "",
          d.prompt_chars !== undefined ? `prompt_chars=${d.prompt_chars}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        break;
      case "tool.started":
        detail = String(d.tool ?? "");
        break;
      case "tool.ended":
        detail = `${d.tool} ${d.ok ? "ok" : "error"}${d.ms !== undefined ? ` ${d.ms}ms` : ""}`;
        break;
      case "attention.needed":
        detail = `${d.kind}${d.tool ? ` ${d.tool}` : ""}${d.message ? ` "${String(d.message).slice(0, 60)}"` : ""}`;
        break;
      case "turn.ended":
        detail = String(d.reason ?? "");
        break;
      case "session.ended":
        detail = `reason=${d.reason}`;
        break;
      case "turn.transcript":
        detail = `#${d.turn} "${String(d.user).slice(0, 50).replace(/\s+/g, " ")}"`;
        break;
      case "turn.progress":
        detail = `#${d.turn} ${String(d.assistant ?? "").length} chars so far`;
        break;
      case "session.backfill":
        detail = `${e.session.title ?? ""}`;
        break;
      default:
        detail = JSON.stringify(d).slice(0, 80);
    }
    return `${t} ${e.harness.name.padEnd(11)} ${e.session.id.slice(0, 4)}…  ${e.type.padEnd(17)} ${detail}`;
  };
  out(`sessionpipe tail · tier ${tier} · ${tilde(path.join(state, "outbox"))} (Ctrl-C to stop)`);
  // Start at the end of each file unless --all.
  for (const ref of outbox.sessions()) {
    try {
      offsets.set(`${ref.harness}/${ref.session}`, has("--all") ? 0 : statSync(outbox.file(ref)).size);
    } catch {}
  }
  for (;;) {
    for (const ref of outbox.sessions()) {
      if (onlyHarness && ref.harness !== onlyHarness) continue;
      if (onlySession && !ref.session.startsWith(onlySession)) continue;
      const k = `${ref.harness}/${ref.session}`;
      const from = offsets.get(k) ?? 0;
      const { events, offset } = outbox.read(ref, from, 200);
      offsets.set(k, offset);
      for (const e of events) {
        const f = filterEvent(e, tier, false);
        if (f) out(has("--json") ? JSON.stringify(f) : fmt(f));
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function workerFromArgv(): Promise<void> {
  const f = args[1];
  if (!f) return;
  const job = JSON.parse(readFileSync(f, "utf8"));
  try {
    unlinkSync(f);
  } catch {}
  await runJob(job);
}

/** Whether the daemon updates this copy by itself, and what it last found. */
function updateState(cfg: Config) {
  return updateSummary({
    // The shell's own SESSIONPIPE_NO_UPDATE_CHECK says nothing about the daemon's
    // environment; the daemon records that one itself.
    off: autoUpdateOff({ env: {}, config: cfg, distDir }),
    paired: pairedCount() > 0,
    rec: readUpdate(updateFile()),
  });
}

/** `sessionpipe update [off|on]`: install the latest release into this copy's prefix
 *  now, then have the daemon restart onto it once idle; or switch the daemon's daily
 *  update off or on (config.json `update_check`; the daemon reads it every ten minutes). */
async function update(): Promise<void> {
  const sub = args[1];
  if (sub === "off" || sub === "on") {
    const cfg = readConfig();
    cfg.update_check = sub === "on";
    writeConfig(cfg);
    return out(
      sub === "off"
        ? "  ✓ The control daemon no longer checks npm or updates itself. `sessionpipe update` still updates by hand; `sessionpipe update on` undoes this."
        : "  ✓ The control daemon checks npm once a day and installs a new release when it's idle.",
    );
  }
  // `update OFF` or `update of` is someone switching updates off: never install for them.
  if (sub !== undefined) {
    process.exitCode = 2;
    return out("usage: sessionpipe update [off|on]");
  }
  if (process.env.SESSIONPIPE_NO_UPDATE_CHECK) return out("  update check is off (SESSIONPIPE_NO_UPDATE_CHECK)");
  let latest: string;
  try {
    latest = await latestVersion();
  } catch (e) {
    return out(`  couldn't check npm: ${(e as Error).message}`);
  }
  if (!isNewer(latest, VERSION)) return out(`  sessionpipe ${VERSION} is current (npm latest: ${latest})`);
  const prefix = globalPrefix(distDir);
  if (!prefix)
    return out(
      `  ${latest} is available (you run ${VERSION}), but this copy isn't a global npm install (npx, a checkout or a dev build): \`npm install -g sessionpipe@${latest}\` installs one.`,
    );
  out(`  ${latest} is available (you run ${VERSION}); installing into ${tilde(prefix)}…`);
  const r = await installVersion(latest, {
    node: process.execPath,
    distDir,
    harnesses: enabledHarnesses(readConfig().harnesses),
  });
  if (!r.ok) {
    process.exitCode = 1;
    return out(`  ✗ ${r.error}`);
  }
  out(`  ✓ sessionpipe ${latest} installed in ${(r.ms / 1000).toFixed(1)} s; ${r.hooks}`);
  // The daemon still runs the old code: it restarts onto this copy when nothing is in hand.
  const sock = socketPath(state);
  const st = await ask(sock, { op: "status" }, 2000);
  if (st?.op !== "status") return;
  const running = (st.status as { version?: string }).version ?? "?";
  if (running === latest) return;
  const r2 = await ask(sock, { op: "restart" }, 2000);
  if (r2?.op === "ok") out(`  The control daemon (${running}) restarts onto ${latest} as soon as nothing is in hand.`);
  else
    out(
      `  The control daemon still runs ${running} and can't restart itself: ${
        process.platform === "darwin"
          ? `\`launchctl kickstart -k gui/${process.getuid?.() ?? "$(id -u)"}/org.sessionpipe.control\``
          : process.platform === "linux"
            ? "`systemctl --user restart sessionpipe-control.service`"
            : "stop `sessionpipe control run` and start it again"
      } moves it (a run in progress stops).`,
    );
}

/** `sessionpipe titles [on|off]`: whether the worker asks a harness's own service for a
 *  session's name (config.json `remote_titles`, off by default). For Claude Code that is
 *  claude.ai, which names the sessions the Claude app starts and never tells the machine;
 *  asking means reading the sign-in token Claude Code keeps here. */
async function titles(): Promise<void> {
  const sub = args[1];
  const set = sub === "on" || sub === "off";
  const cfg = readConfig();
  if (set) {
    cfg.remote_titles = sub === "on";
    writeConfig(cfg);
  }
  const done = set ? "✓ " : "";
  out(
    cfg.remote_titles
      ? `  ${done}Claude Code sessions with a claude.ai link take claude.ai's name, as the Claude app shows it, unless you named them here. To ask, sessionpipe reads Claude Code's sign-in token on this machine and sends it to api.anthropic.com only; it never stores or forwards it. \`sessionpipe titles off\` stops this.`
      : `  ${done}Session names come from this machine's files only, and no sign-in token is read. A session the Claude app started has a name there that never reaches this machine; \`sessionpipe titles on\` asks claude.ai for it.`,
  );
  if (!cfg.remote_titles || (sub !== "on" && sub !== "refresh")) return;
  // Sessions already sent under another name take claude.ai's now, not at their next event.
  const days = Number(flag("--days") ?? 30);
  const { named, renamed } = await queueBackfill(
    collectRows(
      ADAPTERS.filter((a) => a.remoteFacts && a.detect()),
      days,
    ),
    days,
    cfg,
    true,
  );
  out(
    named
      ? `  Asked claude.ai about the last ${days} days' sessions: ${named} named there, ${renamed} sent again under that name.`
      : `  None of the last ${days} days' sessions has a name on claude.ai that could be read here: none was started from the Claude app or has a claude.ai link, or Claude Code's sign-in is missing or about to expire (run \`claude\` once, then \`sessionpipe titles refresh\`).`,
  );
}

// The process entrypoint (`node dist/cli.js`, or npm's bin link to it) runs the command;
// an import of this module runs nothing.
if (isEntrypoint(process.argv[1], import.meta.url)) {
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
  });
  void main(process.argv.slice(2));
}
