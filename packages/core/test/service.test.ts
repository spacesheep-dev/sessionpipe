// SPDX-License-Identifier: Apache-2.0
// sessionpipe-core/service: the launchd agent and the systemd user unit, as files (a
// dry run's snapshots below are the whole text), and installing and removing them with
// a stand-in for launchctl, systemctl and loginctl, in a temp home. Nothing here runs a
// real service manager, and a dry run writes nothing.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureLinger,
  installService,
  ServiceRefused,
  serviceFiles,
  serviceState,
  uninstallService,
} from "../src/service/index.js";
import { compareVersions, isNewer, parseVersion, UPDATE_EXIT } from "../src/version.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-service-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const SPEC = {
  label: "org.sessionpipe.gui",
  unit: "sessionpipe-gui.service",
  description: "sessionpipe board",
  argv: ["/opt/node 22/bin/node", "/opt/gui/server.js", "--port", "7373"],
  env: { NODE_ENV: "production", SP_NOTE: 'a "quoted" 100%' },
  logPath: "/logs/a&b.log",
};

describe("the files", () => {
  it("a dry run's plist and unit, whole", () => {
    const r = installService({ ...SPEC, home, dryRun: true, platform: "darwin", uid: "501" });
    expect(r.files.map((f) => f.path)).toEqual([
      path.join(home, "Library", "LaunchAgents", "org.sessionpipe.gui.plist"),
    ]);
    expect(r.files[0]?.text).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>org.sessionpipe.gui</string>
  <key>ProgramArguments</key>
  <array><string>/opt/node 22/bin/node</string><string>/opt/gui/server.js</string><string>--port</string><string>7373</string></array>
  <key>EnvironmentVariables</key><dict><key>SESSIONPIPE_SERVICE</key><string>launchd</string><key>NODE_ENV</key><string>production</string><key>SP_NOTE</key><string>a "quoted" 100%</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/logs/a&amp;b.log</string>
  <key>StandardErrorPath</key><string>/logs/a&amp;b.log</string>
</dict>
</plist>
`);
    expect(r.commands).toEqual([
      "launchctl bootout gui/501/org.sessionpipe.gui",
      "launchctl bootout user/501/org.sessionpipe.gui",
      `launchctl bootstrap gui/501 ${path.join(home, "Library", "LaunchAgents", "org.sessionpipe.gui.plist")}`,
    ]);
    expect(r).toMatchObject({ manager: "launchd", domain: "gui" });
    const u = installService({ ...SPEC, home, dryRun: true, platform: "linux", user: "misha" });
    expect(u.files[0]?.path).toBe(path.join(home, ".config", "systemd", "user", "sessionpipe-gui.service"));
    expect(u.files[0]?.text).toBe(`[Unit]
Description=sessionpipe board
After=network-online.target

[Service]
ExecStart="/opt/node 22/bin/node" "/opt/gui/server.js" "--port" "7373"
Environment=SESSIONPIPE_SERVICE=systemd
Environment="NODE_ENV=production"
Environment="SP_NOTE=a \\"quoted\\" 100%%"
Restart=on-failure
RestartForceExitStatus=${UPDATE_EXIT}
RestartSec=5

[Install]
WantedBy=default.target
`);
    expect(u.commands).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now sessionpipe-gui.service",
      "loginctl enable-linger misha",
    ]);
    // A dry run touches nothing.
    expect(existsSync(path.join(home, "Library"))).toBe(false);
    expect(existsSync(path.join(home, ".config"))).toBe(false);
    expect(installService({ ...SPEC, home, dryRun: true, platform: "win32" })).toEqual({
      files: [],
      commands: [],
      manager: null,
    });
  });
  it("the user's own home, and a description on one line", () => {
    const f = serviceFiles({ ...SPEC, description: "two\nlines" });
    expect(f.plist.path.startsWith(os.homedir())).toBe(true);
    expect(f.unit.text).toContain("Description=two lines\n");
  });
});

describe("installing and removing", () => {
  it("darwin: written, booted out and bootstrapped; the user domain when nobody is at the screen", () => {
    const exec = vi.fn((_c: string, args: string[]) => {
      if (args[0] === "bootout") throw new Error("not loaded");
      return "";
    });
    const r = installService({ ...SPEC, home, exec, platform: "darwin", uid: "501" });
    expect(readFileSync(r.files[0]?.path as string, "utf8")).toBe(r.files[0]?.text);
    expect(r.domain).toBe("gui");
    exec.mockImplementation((_c, args) => {
      if (args[1]?.startsWith("gui/")) throw new Error("Bootstrap failed: 5: Input/output error");
      return "";
    });
    expect(installService({ ...SPEC, home, exec, platform: "darwin", uid: "501" }).domain).toBe("user");
    expect(exec).toHaveBeenLastCalledWith("launchctl", ["bootstrap", "user/501", r.files[0]?.path]);
    const gone = uninstallService({ label: SPEC.label, unit: SPEC.unit, home, exec, platform: "darwin", uid: "501" });
    expect(gone.files).toEqual([r.files[0]?.path]);
    expect(existsSync(r.files[0]?.path as string)).toBe(false);
    // Nothing there: nothing to do.
    expect(uninstallService({ label: SPEC.label, unit: SPEC.unit, home, exec, platform: "darwin" })).toEqual({
      files: [],
      commands: [],
    });
  });
  // launchd as it answers on a Mac with someone at the screen: `bootout` answers at once
  // and the service stays until its process has exited (here: after `leaves` looks), a
  // bootstrap of a label that is still there is refused in both domains, and `print`
  // fails for what isn't there.
  // launchctl's failure as execFileSync throws it: the exit status beside the message.
  const failed = (status: number, said: string) => Object.assign(new Error(said), { status });
  const launchd = (o: { running: boolean; leaves: number; disabled?: boolean }) => {
    let loaded = o.running;
    let left = Number.POSITIVE_INFINITY;
    const exec = vi.fn((_c: string, args: string[]) => {
      const [verb, target] = args;
      const mine = target?.startsWith("gui/501");
      if (verb === "bootout") {
        if (!mine || !loaded) throw failed(3, "Boot-out failed: 3: No such process");
        left = o.leaves;
      } else if (verb === "print") {
        if (target === "gui/501") return "";
        if (!mine || !loaded) throw failed(113, "Bad request.");
      } else if (verb === "bootstrap") {
        if (loaded || !mine) throw failed(5, "Bootstrap failed: 5: Input/output error");
        if (o.disabled) throw failed(119, "Bootstrap failed: 119: Service is disabled");
        loaded = true;
        left = Number.POSITIVE_INFINITY;
      }
      return "";
    });
    const sleep = vi.fn((_ms: number) => {
      if (--left <= 0) loaded = false;
    });
    return { exec, sleep, loaded: () => loaded };
  };
  const plistPath = () => path.join(home, "Library", "LaunchAgents", "org.sessionpipe.gui.plist");

  it("darwin: a running service is replaced: the new one starts once launchd has let go of the old one", () => {
    const l = launchd({ running: true, leaves: 4 });
    const r = installService({ ...SPEC, home, exec: l.exec, sleep: l.sleep, platform: "darwin", uid: "501" });
    expect(r).toMatchObject({ manager: "launchd", domain: "gui" });
    expect(l.loaded()).toBe(true);
    // The first bootstrap is the refused one; the looks in between aren't the plan's.
    expect(r.commands).toEqual([
      "launchctl bootout gui/501/org.sessionpipe.gui",
      "launchctl bootout user/501/org.sessionpipe.gui",
      `launchctl bootstrap gui/501 ${plistPath()}`,
      `launchctl bootstrap gui/501 ${plistPath()}`,
    ]);
    expect(l.sleep.mock.calls).toEqual([[100], [100], [100], [100]]);
    expect(l.exec).not.toHaveBeenCalledWith("launchctl", ["bootstrap", "user/501", plistPath()]);
  });
  it("darwin: with no stand-in for the wait, this thread sleeps between looks", () => {
    // Time passes for the stand-in at each look at the old service: gone at the second.
    const l = launchd({ running: true, leaves: 2 });
    const exec = (c: string, args: string[]) => {
      if (args[0] === "print" && args[1] === "gui/501/org.sessionpipe.gui") l.sleep(0);
      return l.exec(c, args);
    };
    const t0 = performance.now();
    const r = installService({ ...SPEC, home, exec, platform: "darwin", uid: "501" });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(95);
    expect(r.domain).toBe("gui");
    expect(l.loaded()).toBe(true);
  });
  it("darwin: nothing was running: one bootstrap, no look and no wait", () => {
    const l = launchd({ running: false, leaves: 0 });
    const r = installService({ ...SPEC, home, exec: l.exec, sleep: l.sleep, platform: "darwin", uid: "501" });
    expect(r.domain).toBe("gui");
    expect(l.exec.mock.calls.map((c) => c[1][0])).toEqual(["bootout", "bootout", "bootstrap"]);
    expect(l.sleep).not.toHaveBeenCalled();
  });
  it("darwin: launchd never lets go, or nobody is at the screen and it refuses: the command that starts it", () => {
    const stuck = launchd({ running: true, leaves: Number.POSITIVE_INFINITY });
    expect(() =>
      installService({ ...SPEC, home, exec: stuck.exec, sleep: stuck.sleep, platform: "darwin", uid: "501" }),
    ).toThrow(
      `launchd didn't start the new org.sessionpipe.gui (launchctl answered 5): the one that was running is still loaded. \`launchctl bootout gui/501/org.sessionpipe.gui\`, then \`launchctl bootstrap gui/501 ${plistPath()}\``,
    );
    // Ten seconds of looks, then one more try in each domain; the file is there for the command.
    expect(stuck.sleep).toHaveBeenCalledTimes(100);
    expect(stuck.exec.mock.calls.filter((c) => c[1][0] === "bootstrap").map((c) => c[1][1])).toEqual([
      "gui/501",
      "gui/501",
      "user/501",
    ]);
    expect(existsSync(plistPath())).toBe(true);
    // The old one left and launchd refuses the new one all the same (a label someone disabled).
    const off = launchd({ running: true, leaves: 1, disabled: true });
    expect(() =>
      installService({ ...SPEC, home, exec: off.exec, sleep: off.sleep, platform: "darwin", uid: "501" }),
    ).toThrow(
      `launchd didn't start org.sessionpipe.gui (launchctl answered 119), and nothing runs it now: \`launchctl bootstrap gui/501 ${plistPath()}\` starts it`,
    );
    expect(off.sleep).toHaveBeenCalledTimes(1);
    const sleep = vi.fn();
    expect(() =>
      installService({
        ...SPEC,
        home,
        exec: (_c, args) => {
          if (args[0] === "bootout") return "";
          throw new Error("no such domain");
        },
        sleep,
        platform: "darwin",
        uid: "501",
      }),
    ).toThrow(
      "launchd didn't start org.sessionpipe.gui: no login at this Mac's screen can be seen from here (nobody is logged in there, or launchctl is blocked). From a login at the screen, `launchctl bootstrap gui/501 ",
    );
    expect(sleep).not.toHaveBeenCalled();
  });
  it("linux: enabled now and lingering; written but unreachable without systemd --user", () => {
    const exec = vi.fn((_c: string, args: string[]) => (args[0] === "show-user" ? "Linger=yes\n" : ""));
    const r = installService({ ...SPEC, home, exec, platform: "linux", user: "misha" });
    expect(r).toMatchObject({ manager: "systemd", linger: { on: true } });
    expect(existsSync(r.files[0]?.path as string)).toBe(true);
    exec.mockImplementation(() => {
      throw new Error("Failed to connect to bus");
    });
    expect(installService({ ...SPEC, home, exec, platform: "linux" })).toMatchObject({
      manager: null,
      unreachable: r.files[0]?.path,
    });
    // A dry run of the removal names what it would do and leaves the file.
    const plan = uninstallService({ label: SPEC.label, unit: SPEC.unit, home, dryRun: true, platform: "linux" });
    expect(plan.commands).toEqual([
      "systemctl --user disable --now sessionpipe-gui.service",
      "systemctl --user daemon-reload",
    ]);
    expect(existsSync(r.files[0]?.path as string)).toBe(true);
    uninstallService({ label: SPEC.label, unit: SPEC.unit, home, exec, platform: "linux" });
    expect(existsSync(r.files[0]?.path as string)).toBe(false);
  });
  it("linux: a unit that was running is restarted onto the new file; one that wasn't is only started", () => {
    const unit = "sessionpipe-gui.service";
    const systemd = (active: boolean) => {
      const ran: string[] = [];
      const exec = (cmd: string, args: string[]) => {
        ran.push([cmd, ...args].join(" "));
        if (args.includes("is-active") && !active) throw new Error("inactive");
        return args[0] === "show-user" ? "Linger=yes\n" : "";
      };
      return { ran, exec };
    };
    const linger = "loginctl show-user misha --property=Linger";
    // Not active: enabled and started, as a first install is.
    const idle = systemd(false);
    const first = installService({ ...SPEC, home, exec: idle.exec, platform: "linux", user: "misha" });
    expect(first.commands).toEqual(["systemctl --user daemon-reload", `systemctl --user enable --now ${unit}`, linger]);
    // The look at whether it runs is asked first, and is no step of the plan.
    expect(idle.ran).toEqual([`systemctl --user is-active ${unit}`, ...first.commands]);
    // Active: `enable --now` leaves the running process on the old file, so it is restarted.
    const running = systemd(true);
    const again = installService({
      ...SPEC,
      argv: ["/opt/node 22/bin/node", "/opt/gui-2/server.js"],
      home,
      exec: running.exec,
      platform: "linux",
      user: "misha",
    });
    expect(again.commands).toEqual([
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${unit}`,
      `systemctl --user restart ${unit}`,
      linger,
    ]);
    expect(running.ran).toEqual([`systemctl --user is-active ${unit}`, ...again.commands]);
    expect(readFileSync(again.files[0]?.path as string, "utf8")).toContain("/opt/gui-2/server.js");
  });
  it("linux: a new unit systemd won't take is taken back, and the one from before started again", () => {
    const quiet = () => "Linger=yes\n";
    const first = installService({ ...SPEC, home, exec: quiet, platform: "linux", user: "misha" });
    const file = first.files[0]?.path as string;
    const old = readFileSync(file, "utf8");
    const next = { ...SPEC, argv: ["/n", "/opt/gui-2/server.js"], home, platform: "linux" as const, user: "misha" };
    // The restart onto the new file fails: the old file goes back and is started.
    const ran: string[] = [];
    const plan = installService({
      ...next,
      exec: (cmd, args) => {
        ran.push([cmd, ...args].join(" "));
        if (args.includes("restart")) throw new Error("Job for sessionpipe-gui.service failed");
        return "";
      },
    });
    expect(plan).toMatchObject({ manager: null, unreachable: file, restored: true });
    expect(readFileSync(file, "utf8")).toBe(old);
    expect(ran).toEqual([
      "systemctl --user is-active sessionpipe-gui.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now sessionpipe-gui.service",
      "systemctl --user restart sessionpipe-gui.service",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now sessionpipe-gui.service",
    ]);
    // systemd can't be reached at all: the file goes back, and nothing else can be done.
    const calls: string[] = [];
    const down = installService({
      ...next,
      exec: (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        throw new Error("Failed to connect to bus");
      },
    });
    expect(down).toMatchObject({ manager: null, unreachable: file, restored: true });
    expect(readFileSync(file, "utf8")).toBe(old);
    expect(calls).toEqual([
      "systemctl --user is-active sessionpipe-gui.service",
      "systemctl --user daemon-reload",
      "systemctl --user daemon-reload",
    ]);
    // The same file again has nothing to take back.
    expect(
      installService({
        ...SPEC,
        home,
        platform: "linux",
        exec: () => {
          throw new Error("Failed to connect to bus");
        },
      }),
    ).toEqual({ files: first.files, commands: ["systemctl --user daemon-reload"], manager: null, unreachable: file });
  });
  it("darwin: a new service launchd refuses is taken back: the old file, and the old service started again", () => {
    const quiet = launchd({ running: false, leaves: 0 });
    const first = installService({
      ...SPEC,
      home,
      exec: quiet.exec,
      sleep: quiet.sleep,
      platform: "darwin",
      uid: "501",
    });
    const old = readFileSync(plistPath(), "utf8");
    expect(first.files[0]?.text).toBe(old);
    const next = { ...SPEC, argv: ["/n", "/opt/gui-2/server.js"], home, platform: "darwin" as const, uid: "501" };
    const refused = (fn: () => unknown): ServiceRefused => {
      try {
        fn();
      } catch (e) {
        return e as ServiceRefused;
      }
      throw new Error("it was not refused");
    };
    // launchd lets go of the old one and refuses the new file, then takes the old one back.
    let loaded = true;
    const picky = vi.fn((_c: string, args: string[]) => {
      const [verb, target] = args;
      if (verb === "bootout") {
        if (!target?.startsWith("gui/501") || !loaded) throw failed(3, "Boot-out failed: 3: No such process");
        loaded = false;
      } else if (verb === "print") {
        if (target !== "gui/501" && !(loaded && target?.startsWith("gui/501"))) throw failed(113, "Bad request.");
      } else {
        if (readFileSync(plistPath(), "utf8") !== old || target !== "gui/501")
          throw failed(5, "Bootstrap failed: 5: Input/output error");
        loaded = true;
      }
      return "";
    });
    const a = refused(() => installService({ ...next, exec: picky, sleep: vi.fn() }));
    expect(a).toBeInstanceOf(ServiceRefused);
    expect(a.message).toBe(
      "launchd didn't start the new org.sessionpipe.gui (launchctl answered 5); the one that was there before is started again (the file that was there before is back in its place)",
    );
    expect(a.why).toBe("launchd refused it (launchctl answered 5)");
    expect(a.back).toBe("running");
    expect(readFileSync(plistPath(), "utf8")).toBe(old);
    expect(loaded).toBe(true);
    // launchd never lets go of the old one: its file goes back, and it is still the one loaded.
    const stuck = launchd({ running: true, leaves: Number.POSITIVE_INFINITY });
    const b = refused(() => installService({ ...next, exec: stuck.exec, sleep: stuck.sleep }));
    expect(b.message).toBe(
      `launchd didn't start the new org.sessionpipe.gui (launchctl answered 5): the one that was running is still loaded. \`launchctl bootout gui/501/org.sessionpipe.gui\`, then \`launchctl bootstrap gui/501 ${plistPath()}\` (the file that was there before is back in its place)`,
    );
    expect(b.why).toBe("launchd has not let go of the one that was running (launchctl answered 5)");
    expect(b.back).toBe("running");
    expect(readFileSync(plistPath(), "utf8")).toBe(old);
    // No bootstrap of the old file was tried while the old one is still loaded.
    expect(stuck.exec.mock.calls.filter((c) => c[1][0] === "bootstrap")).toHaveLength(3);
    // It refuses the old one too (a label someone disabled): the file is back, nothing runs.
    const off = launchd({ running: true, leaves: 1, disabled: true });
    const c = refused(() => installService({ ...next, exec: off.exec, sleep: off.sleep }));
    expect(c.message).toBe(
      `launchd didn't start org.sessionpipe.gui (launchctl answered 119), and nothing runs it now: \`launchctl bootstrap gui/501 ${plistPath()}\` starts it (the file that was there before is back in its place)`,
    );
    expect(c.back).toBe("stopped");
    expect(readFileSync(plistPath(), "utf8")).toBe(old);
    expect(off.exec.mock.calls.filter((x) => x[1][0] === "bootstrap").map((x) => x[1][1])).toEqual([
      "gui/501",
      "gui/501",
      "user/501",
      "gui/501",
      "user/501",
    ]);
    // Nobody at the screen and launchd refuses: said without a launchctl command in `why`.
    const d = refused(() =>
      installService({
        ...next,
        exec: (_c, args) => {
          if (args[0] === "bootout") return "";
          throw new Error("no such domain");
        },
        sleep: vi.fn(),
      }),
    );
    expect(d.message).toContain("(the file that was there before is back in its place)");
    expect(d.why).toBe(
      "launchd can't be asked from here: nobody is logged in at this Mac's screen, or this shell isn't allowed to ask it",
    );
    expect(d.back).toBe("stopped");
    // With no service there before, there is nothing to take back.
    rmSync(plistPath());
    const e = refused(() => installService({ ...next, exec: off.exec, sleep: off.sleep }));
    expect(e.back).toBeNull();
    expect(e.message).toContain("(its file is written)");
    expect(readFileSync(plistPath(), "utf8")).toContain("/opt/gui-2/server.js");
  });
  it("linger, through the stand-in", () => {
    expect(ensureLinger("me", () => "Linger=no\n").on).toBe(false);
  });
  it("a dry run of the removal on a Mac", () => {
    const f = serviceFiles({ ...SPEC, home });
    mkdirSync(path.dirname(f.plist.path), { recursive: true });
    writeFileSync(f.plist.path, f.plist.text);
    expect(
      uninstallService({ label: SPEC.label, unit: SPEC.unit, home, dryRun: true, platform: "darwin", uid: "7" }),
    ).toEqual({
      files: [f.plist.path],
      commands: ["launchctl bootout gui/7/org.sessionpipe.gui", "launchctl bootout user/7/org.sessionpipe.gui"],
    });
    expect(existsSync(f.plist.path)).toBe(true);
  });
});

describe("a look at the service", () => {
  const NAMES = { label: SPEC.label, unit: SPEC.unit };
  /** A manager that has exactly the targets named, and remembers what it was asked. */
  const manager = (...has: string[]) => {
    const asked: string[] = [];
    const exec = (cmd: string, args: string[]) => {
      asked.push([cmd, ...args].join(" "));
      if (!has.includes(args.at(-1) as string)) throw new Error("Could not find service");
      return "";
    };
    return { asked, exec };
  };

  it("darwin: launchd has it in the gui domain, in the user domain, or in neither; the file is there or not", () => {
    const o = { ...NAMES, home, platform: "darwin" as const, uid: "501" };
    const plist = path.join(home, "Library", "LaunchAgents", "org.sessionpipe.gui.plist");
    const neither = manager();
    expect(serviceState({ ...o, exec: neither.exec })).toEqual({
      manager: "launchd",
      file: plist,
      installed: false,
      loaded: false,
      argv: null,
      pid: null,
    });
    // A look, in both domains: nothing but `print`.
    expect(neither.asked).toEqual([
      "launchctl print gui/501/org.sessionpipe.gui",
      "launchctl print user/501/org.sessionpipe.gui",
    ]);
    mkdirSync(path.dirname(plist), { recursive: true });
    writeFileSync(plist, "");
    const gui = manager("gui/501/org.sessionpipe.gui");
    expect(serviceState({ ...o, exec: gui.exec })).toEqual({
      manager: "launchd",
      file: plist,
      installed: true,
      loaded: true,
      argv: null,
      pid: null,
    });
    // Found at the screen: the other domain is not asked.
    expect(gui.asked).toEqual(["launchctl print gui/501/org.sessionpipe.gui"]);
    const user = manager("user/501/org.sessionpipe.gui");
    expect(serviceState({ ...o, exec: user.exec }).loaded).toBe(true);
    expect(user.asked).toHaveLength(2);
    // The file was looked at and left as it was.
    expect(readFileSync(plist, "utf8")).toBe("");
  });

  it("linux: the unit is active or it isn't; the file is there or not", () => {
    const o = { ...NAMES, home, platform: "linux" as const };
    const unit = path.join(home, ".config", "systemd", "user", "sessionpipe-gui.service");
    const active = manager("sessionpipe-gui.service");
    expect(serviceState({ ...o, exec: active.exec })).toEqual({
      manager: "systemd",
      file: unit,
      installed: false,
      loaded: true,
      argv: null,
      pid: null,
    });
    // Active: it is asked which process that is, and nothing else.
    expect(active.asked).toEqual([
      "systemctl --user is-active sessionpipe-gui.service",
      "systemctl --user show sessionpipe-gui.service --property=MainPID --value",
    ]);
    mkdirSync(path.dirname(unit), { recursive: true });
    writeFileSync(unit, "");
    // Not active: systemd is asked for its own version, which only one that answers says.
    const idle = manager("--property=Version");
    expect(serviceState({ ...o, exec: idle.exec })).toEqual({
      manager: "systemd",
      file: unit,
      installed: true,
      loaded: false,
      argv: null,
      pid: null,
    });
    expect(idle.asked).toEqual([
      "systemctl --user is-active sessionpipe-gui.service",
      "systemctl --user show --property=Version",
    ]);
  });

  it("a manager that can't be asked is none: no systemd user manager to reach, no launchctl to run", () => {
    const unit = path.join(home, ".config", "systemd", "user", "sessionpipe-gui.service");
    mkdirSync(path.dirname(unit), { recursive: true });
    writeFileSync(unit, serviceFiles({ ...SPEC, home }).unit.text);
    // A container, WSL without systemd, a shell with no session: every question fails.
    // The file is still said to be there, with what it names.
    expect(serviceState({ ...NAMES, home, platform: "linux", exec: manager().exec })).toEqual({
      manager: null,
      file: unit,
      installed: true,
      loaded: false,
      argv: SPEC.argv,
      pid: null,
    });
    // launchctl that isn't there, as execFileSync says it: an error with a code, no exit status.
    const none = (): string => {
      throw Object.assign(new Error("spawnSync launchctl ENOENT"), { code: "ENOENT" });
    };
    expect(serviceState({ ...NAMES, home, platform: "darwin", uid: "501", exec: none })).toEqual({
      manager: null,
      file: path.join(home, "Library", "LaunchAgents", "org.sessionpipe.gui.plist"),
      installed: false,
      loaded: false,
      argv: null,
      pid: null,
    });
    // One that ran and said no (an exit status) is launchd answering; so is anything else thrown.
    for (const said of [Object.assign(new Error("Bad request."), { status: 113 }), null, "no"])
      expect(
        serviceState({
          ...NAMES,
          home,
          platform: "darwin",
          uid: "501",
          exec: () => {
            throw said;
          },
        }).manager,
      ).toBe("launchd");
  });

  it("another platform has no manager, and nothing is asked", () => {
    const none = manager();
    const nothing = { manager: null, file: null, installed: false, loaded: false, argv: null, pid: null };
    expect(serviceState({ ...NAMES, home, platform: "win32", exec: none.exec })).toEqual(nothing);
    expect(none.asked).toEqual([]);
    // With no stand-in either: there is still nothing to run.
    expect(serviceState({ ...NAMES, home, platform: "win32" })).toEqual(nothing);
  });

  it("asks about this process's own user; where the system has no uid, about none", () => {
    const own = manager();
    serviceState({ ...NAMES, home, platform: "darwin", exec: own.exec });
    expect(own.asked[0]).toBe(`launchctl print gui/${process.getuid?.() ?? ""}/org.sessionpipe.gui`);
    const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true, writable: true });
    try {
      const without = manager();
      expect(serviceState({ ...NAMES, home, platform: "darwin", exec: without.exec }).loaded).toBe(false);
      expect(without.asked).toEqual([
        "launchctl print gui//org.sessionpipe.gui",
        "launchctl print user//org.sessionpipe.gui",
      ]);
    } finally {
      if (getuid) Object.defineProperty(process, "getuid", getuid);
      else delete (process as { getuid?: unknown }).getuid;
    }
  });

  it("darwin: the process launchd runs for it, read from what `print` says; none for one that isn't running", () => {
    const o = { ...NAMES, home, platform: "darwin" as const, uid: "501" };
    /** launchd's own page for a service, as far as it matters here. */
    const page = (lines: string[]) =>
      ["gui/501/org.sessionpipe.gui = {", "\tactive count = 1", ...lines, "\tprogram = /usr/local/bin/node", "}"].join(
        "\n",
      );
    const says =
      (target: string, text: string) =>
      (_cmd: string, args: string[]): string => {
        if (args.at(-1) !== target) throw new Error("Could not find service");
        return text;
      };
    // Running: `pid = <n>` on a line of its own, among the others.
    const running = serviceState({
      ...o,
      exec: says("gui/501/org.sessionpipe.gui", page(["\tstate = running", "\tpid = 4242"])),
    });
    expect(running).toMatchObject({ manager: "launchd", loaded: true, pid: 4242 });
    // Loaded and not running (it exited, launchd waits to start it again): no such line.
    // `last exit pid`-like lines that only end the same way are not it.
    const waiting = serviceState({
      ...o,
      exec: says("gui/501/org.sessionpipe.gui", page(["\tstate = not running", "\tlast pid = 4242 (exited)"])),
    });
    expect(waiting).toMatchObject({ loaded: true, pid: null });
    // In the user domain (a Mac nobody is at the screen of): the same line, from that page.
    const user = serviceState({ ...o, exec: says("user/501/org.sessionpipe.gui", page(["\tpid = 7"])) });
    expect(user).toMatchObject({ loaded: true, pid: 7 });
    // Not loaded at all: nothing was printed, so there is no process to name.
    expect(serviceState({ ...o, exec: manager().exec })).toMatchObject({ loaded: false, pid: null });
    // A number no process has is not one.
    expect(serviceState({ ...o, exec: says("gui/501/org.sessionpipe.gui", page(["\tpid = 0"])) }).pid).toBeNull();
  });

  it("linux: systemd's MainPID for an active unit; 0, no answer, and a unit that isn't active are none", () => {
    const o = { ...NAMES, home, platform: "linux" as const };
    /** systemd with the unit active, answering `show … MainPID` as told. */
    const systemd = (main: string | Error) => {
      const asked: string[] = [];
      const exec = (cmd: string, args: string[]): string => {
        asked.push([cmd, ...args].join(" "));
        if (args[1] === "is-active") return "active\n";
        if (main instanceof Error) throw main;
        return main;
      };
      return { asked, exec };
    };
    const running = systemd("31337\n");
    expect(serviceState({ ...o, exec: running.exec })).toMatchObject({ manager: "systemd", loaded: true, pid: 31337 });
    expect(running.asked).toEqual([
      "systemctl --user is-active sessionpipe-gui.service",
      "systemctl --user show sessionpipe-gui.service --property=MainPID --value",
    ]);
    // Between two starts systemd says 0: no process.
    expect(serviceState({ ...o, exec: systemd("0\n").exec })).toMatchObject({ loaded: true, pid: null });
    // Nothing printed, or something that is no number.
    expect(serviceState({ ...o, exec: systemd("").exec }).pid).toBeNull();
    expect(serviceState({ ...o, exec: systemd("n/a\n").exec }).pid).toBeNull();
    // The question itself failing leaves the rest of the answer as it was.
    expect(serviceState({ ...o, exec: systemd(new Error("Failed to connect to bus")).exec })).toMatchObject({
      manager: "systemd",
      loaded: true,
      pid: null,
    });
    // A unit that isn't active runs nothing: it is not asked which process.
    const idle = manager("--property=Version");
    expect(serviceState({ ...o, exec: idle.exec })).toMatchObject({ manager: "systemd", loaded: false, pid: null });
    expect(idle.asked.some((a) => a.includes("MainPID"))).toBe(false);
  });
});

describe("sessionpipe-core/version", () => {
  it("orders versions, and offers only a release newer than this one", () => {
    expect(parseVersion("v1.2.3-rc.1+b")).toEqual({ n: [1, 2, 3], pre: "rc.1" });
    expect(parseVersion("1.2")).toBeNull();
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.11.0-rc.1", "0.10.0")).toBe(false);
    expect(UPDATE_EXIT).toBe(75);
  });
});
