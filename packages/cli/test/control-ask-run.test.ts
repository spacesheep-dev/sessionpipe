// SPDX-License-Identifier: Apache-2.0
// `sessionpipe control run` with no paired receiver: the daemon still serves asks on the
// local socket (CONTROL.md §13), so it runs unless asking is off too. The daemon, the
// updater and the SDK loader are stand-ins, as in control-run.test.ts.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlMain } from "../src/control/cli.js";
import { writeControl } from "../src/control/store.js";

const seen = vi.hoisted(() => ({ daemons: [] as { cfg: { receivers: unknown[]; ask?: boolean } }[] }));

vi.mock("../src/control/daemon.js", async (original) => {
  const real = await original<typeof import("../src/control/daemon.js")>();
  class ControlDaemon {
    constructor(readonly cfg: { receivers: unknown[]; ask?: boolean }) {
      seen.daemons.push(this);
    }
    async start() {}
    async stop() {}
    reload() {}
  }
  return { ...real, ControlDaemon };
});
vi.mock("../src/control/autoupdate.js", async (original) => {
  const real = await original<typeof import("../src/control/autoupdate.js")>();
  class AutoUpdater {
    start() {}
    stop() {}
    restartWhenIdle() {
      return true;
    }
    record() {
      return null;
    }
  }
  return { ...real, AutoUpdater };
});
vi.mock("../src/control/sdk.js", () => ({ loadSdk: vi.fn(async () => null) }));
vi.mock("@sessionpipe/core", async (original) => {
  const real = await original<typeof import("@sessionpipe/core")>();
  return {
    ...real,
    claudeControl: { ...real.claudeControl, findClaude: () => null },
    codexControl: { ...real.codexControl, findCodex: () => null },
    antigravityControl: { ...real.antigravityControl, findAgy: () => null },
    acpControl: { ...real.acpControl, findAcpAgent: () => null },
    drivableHarnesses: () => [],
  };
});
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  return { ...real, watchFile: vi.fn(), unwatchFile: vi.fn() };
});

let tmp: string;
let out: string[];
type Listener = (...args: unknown[]) => void;
const SIGS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
const emitter = process as unknown as { listeners(e: string): Listener[]; off(e: string, l: Listener): void };
let before: Map<string, Listener[]>;

const run = () => controlMain(["control", "run"], (s) => out.push(s ?? ""), path.join(tmp, "dist"));
const unpaired = (ask?: boolean) =>
  writeControl({ name: "box", folders: [tmp], mode: "safe", receivers: [], ...(ask === undefined ? {} : { ask }) });

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-ask-run-")));
  vi.stubEnv("SESSIONPIPE_CONFIG", path.join(tmp, "config", "config.json"));
  vi.stubEnv("SESSIONPIPE_STATE", path.join(tmp, "state"));
  vi.stubEnv("SESSIONPIPE_SOCKET", path.join(tmp, "control.sock"));
  out = [];
  seen.daemons.length = 0;
  before = new Map(SIGS.map((s) => [s, emitter.listeners(s)]));
});
afterEach(() => {
  for (const sig of SIGS)
    for (const l of emitter.listeners(sig)) if (!before.get(sig)?.includes(l)) emitter.off(sig, l);
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("control run with no receiver", () => {
  it("nothing set up at all: nothing to do, as before", async () => {
    await run();
    expect(out).toEqual([
      "control isn't paired on this machine; nothing to do (`sessionpipe control pair <receiver>`)",
    ]);
    expect(seen.daemons).toEqual([]);
  });

  it("asking off too: nothing to do, and both ways to change that", async () => {
    unpaired(false);
    await run();
    expect(out).toEqual([
      "control isn't paired on this machine and asking is off; nothing to do (`sessionpipe control pair <receiver>` or `sessionpipe ask on`)",
    ]);
    expect(seen.daemons).toEqual([]);
  });

  it("asking on (said, or unsaid): the daemon runs for the local socket alone", async () => {
    unpaired(true);
    await run();
    expect(seen.daemons).toHaveLength(1);
    expect(seen.daemons[0]?.cfg).toMatchObject({ receivers: [], ask: true });
    expect(out.join("\n")).not.toContain("nothing to do");
    unpaired();
    await run();
    expect(seen.daemons).toHaveLength(2);
    expect(seen.daemons[1]?.cfg.receivers).toEqual([]);
  });
});
