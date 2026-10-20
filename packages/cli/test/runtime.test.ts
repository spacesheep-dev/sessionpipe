// SPDX-License-Identifier: Apache-2.0
// What setup asks of the machine before it writes anything: the node path that survives
// a Homebrew upgrade, whether this copy came from npx, the refusal to downgrade over a
// newer installed copy or newer hooks, and the handoff of a command to a persistent
// copy. npm is stood in for at the process boundary; nothing here installs anything.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLauncher, launcherScript } from "../src/launcher.js";
import { VERSION } from "../src/run.js";
import { assertSetupVersion, rerunGlobally, stableNode, viaNpx } from "../src/runtime.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

let tmp: string;
const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
const onPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p, configurable: true });

/** A global install under `prefix`, with its package.json saying `version`. */
function installed(prefix: string, version: unknown, lib = true): string {
  const pkg = path.join(prefix, ...(lib ? ["lib"] : []), "node_modules", "sessionpipe", "package.json");
  mkdirSync(path.dirname(pkg), { recursive: true });
  writeFileSync(pkg, typeof version === "string" && version.startsWith("{") ? version : JSON.stringify({ version }));
  return pkg;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-runtime-")));
  vi.stubEnv("SESSIONPIPE_DATA", path.join(tmp, "data"));
  vi.mocked(execFileSync).mockReset();
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("stableNode and viaNpx", () => {
  it("leaves a node that isn't Homebrew's, or one that no longer exists, as it is", () => {
    expect(stableNode("/usr/local/bin/node")).toBe("/usr/local/bin/node");
    const gone = path.join(tmp, "Cellar", "node", "25.0.0", "bin", "node");
    expect(stableNode(gone)).toBe(gone);
  });

  it("knows the npx cache by either of its spellings", () => {
    expect(viaNpx("/home/me/.npm/_npx/abc/node_modules/sessionpipe/dist")).toBe(true);
    expect(viaNpx("C:\\Users\\me\\.npm\\_npx\\abc\\dist")).toBe(true);
    expect(viaNpx("/home/me/.npm/x/dist")).toBe(true);
    expect(viaNpx("/usr/local/lib/node_modules/sessionpipe/dist")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("assertSetupVersion", () => {
  it("--allow-downgrade asks nothing", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("not asked");
    });
    expect(() => assertSetupVersion(true)).not.toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("refuses when the hooks already run a newer sessionpipe, naming the launcher", () => {
    writeFileSync(path.join(tmp, "hook.js"), "");
    writeFileSync(path.join(tmp, "worker.js"), "");
    const { launcher } = installLauncher({ distDir: tmp, node: process.execPath, version: "99.0.0" });
    expect(() => assertSetupVersion(false)).toThrow(
      `refusing to downgrade sessionpipe: 99.0.0 is installed at ${launcher}; this command would install ${VERSION}. Use the installed newer CLI, or pass --allow-downgrade to force ${VERSION}.`,
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("asks npm for its prefix, and stops there when npm has none", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("no npm");
    });
    expect(() => assertSetupVersion(false)).not.toThrow();
    expect(execFileSync).toHaveBeenCalledWith("npm", ["prefix", "-g"], expect.objectContaining({ timeout: 15000 }));
  });

  it("refuses over a newer copy in the prefix, by npm's layout per platform; an older or unreadable one is fine", () => {
    const prefix = path.join(tmp, "prefix");
    vi.mocked(execFileSync).mockReturnValue(`${prefix}\n`);
    const pkg = installed(prefix, "99.0.0-rc.1");
    expect(() => assertSetupVersion(false)).toThrow(`99.0.0-rc.1 is installed at ${pkg}`);
    installed(prefix, VERSION);
    expect(() => assertSetupVersion(false)).not.toThrow();
    installed(prefix, "{not json");
    expect(() => assertSetupVersion(false)).not.toThrow();
    installed(prefix, 7);
    expect(() => assertSetupVersion(false)).not.toThrow();
    // The prefix given by the caller wins over npm's.
    expect(() => assertSetupVersion(false, path.join(tmp, "elsewhere"))).not.toThrow();
    installed(prefix, "99.0.0", false);
    onPlatform("win32");
    expect(() => assertSetupVersion(false, prefix)).toThrow("99.0.0 is installed at");
  });

  it("Homebrew's versioned prefix is not where a persistent copy lives: ~/.local is", () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmp);
    vi.mocked(execFileSync).mockReturnValue(`${tmp}/Cellar/node/25.0.0\n`);
    const pkg = installed(path.join(tmp, ".local"), "99.0.0");
    expect(() => assertSetupVersion(false)).toThrow(`99.0.0 is installed at ${pkg}`);
  });
});

describe.skipIf(process.platform === "win32")("rerunGlobally", () => {
  const argv = ["install", "--claude-code"];
  const calls = () => vi.mocked(execFileSync).mock.calls.map((c) => [c[0], ...(c[1] as string[])]);

  it("installs into npm's prefix and hands the command to the copy there, passing its exit status on", () => {
    const prefix = path.join(tmp, "prefix");
    const lines: string[] = [];
    vi.mocked(execFileSync).mockImplementation(((cmd: string) => {
      if (cmd === "npm") return `${prefix}\n`;
      throw Object.assign(new Error("the command failed"), { status: 3 });
    }) as never);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    rerunGlobally(argv, (s) => lines.push(s), { allowDowngrade: false });
    expect(lines).toEqual([
      `  Installing sessionpipe@${VERSION} globally, so hooks and services use a persistent copy…`,
    ]);
    expect(calls()).toEqual([
      ["npm", "prefix", "-g"],
      ["npm", "install", "-g", `sessionpipe@${VERSION}`, "--prefix", prefix],
      [path.join(prefix, "bin", "sessionpipe"), ...argv],
    ]);
    expect(exit).toHaveBeenCalledWith(3);
  });

  it("a failure without a status is exit 1; npm without a prefix means `sessionpipe` on PATH", () => {
    vi.mocked(execFileSync).mockImplementation(((cmd: string) => {
      if (cmd === "npm") throw new Error("npm prefix failed");
      throw new Error("no status");
    }) as never);
    // The first call (npm prefix) fails, the install itself passes: both are `npm`.
    let n = 0;
    vi.mocked(execFileSync).mockImplementation(((cmd: string) => {
      n++;
      if (n === 1) throw new Error("npm prefix failed");
      if (cmd === "npm") return "";
      throw new Error("no status");
    }) as never);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    rerunGlobally(argv, () => {});
    expect(calls()[1]).toEqual(["npm", "install", "-g", `sessionpipe@${VERSION}`]);
    expect(calls()[2]).toEqual(["sessionpipe", ...argv]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("a Homebrew prefix is replaced by ~/.local, and said so; on Windows the copy is sessionpipe.cmd", () => {
    vi.spyOn(os, "homedir").mockReturnValue(tmp);
    const lines: string[] = [];
    vi.mocked(execFileSync).mockImplementation(((cmd: string) =>
      cmd === "npm" ? `${tmp}/Cellar/node/25.0.0\n` : "") as never);
    rerunGlobally(argv, (s) => lines.push(s));
    expect(lines[1]).toBe(`  Installed into ${tmp}/.local; make sure ${tmp}/.local/bin is on your PATH.`);
    expect(calls()[2]).toEqual([path.join(tmp, ".local", "bin", "sessionpipe"), ...argv]);
    vi.mocked(execFileSync).mockClear();
    onPlatform("win32");
    rerunGlobally(argv, () => {});
    expect(calls()[2]).toEqual([path.join(tmp, ".local", "sessionpipe.cmd"), ...argv]);
    expect(vi.mocked(execFileSync).mock.calls[2]?.[2]).toEqual({ stdio: "inherit", shell: true });
  });

  it("when npm can't install, it says so and exits 1 before running anything", () => {
    let n = 0;
    vi.mocked(execFileSync).mockImplementation((() => {
      if (++n === 1) return `${tmp}/prefix\n`;
      throw new Error("EACCES");
    }) as never);
    const lines: string[] = [];
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    expect(() => rerunGlobally(argv, (s) => lines.push(s))).toThrow("exit");
    expect(lines[1]).toContain("couldn't install globally");
    expect(exit).toHaveBeenCalledWith(1);
    expect(calls()).toHaveLength(2);
  });

  it("refuses to downgrade before installing: a newer launcher, or a newer copy in the target", () => {
    writeFileSync(path.join(tmp, "hook.js"), "");
    writeFileSync(path.join(tmp, "worker.js"), "");
    vi.mocked(execFileSync).mockReturnValue(`${tmp}/prefix\n`);
    installed(path.join(tmp, "prefix"), "99.0.0");
    expect(() => rerunGlobally(argv, () => {}, { allowDowngrade: false })).toThrow(/refusing to downgrade/);
    expect(calls()).toEqual([["npm", "prefix", "-g"]]);
    mkdirSync(path.join(tmp, "data"), { recursive: true });
    writeFileSync(path.join(tmp, "data", "sessionpipe-hook"), launcherScript(process.execPath, "/x/hook.js", "99.0.0"));
    expect(() => rerunGlobally(argv, () => {}, { allowDowngrade: false })).toThrow(
      /99\.0\.0 is installed at .*sessionpipe-hook/,
    );
  });
});
