// SPDX-License-Identifier: Apache-2.0
// sessionpipe-core/service: the launchd agent and the systemd user unit, as files (a
// dry run's snapshots below are the whole text), and installing and removing them with
// a stand-in for launchctl, systemctl and loginctl, in a temp home. Nothing here runs a
// real service manager, and a dry run writes nothing.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureLinger, installService, serviceFiles, uninstallService } from "../src/service/index.js";
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
