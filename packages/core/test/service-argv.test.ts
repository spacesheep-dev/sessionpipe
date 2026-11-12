// SPDX-License-Identifier: Apache-2.0
// sessionpipe-core/service: which program a service file names, read back from the
// files `serviceFiles` writes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serviceArgv, serviceFiles, serviceState } from "../src/service/index.js";

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
