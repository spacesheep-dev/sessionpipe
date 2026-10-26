// SPDX-License-Identifier: Apache-2.0
// config.json: every documented field reads back, an unknown one is not fatal, a
// broken file is the defaults. Where the files live per platform and env. The
// home-as-~ rule, file-safe ids, the event envelope, and the ULID's ordering.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Config, DEFAULT_CONFIG, machineName, readConfig, writeConfig } from "../src/config.js";
import { makeEvent } from "../src/events.js";
import { configFile, homeDir, safeId, stateDir, tilde, untilde } from "../src/paths.js";
import { isUlid, ulid } from "../src/ulid.js";

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "sp-config-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run `f` with process.platform reported as `p`; the real value is put back after. */
function onPlatform<T>(p: NodeJS.Platform, f: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { value: p, configurable: true });
  try {
    return f();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

const FULL: Config = {
  machine: "misha-air",
  sinks: [
    {
      name: "board",
      url: "https://board.example/v1",
      tier: 1,
      pii: true,
      control: false,
      token: "t",
      secret: "whsec_x",
      token_in: "keychain",
      max_tier: 2,
      well_known_at: "2026-10-01T00:00:00.000Z",
      paused: "2026-10-02T00:00:00.000Z",
    },
    { name: "log", url: "file:/tmp/x.jsonl", tier: 3 },
    { name: "out", url: "stdout", tier: 0 },
  ],
  harnesses: { "claude-code": { enabled: true, created: ["~/.claude/settings.json"] }, codex: { enabled: false } },
  update_check: false,
  keep_days: 7,
};

describe("readConfig", () => {
  it("reads every documented field back", () => {
    const file = path.join(fresh(), "config.json");
    writeConfig(FULL, file);
    expect(readConfig(file)).toEqual(FULL);
  });
  it("fills the defaults a file leaves out", () => {
    const file = path.join(fresh(), "config.json");
    writeConfig({ sinks: [], harnesses: {} }, file);
    expect(readConfig(file)).toEqual({ sinks: [], harnesses: {}, update_check: true, keep_days: 30 });
  });
  it("an unknown field, top-level or on a sink, is not fatal and is carried through", () => {
    const file = path.join(fresh(), "config.json");
    const sink = { ...FULL.sinks[0], colour: "red" } as unknown as Config["sinks"][number];
    writeConfig({ ...FULL, future_flag: 1, sinks: [sink] } as Config, file);
    const c = readConfig(file) as Config & { future_flag?: number };
    expect(c.future_flag).toBe(1);
    expect(c.sinks).toHaveLength(1);
    expect(c.sinks[0]).toMatchObject({ name: "board", tier: 1, colour: "red" });
    expect(c.harnesses).toEqual(FULL.harnesses);
  });
  it("sinks that are not a list and harnesses that are not an object become empty", () => {
    const file = path.join(fresh(), "config.json");
    writeConfig({ sinks: "nope", harnesses: null } as unknown as Config, file);
    expect(readConfig(file)).toEqual({ sinks: [], harnesses: {}, update_check: true, keep_days: 30 });
    writeConfig({ sinks: { a: 1 }, harnesses: "x" } as unknown as Config, file);
    expect(readConfig(file).sinks).toEqual([]);
    expect(readConfig(file).harnesses).toEqual({});
  });
  it("a missing or broken file is the defaults, as a fresh copy", () => {
    const d = fresh();
    const missing = readConfig(path.join(d, "none.json"));
    expect(missing).toEqual(DEFAULT_CONFIG);
    expect(missing.sinks).not.toBe(DEFAULT_CONFIG.sinks);
    const broken = path.join(d, "broken.json");
    writeFileSync(broken, "{ not json");
    expect(readConfig(broken)).toEqual(DEFAULT_CONFIG);
  });
});

describe("writeConfig", () => {
  it("creates the folder, writes mode 0600 with a trailing newline", () => {
    const file = path.join(fresh(), "deep", "er", "config.json");
    writeConfig(FULL, file);
    const text = readFileSync(file, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(FULL);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("does not chmod on Windows", () => {
    const file = path.join(fresh(), "config.json");
    onPlatform("win32", () => writeConfig(FULL, file));
    expect(readConfig(file)).toEqual(FULL);
  });
});

describe("machineName", () => {
  it("is what the person configured, cut to 80, else the hostname without a local suffix", () => {
    expect(machineName({ machine: "studio", sinks: [], harnesses: {} }, "whatever.local")).toBe("studio");
    expect(machineName({ machine: "m".repeat(100), sinks: [], harnesses: {} }, "h")).toHaveLength(80);
    expect(machineName({ machine: 42 as unknown as string, sinks: [], harnesses: {} }, "h")).toBe("42");
    expect(machineName({ sinks: [], harnesses: {} }, "misha-air.local")).toBe("misha-air");
    expect(machineName({ sinks: [], harnesses: {} }, "box.LAN")).toBe("box");
    expect(machineName({ sinks: [], harnesses: {} }, "box.home")).toBe("box");
    expect(machineName({ sinks: [], harnesses: {} }, "box.example.com")).toBe("box.example.com");
    expect(machineName({ machine: "", sinks: [], harnesses: {} }, "box")).toBe("box");
  });
});

describe("paths", () => {
  it("configFile: SESSIONPIPE_CONFIG wins, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(configFile({ SESSIONPIPE_CONFIG: "rel/c.json" })).toBe(path.resolve("rel/c.json"));
    onPlatform("linux", () => {
      expect(configFile({ XDG_CONFIG_HOME: "/xdg" })).toBe(path.join("/xdg", "sessionpipe", "config.json"));
      expect(configFile({})).toBe(path.join(homeDir(), ".config", "sessionpipe", "config.json"));
    });
  });
  it("stateDir: SESSIONPIPE_STATE wins, then XDG_STATE_HOME, then ~/.local/state", () => {
    expect(stateDir({ SESSIONPIPE_STATE: "/s" })).toBe(path.resolve("/s"));
    onPlatform("linux", () => {
      expect(stateDir({ XDG_STATE_HOME: "/xdg-state" })).toBe(path.join("/xdg-state", "sessionpipe"));
      expect(stateDir({})).toBe(path.join(homeDir(), ".local", "state", "sessionpipe"));
    });
  });
  it("on Windows: %APPDATA% and %LOCALAPPDATA%, with a fallback under the home", () => {
    onPlatform("win32", () => {
      expect(configFile({ APPDATA: "C:\\Roaming" })).toBe(path.join("C:\\Roaming", "sessionpipe", "config.json"));
      expect(configFile({})).toBe(path.join(homeDir(), "AppData", "Roaming", "sessionpipe", "config.json"));
      expect(stateDir({ LOCALAPPDATA: "C:\\Local" })).toBe(path.join("C:\\Local", "sessionpipe"));
      expect(stateDir({})).toBe(path.join(homeDir(), "AppData", "Local", "sessionpipe"));
      expect(configFile({ SESSIONPIPE_CONFIG: "/c.json" })).toBe(path.resolve("/c.json"));
    });
  });
  it("tilde: the home itself, a path under it, never a neighbour that shares the prefix", () => {
    expect(tilde("", "/Users/m")).toBe("");
    expect(tilde("/Users/m", "/Users/m")).toBe("~");
    expect(tilde("/Users/m/x/y", "/Users/m")).toBe("~/x/y");
    expect(tilde("/Users/m2/x", "/Users/m")).toBe("/Users/m2/x");
    expect(tilde("/etc", "/Users/m")).toBe("/etc");
    expect(tilde(path.join(homeDir(), "code"))).toBe(`~${path.sep}code`);
  });
  it("untilde: ~ and ~/… (or ~\\…) under the home, the way back from tilde; ~user and the rest as they are", () => {
    expect(untilde("~", "/Users/m")).toBe("/Users/m");
    expect(untilde("~/x/y", "/Users/m")).toBe(path.join("/Users/m", "x/y"));
    expect(untilde("~\\x", "/Users/m")).toBe(path.join("/Users/m", "x"));
    expect(untilde("~m2/x", "/Users/m")).toBe("~m2/x");
    expect(untilde("/etc", "/Users/m")).toBe("/etc");
    expect(untilde(tilde(path.join(homeDir(), "code")))).toBe(path.join(homeDir(), "code"));
  });
  it("safeId keeps [A-Za-z0-9_.-], replaces the rest, cuts at 160", () => {
    expect(safeId("s/1:a b")).toBe("s_1_a_b");
    expect(safeId("x".repeat(200))).toHaveLength(160);
    expect(safeId(12 as unknown as string)).toBe("12");
  });
});

describe("makeEvent", () => {
  const a = { type: "tool.ended", data: { tool: "Bash", ok: true }, harnessEvent: "PostToolUse" };
  it("stamps id, time, tier 3 and an empty privacy block from the given clock", () => {
    const e = makeEvent(a, {
      harness: { name: "claude-code", version: "2.1.0" },
      session: { id: "s", seq: 4 },
      now: 1_700_000_000_000,
    });
    expect(e).toEqual({
      protocol: 1,
      id: e.id,
      type: "tool.ended",
      time: "2023-11-14T22:13:20.000Z",
      tier: 3,
      harness: { name: "claude-code", event: "PostToolUse", version: "2.1.0" },
      session: { id: "s", seq: 4 },
      privacy: { rulesets: [], pii: false },
      data: { tool: "Bash", ok: true },
    });
    expect(isUlid(e.id)).toBe(true);
    expect(e.id.slice(0, 10)).toBe(ulid(1_700_000_000_000).slice(0, 10));
  });
  it("uses the wall clock when none is given, and leaves version out when unknown", () => {
    const before = Date.now();
    const e = makeEvent(a, { harness: { name: "codex" }, session: { id: "s", seq: 0 } });
    expect(Date.parse(e.time)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(e.time)).toBeLessThanOrEqual(Date.now());
    expect("version" in e.harness).toBe(false);
  });
});

describe("ulid", () => {
  it("is strictly increasing within one millisecond, keeping the time prefix", () => {
    const t = 1_700_000_000_123;
    const ids = Array.from({ length: 2000 }, () => ulid(t));
    for (let i = 1; i < ids.length; i++) expect((ids[i] as string) > (ids[i - 1] as string)).toBe(true);
    expect(new Set(ids.map((s) => s.slice(0, 10))).size).toBe(1);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isUlid(id)).toBe(true);
  });
  it("encodes the time in the first ten characters, so a later millisecond always sorts after", () => {
    expect(ulid(0).slice(0, 10)).toBe("0000000000");
    expect(ulid(1).slice(0, 10)).toBe("0000000001");
    expect(ulid(32).slice(0, 10)).toBe("0000000010");
    for (let t = 1_700_000_000_000; t < 1_700_000_000_300; t++) expect(ulid(t + 1) > ulid(t)).toBe(true);
  });
  it("isUlid accepts only 26 Crockford base32 characters", () => {
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
    expect(isUlid("01arz3ndektsv4rrffq69g5fav")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAI")).toBe(false);
    expect(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAO")).toBe(false);
  });
});
