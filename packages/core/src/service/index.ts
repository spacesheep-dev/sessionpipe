// SPDX-License-Identifier: Apache-2.0
/** sessionpipe-core/service — a per-user background service for a sessionpipe process:
 *  a launchd agent on macOS, a systemd user unit on Linux. The control daemon runs
 *  under it (`org.sessionpipe.control`), and so can a receiver of the person's own (a
 *  board on their machine), with the same files and the same commands. Node only: it
 *  writes files and runs launchctl, systemctl and loginctl, so it is never part of the
 *  root export, which stays Worker- and browser-safe.
 *
 *  Both files restart the process when it exits non-zero, and when it exits
 *  UPDATE_EXIT (75, sessionpipe-core/version) to come back on new code. The process is
 *  told which manager that is in SESSIONPIPE_SERVICE (`launchd`, `systemd`). Nothing
 *  here needs root, and a dry run touches nothing: it answers the files it would write
 *  and the commands it would run. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** One service, as both managers need it. */
export interface ServiceSpec {
  /** The launchd label, also the plist's name: `org.sessionpipe.control`. */
  label: string;
  /** The systemd user unit's file name: `sessionpipe-control.service`. */
  unit: string;
  /** The unit's Description line. */
  description: string;
  /** The program and its arguments, each one argument (never through a shell). */
  argv: string[];
  /** More environment for the process, beside SESSIONPIPE_SERVICE. */
  env?: Record<string, string>;
  /** Where launchd writes its stdout and stderr (journald keeps a unit's). */
  logPath: string;
  /** The home the files go under; the user's own by default. */
  home?: string;
}

/** A file the service writes, and what is in it. */
export interface ServiceFile {
  path: string;
  text: string;
}

/** Runs one command and answers its stdout; throws when it fails. */
export type Exec = (cmd: string, args: string[]) => string;

const execQuiet: Exec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** One systemd argument, quoted: backslashes and quotes escaped, `%` doubled (a specifier otherwise). */
const sd = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** The plist and the unit for a service, and where each goes. */
export function serviceFiles(s: ServiceSpec): { plist: ServiceFile; unit: ServiceFile } {
  const home = s.home ?? os.homedir();
  const env = (manager: string) => ({ SESSIONPIPE_SERVICE: manager, ...s.env });
  const plistEnv = Object.entries(env("launchd"))
    .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(s.label)}</string>
  <key>ProgramArguments</key>
  <array>${s.argv.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict>${plistEnv}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(s.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(s.logPath)}</string>
</dict>
</plist>
`;
  const unitEnv = Object.entries(env("systemd"))
    .map(([k, v]) => `Environment=${k === "SESSIONPIPE_SERVICE" ? `${k}=${v}` : sd(`${k}=${v}`)}`)
    .join("\n");
  const unit = `[Unit]
Description=${s.description.replace(/\n/g, " ")}
After=network-online.target

[Service]
ExecStart=${s.argv.map(sd).join(" ")}
${unitEnv}
Restart=on-failure
RestartForceExitStatus=75
RestartSec=5

[Install]
WantedBy=default.target
`;
  return {
    plist: { path: path.join(home, "Library", "LaunchAgents", `${s.label}.plist`), text: plist },
    unit: { path: path.join(home, ".config", "systemd", "user", s.unit), text: unit },
  };
}

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

/** What an install did, or would do in a dry run. */
export interface ServicePlan {
  /** The files written (or that would be). */
  files: ServiceFile[];
  /** The commands run (or that would be), one string each, in order; launchd's looks
   *  at what it has (`launchctl print`) between them aren't among them. */
  commands: string[];
  /** Which manager runs it now: null on a platform with none, or where it isn't reachable. */
  manager: "launchd" | "systemd" | null;
  /** launchd: `gui` when someone is at the screen, else `user` (it starts again at the next login there). */
  domain?: "gui" | "user";
  /** systemd: whether it outlives the login, in words. */
  linger?: { on: boolean; note: string };
  /** The file that was written for a manager that couldn't be reached. */
  unreachable?: string;
}

export interface InstallOptions extends ServiceSpec {
  /** Answer the plan and touch nothing. */
  dryRun?: boolean;
  exec?: Exec;
  platform?: NodeJS.Platform;
  /** The user's id (launchd's domains) and name (linger); this process's by default. */
  uid?: string;
  user?: string;
  /** How a wait for launchd passes; this thread sleeps by default. */
  sleep?: (ms: number) => void;
}

const line = (cmd: string, args: string[]) => [cmd, ...args].join(" ");

const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** How long launchd is given to let go of a service it was told to boot out. It signals
 *  the process and removes the service when that exits, killing it after 5 s by default. */
const LET_GO_MS = 10_000;
const LOOK_MS = 100;

/** Write the service for this platform and start it now; a service already there is
 *  replaced (launchd: booted out first, and started once the old one is gone). */
export function installService(o: InstallOptions): ServicePlan {
  const f = serviceFiles(o);
  const platform = o.platform ?? process.platform;
  const uid = o.uid ?? String(process.getuid?.() ?? "");
  const commands: string[] = [];
  const real = o.exec ?? execQuiet;
  const run: Exec = (cmd, args) => {
    commands.push(line(cmd, args));
    return o.dryRun ? "" : real(cmd, args);
  };
  const write = (file: ServiceFile) => {
    if (o.dryRun) return;
    mkdirSync(path.dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.text);
  };
  if (platform === "darwin") {
    write(f.plist);
    for (const d of ["gui", "user"])
      try {
        run("launchctl", ["bootout", `${d}/${uid}/${o.label}`]);
      } catch {}
    let refusal: unknown;
    const gui = (): boolean => {
      try {
        run("launchctl", ["bootstrap", `gui/${uid}`, f.plist.path]);
        return true;
      } catch (e) {
        refusal = e;
        return false;
      }
    };
    const started: ServicePlan = { files: [f.plist], commands, manager: "launchd", domain: "gui" };
    if (gui()) return started;
    // `launchctl print` exits non-zero for a domain or a service launchd doesn't have.
    // A look, not a step: it isn't one of the plan's commands.
    const has = (target: string): boolean => {
      try {
        real("launchctl", ["print", target]);
        return true;
      } catch {
        return false;
      }
    };
    const atScreen = has(`gui/${uid}`);
    // A service is in one domain, and a look at the other doesn't see it.
    const there = () => has(`gui/${uid}/${o.label}`) || has(`user/${uid}/${o.label}`);
    if (atScreen) {
      // The gui domain is there, so the refusal is about the service: `bootout` answers
      // at once, and the service it booted out stays until its process has exited. A
      // bootstrap in between is refused (5, or 37 "Operation already in progress"), in
      // the user domain too, and the machine is left with no service at all. So: wait
      // for the old one to be gone, then start the new one.
      const sleep = o.sleep ?? sleepSync;
      for (let waited = 0; waited < LET_GO_MS && there(); waited += LOOK_MS) sleep(LOOK_MS);
      if (gui()) return started;
    }
    // No one logged in at the screen (an ssh session to a Mac mini): the gui domain
    // doesn't exist. The user domain runs it now; after a restart it starts again at
    // the next login at the screen.
    try {
      run("launchctl", ["bootstrap", `user/${uid}`, f.plist.path]);
    } catch {
      const code = (refusal as { status?: unknown }).status;
      const said = typeof code === "number" ? ` (launchctl answered ${code})` : "";
      const by = `\`launchctl bootstrap gui/${uid} ${f.plist.path}\``;
      throw new Error(
        !atScreen
          ? `launchd didn't start ${o.label}${said}: no login at this Mac's screen can be seen from here (nobody is logged in there, or launchctl is blocked). From a login at the screen, ${by} starts it (its file is written)`
          : there()
            ? `launchd didn't start the new ${o.label}${said}: the one that was running is still loaded. \`launchctl bootout gui/${uid}/${o.label}\`, then ${by} (its file is written)`
            : `launchd didn't start ${o.label}${said}, and nothing runs it now: ${by} starts it (its file is written)`,
      );
    }
    return { files: [f.plist], commands, manager: "launchd", domain: "user" };
  }
  if (platform === "linux") {
    write(f.unit);
    try {
      run("systemctl", ["--user", "daemon-reload"]);
      run("systemctl", ["--user", "enable", "--now", o.unit]);
    } catch {
      return { files: [f.unit], commands, manager: null, unreachable: f.unit.path };
    }
    const user = o.user ?? os.userInfo().username;
    if (o.dryRun) {
      commands.push(line("loginctl", ["enable-linger", user]));
      return { files: [f.unit], commands, manager: "systemd", linger: { on: false, note: "dry run" } };
    }
    return { files: [f.unit], commands, manager: "systemd", linger: ensureLinger(user, run) };
  }
  return { files: [], commands, manager: null };
}

/** What a look at the service finds. */
export interface ServiceState {
  /** Which manager this platform has; null where there is none. */
  manager: "launchd" | "systemd" | null;
  /** Where its file is, or would be. */
  file: string | null;
  /** The file is there. */
  installed: boolean;
  /** The manager has the service now (launchd: in either domain; systemd: active). */
  loaded: boolean;
}

/** Whether this platform's manager has the service now. A look only: nothing is
 *  written, started or stopped (`launchctl print`, `systemctl --user is-active`). */
export function serviceState(o: UninstallOptions): ServiceState {
  const f = serviceFiles({ ...o, description: "", argv: [], logPath: "" });
  const platform = o.platform ?? process.platform;
  const uid = o.uid ?? String(process.getuid?.() ?? "");
  const exec = o.exec ?? execQuiet;
  const ok = (cmd: string, args: string[]): boolean => {
    try {
      exec(cmd, args);
      return true;
    } catch {
      return false;
    }
  };
  if (platform === "darwin")
    return {
      manager: "launchd",
      file: f.plist.path,
      installed: existsSync(f.plist.path),
      loaded:
        ok("launchctl", ["print", `gui/${uid}/${o.label}`]) || ok("launchctl", ["print", `user/${uid}/${o.label}`]),
    };
  if (platform === "linux")
    return {
      manager: "systemd",
      file: f.unit.path,
      installed: existsSync(f.unit.path),
      loaded: ok("systemctl", ["--user", "is-active", o.unit]),
    };
  return { manager: null, file: null, installed: false, loaded: false };
}

export interface UninstallOptions {
  label: string;
  unit: string;
  home?: string;
  dryRun?: boolean;
  exec?: Exec;
  platform?: NodeJS.Platform;
  uid?: string;
}

/** Stop the service and remove its file, where this platform has one; nothing where
 *  there is none. A manager that says it wasn't loaded is no failure. */
export function uninstallService(o: UninstallOptions): { files: string[]; commands: string[] } {
  const f = serviceFiles({ ...o, description: "", argv: [], logPath: "" });
  const platform = o.platform ?? process.platform;
  const uid = o.uid ?? String(process.getuid?.() ?? "");
  const commands: string[] = [];
  const files: string[] = [];
  const real = o.exec ?? execQuiet;
  const run = (cmd: string, args: string[]) => {
    commands.push(line(cmd, args));
    if (o.dryRun) return;
    try {
      real(cmd, args);
    } catch {}
  };
  const remove = (file: string) => {
    files.push(file);
    if (!o.dryRun) unlinkSync(file);
  };
  if (platform === "darwin" && existsSync(f.plist.path)) {
    run("launchctl", ["bootout", `gui/${uid}/${o.label}`]);
    run("launchctl", ["bootout", `user/${uid}/${o.label}`]);
    remove(f.plist.path);
  }
  if (platform === "linux" && existsSync(f.unit.path)) {
    run("systemctl", ["--user", "disable", "--now", o.unit]);
    remove(f.unit.path);
    run("systemctl", ["--user", "daemon-reload"]);
  }
  return { files, commands };
}
