// SPDX-License-Identifier: Apache-2.0
// `sessionpipe control …` and `sessionpipe wait` at the terminal: every flag of `pair`
// (and the one question it asks), `mode`, `keys`, `off`, `status`, the help, and what
// a key the receiver hands over at pairing becomes in config.json. The pairing itself
// and the service writers are stubbed; control.json and config.json are real, in a
// temp dir.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readConfig, writeConfig } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptSinkToken, CONTROL_HELP, controlMain, enabledHarnesses, waitMain } from "../src/control/cli.js";
import { installService, off, pair, uninstallService, withoutInherit } from "../src/control/pair.js";
import { readControl, writeControl } from "../src/control/store.js";
import { readPool } from "../src/pool/index.js";

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
    expect(said()).toContain("Daemon: not installed as a service (--no-service)");
    expect(installService).not.toHaveBeenCalled();
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
    expect(said()).toContain("Daemon: launchd agent (stand-in)");
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
    expect(said()).toContain("inherit As your own sessions here run: no permission flag");
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
    await run("pair", RX, "--no-service", "--tier", "nan");
    expect(readConfig().sinks[0]?.tier).toBe(0);
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
