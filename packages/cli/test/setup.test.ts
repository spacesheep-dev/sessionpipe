// SPDX-License-Identifier: Apache-2.0
// Run the setup CLI as an older npx package, with npm confined to a throwaway prefix.
// No registry, global installation, keychain or service is touched by these tests.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { launcherScript } from "../src/launcher.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const offered = "0.7.0";
let compiled: string;
let tmp: string;
let prefix: string;
let npxCli: string;
let directCli: string;
let env: NodeJS.ProcessEnv;

function put(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function snapshot(dir: string): unknown {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => {
        const file = path.join(dir, name);
        const st = statSync(file);
        return [
          name,
          st.isDirectory()
            ? snapshot(file)
            : {
                hash: createHash("sha256").update(readFileSync(file)).digest("hex"),
                mode: st.mode,
                mtime: st.mtimeMs,
              },
        ];
      }),
  );
}

function installed(version: string): void {
  put(path.join(prefix, "lib/node_modules/sessionpipe/package.json"), JSON.stringify({ version, type: "module" }));
  put(path.join(prefix, "lib/node_modules/sessionpipe/dist/cli.js"), "// installed CLI\n");
  put(path.join(prefix, "lib/node_modules/sessionpipe/dist/hook.js"), "// installed hook\n");
  put(path.join(prefix, "lib/node_modules/sessionpipe/dist/worker.js"), "// installed worker\n");
}

function hooks(version: string): void {
  const data = env.SESSIONPIPE_DATA as string;
  put(path.join(data, "sessionpipe-hook"), launcherScript(process.execPath, path.join(data, "hook.js"), version));
  put(path.join(data, "hook.js"), "// newer persistent hook\n");
  put(path.join(data, "worker.js"), "// newer persistent worker\n");
}

function run(args: string[], cli = npxCli) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: tmp, env, encoding: "utf8", timeout: 15_000 });
  expect(r.error).toBeUndefined();
  return { code: r.status, out: r.stdout + r.stderr };
}

function config(): { machine?: string } {
  return JSON.parse(readFileSync(env.SESSIONPIPE_CONFIG as string, "utf8"));
}

const installArgs = ["install", "--claude-code", "--backfill", "0"];
const connectArgs = ["connect", "https://receiver.invalid", "--no-service"];

describe.runIf(process.platform !== "win32")("setup preserves installed code and machine identity", () => {
  beforeAll(async () => {
    compiled = mkdtempSync(path.join(os.tmpdir(), "sp-setup-build-"));
    await build({
      entryPoints: [path.join(root, "packages/cli/src/cli.ts")],
      outfile: path.join(compiled, "cli.js"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      alias: {
        "@sessionpipe/core": path.join(root, "packages/core/src/index.ts"),
        "@sessionpipe/core/control": path.join(root, "packages/core/src/control/index.ts"),
      },
      define: { __SESSIONPIPE_VERSION__: JSON.stringify(offered) },
    });
  });
  afterAll(() => rmSync(compiled, { recursive: true, force: true }));
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "sp-setup-"));
    prefix = path.join(tmp, "prefix");
    const bin = path.join(tmp, "bin");
    env = {
      HOME: tmp,
      PATH: bin,
      SESSIONPIPE_CONFIG: path.join(tmp, "config/config.json"),
      SESSIONPIPE_STATE: path.join(tmp, "state"),
      SESSIONPIPE_DATA: path.join(tmp, "data"),
      SESSIONPIPE_SECRETS: "file",
      SESSIONPIPE_NO_UPDATE_CHECK: "1",
    };
    npxCli = path.join(tmp, ".npm/_npx/test/node_modules/sessionpipe/dist/cli.js");
    directCli = path.join(tmp, "direct/dist/cli.js");
    for (const cli of [npxCli, directCli]) {
      put(path.join(path.dirname(cli), "../package.json"), JSON.stringify({ type: "module", version: offered }));
      mkdirSync(path.dirname(cli), { recursive: true });
      copyFileSync(path.join(compiled, "cli.js"), cli);
      put(path.join(path.dirname(cli), "hook.js"), "// offered hook\n");
      put(path.join(path.dirname(cli), "worker.js"), "// offered worker\n");
    }
    put(env.SESSIONPIPE_CONFIG as string, JSON.stringify({ machine: "Intel", sinks: [], harnesses: {} }));
    put(path.join(tmp, ".claude/settings.json"), "{}\n");
    put(path.join(tmp, "state/backoff/spacesheep.json"), '{"until":1792022400000}\n');
    put(
      path.join(bin, "npm"),
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'prefix') { console.log(process.env.SETUP_TEST_PREFIX || ${JSON.stringify(prefix)}); process.exit(0); }
if (args[0] !== 'install') process.exit(98);
fs.writeFileSync(${JSON.stringify(path.join(tmp, "npm-install.json"))}, JSON.stringify(args));
const target = args[args.indexOf('--prefix') + 1];
const pkg = path.join(target, 'lib/node_modules/sessionpipe');
fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ type: 'module', version: ${JSON.stringify(offered)} }));
for (const file of ['cli.js', 'hook.js', 'worker.js']) fs.copyFileSync(path.join(${JSON.stringify(path.dirname(npxCli))}, file), path.join(pkg, 'dist', file));
fs.mkdirSync(path.join(target, 'bin'), { recursive: true });
const script = '#!${process.execPath}\\n' + 'const { spawnSync } = require("node:child_process");\\n' +
  'process.exit(spawnSync(' + JSON.stringify(process.execPath) + ', [' + JSON.stringify(path.join(pkg, 'dist/cli.js')) + ', ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 1);\\n';
fs.writeFileSync(path.join(target, 'bin/sessionpipe'), script, { mode: 0o755 });
`,
    );
    chmodSync(path.join(bin, "npm"), 0o755);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  for (const args of [installArgs, connectArgs]) {
    it(`${args[0]} refuses 0.7.0 over global 0.9.0-devin.1 before any writes`, () => {
      installed("0.9.0-devin.1");
      hooks(offered); // Independently exercise the package check, not the launcher check.
      const before = snapshot(tmp);
      const r = run([...args, "--machine", "Intel-mbp"]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("refusing to downgrade");
      expect(r.out).toContain("0.9.0-devin.1");
      expect(r.out).toContain("would install 0.7.0");
      expect(r.out).toContain("--allow-downgrade");
      expect(snapshot(tmp)).toEqual(before);
    });

    for (const via of ["npx", "direct"]) {
      it(`${args[0]} from ${via} protects newer hook copies even without the global package`, () => {
        hooks("0.9.0-devin.1");
        const before = snapshot(tmp);
        const r = run(args, via === "npx" ? npxCli : directCli);
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain("--allow-downgrade");
        expect(snapshot(tmp)).toEqual(before);
      });
    }

    it(`${args[0]} refuses an explicit rename that would split a paired daemon before npm or hook writes`, () => {
      put(path.join(tmp, "config/control.json"), JSON.stringify({ name: "Intel", receivers: [{ machine: "Intel" }] }));
      const before = snapshot(tmp);
      const r = run([...args, "--machine", "Intel-mbp", "--rename-machine", "--allow-downgrade"]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("refusing to rename");
      expect(snapshot(tmp)).toEqual(before);
    });
  }

  it.each([null, "0.6.0", "0.7.0-devin.1", "0.7.0"])(
    "installs normally over %s (or no installed version)",
    (version) => {
      if (version) {
        installed(version);
        hooks(version);
      }
      const r = run(installArgs);
      expect(r.code, r.out).toBe(0);
      expect(JSON.parse(readFileSync(path.join(tmp, "npm-install.json"), "utf8"))).toContain("sessionpipe@0.7.0");
      expect(readFileSync(path.join(env.SESSIONPIPE_DATA as string, "hook.js"), "utf8")).toBe("// offered hook\n");
      expect(readFileSync(path.join(env.SESSIONPIPE_DATA as string, "worker.js"), "utf8")).toBe("// offered worker\n");
      expect(readFileSync(path.join(tmp, ".claude/settings.json"), "utf8")).toContain("sessionpipe-hook");
    },
  );

  it("--allow-downgrade explicitly replaces the global package and both hook copies", () => {
    installed("0.9.0-devin.1");
    hooks("0.9.0-devin.1");
    const r = run([...installArgs, "--allow-downgrade"]);
    expect(r.code, r.out).toBe(0);
    expect(
      JSON.parse(readFileSync(path.join(prefix, "lib/node_modules/sessionpipe/package.json"), "utf8")).version,
    ).toBe(offered);
    expect(readFileSync(path.join(env.SESSIONPIPE_DATA as string, "hook.js"), "utf8")).toBe("// offered hook\n");
    expect(readFileSync(path.join(env.SESSIONPIPE_DATA as string, "worker.js"), "utf8")).toBe("// offered worker\n");
  });

  it("checks the persistent Homebrew target instead of the disappearing Cellar prefix", () => {
    env.SETUP_TEST_PREFIX = path.join(tmp, "Cellar/node/22.0.0");
    prefix = path.join(tmp, ".local");
    installed("0.9.0-devin.1");
    const before = snapshot(tmp);
    const r = run(installArgs);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(prefix);
    expect(snapshot(tmp)).toEqual(before);
  });

  it("a direct CLI also checks the global package before writing hooks", () => {
    installed("0.9.0-devin.1");
    const before = snapshot(tmp);
    const r = run(installArgs, directCli);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("would install 0.7.0");
    expect(snapshot(tmp)).toEqual(before);
  });

  it("install preserves a paired name and backoff when a setup command suggests another name", () => {
    const control = path.join(tmp, "config/control.json");
    put(control, JSON.stringify({ name: "Intel", receivers: [{ machine: "Intel" }] }));
    const beforeControl = readFileSync(control, "utf8");
    const beforeBackoff = snapshot(path.join(tmp, "state/backoff"));
    const r = run([...installArgs, "--machine", "Intel-mbp"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Keeping configured machine name Intel");
    expect(config().machine).toBe("Intel");
    expect(readFileSync(control, "utf8")).toBe(beforeControl);
    expect(snapshot(path.join(tmp, "state/backoff"))).toEqual(beforeBackoff);
  });

  it("an unpaired machine needs --rename-machine to change its configured name", () => {
    expect(run([...installArgs, "--machine", "Intel-mbp"], directCli).code).toBe(0);
    expect(config().machine).toBe("Intel");
    expect(run([...installArgs, "--machine", "Intel-mbp", "--rename-machine"], directCli).code).toBe(0);
    expect(config().machine).toBe("Intel-mbp");
  });

  it("a legacy config without a machine name keeps the daemon's name", () => {
    put(env.SESSIONPIPE_CONFIG as string, JSON.stringify({ sinks: [], harnesses: {} }));
    put(
      path.join(tmp, "config/control.json"),
      JSON.stringify({ name: "Intel", receivers: [{ machine: "opaque-id" }] }),
    );
    const r = run([...installArgs, "--machine", "Intel-mbp"], directCli);
    expect(r.code, r.out).toBe(0);
    expect(config().machine).toBe("Intel");
  });

  it("a locally configured daemon also cannot be renamed by setup", () => {
    put(path.join(tmp, "config/control.json"), JSON.stringify({ name: "Intel", receivers: [] }));
    const before = snapshot(tmp);
    const r = run([...installArgs, "--machine", "Intel-mbp", "--rename-machine"], directCli);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("refusing to rename");
    expect(snapshot(tmp)).toEqual(before);
  });

  it("--machine sets the initial name; the default hostname is also persisted", () => {
    rmSync(env.SESSIONPIPE_CONFIG as string);
    expect(run(installArgs, directCli).code).toBe(0);
    expect(config().machine).toBe(os.hostname().replace(/\.(local|lan|home)$/i, ""));
    rmSync(env.SESSIONPIPE_CONFIG as string);
    expect(run([...installArgs, "--machine", "Intel-mbp"], directCli).code).toBe(0);
    expect(config().machine).toBe("Intel-mbp");
  });

  it("--rename-machine requires a name, without touching the install", () => {
    const before = snapshot(tmp);
    const r = run([...installArgs, "--rename-machine"]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("--machine NAME is required");
    expect(snapshot(tmp)).toEqual(before);
    expect(existsSync(path.join(tmp, "npm-install.json"))).toBe(false);
  });
});
