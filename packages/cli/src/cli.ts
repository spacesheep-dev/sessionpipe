#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// sessionpipe: install once, hook everything, choose per sink what leaves.
//   connect · install · uninstall · sink add|list|remove|test · secrets · status ·
//   doctor · tail · backfill · forget · replay · update · hook · worker
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTERS,
  adapterByName,
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
  type SinkConfig,
  stateDir,
  type Tier,
  tilde,
  writeConfig,
} from "@sessionpipe/core";
import { connectFolders, connectTier } from "./connect.js";
import { autoUpdateOff, readUpdate, updateFile, updateLine, updateSummary } from "./control/autoupdate.js";
import { CONTROL_HELP, controlMain, enabledHarnesses, waitMain } from "./control/cli.js";
import { ask, socketPath } from "./control/local.js";
import { moveControlSecrets, pairedCount, readControl } from "./control/store.js";
import { commandHelp } from "./help.js";
import { installLauncher, launcherPath, launcherState, removeLauncher, usesLauncher } from "./launcher.js";
import { buildSinks, factsState, flush, jobsDir, runJob, VERSION } from "./run.js";
import { rerunGlobally, stableNode, viaNpx } from "./runtime.js";
import { bestStore, dropSinkSecrets, moveSinkSecrets, type StoreName, sinkWithSecrets, storeLabel } from "./secrets.js";
import { globalPrefix, installVersion, isNewer, latestVersion } from "./update.js";

process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
});
const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(name);
const out = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};
const state = stateDir();
const distDir = path.dirname(fileURLToPath(import.meta.url));

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

function selectedAdapters(): typeof ADAPTERS {
  const named = ADAPTERS.filter((a) => has(`--${a.name}`));
  if (named.length) return named;
  return ADAPTERS.filter((a) => a.detect());
}

async function main(): Promise<void> {
  // Help wins over every command and argument, before any command can do work.
  if (has("--help") || has("-h")) {
    const usage = commandHelp(
      args,
      ADAPTERS.map((a) => a.name),
    );
    return usage ? out(usage) : help();
  }
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
    case "worker":
      return workerFromArgv();
    case "control":
      return controlMain(args, out, distDir);
    case "wait":
      return waitMain(args, out);
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
  out(`sessionpipe ${VERSION} — an open protocol for what your coding agents are doing

Usage:
  sessionpipe connect <receiver> [--machine NAME] [--tier 0-3] [--mode safe|auto] [--folder DIR]…
                                  (everything, in one go: hooks, a sink, signed messages, keys)
  sessionpipe install [--claude-code --codex --gemini-cli --antigravity] [--machine NAME] [--backfill DAYS] [--sink URL --tier N]
  sessionpipe uninstall [--keep-state]
  sessionpipe sink add <url|file:PATH|stdout> [--tier 0-3] [--token T] [--pii] [--name N]
  sessionpipe sink list | remove <name> | test <name>
  sessionpipe secrets [move keychain|secret-service|file]   (where the machine's keys live)
  sessionpipe status [--json] | doctor [--json]
  sessionpipe tail [--session ID] [--tier N] [--harness NAME]
  sessionpipe backfill [--days 30] | forget <harness> <session> | replay --sink NAME
  sessionpipe update [off|on]       (install the latest now; off/on: the daemon's daily update)
${CONTROL_HELP}

Docs: https://sessionpipe.org · nothing leaves this machine until you add a sink.`);
}

async function install(): Promise<void> {
  if (viaNpx(distDir)) return rerunGlobally(args, out);
  const cfg = readConfig();
  const machine = flag("--machine");
  if (machine) cfg.machine = machine.slice(0, 80);
  // A sink URL given here is added first, so the install knows whether it needs
  // every tool event or only the heartbeat's one.
  const sinkUrl = flag("--sink");
  if (sinkUrl) await sinkAdd(sinkUrl, cfg);
  const adapters = selectedAdapters();
  if (!adapters.length) {
    out(
      "  No supported harness found on this machine (Claude Code, Codex, Gemini CLI, Antigravity). Pass --<harness> to force one.",
    );
    return;
  }
  out(`  Machine: ${machineName(cfg, os.hostname())}`);
  const lean = isLean(cfg);
  if (lean)
    out(
      "  No sink above tier 0: hooking one tool event per harness (the heartbeat's). `sink add … --tier 1` or higher hooks the rest.",
    );
  installHarnesses(adapters, cfg, lean);
  writeConfig(cfg);
  const days = Number(flag("--backfill") ?? 30);
  if (days > 0) backfillRows(adapters, days, cfg);
  out("");
  const live = cfg.sinks.filter((s) => !s.paused);
  if (live.length) out(`  Reporting to ${live.map((s) => `${s.name} (tier ${s.tier})`).join(", ")}.`);
  else
    out(
      "  Nothing leaves this machine yet: events go to the local outbox. `sessionpipe tail` shows them; `sessionpipe sink add <url> --tier N` sends them.",
    );
  out("  Sessions already running pick up hooks on their next start (Claude Code ≥ 2.1.280 picks them up live).");
}

/** No sink takes tier ≥ 1: the harness only needs one tool event (issue #12). */
function isLean(cfg: Config): boolean {
  return !cfg.sinks.some((s) => !s.paused && Math.min(s.tier, s.max_tier ?? 3) >= 1);
}

/** Write the hooks for these harnesses; remember which files sessionpipe created. */
function installHarnesses(adapters: readonly (typeof ADAPTERS)[number][], cfg: Config, lean: boolean): void {
  if (usesLauncher()) {
    const node = stableNode(process.execPath);
    const l = installLauncher({ distDir, node, version: VERSION });
    if (l.changed)
      out(`  ✓ hook launcher: ${tilde(l.launcher)} (node ${tilde(node)}, or any node on PATH once that one is gone)`);
  }
  const hc = hookCommand();
  for (const a of adapters) {
    const prev = cfg.harnesses[a.name] ?? {};
    const created = new Set(prev.created ?? []);
    const reports = a.install(hc, process.env, { lean, created: [...created] });
    for (const r of reports) {
      if (r.created) created.add(r.file);
      const mark = r.skipped ? "!" : r.changed ? "✓" : "=";
      out(
        `  ${mark} ${a.name}: ${tilde(r.file)}${r.note ? ` — ${r.note}` : r.changed ? " written" : " already current"}`,
      );
    }
    cfg.harnesses[a.name] = { enabled: true, ...(created.size ? { created: [...created] } : {}) };
    if (a.name === "gemini-cli")
      out("    note: Gemini CLI's own telemetry defaults logPrompts on; that is Google's setting, not sessionpipe's.");
    if (a.name === "codex" && !reports.some((r) => r.skipped))
      out(
        "    note: Codex runs non-managed hooks only after you approve them: start `codex` and accept the hook review. The notify fallback reports turn ends meanwhile.",
      );
  }
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
      "usage: sessionpipe connect <receiver> [--machine NAME] [--tier 0-3] [--mode safe|auto] [--folder DIR]… [--no-service]",
    );
  if (viaNpx(distDir)) return rerunGlobally(args, out);
  const url = (/^https?:\/\//.test(raw) ? raw : `https://${raw}`).replace(/\/$/, "");
  const host = new URL(url).host;
  const cfg = readConfig();
  const machine = flag("--machine");
  if (machine) cfg.machine = machine.slice(0, 80);
  const name = machineName(cfg, os.hostname());
  const before = cfg.sinks.find((x) => x.url.replace(/\/$/, "") === url);
  const tier = connectTier(flag("--tier"), before?.tier);
  out(`  Connecting ${name} to ${host}.`);

  // 1. The hooks, for every agent on this machine (and every Claude Code account).
  const adapters = ADAPTERS.filter((a) => a.detect());
  if (!adapters.length)
    out(
      "  ! No coding agent here yet (Claude Code, Codex, Gemini CLI, Antigravity): run `sessionpipe install` once you have one.",
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
    const mode =
      flag("--mode") === "auto" || flag("--mode") === "safe" ? (flag("--mode") as string) : (control?.mode ?? "safe");
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
  } else out(`  ! No sink for ${host}: \`sessionpipe sink add ${url} --token <key> --tier ${tier}\``);

  // 4. Keys into the keychain, when this session has one unlocked.
  const store = bestStore();
  if (store !== "file") {
    const a = moveSinkSecrets(store);
    const b = moveControlSecrets(store);
    const kept = [...a.kept, ...b.kept];
    out(`  ✓ Keys: in ${storeLabel(store)}${kept.length ? ` (left in the file: ${kept.join(", ")})` : ""}`);
  } else
    out(
      `  Keys: in ${tilde(path.dirname(configFile()))} at 0600 — no unlocked keychain in this session${process.env.SSH_CONNECTION ? " (an ssh shell)" : ""}`,
    );

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
        `  ! Claude Code ${tilde(d)}: not signed in as this shell sees it — ${claudeControl.loginCommand(d)}${process.platform === "darwin" && process.env.SSH_CONNECTION ? " (over ssh a Mac's keychain login can't be read; log in at the screen)" : ""}`,
      );
  });
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
        ? `${tilde(configFile())} (0600)`
        : "no key";
  for (const s of cfg.sinks) out(`  sink ${s.name.padEnd(20)} ${where(s)}`);
  for (const r of readControl()?.receivers ?? [])
    out(
      `  control ${new URL(r.url).host.padEnd(17)} ${r.token_in ? `${storeLabel(r.token_in)}${r.token ? "" : " — can't be read from this session (locked?)"}` : "control.json (0600)"}`,
    );
  if (!cfg.sinks.length && !readControl()?.receivers.length) out("  no keys on this machine");
  out(`  best store from this session: ${storeLabel(bestStore())}`);
}

function uninstall(): void {
  const cfg = readConfig();
  for (const a of ADAPTERS) {
    const created = cfg.harnesses[a.name]?.created ?? [];
    for (const r of a.uninstall(process.env, { created }))
      if (r.changed) out(`  ✓ ${a.name}: ${r.note ?? `hooks removed from ${tilde(r.file)}`}`);
      else if (r.skipped) out(`  ! ${a.name}: ${tilde(r.file)} — ${r.note}`);
    delete cfg.harnesses[a.name];
  }
  writeConfig(cfg);
  if (usesLauncher()) removeLauncher();
  if (!has("--keep-state"))
    out(
      `  Outbox and state kept under ${tilde(state)} (delete it yourself, or pass nothing: it prunes after ${readConfig().keep_days ?? 30} days).`,
    );
  out("  Done. Every config file is byte-identical except for the entries sessionpipe wrote.");
}

async function sink(): Promise<void> {
  const sub = args[1];
  const cfg = readConfig();
  if (sub === "add" && args[2]) return sinkAdd(args[2], cfg);
  if (sub === "list") {
    if (!cfg.sinks.length) out("  no sinks");
    for (const s of cfg.sinks)
      out(
        `  ${s.name.padEnd(16)} ${s.url.padEnd(44)} tier ${s.tier}${s.max_tier !== undefined && s.max_tier < s.tier ? ` (capped ${s.max_tier})` : ""}${s.pii ? " pii" : ""}${s.control ? " control" : ""}${s.paused ? ` PAUSED ${s.paused}` : ""}`,
      );
    return;
  }
  if (sub === "remove" && args[2]) {
    const n = cfg.sinks.length;
    for (const s of cfg.sinks) if (s.name === args[2]) dropSinkSecrets(s);
    cfg.sinks = cfg.sinks.filter((s) => s.name !== args[2]);
    writeConfig(cfg);
    out(cfg.sinks.length < n ? `  ✓ removed ${args[2]}` : `  no sink named ${args[2]}`);
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
        : `  ✗ ${s.name}: ${r.status ?? ""} ${r.error ?? ""} (${r.action})`,
    );
    return;
  }
  out(
    "usage: sessionpipe sink add <url|file:PATH|stdout> [--tier N] [--token T] [--pii] [--name N] | list | remove <name> | test <name>",
  );
}

async function sinkAdd(url: string, cfg: Config): Promise<void> {
  const tier = Math.max(0, Math.min(3, Number(flag("--tier") ?? 0))) as Tier;
  const name = flag("--name") ?? (url === "stdout" ? "stdout" : url.startsWith("file:") ? "file" : new URL(url).host);
  // Control is not a property of a sink: it is set up per machine, with keys enrolled
  // at this terminal (spec/CONTROL.md §2, `sessionpipe control pair`). A sink never
  // carries `control: true`.
  if (has("--control"))
    out("  --control is ignored: control is set up per machine (`sessionpipe control pair <url>`, spec/CONTROL.md)");
  const s: SinkConfig = { name, url, tier, pii: has("--pii") };
  // Changing a sink's tier keeps the key it has (pairing may have handed it over, and
  // it may live in a keychain): only --token / --secret replace one.
  const prev = cfg.sinks.find((x) => x.name === name && x.url === url);
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
}
/** Read the receiver's well-known file onto the sink: its tier cap and endpoints. */
async function learnReceiver(s: SinkConfig, tier: Tier): Promise<void> {
  if (!/^https?:\/\//.test(s.url)) return;
  try {
    const r = await fetch(`${s.url.replace(/\/$/, "")}/.well-known/sessionpipe`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const wk = (await r.json()) as { max_tier?: number; endpoints?: { events?: string }; capabilities?: string[] };
    if (typeof wk.max_tier === "number") {
      s.max_tier = wk.max_tier as Tier;
      if (wk.max_tier < tier) out(`  receiver's max_tier is ${wk.max_tier}: sending tier ${wk.max_tier}, not ${tier}`);
    }
    if (wk.endpoints) (s as SinkConfig & { endpoints?: unknown }).endpoints = wk.endpoints;
    s.well_known_at = new Date().toISOString();
  } catch (e) {
    out(
      `  ! ${s.url} has no readable /.well-known/sessionpipe (${(e as Error).message}); added anyway, at tier ${tier}`,
    );
  }
}

const TIER_TEXT: Record<Tier, string> = {
  0: "session state and timing, machine, folder, repo, branch, model, title, link, the KIND of attention needed — no tool names, no words",
  1: "tier 0 + tool names, durations, ok/error, file paths, the attention message, subagents, compactions — no prompts",
  2: "tier 1 + your prompts and the assistant's text, secrets removed",
  3: "everything, including tool input and output",
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

function backfillRows(adapters: readonly (typeof ADAPTERS)[number][], days: number, cfg: Config): void {
  queueBackfill(collectRows(adapters, days), days, cfg);
}

function queueBackfill(rows: { harness: string; row: BackfillRow }[], days: number, cfg: Config): void {
  const outbox = new Outbox(state);
  let n = 0;
  const machine = machineName(cfg, os.hostname());
  for (const { harness, row } of rows) {
    const ref = { harness, session: row.session.id };
    const facts = factsState(state).get(harness, row.session.id);
    if (facts.backfilled) continue;
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
    factsState(state).save(harness, row.session.id, { backfilled: true });
    n++;
  }
  out(`  ✓ Backfill: ${n} session${n === 1 ? "" : "s"} from the last ${days} days queued as session.backfill`);
  void flush(state, cfg.sinks, outbox);
}

function backfill(): void {
  backfillRows(selectedAdapters(), Number(flag("--days") ?? 30), readConfig());
}

async function forget(): Promise<void> {
  const [, harness, session] = args;
  if (!harness || !session) return out("usage: sessionpipe forget <harness> <session>");
  const cfg = readConfig();
  const outbox = new Outbox(state);
  const ref = { harness, session };
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
    out(r.ok ? `  ✓ ${s.name}: asked to delete ${harness}:${session}` : `  ✗ ${s.name}: ${r.error ?? r.status}`);
  }
  outbox.delete(ref);
  out("  local outbox for the session removed");
}

async function replay(): Promise<void> {
  const name = flag("--sink");
  const cfg = readConfig();
  const sinks = name ? cfg.sinks.filter((s) => s.name === name) : cfg.sinks;
  if (!sinks.length) return out("  no such sink");
  for (const s of sinks) {
    if (has("--from-start")) new Cursors(state, s.name).write({});
  }
  const d = await flush(state, sinks, new Outbox(state));
  for (const [k, v] of Object.entries(d)) out(`  ${k}: ${v} event${v === 1 ? "" : "s"} delivered`);
}

function status(): void {
  const cfg = readConfig();
  const hc = hookCommand();
  const json = has("--json");
  const harnesses: Record<string, { file: string; state: string; note?: string }[]> = {};
  const sinks = [];
  if (!json) out(`  machine:  ${machineName(cfg, os.hostname())}   sessionpipe ${VERSION}   state ${tilde(state)}`);
  for (const a of ADAPTERS) {
    if (!a.detect() && !cfg.harnesses[a.name]) continue;
    const installed = a.installed(hc, process.env, { lean: isLean(cfg) });
    harnesses[a.name] = installed.map((r) => ({
      file: tilde(r.file),
      state: r.state,
      ...(r.note ? { note: r.note } : {}),
    }));
    if (!json)
      for (const r of installed)
        out(
          `  ${a.name.padEnd(12)} ${tilde(r.file).padEnd(44)} ${r.state}${r.state !== "current" && r.note ? ` — ${r.note}` : ""}`,
        );
  }
  if (!json && !cfg.sinks.length) out("  sinks:    none (events stay in the local outbox)");
  for (const s of cfg.sinks) {
    const c = new Cursors(state, s.name).read();
    const outbox = new Outbox(state);
    let pending = 0;
    for (const ref of outbox.sessions()) {
      const f = outbox.file(ref);
      try {
        pending += Math.max(0, statSync(f).size - (c[`${ref.harness}/${ref.session}`] ?? 0)) > 0 ? 1 : 0;
      } catch {}
    }
    sinks.push({
      name: s.name,
      url: s.url,
      tier: s.tier,
      max_tier: s.max_tier ?? null,
      pii: !!s.pii,
      control: !!s.control,
      paused: s.paused ?? null,
      pending_sessions: pending,
    });
    if (!json)
      out(
        `  sink      ${s.name.padEnd(16)} tier ${Math.min(s.tier, s.max_tier ?? 3)}  ${s.paused ? `PAUSED ${s.paused}` : pending ? `${pending} session file(s) with undelivered events` : "up to date"}`,
      );
  }
  const update = updateState(cfg);
  if (!json) out(`  update:   ${updateLine(update, Date.now())}`);
  const t = timing();
  if (!json && t)
    out(
      `  hook:     in-process p50 ${t.p50} ms over ${t.n} runs (\`sessionpipe doctor\` measures the wall clock the harness waits)`,
    );
  let jobs = 0;
  try {
    jobs = readdirSync(jobsDir(state)).filter((n) => n.endsWith(".json")).length;
  } catch {}
  if (json)
    out(
      JSON.stringify(
        {
          version: VERSION,
          machine: machineName(cfg, os.hostname()),
          state,
          config: configFile(),
          harnesses,
          sinks,
          timing: t,
          update,
          jobs,
        },
        null,
        2,
      ),
    );
  else if (jobs) out(`  jobs:     ${jobs} waiting`);
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
  const q = (p: number) => Math.round(times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? 0);
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
    const q = (p: number) => Math.round(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] ?? 0);
    return { n: ms.length, p50: q(0.5), p95: q(0.95) };
  } catch {
    return null;
  }
}

async function doctor(): Promise<void> {
  const cfg = readConfig();
  const hc = hookCommand();
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
    hook_wall_ms: hookWall(),
    update: updateState(cfg),
    warnings: [] as string[],
  };
  const warnings = report.warnings as string[];
  const upd = report.update as ReturnType<typeof updateState>;
  if (upd.failed)
    warnings.push(
      `the control daemon couldn't install sessionpipe ${upd.failed.version}: ${upd.failed.error}. It tries again tomorrow; \`sessionpipe update\` tries now.`,
    );
  if (usesLauncher()) {
    const l = launcherState(VERSION);
    report.launcher = { file: tilde(l.file), node: l.node, node_ok: l.nodeOk, version: l.version };
    if (Object.keys(cfg.harnesses).length) warnings.push(...l.problems);
  }
  // Where each key lives, and whether this session can read it.
  const keys: { what: string; where: string; readable: boolean }[] = [];
  for (const s of cfg.sinks)
    if (s.token_in || s.token || s.secret)
      keys.push({ what: `sink ${s.name}`, where: s.token_in ?? "file", readable: !!sinkWithSecrets(s) });
  const control = readControl();
  for (const r of control?.receivers ?? [])
    keys.push({ what: `control ${new URL(r.url).host}`, where: r.token_in ?? "file", readable: !!r.token });
  report.keys = keys;
  for (const k of keys)
    if (!k.readable)
      warnings.push(
        `${k.what}: its key is in ${storeLabel(k.where as StoreName)}, which this session can't read (locked, or an ssh shell). Events wait; the control daemon sends them from your own session.`,
      );
  // Each Claude Code account: a message's headless run needs its login.
  const claudeBin = claudeControl.findClaude();
  if (claudeBin) {
    const dirs = claudeDirs();
    const logins = await Promise.all(dirs.map((d) => claudeControl.claudeLogin(claudeBin, d)));
    report.claude_accounts = dirs.map((d, i) => ({ dir: tilde(d), signed_in: logins[i]?.loggedIn ?? null }));
    dirs.forEach((d, i) => {
      if (logins[i]?.loggedIn === false && control?.receivers.length)
        warnings.push(`Claude Code ${tilde(d)} isn't signed in from here: ${claudeControl.loginCommand(d)}`);
    });
  }
  // A systemd user service stops at logout unless the user lingers.
  if (process.platform === "linux" && control?.receivers.length) {
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
    if (linger === false)
      warnings.push(
        `the control daemon stops when you log out: \`loginctl enable-linger ${os.userInfo().username}\` (with sudo if refused) keeps it running`,
      );
  }
  if (/\/Cellar\/node(?:@\d+)?\/[^/]+\//.test(distDir))
    warnings.push(
      "sessionpipe is installed inside Homebrew's versioned node folder; `brew upgrade node` will delete it. Install with `npm install -g --prefix ~/.local sessionpipe`.",
    );
  for (const a of ADAPTERS) {
    if (!a.detect()) continue;
    const st = a.installed(hc, process.env, { lean: isLean(cfg) });
    (report.harnesses as Record<string, unknown>)[a.name] = st.map((r) => ({
      file: tilde(r.file),
      state: r.state,
      ...(r.note ? { note: r.note } : {}),
    }));
    for (const r of st)
      if (r.state === "inactive")
        warnings.push(`${a.name}: hooks are written but the harness will not run them — ${r.note ?? ""}`);
    for (const r of st)
      if (r.state === "stale")
        warnings.push(
          `${a.name}: the hook in ${tilde(r.file)} points at an old node or script path; run \`sessionpipe install\` again.`,
        );
    for (const r of st)
      if (r.state === "misplaced")
        warnings.push(
          `${a.name}: the notify line in ${tilde(r.file)} sits inside a [table], where Codex never reads it; run \`sessionpipe install\` again.`,
        );
  }
  for (const s of cfg.sinks)
    (report.sinks as unknown[]).push({
      name: s.name,
      url: s.url,
      tier: s.tier,
      max_tier: s.max_tier ?? null,
      pii: !!s.pii,
      control: !!s.control,
      paused: s.paused ?? null,
      token: s.token_in ? `in ${s.token_in}` : s.token ? `${s.token.slice(0, 4)}…` : null,
    });
  const w = report.hook_wall_ms as { p50: number; p95: number; n: number } | null;
  if (w && w.p50 > 150)
    warnings.push(
      `the harness waits ${w.p50} ms per hook (p50, target < 150): that is Node's own startup on this machine. A lean install (no sink above tier 0) hooks fewer events.`,
    );
  if (has("--json")) {
    out(JSON.stringify(report, null, 2));
    return;
  }
  out(`  sessionpipe ${VERSION} · node ${process.version} at ${report.node_path}`);
  out(`  config ${tilde(configFile())} · state ${tilde(state)}`);
  for (const [h, st] of Object.entries(report.harnesses as Record<string, { file: string; state: string }[]>))
    for (const r of st) out(`  ${h.padEnd(12)} ${r.file.padEnd(44)} ${r.state}`);
  for (const s of report.sinks as { name: string; tier: number; max_tier: number | null; paused: string | null }[])
    out(
      `  sink ${s.name.padEnd(16)} tier ${s.tier}${s.max_tier !== null ? ` (receiver max ${s.max_tier})` : ""}${s.paused ? ` PAUSED ${s.paused}` : ""}`,
    );
  const lr = report.launcher as { file: string; node: string | null; node_ok: boolean } | undefined;
  if (lr)
    out(`  hooks run ${lr.file} → node ${lr.node ? tilde(lr.node) : "?"}${lr.node_ok ? "" : " (gone: PATH's node)"}`);
  for (const k of keys)
    out(`  key  ${k.what.padEnd(28)} ${storeLabel(k.where as StoreName)}${k.readable ? "" : " (unreadable here)"}`);
  for (const a of (report.claude_accounts as { dir: string; signed_in: boolean | null }[] | undefined) ?? [])
    out(
      `  claude ${a.dir.padEnd(26)} ${a.signed_in === true ? "signed in" : a.signed_in === false ? "NOT signed in from here" : "can't tell"}`,
    );
  out(`  update ${updateLine(upd, Date.now())}`);
  const t = report.timing as { p50: number; p95: number; n: number } | null;
  out(
    w
      ? `  hook wall clock (what the harness waits): p50 ${w.p50} ms · p95 ${w.p95} ms over ${w.n} spawns`
      : "  hook wall clock: could not spawn dist/hook.js",
  );
  out(
    t
      ? `  hook in-process: p50 ${t.p50} ms · p95 ${t.p95} ms over the last ${t.n} runs`
      : "  hook in-process: no runs yet",
  );
  for (const w of warnings) out(`  ! ${w}`);
  if (!warnings.length) out("  no warnings");
}

/** Follow the local outbox: one event per line, filtered to a tier. The zero-server demo. */
async function tail(): Promise<void> {
  const tier = Math.max(0, Math.min(3, Number(flag("--tier") ?? 1))) as Tier;
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
        detail = d.prompt_chars !== undefined ? `prompt_chars=${d.prompt_chars}` : "";
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
  out(`sessionpipe tail · tier ${tier} · ${tilde(state)}/outbox (Ctrl-C to stop)`);
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

main().catch((e) => {
  process.stderr.write(`sessionpipe: ${(e as Error).message}\n`);
  process.exit(1);
});
