// SPDX-License-Identifier: Apache-2.0
// sessionpipe-core/service: which program a service file names, read back from the
// files `serviceFiles` writes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serviceArgv, serviceEnvironment, serviceFiles, serviceState } from "../src/service/index.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-argv-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const spec = (argv: string[]) => ({
  label: "org.sessionpipe.racetest",
  unit: "racetest.service",
  description: "test",
  argv,
  logPath: "/tmp/log",
  home,
});

describe("the program a service file names", () => {
  // Paths with everything the two formats escape.
  const argv = ["/opt/node 22/bin/node", '/Users/a&b/<x>/say "hi" 100%/back\\slash/cli.js', "control", "run"];

  it("is read back from a plist and from a unit exactly as it was written", () => {
    const f = serviceFiles(spec(argv));
    expect(serviceArgv(f.plist.text)).toEqual(argv);
    expect(serviceArgv(f.unit.text)).toEqual(argv);
  });

  it("is null for a text that is neither", () => {
    expect(serviceArgv("")).toBeNull();
    expect(serviceArgv("[Unit]\nDescription=x\n")).toBeNull();
  });

  it("comes with a look at the service, on a Mac and on Linux; null with no file", () => {
    const never = () => {
      throw new Error("not loaded");
    };
    const names = { label: "org.sessionpipe.racetest", unit: "racetest.service", home, exec: never };
    expect(serviceState({ ...names, platform: "darwin" }).argv).toBeNull();
    expect(serviceState({ ...names, platform: "linux" }).argv).toBeNull();
    expect(serviceState({ ...names, platform: "win32" }).argv).toBeNull();
    const f = serviceFiles(spec(argv));
    for (const file of [f.plist, f.unit]) {
      mkdirSync(path.dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.text);
    }
    expect(serviceState({ ...names, platform: "darwin" })).toMatchObject({ installed: true, loaded: false, argv });
    expect(serviceState({ ...names, platform: "linux" })).toMatchObject({ installed: true, loaded: false, argv });
  });
});

describe("the environment a service file gives its process", () => {
  // Values with everything the two formats escape, and a PATH as a shell has it.
  const env = {
    PATH: "/Users/a b/.nvm/versions/node/v22/bin:/usr/bin:/bin",
    SESSIONPIPE_CLAUDE: '/opt/a&b/<x>/say "hi" 100%/back\\slash/claude',
    NOTE: "%%h is no specifier here, nor is \\%",
  };

  it("is read back from a plist and from a unit exactly as it was written", () => {
    const f = serviceFiles({ ...spec(["/n", "/cli.js"]), env });
    expect(serviceEnvironment(f.plist.text)).toEqual({ SESSIONPIPE_SERVICE: "launchd", ...env });
    expect(serviceEnvironment(f.unit.text)).toEqual({ SESSIONPIPE_SERVICE: "systemd", ...env });
    // Written again from what was read, the files are the same files.
    for (const file of [f.plist, f.unit]) {
      const { SESSIONPIPE_SERVICE: _manager, ...read } = serviceEnvironment(file.text) as Record<string, string>;
      const again = serviceFiles({ ...spec(["/n", "/cli.js"]), env: read });
      expect([again.plist.text, again.unit.text]).toContain(file.text);
    }
  });

  it("with none beside the manager's own, and null for a text that is neither file", () => {
    const f = serviceFiles(spec(["/n", "/cli.js"]));
    expect(serviceEnvironment(f.plist.text)).toEqual({ SESSIONPIPE_SERVICE: "launchd" });
    expect(serviceEnvironment(f.unit.text)).toEqual({ SESSIONPIPE_SERVICE: "systemd" });
    expect(serviceEnvironment("")).toBeNull();
    expect(serviceEnvironment("[Unit]\nDescription=x\n")).toBeNull();
  });

  it("reads what a person added by hand, however they laid it out", () => {
    // A plist someone opened in an editor: one key a line.
    const plist = serviceFiles(spec(["/n", "/cli.js"])).plist.text.replace(
      "</dict>",
      "\n    <key>SESSIONPIPE_CLAUDE</key>\n    <string>/opt/claude &amp; co/claude</string>\n  </dict>",
    );
    expect(serviceEnvironment(plist)).toEqual({
      SESSIONPIPE_SERVICE: "launchd",
      SESSIONPIPE_CLAUDE: "/opt/claude & co/claude",
    });
    // A unit: bare, quoted whole, quoted at the value, several on a line; a word with no value says nothing.
    const unit = [
      "[Service]",
      'ExecStart="/n" "/cli.js"',
      "Environment=SESSIONPIPE_SERVICE=systemd",
      "Environment=SESSIONPIPE_CLAUDE=/opt/claude/bin/claude",
      'Environment="A=one two" B="three four" C=5',
      "Environment=NOVALUE =x",
      "",
    ].join("\n");
    expect(serviceEnvironment(unit)).toEqual({
      SESSIONPIPE_SERVICE: "systemd",
      SESSIONPIPE_CLAUDE: "/opt/claude/bin/claude",
      A: "one two",
      B: "three four",
      C: "5",
    });
  });
});
