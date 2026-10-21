// SPDX-License-Identifier: Apache-2.0
// `sessionpipe connect` end to end, the built CLI against an in-process receiver with
// open pairing, in a throwaway HOME: one command writes the hooks through the launcher,
// pairs, keeps the key the receiver hands over at tier 2, names each Claude Code account
// that isn't signed in — and a second run asks for nothing.
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeReceiver } from "./helpers/receiver.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../dist/cli.js");
let rx: FakeReceiver;
let tmp: string;
let home: string;
let project: string;
let env: NodeJS.ProcessEnv;

function run(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [cli, ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (b) => {
      out += b;
    });
    c.stderr.on("data", (b) => {
      out += b;
    });
    c.on("close", (code) => resolve({ code, out }));
  });
}

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
  rx.openPairing = true;
  rx.paired = true;
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-connect-"));
  home = path.join(tmp, "home");
  project = path.join(home, "code", "app");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  // A Claude Code that says this account is signed out.
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "claude"),
    `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn":false}'; exit 1; fi\necho "Usage: claude"\n`,
  );
  chmodSync(path.join(bin, "claude"), 0o755);
  env = {
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_DATA: path.join(tmp, "data"),
    SESSIONPIPE_SECRETS: "file",
    SESSIONPIPE_CLAUDE: path.join(bin, "claude"),
    SESSIONPIPE_NO_UPDATE_CHECK: "1",
  };
});
afterAll(async () => {
  await rx.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32" || !existsSync(cli))("connect", () => {
  it("one command: hooks through the launcher, paired, the sink at tier 2 with the handed-over key", async () => {
    const r = await run(["connect", rx.url, "--no-service", "--mode", "safe", "--machine", "Intel"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("not signed in as this shell sees it");
    expect(r.out).toContain("Approved by @fake on localhost");
    expect(r.out).toMatch(/Sink localhost:\d+: tier 2/);
    expect(r.out).toContain("Done:");

    const settings = readFileSync(path.join(home, ".claude", "settings.json"), "utf8");
    expect(settings).toContain(path.join(tmp, "data", "sessionpipe-hook"));
    expect(settings).not.toContain("dist/hook.js");

    const cfg = JSON.parse(readFileSync(env.SESSIONPIPE_CONFIG as string, "utf8")) as {
      sinks: { tier: number; token?: string; max_tier?: number }[];
    };
    expect(cfg.sinks).toHaveLength(1);
    expect(cfg.sinks[0]).toMatchObject({ tier: 2, token: "sink_from_pairing_0123456789", max_tier: 2 });

    const ctl = JSON.parse(readFileSync(path.join(tmp, "config", "control.json"), "utf8")) as {
      folders: string[];
      mode: string;
      receivers: { machine: string }[];
    };
    expect(ctl.receivers[0]?.machine).toBe(rx.machine);
    expect(ctl.folders).toEqual([realpathSync(project)]);
    expect(ctl.mode).toBe("safe");
  }, 30_000);

  it("again: nothing to approve, nothing duplicated", async () => {
    const r = await run(["connect", rx.url, "--no-service", "--machine", "Intel"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Already paired");
    const settings = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    for (const [ev, list] of Object.entries(settings.hooks))
      expect(list, `${ev}: ${JSON.stringify(list)}`).toHaveLength(1);
  }, 30_000);

  it("a repeated setup line keeps the paired machine name even with a different --machine", async () => {
    const configFile = env.SESSIONPIPE_CONFIG as string;
    const controlFile = path.join(tmp, "config", "control.json");
    const before = JSON.parse(readFileSync(configFile, "utf8")) as { machine: string };
    const control = readFileSync(controlFile, "utf8");
    const r = await run(["connect", rx.url, "--no-service", "--machine", "Intel-mbp"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`Keeping configured machine name ${before.machine}`);
    expect(r.out).toContain("Already paired");
    expect(JSON.parse(readFileSync(configFile, "utf8")).machine).toBe(before.machine);
    expect(readFileSync(controlFile, "utf8")).toBe(control);
  }, 30_000);

  it("an explicit rename renames the hooks and the paired daemon together", async () => {
    const configFile = env.SESSIONPIPE_CONFIG as string;
    const controlFile = path.join(tmp, "config", "control.json");
    const before = JSON.parse(readFileSync(controlFile, "utf8")) as { name: string; receivers: unknown[] };
    const r = await run(["connect", rx.url, "--no-service", "--machine", "Intel-mbp", "--rename-machine"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`Renamed the control daemon ${before.name} → Intel-mbp`);
    expect(JSON.parse(readFileSync(configFile, "utf8")).machine).toBe("Intel-mbp");
    const after = JSON.parse(readFileSync(controlFile, "utf8")) as { name: string; receivers: unknown[] };
    expect(after.name).toBe("Intel-mbp");
    // The pairing itself is untouched: same receivers, same ids, same keys.
    expect(after.receivers).toEqual(before.receivers);
  }, 30_000);
});
