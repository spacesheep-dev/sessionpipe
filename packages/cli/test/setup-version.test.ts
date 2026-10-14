// SPDX-License-Identifier: Apache-2.0
// Exercise the bundled CLI's actual npx handoff with a local npm stand-in. No
// registry access, global installation or real user config is allowed by the fixture.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launcherScript } from "../src/launcher.js";
import { checkInstallVersion } from "../src/runtime.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const version: string = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;
let tmp: string;
let target: string;
let cached: string;
let env: NodeJS.ProcessEnv;
function put(file: string, text: string, executable = false): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, executable ? { mode: 0o755 } : undefined);
}
function installed(v: string, platform: NodeJS.Platform = process.platform): void {
  put(
    path.join(target, ...(platform === "win32" ? [] : ["lib"]), "node_modules/sessionpipe/package.json"),
    JSON.stringify({ version: v }),
  );
}
function run(command: string[], npx = true) {
  return spawnSync(process.execPath, [npx ? cached : cli, ...command], {
    env,
    cwd: tmp,
    encoding: "utf8",
    timeout: 10000,
  });
}
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-setup-version-"));
  target = path.join(tmp, "global");
  cached = path.join(tmp, "_npx/sessionpipe/dist/cli.js");
  mkdirSync(path.dirname(cached), { recursive: true });
  copyFileSync(cli, cached);
  env = {
    HOME: tmp,
    PATH: path.join(tmp, "bin"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config.json"),
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_DATA: path.join(tmp, "data"),
    SESSIONPIPE_SECRETS: "file",
    SESSIONPIPE_NO_UPDATE_CHECK: "1",
    TEST_PREFIX: target,
    TEST_LOG: path.join(tmp, "npm-installed"),
    TEST_RERUN: path.join(tmp, "rerun.json"),
  };
  put(
    path.join(tmp, "bin/npm"),
    `#!${process.execPath}\nconst fs = require('node:fs'); if (process.argv[2] === 'prefix') console.log(process.env.TEST_PREFIX); else fs.writeFileSync(process.env.TEST_LOG, JSON.stringify(process.argv.slice(2)));\n`,
    true,
  );
  put(
    path.join(target, "bin/sessionpipe"),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.TEST_RERUN, JSON.stringify(process.argv.slice(2)));\n`,
    true,
  );
  put(env.SESSIONPIPE_CONFIG!, JSON.stringify({ machine: "Intel", sinks: [], harnesses: {} }));
  put(path.join(tmp, "data/hook.js"), "existing hook");
  put(path.join(tmp, "data/worker.js"), "existing worker");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

for (const command of [
  ["install", "--claude-code", "--backfill", "0"],
  ["connect", "https://receiver.invalid", "--no-service"],
]) {
  describe.skipIf(process.platform === "win32")(`${command[0]} setup version guard`, () => {
    for (const newer of ["99.0.0", "99.0.0-dev.1"])
      it(`refuses a newer global ${newer} before npm, config or hook writes`, () => {
        installed(newer);
        const config = readFileSync(env.SESSIONPIPE_CONFIG!, "utf8");
        const r = run(command);
        expect(r.status, r.stderr).toBe(1);
        expect(r.stderr).toContain(`found sessionpipe ${newer}`);
        expect(r.stderr).toContain(`would install ${version}`);
        expect(r.stderr).toContain("--allow-downgrade");
        expect(existsSync(env.TEST_LOG!)).toBe(false);
        expect(existsSync(env.TEST_RERUN!)).toBe(false);
        expect(readFileSync(env.SESSIONPIPE_CONFIG!, "utf8")).toBe(config);
        expect(readFileSync(path.join(tmp, "data/hook.js"), "utf8")).toBe("existing hook");
        expect(readFileSync(path.join(tmp, "data/worker.js"), "utf8")).toBe("existing worker");
      });

    it("allows the same version to install and rerun the original command", () => {
      installed(version);
      const r = run(command);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(readFileSync(env.TEST_RERUN!, "utf8"))).toEqual(command);
      expect(readFileSync(env.TEST_LOG!, "utf8")).toContain(`sessionpipe@${version}`);
    });

    it("allows an explicit downgrade and forwards the override", () => {
      installed("99.0.0");
      const args = [...command, "--allow-downgrade"];
      const r = run(args);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(readFileSync(env.TEST_RERUN!, "utf8"))).toEqual(args);
    });

    it("also refuses to replace newer hook copies from a directly invoked older CLI", () => {
      installed(version);
      put(path.join(tmp, "data/sessionpipe-hook"), launcherScript(process.execPath, "hook.js", "99.0.0-dev.1"));
      const r = run(command, false);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain("99.0.0-dev.1");
      expect(readFileSync(path.join(tmp, "data/worker.js"), "utf8")).toBe("existing worker");
    });
  });
}

it("checks the Windows global package layout too", () => {
  installed("99.0.0-dev.1", "win32");
  expect(() => checkInstallVersion(version, { target, env, platform: "win32" })).toThrow("99.0.0-dev.1");
});

// These invoke the real setup command, with no daemon paired in this fixture.
describe.skipIf(process.platform === "win32")("install machine names", () => {
  for (const [flags, expected] of [
    [[], "Intel"],
    [["--machine", "Intel-mbp"], "Intel"],
    [["--rename-machine", "Intel-mbp"], "Intel-mbp"],
  ] as [string[], string][])
    it(`preserves the name unless explicitly renamed: ${flags.join(" ") || "no flags"}`, () => {
      installed(version);
      const r = run(["install", "--claude-code", "--backfill", "0", ...flags], false);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(readFileSync(env.SESSIONPIPE_CONFIG!, "utf8")).machine).toBe(expected);
    });
});
