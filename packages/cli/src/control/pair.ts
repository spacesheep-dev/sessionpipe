// SPDX-License-Identifier: Apache-2.0
// `sessionpipe control pair <receiver>`: a key enters this machine's trust store only
// from this terminal (spec/CONTROL.md §2). The receiver hands back a passkey and a
// proof over sha256("sessionpipe.pair:<machine>:<code>"); the key is trusted only once
// the proof verifies here. Also the service files (launchd / systemd) that keep the
// daemon running, and `control off`.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAccounts, claudeDirs, drivableHarnesses, type HarnessAccount } from "@sessionpipe/core";
import { type TrustedKey, verifyEnrollment } from "@sessionpipe/core/control";
import {
  type ControlConfig,
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
  mode: "safe" | "auto";
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
): Promise<{ control: string; rpId: string; open: boolean; events: string | null }> {
  const base = url.replace(/\/$/, "");
  const r = await f(`${base}/.well-known/sessionpipe`);
  if (!r.ok) throw new Error(`${base} has no sessionpipe well-known file (HTTP ${r.status})`);
  const wk = (await r.json()) as {
    capabilities?: string[];
    endpoints?: { control?: string; events?: string };
    control?: { signing?: { rp_id?: string }; open_pairing?: boolean };
  };
  if (!wk.capabilities?.includes("control") || !wk.endpoints?.control || !wk.control?.signing?.rp_id)
    throw new Error(`${base} doesn't serve control yet (its well-known file lists no control.signing)`);
  const abs = (ep: string) => (/^https?:\/\//.test(ep) ? ep : base + ep);
  return {
    control: abs(wk.endpoints.control),
    rpId: wk.control.signing.rp_id,
    open: wk.control.open_pairing === true,
    events: wk.endpoints.events ? abs(wk.endpoints.events) : null,
  };
}

/** Pair (or add a key to) this machine with one receiver. Returns the saved config. */
export async function pair(o: PairOptions): Promise<ControlConfig> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { control, rpId, open } = await discover(o.url, f);
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
  const hello = {
    ...(pollKey ? { poll_key: pollKey } : {}),
    name: cfg.name,
    harnesses: o.harnesses ?? drivableHarnesses(o.env ?? process.env),
    modes: ["waiter", "turn", "resume", "fork"],
    version: VERSION,
    folders: cfg.folders,
    mode: cfg.mode,
    ...(accounts.length ? { accounts } : {}),
    // This daemon takes `files` on a start (an older one would start without them).
    files: true,
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
  const announce = (p: { url: string; check: string; until: number }) => {
    const spaced = /^\d{6}$/.test(p.check) ? `${p.check.slice(0, 3)} ${p.check.slice(3)}` : p.check;
    o.out("");
    // The approval happens on whatever device holds the person's passkey, which is
    // rarely the machine being paired (a server may have no screen at all): say so, or
    // the "Touch ID" line reads as "do it here" (2026-10-02, four machines, one headless).
    o.out(`  On any phone or computer where you're signed in to ${host} (it doesn't have to be this one),`);
    if (pollKey) {
      // Open pairing: one address for everyone, and the digits are what the person types.
      o.out(`  open ${p.url} and enter:  ${spaced}`);
      o.out("  then approve with that device's passkey (Touch ID, Face ID, a security key).");
      o.out("  Pairing several machines? Run this on each one: every machine shows its own digits.");
    } else {
      o.out("  open this link and approve with that device's passkey (Touch ID, Face ID, a security key):");
      o.out(`    ${p.url}`);
      o.out(`  The page shows these digits too: ${p.check}`);
    }
    const mins = Math.max(1, Math.round((p.until - Date.now()) / 60_000));
    o.out(`  This code is good for ${mins} minute${mins === 1 ? "" : "s"}; if it runs out, a fresh one appears here.`);
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
      if (r.status === 404) throw new Error("the receiver lost the pairing; run `sessionpipe control pair` again");
      p = await json(r);
      if (p.status === "expired") expired = true;
      else if (p.status !== "paired") continue;
    }
    if (expired) {
      if (Date.now() >= renewUntil) throw new Error("the pairing link expired; run `sessionpipe control pair` again");
      // A keyed pairing keeps the machine row its first code made; an open one starts
      // clean under the same poll key (the receiver names the machine at approval).
      cur = await start(o.token ? cur.machine : existing?.machine);
      o.out("  Nobody approved that code before it expired. Here is a fresh one; the old digits no longer work.");
      announce(cur);
      continue;
    }
    const { machine, code } = cur;
    const key = p.key as TrustedKey;
    const proof = p.proof as { cred: string; ad: string; cd: string; sig: string };
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
    o.out(`  ✓ Paired with ${rec.url} as ${machine} · ${rec.keys.length} key(s) trusted on this machine`);
    const named = accounts.flatMap((a) => (a.email ? [a.email] : a.name ? [a.name] : []));
    if (named.length)
      o.out(`  Its session board names your Claude Code account${named.length > 1 ? "s" : ""}: ${named.join(", ")}`);
    // Whose passkey this machine now trusts: with open pairing, whoever approved the link.
    if (typeof p.account === "string")
      o.out(`  Approved by ${p.account}. If that isn't you, run \`sessionpipe control off\` now.`);
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

const LABEL = "org.sessionpipe.control";
const UNIT = "sessionpipe-control.service";

/** Both files restart the daemon when it exits non-zero; an update exits UPDATE_EXIT
 *  (75, autoupdate.ts) to come back on the new code. SESSIONPIPE_SERVICE tells the
 *  daemon which manager that is (files from before it are recognized without it). */
export function serviceFiles(o: { node: string; cli: string; logDir: string; home?: string }) {
  const home = o.home ?? os.homedir();
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(o.node)}</string><string>${xml(o.cli)}</string><string>control</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>SESSIONPIPE_SERVICE</key><string>launchd</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(o.logDir, "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(o.logDir, "daemon.log"))}</string>
</dict>
</plist>
`;
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
  const unit = `[Unit]
Description=sessionpipe control daemon (signed messages to your coding sessions)
After=network-online.target

[Service]
ExecStart=${q(o.node)} ${q(o.cli)} control run
Environment=SESSIONPIPE_SERVICE=systemd
Restart=on-failure
RestartForceExitStatus=75
RestartSec=5

[Install]
WantedBy=default.target
`;
  return {
    plist: { file: path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`), body: plist },
    unit: { file: path.join(home, ".config", "systemd", "user", UNIT), body: unit },
  };
}

export type Exec = (cmd: string, args: string[]) => string;
const execQuiet: Exec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });

/** A systemd user service stops when its person's last login ends — closing the ssh
 *  session to a lab workstation or a cloud machine stopped the daemon with it — unless
 *  the user lingers. `loginctl enable-linger` for yourself needs no root on systemd's
 *  default policy; where it does, say the one command that does it. */
export function ensureLinger(user: string, exec: Exec = execQuiet): { on: boolean; note: string } {
  const lingering = () => {
    try {
      return /^Linger=yes/m.test(exec("loginctl", ["show-user", user, "--property=Linger"]));
    } catch {
      return false;
    }
  };
  if (lingering()) return { on: true, note: "it keeps running after you log out (linger was already on)" };
  try {
    exec("loginctl", ["enable-linger", user]);
  } catch {}
  if (lingering()) return { on: true, note: "it keeps running after you log out (turned linger on)" };
  return {
    on: false,
    note: `it stops when you log out: run \`sudo loginctl enable-linger ${user}\` once to keep it running`,
  };
}

/** Write and start the service for this platform. Returns what it did, in words. */
export function installService(o: {
  node: string;
  cli: string;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  platform?: NodeJS.Platform;
}): string {
  const logDir = controlState(o.env);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const f = serviceFiles({ node: o.node, cli: o.cli, logDir });
  const run = o.exec ?? execQuiet;
  const platform = o.platform ?? process.platform;
  if (platform === "darwin") {
    mkdirSync(path.dirname(f.plist.file), { recursive: true });
    writeFileSync(f.plist.file, f.plist.body);
    const uid = String(process.getuid?.() ?? "");
    for (const d of ["gui", "user"])
      try {
        run("launchctl", ["bootout", `${d}/${uid}/${LABEL}`]);
      } catch {}
    try {
      run("launchctl", ["bootstrap", `gui/${uid}`, f.plist.file]);
      return `launchd agent ${LABEL} (log: ${path.join(logDir, "daemon.log")})`;
    } catch {}
    // No one logged in at the screen (an ssh session to a Mac mini): the gui domain
    // doesn't exist. The user domain runs it now; after a restart it starts again at
    // the next login at the screen.
    run("launchctl", ["bootstrap", `user/${uid}`, f.plist.file]);
    return `launchd agent ${LABEL} in the background domain, since nobody is logged in at this Mac's screen; after a restart it starts again when someone logs in there (log: ${path.join(logDir, "daemon.log")})`;
  }
  if (platform === "linux") {
    mkdirSync(path.dirname(f.unit.file), { recursive: true });
    writeFileSync(f.unit.file, f.unit.body);
    try {
      run("systemctl", ["--user", "daemon-reload"]);
      run("systemctl", ["--user", "enable", "--now", UNIT]);
    } catch {
      return `wrote ${f.unit.file}, but systemd --user isn't reachable here; run \`sessionpipe control run\` yourself (tmux, screen)`;
    }
    const linger = ensureLinger(os.userInfo().username, run);
    return `systemd user unit ${UNIT}; ${linger.note} (journalctl --user -u ${UNIT})`;
  }
  return "no service manager for this platform yet; run `sessionpipe control run` yourself";
}

export function uninstallService(env?: NodeJS.ProcessEnv): void {
  const f = serviceFiles({ node: "", cli: "", logDir: controlState(env) });
  const run = (cmd: string, args: string[]) => {
    try {
      execFileSync(cmd, args, { stdio: "ignore", timeout: 15_000 });
    } catch {}
  };
  if (process.platform === "darwin" && existsSync(f.plist.file)) {
    run("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}/${LABEL}`]);
    run("launchctl", ["bootout", `user/${process.getuid?.() ?? ""}/${LABEL}`]);
    unlinkSync(f.plist.file);
  }
  if (process.platform === "linux" && existsSync(f.unit.file)) {
    run("systemctl", ["--user", "disable", "--now", UNIT]);
    unlinkSync(f.unit.file);
    run("systemctl", ["--user", "daemon-reload"]);
  }
}
