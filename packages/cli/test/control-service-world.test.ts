// SPDX-License-Identifier: Apache-2.0
// A sessionpipe pointed away from this computer's own files (a test, an agent's
// throwaway world) never replaces or stops this computer's real service; one that names
// a service of its own gives that service the same world.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serviceNames } from "../src/control/health.js";
import { installService, NOT_THIS_COMPUTERS, serviceEnv, uninstallService } from "../src/control/pair.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-world-"));
  vi.spyOn(os, "homedir").mockReturnValue(path.join(tmp, "home"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("the service of a sessionpipe pointed elsewhere", () => {
  const world = () => ({ SESSIONPIPE_STATE: path.join(tmp, "state"), PATH: "/usr/bin:/bin" });

  it("is not installed over this computer's real one, and says so", () => {
    expect(installService({ node: "/n", cli: "/c", env: world(), platform: "darwin" })).toBe(NOT_THIS_COMPUTERS);
    expect(
      installService({ node: "/n", cli: "/c", env: { SESSIONPIPE_CONFIG: "/x/config.json" }, platform: "linux" }),
    ).toBe(NOT_THIS_COMPUTERS);
    // Nothing is removed either: with no service of its own there is nothing to name.
    expect(() => uninstallService(world())).not.toThrow();
  });

  it("with everything it would run stood in for, the real names are used as before", () => {
    const ran: string[] = [];
    const said = installService({
      node: "/n",
      cli: "/c",
      env: world(),
      platform: "darwin",
      exec: (cmd, args) => {
        ran.push([cmd, ...args].join(" "));
        return "";
      },
    });
    expect(said).toContain("launchd agent org.sessionpipe.control");
    expect(ran.some((c) => c.includes("org.sessionpipe.control"))).toBe(true);
  });

  it("a service of its own is installed under its own name, in its own world", () => {
    const env = {
      ...world(),
      SESSIONPIPE_SERVICE_LABEL: "org.sessionpipe.racetest",
      HOME: path.join(tmp, "home"),
      npm_config_registry: "http://127.0.0.1:4873",
      EDITOR: "vi",
    };
    const ran: string[] = [];
    const said = installService({
      node: "/n",
      cli: "/c",
      env,
      platform: "darwin",
      exec: (cmd, args) => {
        ran.push([cmd, ...args].join(" "));
        return "";
      },
    });
    expect(said).toContain("launchd agent org.sessionpipe.racetest");
    expect(ran.join("\n")).not.toContain("org.sessionpipe.control");
    // What it is given: where its files are, whose home, which registry; nothing else of the shell's.
    expect(serviceEnv(env)).toMatchObject({
      SESSIONPIPE_STATE: env.SESSIONPIPE_STATE,
      SESSIONPIPE_SERVICE_LABEL: "org.sessionpipe.racetest",
      HOME: env.HOME,
      npm_config_registry: "http://127.0.0.1:4873",
      PATH: "/usr/bin:/bin",
    });
    expect(serviceEnv(env)).not.toHaveProperty("EDITOR");
    // Without a service of its own, only what every service gets.
    expect(Object.keys(serviceEnv({ ...world(), SESSIONPIPE_CLAUDE: path.join(tmp, "none") })).sort()).toEqual([
      "PATH",
    ]);
  });

  it("this computer's real service, named outright, is the real one", () => {
    expect(serviceNames({ SESSIONPIPE_STATE: "/x", SESSIONPIPE_SERVICE_LABEL: "org.sessionpipe.control" })).toEqual({
      label: "org.sessionpipe.control",
      unit: "sessionpipe-control.service",
    });
  });
});
