// SPDX-License-Identifier: Apache-2.0
// Whose service it is. A sessionpipe that keeps its files somewhere other than this
// account's usual place (a test, an agent's throwaway world, a profile that sets
// SESSIONPIPE_CONFIG) never looks at, replaces or stops this computer's usual service;
// one that names a service of its own gives that service the same world. Decided on
// where the files are, whichever variable moved them.
//
// Nothing in this file may reach a real service manager: were the guard to fail, an
// install here would boot out the service of the computer the tests run on. So
// `execFileSync` is stood in for the whole file, and every test ends by checking that
// it was never called.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { elsewhere, noService, SERVICE_LABEL, SERVICE_UNIT, serviceLook, serviceNames } from "../src/control/health.js";
import {
  BY_HAND,
  installService,
  placeService,
  serviceEnv,
  serviceFiles,
  uninstallService,
} from "../src/control/pair.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => {
    throw new Error("a test ran a real service command");
  }),
}));

const posix = process.platform !== "win32";
const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
const USUAL = { label: SERVICE_LABEL, unit: SERVICE_UNIT };
let tmp: string;
let home: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-world-")));
  home = path.join(tmp, "home");
  mkdirSync(home);
  vi.spyOn(os, "homedir").mockReturnValue(home);
});
afterEach(() => {
  const ran = vi
    .mocked(execFileSync)
    .mock.calls.map((c) => [c[0], ...((c[1] as string[] | undefined) ?? [])].join(" "));
  vi.mocked(execFileSync).mockClear();
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
  expect(ran).toEqual([]);
});

/** This account's home as the system has it: the one thing `$HOME` doesn't change. Here
 *  it is a folder of the test's, so "this computer's usual place" is one too. */
const account = (dir: string) => vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: dir });
const on = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p, configurable: true });
/** A stand-in for launchctl and systemctl that remembers what it was asked. */
const standIn = () => {
  const ran: string[] = [];
  const exec = (cmd: string, args: string[]) => {
    ran.push([cmd, ...args].join(" "));
    return "";
  };
  return { ran, exec };
};

describe("whose service it is", () => {
  it("the test's own sandbox is not this computer's usual place, and says where it is instead", () => {
    expect(serviceNames()).toBeNull();
    expect(serviceLook()).toBeNull();
    expect(noService()).toMatch(
      /^this sessionpipe keeps its files somewhere other than this computer's usual place \(.+, not .+\), so the usual background service is left alone$/,
    );
  });

  it.runIf(posix)("with nothing set, in this account's own home, it is this computer's usual service", () => {
    account(home);
    expect(elsewhere({})).toBeNull();
    expect(serviceNames({})).toEqual(USUAL);
    expect(noService({})).toBeNull();
  });

  it.runIf(posix)("is decided on where the files are, whichever variable moved them", () => {
    account(home);
    const state = path.join(home, ".local", "state", "sessionpipe");
    const config = path.join(home, ".config", "sessionpipe", "config.json");
    const x = path.join(tmp, "x");
    for (const [env, now, usual] of [
      [{ SESSIONPIPE_STATE: x }, x, state],
      [{ XDG_STATE_HOME: x }, path.join(x, "sessionpipe"), state],
      [{ SESSIONPIPE_CONFIG: path.join(x, "config.json") }, path.join(x, "config.json"), config],
      [{ XDG_CONFIG_HOME: x }, path.join(x, "sessionpipe", "config.json"), config],
    ] as const) {
      expect(elsewhere(env)).toEqual({ now, usual });
      expect(serviceNames(env)).toBeNull();
      expect(noService(env)).toBe(
        `this sessionpipe keeps its files somewhere other than this computer's usual place (${now}, not ${usual}), so the usual background service is left alone`,
      );
    }
    // A variable that names the usual place moves nothing.
    expect(
      serviceNames({
        SESSIONPIPE_STATE: state,
        SESSIONPIPE_CONFIG: config,
        XDG_STATE_HOME: path.join(home, ".local", "state"),
        XDG_CONFIG_HOME: `${home}/.config/`,
      }),
    ).toEqual(USUAL);
    // Only HOME pointed somewhere else: the account's own home is still where it was.
    vi.mocked(os.homedir).mockReturnValue(path.join(tmp, "other-home"));
    expect(elsewhere({})).toEqual({
      now: path.join(tmp, "other-home", ".local", "state", "sessionpipe"),
      usual: state,
    });
    expect(serviceNames({})).toBeNull();
  });

  it.runIf(posix)("a home reached through a link is the same home, once its folders are there", () => {
    const alias = path.join(tmp, "alias");
    symlinkSync(home, alias);
    account(alias);
    // Nothing there yet to tell by: not known to be the same place.
    expect(serviceNames({})).toBeNull();
    mkdirSync(path.join(home, ".local", "state", "sessionpipe"), { recursive: true });
    expect(elsewhere({})?.now).toBe(path.join(home, ".config", "sessionpipe", "config.json"));
    mkdirSync(path.join(home, ".config", "sessionpipe"), { recursive: true });
    writeFileSync(path.join(home, ".config", "sessionpipe", "config.json"), "{}");
    expect(serviceNames({})).toEqual(USUAL);
  });

  it.runIf(posix)("an account the system can't name has the home this process was given", () => {
    vi.spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, uv_os_get_passwd");
    });
    expect(serviceNames({})).toEqual(USUAL);
    expect(serviceNames({ XDG_STATE_HOME: path.join(tmp, "x") })).toBeNull();
  });

  it.runIf(posix)("nor does one with no home in its entry", () => {
    account("");
    expect(serviceNames({})).toEqual(USUAL);
  });

  it("on Windows the usual place is under the account's AppData", () => {
    on("win32");
    account(home);
    expect(serviceNames({})).toEqual(USUAL);
    const x = path.join(tmp, "x");
    expect(elsewhere({ LOCALAPPDATA: x })).toEqual({
      now: path.join(x, "sessionpipe"),
      usual: path.join(home, "AppData", "Local", "sessionpipe"),
    });
    expect(elsewhere({ APPDATA: x })).toEqual({
      now: path.join(x, "sessionpipe", "config.json"),
      usual: path.join(home, "AppData", "Roaming", "sessionpipe", "config.json"),
    });
    expect(serviceNames({ SESSIONPIPE_STATE: x })).toBeNull();
  });

  it("a service of its own is one of sessionpipe's by its name, and no other program's", () => {
    const world = { SESSIONPIPE_STATE: path.join(tmp, "state") };
    expect(serviceNames({ ...world, SESSIONPIPE_SERVICE_LABEL: "org.sessionpipe.racetest" })).toEqual({
      label: "org.sessionpipe.racetest",
      unit: "org.sessionpipe.racetest.service",
    });
    expect(noService({ ...world, SESSIONPIPE_SERVICE_LABEL: "org.sessionpipe.race-test.2" })).toBeNull();
    for (const label of [
      "com.apple.Finder",
      "homebrew.mxcl.postgresql",
      "org.sessionpipe",
      "org.sessionpipe.",
      "org.sessionpipe.-x",
      "org.sessionpipe.a/b",
      "xorg.sessionpipe.control",
      "no/slashes here",
      `org.sessionpipe.${"a".repeat(65)}`,
    ]) {
      const env = { ...world, SESSIONPIPE_SERVICE_LABEL: label };
      expect(serviceNames(env)).toBeNull();
      expect(serviceLook({ env, platform: "darwin", exec: standIn().exec })).toBeNull();
      expect(noService(env)).toBe(
        `SESSIONPIPE_SERVICE_LABEL is set to ${label}, and a service of sessionpipe's own is named org.sessionpipe.<name>`,
      );
    }
    // This computer's usual service, named outright, is that one, wherever the files are.
    expect(serviceNames({ ...world, SESSIONPIPE_SERVICE_LABEL: SERVICE_LABEL })).toEqual(USUAL);
  });
});

describe.runIf(posix)("a look at the service", () => {
  beforeEach(() => {
    account(home);
  });

  it("asks launchd, in both domains, and never changes anything", () => {
    const asked: string[] = [];
    const exec = (answers: Record<string, boolean>) => (cmd: string, args: string[]) => {
      asked.push([cmd, ...args].join(" "));
      if (!answers[args[1] as string]) throw new Error("not loaded");
      return "";
    };
    const o = { env: {}, platform: "darwin" as const, home: tmp };
    const plist = path.join(tmp, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    expect(serviceLook({ ...o, exec: exec({}) })).toEqual({
      manager: "launchd",
      file: plist,
      installed: false,
      loaded: false,
      argv: null,
    });
    expect(asked.every((a) => a.startsWith("launchctl print "))).toBe(true);
    expect(asked.map((a) => a.split(" ")[2]?.split("/")[0])).toEqual(["gui", "user"]);
    mkdirSync(path.dirname(plist), { recursive: true });
    writeFileSync(plist, "");
    const uid = String(process.getuid?.() ?? "");
    expect(serviceLook({ ...o, exec: exec({ [`user/${uid}/${SERVICE_LABEL}`]: true }) })).toMatchObject({
      installed: true,
      loaded: true,
      argv: null,
    });
    expect(serviceLook({ ...o, exec: exec({ [`gui/${uid}/${SERVICE_LABEL}`]: true }) })?.loaded).toBe(true);
  });

  it("asks systemd whether the unit is active, and whether systemd is there to ask", () => {
    const o = { env: {}, platform: "linux" as const, home: tmp };
    expect(serviceLook({ ...o, exec: () => "active\n" })).toEqual({
      manager: "systemd",
      file: path.join(tmp, ".config", "systemd", "user", SERVICE_UNIT),
      installed: false,
      loaded: true,
      argv: null,
    });
    // Not active: systemd says so, and answers for itself.
    expect(
      serviceLook({
        ...o,
        exec: (_cmd, args) => {
          if (args.includes("is-active")) throw new Error("inactive");
          return "Version=257\n";
        },
      }),
    ).toMatchObject({ manager: "systemd", loaded: false });
    // No user manager that can be reached (a container, WSL without systemd): no look at all.
    expect(
      serviceLook({
        ...o,
        exec: () => {
          throw new Error("Failed to connect to bus");
        },
      }),
    ).toBeNull();
  });

  it("is null where there is no manager, and in a world with no service of its own", () => {
    // Nothing stood in: on a platform with no manager nothing is run.
    expect(serviceLook({ env: {}, platform: "win32" })).toBeNull();
    expect(serviceLook({ env: { SESSIONPIPE_STATE: tmp }, platform: "darwin" })).toBeNull();
    // A world with a service of its own, on whatever this platform is: asked, never changed.
    const asked: string[] = [];
    const look = serviceLook({
      env: { SESSIONPIPE_STATE: tmp, SESSIONPIPE_SERVICE_LABEL: "org.sessionpipe.racetest" },
      exec: (cmd, args) => {
        asked.push([cmd, ...args].join(" "));
        throw new Error("not loaded");
      },
    });
    expect(look?.loaded ?? false).toBe(false);
    for (const a of asked)
      expect(a).toMatch(/^(launchctl print |systemctl --user is-active |systemctl --user show --property=Version$)/);
  });
});

describe.runIf(posix)("the service of a sessionpipe that keeps its files elsewhere", () => {
  const world = () => ({ SESSIONPIPE_STATE: path.join(tmp, "state"), PATH: "/usr/bin:/bin" });

  it("is not installed over this computer's usual one, and says what is true and the way through", () => {
    const said = installService({ node: "/n", cli: "/c", env: world(), platform: "darwin" });
    expect(said).toBe(`left alone: ${noService(world())}; ${BY_HAND}`);
    expect(said).toContain("this sessionpipe keeps its files somewhere other than this computer's usual place");
    expect(said).toContain("run `sessionpipe control run` yourself");
    expect(said).toContain("SESSIONPIPE_SERVICE_LABEL=org.sessionpipe.<name>");
    // Someone's own profile with SESSIONPIPE_CONFIG in it is told the same; nothing says "not installed".
    const profile = { SESSIONPIPE_CONFIG: "/x/config.json" };
    expect(installService({ node: "/n", cli: "/c", env: profile, platform: "linux" })).toBe(
      `left alone: ${noService(profile)}; ${BY_HAND}`,
    );
    expect(() => placeService({ node: "/n", cli: "/c", env: world(), platform: "darwin" })).toThrow(
      noService(world()) as string,
    );
    // A name that is no service of sessionpipe's is none to install either.
    const named = { ...world(), SESSIONPIPE_SERVICE_LABEL: "com.apple.Finder" };
    expect(installService({ node: "/n", cli: "/c", env: named, platform: "darwin" })).toBe(
      `left alone: SESSIONPIPE_SERVICE_LABEL is set to com.apple.Finder, and a service of sessionpipe's own is named org.sessionpipe.<name>; ${BY_HAND}`,
    );
    // Nothing was written, no log was made for a service, and nothing is removed either.
    expect(existsSync(path.join(home, "Library"))).toBe(false);
    expect(existsSync(path.join(home, ".config"))).toBe(false);
    expect(existsSync(path.join(tmp, "state"))).toBe(false);
    expect(() => uninstallService(world())).not.toThrow();
    expect(() => uninstallService(named)).not.toThrow();
  });

  it("with everything it would run stood in for, the usual names are used as before", () => {
    const { ran, exec } = standIn();
    const said = installService({ node: "/n", cli: "/c", env: world(), platform: "darwin", exec });
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
    const { ran, exec } = standIn();
    const said = installService({ node: "/n", cli: "/c", env, platform: "darwin", exec });
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
    // Installed again over its own file: that one is this daemon's, and is replaced.
    expect(installService({ node: "/n2", cli: "/c", env, platform: "darwin", exec })).toContain("launchd agent");
    expect(
      readFileSync(path.join(home, "Library", "LaunchAgents", "org.sessionpipe.racetest.plist"), "utf8"),
    ).toContain("<string>/n2</string>");
  });

  it("a name of its own that another program's service has: that service is left as it is", () => {
    // The board's own service, say, written by the same code under a sibling name.
    const board = path.join(home, "Library", "LaunchAgents", "org.sessionpipe.gui.plist");
    mkdirSync(path.dirname(board), { recursive: true });
    const theirs = serviceFiles({ node: "/n", cli: "/c", logDir: tmp, home }).plist.text.replace(
      "<string>control</string><string>run</string>",
      "<string>--port</string><string>7373</string>",
    );
    writeFileSync(board, theirs);
    const env = { ...world(), SESSIONPIPE_SERVICE_LABEL: "org.sessionpipe.gui" };
    const { ran, exec } = standIn();
    const why = `${board} is another program's service (it runs /n /c --port 7373), and is left as it is`;
    expect(installService({ node: "/n", cli: "/c", env, platform: "darwin", exec })).toBe(
      `left alone: ${why}; ${BY_HAND}`,
    );
    expect(() => placeService({ node: "/n", cli: "/c", env, platform: "darwin", exec })).toThrow(why);
    expect(ran).toEqual([]);
    expect(readFileSync(board, "utf8")).toBe(theirs);
    // A file there that names no program at all is nobody's service to keep.
    writeFileSync(board, "");
    expect(installService({ node: "/n", cli: "/c", env, platform: "darwin", exec })).toContain(
      "launchd agent org.sessionpipe.gui",
    );
  });
});
