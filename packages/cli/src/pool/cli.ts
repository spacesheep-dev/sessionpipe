// SPDX-License-Identifier: Apache-2.0
// `sessionpipe pool …` (DESIGN §2.2): the account pool at the terminal. While the
// control daemon runs it holds the pool's engine — the listener, the pins, the
// credentials in memory — so every request goes to it over the local socket
// (control/local.ts `pool`, same-user 0600) and the answer is the pool as the daemon
// now sees it. With no daemon running, the same request runs against the façade in
// this process (pool/index.ts), which writes pool.json and the secrets store; the
// daemon reads those when it starts. One owner of the state at a time, never two.
import { stateDir, tilde } from "@sessionpipe/core";
import { ask, type LocalReply, type LocalRequest, socketPath } from "../control/local.js";
import { installService } from "../control/pair.js";
import { type Imported, type PoolOutcome, runPoolRequest } from "../control/pool.js";
import { Refusal } from "../refusal.js";
import { cliPath, stableNode } from "../runtime.js";
import { PLAIN, type Ui } from "../style.js";
import { openPool, type Pool, type PoolStatus, summaryLine } from "./index.js";
import { SIGN_IN } from "./server.js";

export const POOL_HELP = `  sessionpipe pool [--json]                        (the accounts in order, the room each has left)
  sessionpipe pool on | off                        (point every Claude Code here at the pool, or stop)
  sessionpipe pool login                           (sign in again to every account that needs it, or to a new one)
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
  /** A person is at this terminal to paste a code (stdin is one). */
  interactive: () => boolean;
  now: () => number;
}

/** Long enough for a vendor call (a sign-in exchange, a usage read for every account). */
const VENDOR_MS = 30_000;
const LOCAL_MS = 5_000;

const DAEMON_DOWN =
  "  ! the daemon isn't running, so Claude Code can't reach Claude while the pool is on: `sessionpipe control run` (or `sessionpipe pool on` again to install the service)";

export { cliPath } from "../runtime.js";

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
  ui: Ui = PLAIN,
): Promise<void> {
  const deps: PoolCliDeps = {
    ask: (req, ms) => ask(socketPath(stateDir()), req, ms),
    open: () => openPool({}),
    // The same persistent paths `control pair` writes (control/cli.ts).
    installService: () => installService({ node: stableNode(process.execPath), cli: cliPath(distDir) }),
    readSecret,
    interactive: () => !!process.stdin.isTTY,
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
    if (r.daemon) out(`  daemon:   running${listenerWord(r.status)}`);
    else if (r.status.on) out(DAEMON_DOWN);
    else out("  daemon:   not running (nothing needs it while the pool is off)");
  };

  /** A sign-in begun: the id it is held under and the page to open. */
  const begin = async (): Promise<{ id: string; url: string }> => {
    const { detail } = await request({ action: "login.begin" });
    const at = detail.indexOf(" ");
    return { id: detail.slice(0, at), url: detail.slice(at + 1) };
  };
  const signedOut = (s: PoolStatus) => s.accounts.filter((a) => a.status === "error");
  /** The account a sign-in was for: the one no longer in error, else the one that is new. */
  const signedIn = (before: PoolStatus, after: PoolStatus) =>
    signedOut(before).find((a) => !signedOut(after).some((b) => b.id === a.id)) ??
    after.accounts.find((a) => !before.accounts.some((b) => b.id === a.id));

  switch (sub) {
    // One command for what used to be two an account: every account that needs signing in
    // again, one after another (the page to open, the code pasted here), or with none that
    // needs it, a new account. Which account a sign-in is for is the person's choice in
    // the browser, so each is named before its page, and one chosen wrongly is said.
    case "login": {
      let r = await request({ action: "status" });
      if (!deps.interactive())
        throw new Refusal(
          "signing in needs a terminal to paste the code at; without one it is two steps: `sessionpipe pool add --login`, then the code to `sessionpipe pool add --login --code -`",
          "sessionpipe pool add --login",
        );
      let left = signedOut(r.status);
      // A person who chooses the wrong account in the browser gets two more goes.
      for (let goes = left.length + 2; goes > 0; goes--) {
        out(
          left.length
            ? `  Sign in again to ${who(left[0] as (typeof left)[number])}${left.length > 1 ? ` (${left.length} accounts need it)` : ""}.`
            : "  Sign in to the Claude account to add.",
        );
        const { id, url } = await begin();
        out(
          `  Open this in a browser, choose ${left.length ? "that account" : "the account"}, and copy the code it shows:`,
        );
        out(`  ${url}`);
        const code = (await deps.readSecret()).trim();
        if (!code) {
          out("  · no code pasted: stopped here");
          break;
        }
        // Read again here: minutes went by in the browser, and what changed in them is
        // not this sign-in's doing.
        const before = (await request({ action: "status" })).status;
        r = await request({ action: "login.complete", account: id, code }, VENDOR_MS);
        const got = signedIn(before, r.status);
        const added = !!got && !before.accounts.some((a) => a.id === got.id);
        out(
          `  ✓ signed in ${got ? who(got) : "an account"}${
            added && left.length
              ? `, which is new to the pool (\`sessionpipe pool remove ${got.id}\` takes it out again)`
              : ""
          }`,
        );
        const still = signedOut(r.status);
        const asked = left[0];
        if (asked && still.some((a) => a.id === asked.id))
          out(`  · that was another account: ${who(asked)} still needs signing in`);
        left = still;
        if (!left.length) break;
      }
      out(`  pool:     ${summaryLine(r.status)}`);
      if (left.length) out(`  ! still to sign in again: ${left.map(who).join(", ")}. Run \`${SIGN_IN}\` again`);
      return daemonLine(r);
    }
    case "status": {
      const r = await request({ action: "status" });
      if (has("--json")) return out(JSON.stringify({ ...r.status, daemon: r.daemon }, null, 2));
      return printStatus(r, out, deps.now(), ui);
    }
    case "on": {
      const r = await request({ action: "on" });
      for (const s of r.status.settings) out(`  ${s.state === "current" ? "✓" : "!"} ${settingsLine(s)}`);
      out("  New Claude Code sessions use the pool with the new token; running ones keep working for 10 minutes.");
      if (!r.status.accounts.length)
        out("  No accounts yet: `sessionpipe pool add --import` copies this machine's Claude Code logins.");
      if (r.daemon)
        out(
          `  Background service: running${r.status.listening || r.status.another_daemon ? listenerWord(r.status) : ""}`,
        );
      else out(`  Background service: ${deps.installService()}`);
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
          const before = (await request({ action: "status" })).status;
          const pending = before.pending;
          if (!pending)
            throw new Refusal(
              "no sign-in is pending; run `sessionpipe pool add --login` first",
              "sessionpipe pool add --login",
            );
          const code = (await deps.readSecret()).trim();
          if (!code) throw new Error("no code was pasted");
          const r = await request({ action: "login.complete", account: pending.id, code }, VENDOR_MS);
          const added = signedIn(before, r.status);
          out(`  ✓ signed in ${added ? who(added) : "an account"}`);
          out(`  pool:     ${summaryLine(r.status)}`);
          return daemonLine(r);
        }
        const { url } = await begin();
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
      if (!rest[0])
        throw new Refusal(
          `pool ${sub} takes an account id or email (\`sessionpipe pool\` lists them)`,
          "sessionpipe pool",
        );
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
      return printStatus(r, out, deps.now(), ui);
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
      ? "env block written (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and the flag that keeps its first-party features on)"
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

/** What the daemon that answered says about the listener. */
const listenerWord = (s: PoolStatus): string =>
  s.another_daemon
    ? ` · another daemon serves the pool on 127.0.0.1:${s.port}`
    : s.listening
      ? ` · listening on 127.0.0.1:${s.port}`
      : " · the pool's listener isn't up";

function printStatus(r: Done, out: (s?: string) => void, now: number, ui: Ui): void {
  const s = r.status;
  out(`  pool:     ${summaryLine(s)}`);
  if (r.daemon) out(`  daemon:   running${listenerWord(s)}`);
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
    // One line per account is over a hundred columns: a terminal gets two, the windows
    // under the name. A pipe keeps the one line it always had.
    const name = a.label ? `${a.label} <${a.email}>` : a.email;
    if (ui.width === Number.POSITIVE_INFINITY)
      out(
        `  ${a.id.padEnd(9)} ${name.padEnd(36)} ${(a.enabled ? "enabled" : "disabled").padEnd(9)} ${win("five_hour", "5h", 24)} ${win("seven_day", "7d", 30)} ${word(a, now)}`,
      );
    else {
      out(`  ${a.id.padEnd(9)} ${name} · ${a.enabled ? "enabled" : "disabled"} · ${word(a, now)}`);
      out(`  ${" ".repeat(9)} ${win("five_hour", "5h", 0)} · ${win("seven_day", "7d", 0)}`);
    }
  }
  if (!s.accounts.length) out("  no accounts: `sessionpipe pool add --import` or `sessionpipe pool login`");
  // What to do about "sign in again", and what it costs until it is done: the status
  // word alone left a person to work out the command, and that Claude Code was being
  // refused because of it.
  const signedOut = s.accounts.filter((a) => a.status === "error").length;
  // Refused for good only when nobody else will serve: an account at its limit comes back.
  const nobodyElse = s.accounts.every((a) => a.status === "error" || a.status === "disabled");
  if (signedOut)
    out(
      `  ! ${signedOut === 1 ? "1 account needs" : `${signedOut} accounts need`} signing in again: \`${SIGN_IN}\`${
        s.on && nobodyElse ? ". Until then Claude Code here is refused" : ""
      }`,
    );
  if (s.unsaved)
    out(
      `  ! ${s.unsaved === 1 ? "1 refreshed sign-in is" : `${s.unsaved} refreshed sign-ins are`} not in the secrets store yet (it refused the write, as a locked keychain does): kept in memory and offered again; a restart before then signs ${s.unsaved === 1 ? "that account" : "those accounts"} out`,
    );
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
