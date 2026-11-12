// SPDX-License-Identifier: Apache-2.0
// `sessionpipe control …` and `sessionpipe wait` at the terminal: every flag of `pair`
// (and the one question it asks), `mode`, `keys`, `off`, `status`, the help, and what
// a key the receiver hands over at pairing becomes in config.json. The pairing itself
// and the service writers are stubbed; control.json and config.json are real, in a
// temp dir.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readConfig, writeConfig } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptSinkToken, CONTROL_HELP, controlMain, enabledHarnesses, waitMain } from "../src/control/cli.js";
import type { Status } from "../src/control/daemon.js";
import { installService, off, pair, uninstallService, withoutInherit } from "../src/control/pair.js";
import { readControl, writeControl } from "../src/control/store.js";
import { readPool } from "../src/pool/index.js";
import { rerunGlobally } from "../src/runtime.js";
import { makeUi, PLAIN, plain } from "../src/style.js";

vi.mock("../src/runtime.js", async (original) => ({
  ...(await original<typeof import("../src/runtime.js")>()),
  rerunGlobally: vi.fn(),
}));
vi.mock("../src/pool/index.js", async (original) => ({
  ...(await original<typeof import("../src/pool/index.js")>()),
  readPool: vi.fn(() => ({ on: false, port: 0, accounts: [] })),
}));
vi.mock("../src/control/pair.js", async (original) => ({
  ...(await original<typeof import("../src/control/pair.js")>()),
  pair: vi.fn(async () => {}),
  off: vi.fn(async () => undefined),
  installService: vi.fn(() => "launchd agent (stand-in)"),
  uninstallService: vi.fn(),
  withoutInherit: vi.fn(async () => [] as string[]),
}));
const rl = vi.hoisted(() => ({ answers: [] as string[], closed: 0 }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async () => rl.answers.shift() ?? "",
    close: () => rl.closed++,
  }),
}));

const RX = "https://rx.test";
let tmp: string;
let home: string;
let project: string;
let dist: string;
let out: string[];
let sock: string;
const said = () => out.join("\n");
const run = (...argv: string[]) => controlMain(["control", ...argv], (s) => out.push(s ?? ""), dist);
/** The same at a terminal 80 columns wide: `shown` is what was set for it, line by line. */
const terminal = makeUi({ isTTY: true, columns: 80, env: {}, platform: "linux" });
let shown: string[];
const atTerminal = (...argv: string[]) =>
  controlMain(["control", ...argv], (s) => out.push(s ?? ""), dist, {
    ui: terminal,
    say: (s) => shown.push(s ?? ""),
  });
const receiver = {
  url: RX,
  control: `${RX}/api/sessionpipe/v1/control`,
  rpId: "rx.test",
  machine: "m_0123456789abcdef",
  token: "t",
  keys: [
    { id: "es256key0123456789abcdef", alg: -7 as const, spki: "k", added_at: "2026-10-01T10:00:00Z" },
    { id: "rs256key0123456789abcdef", alg: -257 as const, spki: "k", added_at: "2026-10-02T10:00:00Z" },
    {
      id: "devicekey0123456789abcdefghijklmnopqrstuvw",
      alg: -7 as const,
      spki: "k",
      type: "device" as const,
      store: "hardware" as const,
      uv: "each-use" as const,
      name: "Mac app",
      added_at: "2026-10-03T10:00:00Z",
    },
  ],
  paired_at: "2026-10-01T10:00:00Z",
};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-ctl-cli-")));
  home = path.join(tmp, "home");
  project = path.join(home, "project");
  dist = path.join(tmp, "dist");
  mkdirSync(project, { recursive: true });
  sock = path.join(tmp, "control.sock");
  vi.stubEnv("SESSIONPIPE_CONFIG", path.join(tmp, "config", "config.json"));
  vi.stubEnv("SESSIONPIPE_STATE", path.join(tmp, "state"));
  vi.stubEnv("SESSIONPIPE_SOCKET", sock);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(os, "hostname").mockReturnValue("Box.local");
  vi.spyOn(process, "cwd").mockReturnValue(project);
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  out = [];
  shown = [];
  rl.answers.length = 0;
  rl.closed = 0;
  vi.mocked(pair).mockClear();
  vi.mocked(off).mockClear();
  vi.mocked(installService).mockClear();
  vi.mocked(uninstallService).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("control pair", () => {
  it("needs a receiver; a token with a character no key has is refused before anything runs", async () => {
    await run("pair");
    expect(said()).toBe(`usage:\n${CONTROL_HELP}`);
    await run("pair", "--token", "x");
    expect(said()).toContain("usage:");
    out = [];
    await run("pair", "rx.test", "--token", "ss_… paste");
    expect(said()).toContain("a character a key never has");
    expect(pair).not.toHaveBeenCalled();
  });

  it("a config.json that does not parse stops it before anything runs, and is left as it is", async () => {
    const file = path.join(tmp, "config", "config.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ "sinks": [], }');
    await expect(run("pair", "rx.test", "--no-service")).rejects.toThrow("so it was not written over");
    expect(pair).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe('{ "sinks": [], }');
    // Run from npx it stops before the global install too, as `install` and `connect` do.
    const npx = path.join(tmp, ".npm", "_npx", "abc", "node_modules", "sessionpipe", "dist");
    await expect(
      controlMain(["control", "pair", "rx.test", "--no-service"], (s) => out.push(s ?? ""), npx),
    ).rejects.toThrow("so it was not written over");
    expect(rerunGlobally).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe('{ "sinks": [], }');
  });

  it("a bare host is https; the folder it ran in, this machine's name and a safe default when nobody can be asked", async () => {
    vi.mocked(pair).mockImplementationOnce(async () => {
      writeControl({ name: "Box", folders: [project], mode: "safe", receivers: [receiver] });
      return readControl()!;
    });
    await run("pair", "rx.test/", "--no-service");
    expect(pair).toHaveBeenCalledWith(
      expect.objectContaining({ url: RX, token: null, folders: [project], mode: "safe", name: "Box" }),
    );
    expect(said()).toContain("Mode: safe for now. Run `sessionpipe control mode auto`");
    expect(said()).toContain(`Folders sessions may run in: ${project}`);
    expect(said()).toContain("Mode: safe (nothing that needs approval runs unattended)");
    // Not at a terminal: the line a program that ran the pairing has always been given.
    expect(out).toContain(
      "  Daemon: not installed as a service (--no-service); run `sessionpipe control run` yourself",
    );
    expect(installService).not.toHaveBeenCalled();
    // At a terminal it is said in the words of the rest of the page.
    out = [];
    await atTerminal("pair", "rx.test/", "--no-service", "--mode", "safe");
    expect(out).toContain(
      "  Background service: not installed as a service (--no-service); run `sessionpipe control run` yourself",
    );
  });

  it("run from the home folder with no folder named: a warning, and no folder at all", async () => {
    vi.mocked(process.cwd).mockReturnValue(home);
    vi.mocked(pair).mockImplementationOnce(async () => {
      writeControl({ name: "Box", folders: [], mode: "auto", receivers: [receiver] });
      return readControl()!;
    });
    await run("pair", RX, "--mode", "auto");
    expect(said()).toContain(`! Not allowing all of ${home}`);
    expect(pair).toHaveBeenCalledWith(expect.objectContaining({ folders: [], mode: "auto" }));
    expect(said()).toContain("Mode: auto (Claude Code's auto mode)");
    // The service is written through the stable node and the real cli.js path.
    expect(installService).toHaveBeenCalledWith({ node: expect.any(String), cli: path.join(dist, "cli.js") });
    expect(out).toContain("  Daemon: launchd agent (stand-in)");
    out = [];
    await atTerminal("pair", RX, "--mode", "auto");
    expect(out).toContain("  Background service: launchd agent (stand-in)");
  });

  it("a paired machine keeps its folders, mode, name and the sink's token unless told otherwise", async () => {
    writeControl({ name: "lab", folders: [project], mode: "auto", receivers: [receiver] });
    writeConfig({ sinks: [{ name: "rx", url: `${RX}/`, tier: 1, token: "sink-key" }], harnesses: {} });
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "cli.js"), "");
    vi.mocked(process.cwd).mockReturnValue(home);
    await run("pair", RX, "--no-service");
    expect(pair).toHaveBeenCalledWith(
      expect.objectContaining({ url: RX, token: "sink-key", folders: [], mode: "auto", name: "lab" }),
    );
    expect(said()).not.toContain("Not allowing");
    await run("pair", RX, "--token", "flag-key", "--name", "other", "--folder", project, "--no-service");
    expect(pair).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: "flag-key", name: "other", folders: [project] }),
    );
  });

  it("asks once at a terminal: enter or `a` is auto, `s` is safe, only the whole word is inherit, anything else is asked again", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    writeControl({ name: "lab", folders: [project], mode: "safe", receivers: [] });
    for (const [answers, mode] of [
      [["x", "s"], "safe"],
      [[""], "auto"],
      [["a"], "auto"],
      [["AUTO "], "auto"],
      [["safe"], "safe"],
      [["i", "bypass", " Inherit "], "inherit"],
    ] as const) {
      rl.answers.push(...answers);
      await run("pair", RX, "--no-service");
      expect(pair).toHaveBeenLastCalledWith(expect.objectContaining({ mode }));
      expect(rl.answers).toEqual([]);
    }
    expect(rl.closed).toBe(6);
    expect(said()).toContain("how may it run?");
    // Into a pipe each mode is one whole line, its name then what it lets a session do.
    expect(said().split("\n")).toContain(
      "  inherit  As your own sessions here run: no permission flag, so each harness starts in its own default on this machine. Claude Code takes permissions.defaultMode from its settings, whatever you set there, bypassPermissions included. Pick this if sessions you message should run the way you run them. (Codex follows the approval_policy and sandbox_mode in its config.toml; Antigravity gets no flag, as in safe.)",
    );
  });

  it("hands the pairing the terminal it is at, so the link and the digits can be picked out there", async () => {
    writeControl({ name: "lab", folders: [project], mode: "safe", receivers: [receiver] });
    vi.mocked(pair).mockImplementationOnce(async (o) => {
      o.say?.("      open:   the link, set for the terminal");
      return readControl()!;
    });
    await atTerminal("pair", RX, "--no-service");
    expect(pair).toHaveBeenLastCalledWith(expect.objectContaining({ url: RX, ui: terminal }));
    // A line the pairing has set for that terminal goes out as it is, not as a line to paint.
    expect(shown).toEqual(["      open:   the link, set for the terminal"]);
    expect(said()).not.toContain("open:");
    // A caller that names no terminal is a pipe: the pairing writes the lines programs read.
    await run("pair", RX, "--no-service");
    expect(pair).toHaveBeenLastCalledWith(expect.objectContaining({ url: RX, ui: PLAIN }));
  });

  it("--mode inherit pairs in inherit mode and says what that means", async () => {
    vi.mocked(pair).mockImplementationOnce(async () => {
      writeControl({ name: "Box", folders: [project], mode: "inherit", receivers: [receiver] });
      return readControl()!;
    });
    await run("pair", RX, "--mode", "inherit", "--no-service");
    expect(pair).toHaveBeenCalledWith(expect.objectContaining({ mode: "inherit" }));
    expect(said()).toContain("Mode: inherit (each harness's own default mode on this machine)");
  });

  it("the key the receiver hands over becomes a sink, at --tier, unless one with a key is configured", async () => {
    writeControl({ name: "lab", folders: [project], mode: "safe", receivers: [receiver] });
    vi.mocked(pair).mockImplementation(async (o) => {
      o.addSink?.("events-key");
      return readControl()!;
    });
    await run("pair", RX, "--no-service");
    expect(said()).toContain(
      "Sink rx.test added (tier 0: session state, no conversation text). `sessionpipe sink add https://rx.test --tier 2` sends transcripts too.",
    );
    expect(readConfig().sinks).toEqual([{ name: "rx.test", url: RX, tier: 0, pii: false, token: "events-key" }]);
    out = [];
    await run("pair", RX, "--no-service", "--tier", "1");
    expect(said()).not.toContain("Sink rx.test");
    writeConfig({ sinks: [{ name: "rx", url: RX, tier: 1 }], harnesses: {} });
    out = [];
    await run("pair", RX, "--no-service", "--tier", "9");
    expect(said()).toContain("Sink rx.test now carries the key the receiver handed over.");
    expect(readConfig().sinks[0]).toMatchObject({ tier: 1, token: "events-key" });
    writeConfig({ sinks: [], harnesses: {} });
    out = [];
    await run("pair", RX, "--no-service", "--tier", "9");
    expect(said()).toContain("Sink rx.test added at tier 3.");
    writeConfig({ sinks: [], harnesses: {} });
    out = [];
    await run("pair", RX, "--no-service", "--tier", "1");
    expect(said()).toContain("added (tier 1: tool activity, no conversation text)");
    writeConfig({ sinks: [], harnesses: {} });
    await expect(run("pair", RX, "--no-service", "--tier", "nan")).rejects.toThrow(
      '--tier takes 0, 1, 2 or 3, not "nan"',
    );
    expect(readConfig().sinks).toEqual([]);
  });

  it("adoptSinkToken works on a named config file too", () => {
    const file = path.join(tmp, "other.json");
    writeFileSync(file, JSON.stringify({ sinks: [{ name: "rx", url: RX, tier: 2, token_in: "keychain" }] }));
    expect(adoptSinkToken(RX, "k", 0, file)).toBe("kept");
    writeFileSync(file, JSON.stringify({ sinks: [] }));
    expect(adoptSinkToken(RX, "k", 2, file)).toBe("added");
    expect(readConfig(file).sinks[0]).toMatchObject({ url: RX, tier: 2, token: "k" });
  });
});

describe("control mode, keys, off, status, help", () => {
  it("mode: shows the current one (or that control isn't set up), then changes it", async () => {
    await run("mode");
    expect(said()).toContain("mode: not set up");
    expect(said()).toContain("usage: sessionpipe control mode auto|safe|inherit");
    out = [];
    await run("mode", "auto");
    expect(said()).toContain("control isn't set up on this machine");
    writeControl({ name: "lab", folders: [project], mode: "safe", receivers: [] });
    out = [];
    await run("mode", "auto");
    expect(said()).toContain("now run in auto mode (Claude Code's auto mode decides what's safe)");
    expect(readControl()?.mode).toBe("auto");
    out = [];
    await run("mode", "safe");
    expect(said()).toContain("now run in safe mode (only what each folder's settings already allow)");
    out = [];
    await run("mode", "inherit");
    expect(said()).toContain("now run in inherit mode (as your own sessions here run: each harness's own default)");
    expect(readControl()?.mode).toBe("inherit");
    out = [];
    // No mode is named after a harness's own bypass.
    await run("mode", "bypass");
    expect(said()).toContain("mode: inherit");
    expect(readControl()?.mode).toBe("inherit");
  });

  it("mode inherit: only when every paired receiver knows it; otherwise says why and keeps the mode", async () => {
    writeControl({ name: "lab", folders: [project], mode: "auto", receivers: [receiver] });
    vi.mocked(withoutInherit).mockResolvedValueOnce([
      "https://rx.test doesn't know inherit mode yet; it would show this machine as safe while the sessions you message run with no permission flag",
    ]);
    await run("mode", "inherit");
    expect(withoutInherit).toHaveBeenCalledWith([RX]);
    expect(said()).toContain("✗ https://rx.test doesn't know inherit mode yet; it would show this machine as safe");
    expect(said()).toContain("Mode stays auto.");
    expect(readControl()?.mode).toBe("auto");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    out = [];
    // Why may end in what the receiver sent for a well-known file: it stays on its line.
    vi.mocked(withoutInherit).mockResolvedValueOnce([
      `couldn't check that https://rx.test knows inherit mode (Unexpected token '<', "<html>\n  ✓ Sessions you message now run in inherit mode" is not valid JSON)`,
    ]);
    await run("mode", "inherit");
    expect(out[0]).toBe(
      `  ✗ couldn't check that https://rx.test knows inherit mode (Unexpected token '<', "<html>   ✓ Sessions you message now run in inherit mode" is not valid JSON).`,
    );
    expect(out.filter((l) => l.startsWith("  ✓"))).toEqual([]);
    process.exitCode = 0;
    out = [];
    await run("mode", "inherit");
    expect(readControl()?.mode).toBe("inherit");
    // Already in inherit: nothing to ask the receivers.
    vi.mocked(withoutInherit).mockClear();
    await run("mode", "inherit");
    expect(withoutInherit).not.toHaveBeenCalled();
  });

  it("keys: lists each receiver's keys with their kind and algorithm, removes one by id, says when there is none", async () => {
    await run("keys");
    expect(said()).toContain("control isn't paired on this machine");
    writeControl({ name: "lab", folders: [project], mode: "safe", receivers: [receiver] });
    out = [];
    await run("keys");
    expect(out).toEqual([
      `  ${RX} · machine m_0123456789abcdef`,
      "    es256key01234567…  passkey  ES256  added 2026-10-01",
      "    rs256key01234567…  passkey  RS256  added 2026-10-02",
      "    devicekey0123456…  device   ES256  added 2026-10-03  Mac app",
    ]);
    out = [];
    await run("keys", "remove", "rs256key");
    expect(said()).toBe("  removed 1 key(s)");
    out = [];
    await run("keys", "remove", "rs256key");
    expect(said()).toBe("  no such key");
    // `keys remove` with no id lists instead.
    out = [];
    await run("keys", "remove");
    expect(out[0]).toContain("machine m_0123456789abcdef");
  });

  it("off: by receiver or all; the service goes when the last receiver does", async () => {
    await run("off", RX);
    expect(off).toHaveBeenCalledWith(expect.objectContaining({ url: RX }));
    expect(uninstallService).not.toHaveBeenCalled();
    vi.mocked(off).mockResolvedValueOnce({ name: "lab", folders: [], mode: "safe", receivers: [receiver] });
    await run("off");
    expect(vi.mocked(off).mock.calls[1]?.[0]).not.toHaveProperty("url");
    expect(uninstallService).not.toHaveBeenCalled();
    vi.mocked(off).mockResolvedValueOnce({ name: "lab", folders: [], mode: "safe", receivers: [] });
    await run("off");
    expect(uninstallService).toHaveBeenCalledTimes(1);
    // The pool is on: Claude Code here depends on the daemon, so the service stays.
    vi.mocked(readPool).mockReturnValueOnce({ on: true, port: 51234, accounts: [] });
    vi.mocked(off).mockResolvedValueOnce({ name: "lab", folders: [], mode: "safe", receivers: [] });
    await run("off");
    expect(uninstallService).toHaveBeenCalledTimes(1);
    expect(said()).toContain("The daemon's service stays: the pool is on (`sessionpipe pool off` first to remove it).");
    // Asking turned on by hand keeps the daemon for its socket; `ask off` is what removes it.
    vi.mocked(off).mockResolvedValueOnce({ name: "lab", folders: [], mode: "safe", receivers: [], ask: true });
    await run("off");
    expect(uninstallService).toHaveBeenCalledTimes(1);
    expect(said()).toContain("The daemon stays: sessions here may still ask another agent");
  });

  it.runIf(process.platform !== "win32")("status: the daemon's answer as JSON, or that it isn't running", async () => {
    await run("status");
    expect(said()).toBe("  the control daemon isn't running");
    const server = net.createServer((s) =>
      s.once("data", () => s.end(`${JSON.stringify({ op: "status", status: { pid: 42, waiting: [] } })}\n`)),
    );
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      out = [];
      await run("status");
      expect(JSON.parse(said())).toEqual({ pid: 42, waiting: [] });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it.runIf(process.platform !== "win32")(
    "status at a terminal: the service's own account as a page; --json there, like a pipe, gets the JSON",
    async () => {
      await atTerminal("status");
      expect(out).toEqual(["  ✗ The background service isn't running. `sessionpipe doctor` says why, and what to do."]);
      out = [];
      await atTerminal("status", "--json");
      expect(out).toEqual(["  the control daemon isn't running"]);
      const status: Status = {
        version: "1.2.3",
        pid: 4242,
        name: "lab-box",
        receivers: [
          {
            url: RX,
            machine: "m_1",
            keys: 2,
            polling: true,
            last_poll: 1,
            last_poll_age_ms: 12_000,
            last_error: null,
          },
        ],
        waiting: ["claude-code:a"],
        mid_turn: [],
        attentions: [],
        sdk: [],
        nonces: 0,
        acks_pending: 0,
        delivered: {},
        start: { "claude-code": {} } as unknown as Status["start"],
        ask: { on: false, harnesses: [] },
        busy: null,
      };
      const server = net.createServer((s) =>
        s.once("data", () => s.end(`${JSON.stringify({ op: "status", status })}\n`)),
      );
      await new Promise<void>((r) => server.listen(sock, r));
      try {
        out = [];
        await atTerminal("status");
        expect(out).toEqual([]);
        expect(shown.map(plain)).toEqual([
          "✓ The background service is running",
          "  sessionpipe 1.2.3 · pid 4242 · lab-box",
          "",
          "Messages from",
          "  ✓ rx.test  live · heard 12 s ago · 2 keys trusted",
          "",
          "Right now",
          "  · in hand   nothing: it could restart at any moment",
          "  · sessions  0 mid-turn · 1 waiting for a message · 0 questions held",
          "",
          "It can",
          "  · start a session in     claude-code",
          "  · let agents ask agents  no (`sessionpipe ask on`)",
          "",
          "  Every field: sessionpipe control status --json",
        ]);
        // In the terminal's colours: the mark green, the verdict bold.
        expect(shown[0]).toBe("\x1b[32m✓\x1b[39m \x1b[1m\x1b[32mThe background service is running\x1b[39m\x1b[22m");
        shown = [];
        await atTerminal("status", "--json");
        expect(shown).toEqual([]);
        expect(JSON.parse(said())).toEqual(status);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  );

  it("mode at a terminal: each mode folded under its own text, its name in the first column", async () => {
    await atTerminal("mode");
    expect(out).toEqual(["  mode: not set up\n  usage: sessionpipe control mode auto|safe|inherit"]);
    const rows = shown.join("\n").split("\n");
    expect(rows.length).toBeGreaterThan(9);
    for (const l of rows) expect(plain(l).length).toBeLessThan(80);
    // A mode's name starts its first line, in bold; every further line hangs under the text.
    const named = rows.filter((l) => !plain(l).startsWith(" ".repeat(11)));
    expect(named.map((l) => l.split("\x1b[22m")[0])).toEqual(["  \x1b[1mauto", "  \x1b[1msafe", "  \x1b[1minherit"]);
    expect(named.map((l) => plain(l).slice(0, 13))).toEqual(["  auto     Cl", "  safe     On", "  inherit  As"]);
    // Folded, not cut: the words are all there, in order.
    const words = rows
      .map((l) => plain(l).trim())
      .join(" ")
      .replace(/ +/g, " ");
    expect(words).toContain(
      "auto Claude Code's auto mode: the session reads, edits and runs commands, and Claude Code's own safety check stops what looks dangerous.",
    );
    expect(words).toContain(
      "(Codex follows the approval_policy and sandbox_mode in its config.toml; Antigravity gets no flag, as in safe.)",
    );
    // Into a pipe: three whole lines.
    out = [];
    await run("mode");
    expect(out[1]?.split("\n").map((l) => l.slice(0, 11))).toEqual(["  auto     ", "  safe     ", "  inherit  "]);
  });

  it("anything else is the help", async () => {
    await run("nope");
    expect(said()).toBe(CONTROL_HELP);
    out = [];
    await run();
    expect(said()).toBe(CONTROL_HELP);
  });

  it("the harnesses an update re-arms: the ones set up here, by a name a hook file can carry", () => {
    expect(
      enabledHarnesses({ "claude-code": {}, codex: { enabled: true }, cursor: { enabled: false }, "Bad Name": {} }),
    ).toEqual(["claude-code", "codex"]);
  });
});

describe.runIf(process.platform !== "win32")("sessionpipe wait", () => {
  it("needs a session; then prints the message a daemon hands it", async () => {
    const code = process.exitCode;
    // Not inside a harness of our own (this test may well run from a Claude Code session).
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
    vi.stubEnv("CODEX_SESSION_ID", "");
    await waitMain(["wait"], (s) => out.push(s ?? ""));
    expect(said()).toContain("which session? Pass --session");
    expect(process.exitCode).toBe(2);
    process.exitCode = code;
    const server = net.createServer((s) =>
      s.once("data", (d) => {
        expect(JSON.parse(d.toString().trim())).toMatchObject({ op: "wait", session: "codex:thread-1" });
        s.end(`${JSON.stringify({ op: "message", text: "hi", id: "01K" })}\n`);
      }),
    );
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      out = [];
      await waitMain(["wait", "--session", "codex:thread-1"], (s) => out.push(s ?? ""));
      expect(said()).toMatch(/^hi\n\n\(Answer it right here/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
