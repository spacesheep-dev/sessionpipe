// SPDX-License-Identifier: Apache-2.0
// `sessionpipe control pair <receiver>`: a key enters this machine's trust store only
// from this terminal (spec/CONTROL.md §2). The receiver hands back a passkey and a
// proof over sha256("sessionpipe.pair:<machine>:<code>"); the key is trusted only once
// the proof verifies here. Also the service files (launchd / systemd) that keep the
// daemon running, and `control off`.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import {
  acpControl,
  claudeAccounts,
  claudeControl,
  claudeDirs,
  drivableHarnesses,
  type HarnessAccount,
  HELLO_HARNESSES_MAX,
} from "@sessionpipe/core";
import { KEY_TYPES, type TrustedKey, verifyEnrollment } from "@sessionpipe/core/control";
import type { Exec } from "@sessionpipe/core/service";
import * as core from "@sessionpipe/core/service";
import { Refusal } from "../refusal.js";
import { shq } from "../shell.js";
import { clean, PLAIN, tint, type Ui } from "../style.js";
import { SERVICE_LABEL as LABEL, serviceNames, SERVICE_UNIT as UNIT } from "./health.js";
import {
  askOn,
  type ControlConfig,
  type ControlMode,
  controlState,
  dropControlSecret,
  type PairedReceiver,
  readControl,
  writeControl,
} from "./store.js";

declare const __SESSIONPIPE_VERSION__: string;
const VERSION = typeof __SESSIONPIPE_VERSION__ === "string" ? __SESSIONPIPE_VERSION__ : "0.0.0";

export interface PairOptions {
  url: string;
  /** The person's sink token for this receiver (from `sink add`, or --token). Null:
   *  open pairing, where the receiver offers it — the person approves a link and that
   *  is the whole setup (CONTROL.md §2). */
  token: string | null;
  folders: string[];
  mode: ControlMode;
  name: string;
  out: (s: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  /** Called with a sessions key the receiver handed over at pairing. */
  addSink?: (token: string) => void;
  /** The harnesses this machine can run a message in (default: those installed here). */
  harnesses?: string[];
  /** The harness accounts signed in here (default: every Claude Code config dir's). */
  accounts?: HarnessAccount[];
  /** How long expired codes are renewed for (default RENEW_FOR_MS). */
  renewFor?: number;
  /** Where the lines go. At a terminal the link and the digits stand each on a line of
   *  their own; left out, or a pipe, the lines are the ones programs have always read. */
  ui?: Ui;
  /** Writes a line already set for that terminal, colour and all (the link, the
   *  digits). Left out: `out`. */
  say?: (s: string) => void;
}

/** How long `control pair` keeps asking for fresh codes when nobody approves one. */
export const RENEW_FOR_MS = 60 * 60_000;

async function json(r: Response): Promise<Record<string, unknown>> {
  try {
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function discover(
  url: string,
  f: typeof fetch,
): Promise<{ control: string; rpId: string; open: boolean; inherit: boolean; events: string | null }> {
  const base = url.replace(/\/$/, "");
  const r = await f(`${base}/.well-known/sessionpipe`);
  if (!r.ok) throw new Error(`${base} has no sessionpipe well-known file (HTTP ${r.status})`);
  const wk = (await r.json()) as {
    capabilities?: string[];
    endpoints?: { control?: string; events?: string };
    control?: { signing?: { rp_id?: string }; open_pairing?: boolean; inherit?: boolean };
  };
  if (!wk.capabilities?.includes("control") || !wk.endpoints?.control || !wk.control?.signing?.rp_id)
    throw new Error(`${base} doesn't serve control yet (its well-known file lists no control.signing)`);
  const abs = (ep: string) => (/^https?:\/\//.test(ep) ? ep : base + ep);
  return {
    control: abs(wk.endpoints.control),
    rpId: wk.control.signing.rp_id,
    open: wk.control.open_pairing === true,
    inherit: wk.control.inherit === true,
    events: wk.endpoints.events ? abs(wk.endpoints.events) : null,
  };
}

/** Why a machine won't run in inherit mode with this receiver (CONTROL.md §2): a
 *  receiver that doesn't know the mode would show the machine as safe. */
export const inheritRefused = (url: string) =>
  `${url} doesn't know inherit mode yet; it would show this machine as safe while the sessions you message run with no permission flag`;

/** The paired receivers that don't say they show inherit mode (`control.inherit` in
 *  their well-known file), with why. A receiver that can't be read counts as one. */
export async function withoutInherit(urls: string[], f: typeof fetch = fetch): Promise<string[]> {
  const out: string[] = [];
  for (const url of urls) {
    try {
      if (!(await discover(url, f)).inherit) out.push(inheritRefused(url));
    } catch (e) {
      out.push(`couldn't check that ${url} knows inherit mode (${(e as Error).message})`);
    }
  }
  return out;
}

/** Pair (or add a key to) this machine with one receiver. Returns the saved config. */
export async function pair(o: PairOptions): Promise<ControlConfig> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { control, rpId, open, inherit } = await discover(o.url, f);
  if (o.mode === "inherit" && !inherit)
    throw new Refusal(
      `${inheritRefused(o.url)}. Pair with --mode safe or --mode auto (\`sessionpipe control mode safe\` first, if this machine is in inherit already).`,
      `sessionpipe control pair ${shq(o.url)} --mode safe`,
    );
  if (!o.token && !open)
    throw new Error(
      `${o.url} needs a key to pair: add it as a sink first (\`sessionpipe sink add ${o.url} --token …\`) or pass --token.`,
    );
  // Open pairing: a secret only this terminal knows. The receiver keeps its hash, and
  // the status poll that hands over the machine's token must present it — so the link,
  // which the person opens elsewhere, is not a credential by itself.
  const pollKey = o.token ? null : randomBytes(32).toString("base64url");
  const cfg: ControlConfig = readControl(o.env) ?? { name: o.name, folders: [], mode: o.mode, receivers: [] };
  cfg.name = o.name || cfg.name;
  cfg.mode = o.mode;
  cfg.folders = [...new Set([...cfg.folders, ...o.folders.map((d) => path.resolve(d))])];
  const existing = cfg.receivers.find((r) => r.control === control);
  let accounts = o.accounts;
  if (!accounts)
    try {
      const e = o.env ?? process.env;
      accounts = claudeAccounts(claudeDirs(e), e.HOME);
    } catch {
      accounts = [];
    }
  const auth = { authorization: `Bearer ${o.token ?? pollKey}`, "content-type": "application/json" };
  const harnesses = (o.harnesses ?? drivableHarnesses(o.env ?? process.env)).slice(0, HELLO_HARNESSES_MAX);
  const hello = {
    ...(pollKey ? { poll_key: pollKey } : {}),
    name: cfg.name,
    harnesses,
    // Every ACP agent's turn is acked `api` (CONTROL.md §6).
    modes: ["waiter", "turn", "resume", "fork", ...(harnesses.some((h) => acpControl.acpAgent(h)) ? ["api"] : [])],
    version: VERSION,
    folders: cfg.folders,
    mode: cfg.mode,
    ...(accounts.length ? { accounts } : {}),
    // This daemon takes `files` on a start (an older one would start without them).
    files: true,
    // And device keys (CONTROL.md §2): an app offers one only to a machine that says so.
    key_types: [...KEY_TYPES],
    // Whether sessions here may ask another agent (§13), and that a start or a prompt
    // may carry `reply_to` (§6, Handoff): a receiver offers a handoff only where it may.
    ask: askOn(cfg),
    handoff: true,
  };
  /** One pairing code from the receiver. `machine` names the row a previous code
   *  made, so a renewal adds no second machine. */
  const start = async (machine: string | undefined) => {
    const started = await f(`${control}/pair`, {
      method: "POST",
      headers: o.token ? auth : { "content-type": "application/json" },
      body: JSON.stringify({ ...hello, ...(machine ? { machine } : {}) }),
    });
    const s = await json(started);
    if (started.status !== 201 && started.status !== 200)
      throw new Error(
        `the receiver refused to start pairing (HTTP ${started.status}${s.reason ? `: ${String(s.reason)}` : ""})`,
      );
    return {
      machine: String(s.machine),
      code: String(s.code),
      url: String(s.url),
      check: String(s.check),
      until: Date.parse(String(s.expires_at)) || Date.now() + 10 * 60_000,
    };
  };
  const host = new URL(o.url).host;
  const ui = o.ui ?? PLAIN;
  const say = o.say ?? o.out;
  /** The same command again, for this receiver: what to run when a pairing came to nothing. */
  const again = `sessionpipe control pair ${shq(o.url)}`;
  const announce = (p: { url: string; check: string; until: number }) => {
    const spaced = /^\d{6}$/.test(p.check) ? `${p.check.slice(0, 3)} ${p.check.slice(3)}` : p.check;
    const mins = Math.max(1, Math.round((p.until - Date.now()) / 60_000));
    const good = `  This code is good for ${mins} minute${mins === 1 ? "" : "s"}; if it runs out, a fresh one appears here.`;
    o.out("");
    // The approval happens on whatever device holds the person's passkey, which is
    // rarely the machine being paired (a server may have no screen at all): say so, or
    // the "Touch ID" line reads as "do it here" (2026-10-02, four machines, one headless).
    if (!ui.tty) {
      // Not a terminal: a program started this and reads these lines, so they stay as
      // they have always been, to the byte. sessionpipe-gui's setup page takes the link
      // from the line that holds it and the digits from "digits too: 123456" or
      // "enter:  123 456" (its server/setup/pairer.ts). control-pair.test.ts pins them.
      o.out(`  On any phone or computer where you're signed in to ${host} (it doesn't have to be this one),`);
      if (pollKey) {
        o.out(`  open ${p.url} and enter:  ${spaced}`);
        o.out("  then approve with that device's passkey (Touch ID, Face ID, a security key).");
        o.out("  Pairing several machines? Run this on each one: every machine shows its own digits.");
      } else {
        o.out("  open this link and approve with that device's passkey (Touch ID, Face ID, a security key):");
        o.out(`    ${p.url}`);
        o.out(`  The page shows these digits too: ${p.check}`);
      }
      o.out(good);
      o.out("");
      return;
    }
    o.out(`  On any phone or computer where you're signed in to ${host} (it doesn't have to be this one):`);
    o.out("");
    // The two things a person needs, each alone on its line: the link, and the digits.
    // Both are the receiver's words, so they are cleaned before they are coloured.
    say(`      open:   ${tint(ui, "cyan", clean(p.url))}`);
    if (pollKey) {
      // Open pairing: one address for everyone, and the digits are what the person types.
      say(`      enter:  ${tint(ui, "bold", clean(spaced))}`);
      o.out("");
      o.out("  Then approve with that device's passkey (Touch ID, Face ID, a security key).");
      o.out("  Pairing several computers? Run this on each one: every one shows its own digits.");
    } else {
      say(`      check:  ${tint(ui, "bold", clean(spaced))}   (the page shows these digits too)`);
      o.out("");
      o.out("  Then approve with that device's passkey (Touch ID, Face ID, a security key).");
    }
    o.out(good);
    o.out("");
  };
  // A code lives ten minutes on the receiver. A person approving three headless
  // machines from a phone ran out of them (2026-10-08). A code nobody approved in time
  // is renewed from this terminal, with fresh digits, for up to RENEW_FOR_MS: the old
  // code is dead on the receiver, so no code lives longer than it did.
  const renewUntil = Date.now() + (o.renewFor ?? RENEW_FOR_MS);
  let cur = await start(existing?.machine);
  announce(cur);
  for (;;) {
    await sleep(2000);
    let p: Record<string, unknown> = {};
    let expired = Date.now() > cur.until;
    if (!expired) {
      const r = await f(`${control}/pair?code=${encodeURIComponent(cur.code)}`, { headers: auth }).catch(() => null);
      if (!r) continue;
      if (r.status === 404)
        throw new Refusal("the receiver lost the pairing; run `sessionpipe control pair` again", again);
      p = await json(r);
      if (p.status === "expired") expired = true;
      else if (p.status !== "paired") continue;
    }
    if (expired) {
      if (Date.now() >= renewUntil)
        throw new Refusal("the pairing link expired; run `sessionpipe control pair` again", again);
      // A keyed pairing keeps the machine row its first code made; an open one starts
      // clean under the same poll key (the receiver names the machine at approval).
      cur = await start(o.token ? cur.machine : existing?.machine);
      o.out("  Nobody approved that code before it expired. Here is a fresh one; the old digits no longer work.");
      announce(cur);
      continue;
    }
    const { machine, code } = cur;
    const key = p.key as TrustedKey;
    const proof = p.proof as { cred: string; ad: string; cd: string; sig: string } | { cred: string; sig: string };
    const v = await verifyEnrollment({ machine, code, key, proof, rpId });
    if (!v.ok) throw new Error(`the receiver's key didn't prove itself (${v.why}); nothing was trusted`);
    const token = existing?.token || (typeof p.token === "string" ? p.token : "");
    if (!token) throw new Error("the receiver didn't hand this machine its token");
    const rec: PairedReceiver = existing ?? {
      url: o.url.replace(/\/$/, ""),
      control,
      rpId,
      machine,
      token,
      keys: [],
      paired_at: new Date().toISOString(),
    };
    if (!rec.keys.some((k) => k.id === key.id)) rec.keys.push({ ...key, added_at: new Date().toISOString() });
    if (!existing) cfg.receivers.push(rec);
    writeControl(cfg, o.env);
    // The receiver named the machine, and names who approved: its words, on one line each.
    o.out(`  ✓ Paired with ${rec.url} as ${clean(machine)} · ${rec.keys.length} key(s) trusted on this machine`);
    // Say so when the approving key is an app's device key rather than a passkey.
    if (key.type === "device") o.out("  It approved with an app's device key: held in hardware, verified each use.");
    const named = accounts.flatMap((a) => (a.email ? [a.email] : a.name ? [a.name] : []));
    if (named.length)
      o.out(`  Its session board names your Claude Code account${named.length > 1 ? "s" : ""}: ${named.join(", ")}`);
    // Whose passkey this machine now trusts: with open pairing, whoever approved the link.
    if (typeof p.account === "string")
      o.out(`  Approved by ${clean(p.account)}. If that isn't you, run \`sessionpipe control off\` now.`);
    // The receiver may hand over a sessions-only key for the events lane, so its session
    // board shows this machine without a second step.
    if (typeof p.sink_token === "string" && o.addSink) o.addSink(p.sink_token);
    return cfg;
  }
}

/** `control off [<receiver>]`: tell the receiver, forget its token and keys. */
export async function off(o: {
  url?: string;
  out: (s: string) => void;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}) {
  const f = o.fetch ?? fetch;
  const cfg = readControl(o.env);
  if (!cfg) return o.out("  control isn't set up on this machine");
  const gone = cfg.receivers.filter((r) => !o.url || r.url === o.url.replace(/\/$/, ""));
  for (const r of gone) {
    await f(`${r.control}/off`, { method: "POST", headers: { authorization: `Bearer ${r.token}` } }).catch(() => null);
    dropControlSecret(r);
    o.out(`  removed ${r.url} (${r.machine}, ${r.keys.length} key(s))`);
  }
  cfg.receivers = cfg.receivers.filter((r) => !gone.includes(r));
  writeControl(cfg, o.env);
  return cfg;
}

export function removeKey(id: string, env?: NodeJS.ProcessEnv): number {
  const cfg = readControl(env);
  if (!cfg) return 0;
  let n = 0;
  for (const r of cfg.receivers) {
    const before = r.keys.length;
    r.keys = r.keys.filter((k) => k.id !== id && !k.id.startsWith(id));
    n += before - r.keys.length;
  }
  writeControl(cfg, env);
  return n;
}

// --- the service -------------------------------------------------------------------
// The launchd agent and the systemd user unit are core's (sessionpipe-core/service);
// this is the daemon's: its label, its command line, and what to tell the person.

const DESCRIPTION = "sessionpipe control daemon (signed messages to your coding sessions)";

export { type Exec, ensureLinger } from "@sessionpipe/core/service";

/** The daemon's service: `<node> <cli> control run`, logging to the state dir. Both files
 *  restart it when it exits non-zero; an update exits UPDATE_EXIT (75) to come back on
 *  the new code. SESSIONPIPE_SERVICE tells the daemon which manager that is. */
const spec = (o: {
  node: string;
  cli: string;
  logDir: string;
  home?: string;
  env?: Record<string, string>;
  names?: { label: string; unit: string };
}) => ({
  label: o.names?.label ?? LABEL,
  unit: o.names?.unit ?? UNIT,
  description: DESCRIPTION,
  argv: [o.node, o.cli, "control", "run"],
  logPath: path.join(o.logDir, "daemon.log"),
  ...(o.home ? { home: o.home } : {}),
  ...(o.env ? { env: o.env } : {}),
});

/** What the service file carries beside SESSIONPIPE_SERVICE: the PATH of the shell that
 *  paired (launchd's and systemd's own is a bare /usr/bin:/bin, where a `claude` under nvm
 *  or Homebrew is not), and the `claude` that shell could see, pinned for the daemon as
 *  SESSIONPIPE_CLAUDE (a path that stops existing is skipped and looked for again). */
export function serviceEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  // A sessionpipe with a service of its own (SESSIONPIPE_SERVICE_LABEL: a throwaway
  // world) gives that service the same world: where its files are, whose home it is and
  // which registry npm asks. Without this the service would come up in this computer's
  // real home, beside the real one.
  if (env.SESSIONPIPE_SERVICE_LABEL)
    for (const [k, v] of Object.entries(env)) if (v !== undefined && WORLD.test(k)) out[k] = v;
  if (env.PATH) out.PATH = env.PATH;
  const claude = claudeControl.findClaude(env);
  if (claude) out.SESSIONPIPE_CLAUDE = claude;
  return out;
}
const WORLD =
  /^(SESSIONPIPE_.+|HOME|USERPROFILE|XDG_[A-Z]+_HOME|CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME|GROK_HOME|npm_config_registry)$/;

export function serviceFiles(o: {
  node: string;
  cli: string;
  logDir: string;
  home?: string;
  env?: Record<string, string>;
}) {
  return core.serviceFiles(spec(o));
}

/** Said where a sessionpipe pointed away from this computer's own files (a test, a
 *  throwaway world) would otherwise have replaced this computer's real service. */
export const NOT_THIS_COMPUTERS =
  "not installed as a service: SESSIONPIPE_STATE or SESSIONPIPE_CONFIG points this sessionpipe away from this computer's own files, so its service is left alone; run `sessionpipe control run` yourself";

interface Placing {
  node: string;
  cli: string;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  platform?: NodeJS.Platform;
}

/** Write and start the service for this platform: what it came to, or null where
 *  nothing was touched. A sessionpipe pointed away from this computer's files never
 *  replaces the real service (health.ts `serviceNames`); a run with `exec` stood in runs
 *  nothing real, and may. */
function put(o: Placing): { plan: core.ServicePlan; label: string; unit: string; file: string; log: string } | null {
  const names = serviceNames(o.env) ?? (o.exec ? { label: LABEL, unit: UNIT } : null);
  if (!names) return null;
  const { label, unit } = names;
  const logDir = controlState(o.env);
  const here = spec({ node: o.node, cli: o.cli, logDir, env: serviceEnv(o.env), names });
  const files = core.serviceFiles(here);
  const file = (o.platform ?? process.platform) === "darwin" ? files.plist.path : files.unit.path;
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const log = path.join(logDir, "daemon.log");
  // launchd and systemd create this file themselves, with whatever the umask says. It
  // sits beside the nonces and the acks, which are 0600 (CONTROL.md §8), and it holds
  // message ids, session ids and folder paths — so it is created here, private, before
  // the service can make a readable one.
  try {
    closeSync(openSync(log, "a", 0o600));
    chmodSync(log, 0o600);
  } catch {}
  const plan = core.installService({
    ...here,
    ...(o.exec ? { exec: o.exec } : {}),
    ...(o.platform ? { platform: o.platform } : {}),
  });
  return { plan, label, unit, file, log };
}

const NO_MANAGER = "no service manager for this platform yet; run `sessionpipe control run` yourself";
const managed = (platform: NodeJS.Platform = process.platform) => platform === "darwin" || platform === "linux";

/** Write and start the service for this platform (`control pair`, `pool on`, `ask on`).
 *  Returns what it did, in words. */
export function installService(o: Placing): string {
  if (!managed(o.platform)) return NO_MANAGER;
  const r = put(o);
  if (!r) return NOT_THIS_COMPUTERS;
  const { plan, label, unit, file, log } = r;
  if (plan.manager === "launchd")
    return plan.domain === "gui"
      ? `launchd agent ${label} (log: ${log})`
      : `launchd agent ${label} in the background domain, since nobody is logged in at this Mac's screen; after a restart it starts again when someone logs in there (log: ${log})`;
  if (plan.manager === "systemd")
    return `systemd user unit ${unit}; ${plan.linger?.note} (journalctl --user -u ${unit})`;
  return `${plan.restored ? `left ${file} as it was` : `wrote ${file}`}, but systemd --user isn't reachable here; run \`sessionpipe control run\` yourself (tmux, screen)`;
}

/** The same for `sessionpipe update`, which replaces a service that is there. It answers
 *  nothing; where the service could not be put in place it throws, with why in words
 *  for a person (what to run next is the caller's to say, which knows whether anything
 *  answers now). */
export function placeService(o: Placing): void {
  if (!managed(o.platform)) throw new Error("nothing on this computer starts the background service by itself");
  const back = "; the service file that was there before was put back";
  let r: ReturnType<typeof put>;
  try {
    r = put(o);
  } catch (e) {
    if (!(e instanceof core.ServiceRefused)) throw e;
    throw new Error(`${e.why}${e.back ? back : ""}`);
  }
  if (!r) throw new Error(NOT_THIS_COMPUTERS);
  if (!r.plan.manager)
    throw new Error(
      `systemd --user didn't start it (it can't be reached from here, or it refused)${r.plan.restored ? back : ""}`,
    );
}

export function uninstallService(env?: NodeJS.ProcessEnv): void {
  const names = serviceNames(env);
  if (names) core.uninstallService(names);
}
