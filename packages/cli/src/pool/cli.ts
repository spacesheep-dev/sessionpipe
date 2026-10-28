// SPDX-License-Identifier: Apache-2.0
// `sessionpipe pool …` (DESIGN §2.2): the account pool at the terminal. While the
// control daemon runs it holds the pool's engine — the listener, the pins, the
// credentials in memory — so every request goes to it over the local socket
// (control/local.ts `pool`, same-user 0600) and the answer is the pool as the daemon
// now sees it. With no daemon running, the same request runs against the façade in
// this process (pool/index.ts), which writes pool.json and the secrets store; the
// daemon reads those when it starts. One owner of the state at a time, never two.
import { realpathSync } from "node:fs";
import path from "node:path";
import { stateDir, tilde } from "@sessionpipe/core";
import { ask, type LocalReply, type LocalRequest, socketPath } from "../control/local.js";
import { installService } from "../control/pair.js";
import { type Imported, type PoolOutcome, runPoolRequest } from "../control/pool.js";
import { stableNode } from "../runtime.js";
import { openPool, type Pool, type PoolStatus, summaryLine } from "./index.js";

export const POOL_HELP = `  sessionpipe pool [--json]                        (the accounts in order, the room each has left)
  sessionpipe pool on | off                        (point every Claude Code here at the pool, or stop)
  sessionpipe pool add --import | --login [--code -]
  sessionpipe pool remove|enable|disable <id|email> | order <id|email>… | refresh [<id|email>]`;

type PoolAsk = Extract<LocalRequest, { op: "pool" }>;

export interface PoolCliDeps {
  /** One request to the running daemon; null when none answers (control/local.ts). */
  ask: (req: PoolAsk, timeoutMs: number) => Promise<LocalReply | null>;
  /** The engine in this process, for when no daemon runs. */
  open: () => Pool;
  /** Write and start the daemon's service; what it did, in words (control/pair.ts). */
  installService: () => string;
  /** The pasted `code#state`, read without echo. */
  readSecret: () => Promise<string>;
  now: () => number;
}

/** Long enough for a vendor call (a sign-in exchange, a usage read for every account). */
const VENDOR_MS = 30_000;
const LOCAL_MS = 5_000;

const DAEMON_DOWN =
  "  ! the daemon isn't running, so Claude Code can't reach Claude while the pool is on: `sessionpipe control run` (or `sessionpipe pool on` again to install the service)";

/** The installed CLI by its real path, so the service outlives a reinstall's symlink. */
export function cliPath(distDir: string): string {
  const cli = path.join(distDir, "cli.js");
  try {
    return realpathSync(cli);
  } catch {
    return cli;
  }
}

/** A delivered answer, from either side. */
interface Done {
  daemon: boolean;
  status: PoolStatus;
  detail: string;
  imported?: Imported;
}

export async function poolMain(
  argv: string[],
  out: (s?: string) => void,
  distDir: string,
  over: Partial<PoolCliDeps> = {},
): Promise<void> {
  const deps: PoolCliDeps = {
    ask: (req, ms) => ask(socketPath(stateDir()), req, ms),
    open: () => openPool({}),
    // The same persistent paths `control pair` writes (control/cli.ts).
    installService: () => installService({ node: stableNode(process.execPath), cli: cliPath(distDir) }),
    readSecret,
    now: Date.now,
    ...over,
  };
  const sub = argv[1] && !argv[1].startsWith("--") ? argv[1] : "status";
  const rest = argv.slice(2).filter((a) => !a.startsWith("--"));
  const has = (f: string) => argv.includes(f);

  /** The daemon when it answers, else this process. A refusal or a failure ends the
   *  command the way every command fails: its detail on stderr, exit 1. */
  const request = async (req: Omit<PoolAsk, "op">, ms = LOCAL_MS): Promise<Done> => {
    const r = await deps.ask({ op: "pool", ...req }, ms);
    const o: PoolOutcome & { daemon: boolean } =
      r?.op === "pool"
        ? ({ ...r, daemon: true } as unknown as PoolOutcome & { daemon: boolean })
        : { ...(await runPoolRequest(deps.open(), req, { terminal: true })), daemon: false };
    if (o.outcome !== "delivered") throw new Error(o.detail);
    return o;
  };
  const daemonLine = (r: Done) => {
    if (r.daemon)
      out(
        `  daemon:   running${r.status.listening ? ` · listening on 127.0.0.1:${r.status.port}` : " · the pool's listener isn't up"}`,
      );
    else if (r.status.on) out(DAEMON_DOWN);
    else out("  daemon:   not running (nothing needs it while the pool is off)");
  };

  switch (sub) {
    case "status": {
      const r = await request({ action: "status" });
      if (has("--json")) return out(JSON.stringify({ ...r.status, daemon: r.daemon }, null, 2));
      return printStatus(r, out, deps.now());
    }
    case "on": {
      const r = await request({ action: "on" });
      for (const s of r.status.settings) out(`  ${s.state === "current" ? "✓" : "!"} ${settingsLine(s)}`);
      out("  New Claude Code sessions use the pool; running ones from their next start.");
      if (!r.status.accounts.length)
        out("  No accounts yet: `sessionpipe pool add --import` copies this machine's Claude Code logins.");
      if (r.daemon) out(`  Daemon: running${r.status.listening ? ` · listening on 127.0.0.1:${r.status.port}` : ""}`);
      else out(`  Daemon: ${deps.installService()}`);
      return out(`  pool:     ${summaryLine(r.status)}`);
    }
    case "off": {
      const r = await request({ action: "off" });
      for (const s of r.status.settings)
        out(s.state === "missing" ? `  ✓ ${tilde(s.file)}: the pool's env block is gone` : `  ! ${settingsLine(s)}`);
      out("  Claude Code talks to Claude directly from its next start; the accounts stay pooled.");
      return out(`  pool:     ${summaryLine(r.status)}`);
    }
    case "add": {
      if (has("--import")) {
        const r = await request({ action: "import" }, VENDOR_MS);
        const got = r.imported as Imported;
        for (const a of got.added) out(`  ✓ added ${who(a.account)} from ${tilde(a.dir)}`);
        for (const s of got.skipped) out(`  · ${tilde(s.dir)}${s.email ? ` (${s.email})` : ""}: ${s.why}`);
        if (!got.added.length && !got.skipped.length) out("  no Claude Code login found on this machine");
        out(`  pool:     ${summaryLine(r.status)}`);
        return daemonLine(r);
      }
      if (has("--login")) {
        if (has("--code")) {
          const pending = (await request({ action: "status" })).status.pending;
          if (!pending) throw new Error("no sign-in is pending; run `sessionpipe pool add --login` first");
          const code = (await deps.readSecret()).trim();
          if (!code) throw new Error("no code was pasted");
          const r = await request({ action: "login.complete", account: pending.id, code }, VENDOR_MS);
          const added = r.status.accounts.at(-1);
          out(`  ✓ signed in ${added ? who(added) : "an account"}`);
          out(`  pool:     ${summaryLine(r.status)}`);
          return daemonLine(r);
        }
        const r = await request({ action: "login.begin" });
        const url = r.detail.slice(r.detail.indexOf(" ") + 1);
        out("  Open this in a browser, sign in to the account to add, and copy the code it shows:");
        out(`  ${url}`);
        out("  Then, within 10 minutes, paste it to:  sessionpipe pool add --login --code -");
        return;
      }
      throw new Error(
        "pool add takes --import (this machine's Claude Code logins) or --login (sign in to another account)",
      );
    }
    case "remove":
    case "enable":
    case "disable": {
      if (!rest[0]) throw new Error(`pool ${sub} takes an account id or email (\`sessionpipe pool\` lists them)`);
      const r = await request({ action: sub, account: rest[0] });
      out(`  ✓ ${sub === "remove" ? "removed" : sub === "enable" ? "enabled" : "disabled"} ${rest[0]}`);
      return out(`  pool:     ${summaryLine(r.status)}`);
    }
    case "order": {
      if (!rest.length) throw new Error("pool order takes every account, in the order wanted");
      const r = await request({ action: "order", order: rest });
      r.status.accounts.forEach((a, i) => {
        out(`  ${i + 1}. ${who(a)}`);
      });
      return out(`  pool:     ${summaryLine(r.status)}`);
    }
    case "refresh": {
      const r = await request({ action: "refresh", ...(rest[0] ? { account: rest[0] } : {}) }, VENDOR_MS);
      return printStatus(r, out, deps.now());
    }
    default:
      return out(POOL_HELP);
  }
}

/** `pool off` for `sessionpipe uninstall` (DESIGN §2.4): nothing to say when the pool
 *  was never on; otherwise the same lines `pool off` prints. */
export async function poolOffForUninstall(out: (s?: string) => void, over: Partial<PoolCliDeps> = {}): Promise<void> {
  const open = over.open ?? (() => openPool({}));
  if (!open().config.on) return;
  await poolMain(["pool", "off"], out, "", { ...over, open });
}

const who = (a: { label?: string; email: string; id: string }) =>
  `${a.label ? `${a.label} <${a.email}>` : a.email} (${a.id})`;

const settingsLine = (s: PoolStatus["settings"][number]) =>
  `${tilde(s.file)}: ${
    s.state === "current"
      ? "env block written (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and two Claude Code flags)"
      : s.state === "missing"
        ? "no env block"
        : s.state === "stale"
          ? "an older block of ours; `pool on` rewrites it"
          : s.state === "other"
            ? `left alone — ${s.note}`
            : `not touched — ${s.note}`
  }`;

/** A reset time as a clock reading today, else a date. */
function when(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The status word of an account, in the words the GUI uses too. */
function word(a: PoolStatus["accounts"][number], now: number): string {
  switch (a.status) {
    case "ready":
      return a.current ? "serving now" : "has room";
    case "limited":
      return `none left${a.until ? ` until ${when(a.until, now)}` : ""}`;
    case "error":
      return "sign in again";
    default:
      return "off";
  }
}

function printStatus(r: Done, out: (s?: string) => void, now: number): void {
  const s = r.status;
  out(`  pool:     ${summaryLine(s)}`);
  if (r.daemon)
    out(
      `  daemon:   running${s.listening ? ` · listening on 127.0.0.1:${s.port}` : " · the pool's listener isn't up"}`,
    );
  else if (s.on) out(DAEMON_DOWN);
  else out("  daemon:   not running (nothing needs it while the pool is off)");
  for (const a of s.accounts) {
    const w = (id: string) => a.windows?.find((x) => x.id === id);
    const win = (id: string, label: string, width: number) => {
      const x = w(id);
      if (!x) return `${label} —`.padEnd(width);
      const reset = when(x.resets_at, now);
      return `${label} ${String(x.used_percent).padStart(3)}%${reset ? ` (resets ${reset})` : ""}`.padEnd(width);
    };
    out(
      `  ${a.id.padEnd(9)} ${(a.label ? `${a.label} <${a.email}>` : a.email).padEnd(36)} ${(a.enabled ? "enabled" : "disabled").padEnd(9)} ${win("five_hour", "5h", 24)} ${win("seven_day", "7d", 30)} ${word(a, now)}`,
    );
  }
  if (!s.accounts.length) out("  no accounts: `sessionpipe pool add --import` or `sessionpipe pool add --login`");
  for (const f of s.settings) out(`  settings  ${tilde(f.file).padEnd(44)} ${f.state}${f.note ? ` — ${f.note}` : ""}`);
  if (s.pending)
    out(
      `  sign-in pending until ${when(s.pending.expires_at, now)}: paste the code to \`sessionpipe pool add --login --code -\``,
    );
}

/** A terminal's input, as far as reading one secret line needs. */
export interface SecretInput {
  isTTY?: boolean;
  setEncoding(enc: BufferEncoding): unknown;
  on(event: "data" | "end", cb: (d: string) => void): unknown;
  off(event: "data", cb: (d: string) => void): unknown;
  setRawMode?(on: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** The code, pasted: everything from a pipe, or one line typed at the terminal with
 *  echo off (raw mode; backspace edits, Ctrl-C leaves). Never an argument: a command
 *  line is in the shell's history and in `ps`. */
export function readSecret(
  stdin: SecretInput = process.stdin,
  err: (s: string) => void = (s) => void process.stderr.write(s),
  exit: (code: number) => void = (c) => process.exit(c),
): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    if (!stdin.isTTY) {
      stdin.setEncoding("utf8");
      stdin.on("data", (d: string) => {
        buf += d;
      });
      stdin.on("end", () => resolve(buf));
      return;
    }
    err("Code: ");
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (d: string) => {
      for (const ch of d) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          err("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") return exit(130);
        if (ch === "\u007f") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}
