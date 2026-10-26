// SPDX-License-Identifier: Apache-2.0
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
import { controlMain } from "../src/control/cli.js";
import { pair, serviceFiles } from "../src/control/pair.js";
import { readControl } from "../src/control/store.js";
import { stableNode } from "../src/runtime.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));
vi.mock("@sessionpipe/core", async (original) => ({
  ...(await original<typeof import("@sessionpipe/core")>()),
  readConfig: () => ({ sinks: [] }),
}));
vi.mock("../src/control/store.js", async (original) => ({
  ...(await original<typeof import("../src/control/store.js")>()),
  readControl: vi.fn(() => ({ folders: ["/project"], mode: "safe", receivers: [], name: "test" })),
}));
// Keep the real platform service writers; only the receiver pairing is stubbed.
vi.mock("../src/control/pair.js", async (original) => ({
  ...(await original<typeof import("../src/control/pair.js")>()),
  pair: vi.fn(async () => {}),
}));

describe.skipIf(process.platform === "win32")("POSIX control service paths", () => {
  let home: string;
  const platform = process.platform;
  const execPath = process.execPath;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sessionpipe-service-")));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.stubEnv("XDG_STATE_HOME", path.join(home, "state"));
    vi.clearAllMocks();
    vi.mocked(execFileSync).mockReset();
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    Object.defineProperty(process, "execPath", { value: execPath });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function brewNode(formula = "node") {
    const prefix = path.join(home, "brew");
    const versioned = path.join(prefix, "Cellar", formula, "25.2.1", "bin", "node");
    const stable = path.join(prefix, "opt", formula, "bin", "node");
    mkdirSync(path.dirname(versioned), { recursive: true });
    mkdirSync(path.dirname(stable), { recursive: true });
    writeFileSync(versioned, "node fixture");
    symlinkSync(versioned, stable);
    return { versioned, stable, prefix: path.dirname(path.dirname(versioned)) };
  }

  const argv = [
    "control",
    "pair",
    "spacesheep.dev",
    "--mode",
    "auto",
    "--folder",
    "/project one",
    "--folder",
    "/project two",
    "--name",
    "my machine",
    "--token",
    "test-token",
  ];

  for (const targetPlatform of ["darwin", "linux"] as const) {
    describe(`${targetPlatform} service written by control pair`, () => {
      for (const npx of [false, true]) {
        for (const brew of [false, true]) {
          it(`${npx ? "npx handoff" : "global install"}, ${brew ? "versioned Homebrew node" : "system node"}`, async () => {
            Object.defineProperty(process, "platform", { value: targetPlatform });
            const node = brew
              ? brewNode()
              : { versioned: "/usr/bin/node", stable: "/usr/bin/node", prefix: path.join(home, ".local") };
            Object.defineProperty(process, "execPath", { value: node.versioned });
            const prefix = path.join(home, ".local");
            const dist = path.join(prefix, "lib", "node_modules", "sessionpipe", "dist");
            mkdirSync(dist, { recursive: true });
            writeFileSync(path.join(dist, "cli.js"), "global CLI fixture");
            const files = serviceFiles({ node: "", cli: "", logDir: home, home });
            const file = targetPlatform === "darwin" ? files.plist.path : files.unit.path;
            if (npx) {
              vi.mocked(execFileSync).mockReturnValue(node.prefix);
              await controlMain(
                argv,
                vi.fn(),
                path.join(home, ".npm", "_npx", "hash", "node_modules", "sessionpipe", "dist"),
              );
              expect(pair).not.toHaveBeenCalled();
              expect(existsSync(file)).toBe(false);
              expect(execFileSync).toHaveBeenCalledWith(
                "npm",
                ["install", "-g", expect.stringMatching(/^sessionpipe@/), "--prefix", prefix],
                expect.anything(),
              );
              expect(execFileSync).toHaveBeenLastCalledWith(path.join(prefix, "bin", "sessionpipe"), argv, {
                stdio: "inherit",
                shell: false,
              });
            }
            // Run the handed-off command from the installed copy, with the real writer.
            await controlMain(argv, vi.fn(), dist);
            expect(pair).toHaveBeenCalledTimes(1);
            expect(pair).toHaveBeenCalledWith(
              expect.objectContaining({
                mode: "auto",
                token: "test-token",
                folders: ["/project one", "/project two"],
                name: "my machine",
              }),
            );
            const body = readFileSync(file, "utf8");
            if (targetPlatform === "darwin") {
              expect(body).toContain(
                `<array><string>${node.stable}</string><string>${path.join(dist, "cli.js")}</string><string>control</string><string>run</string></array>`,
              );
              expect(execFileSync).toHaveBeenCalledWith(
                "launchctl",
                ["bootstrap", expect.any(String), file],
                expect.anything(),
              );
            } else {
              expect(body).toContain(`ExecStart="${node.stable}" "${path.join(dist, "cli.js")}" "control" "run"`);
              expect(execFileSync).toHaveBeenCalledWith("systemctl", ["--user", "daemon-reload"], expect.anything());
            }
            expect(body).not.toMatch(/_npx|\/Cellar\//);
          });
        }
      }

      it("respects --no-service after the npx handoff", async () => {
        Object.defineProperty(process, "platform", { value: targetPlatform });
        const prefix = path.join(home, ".local");
        vi.mocked(execFileSync).mockReturnValue(prefix);
        const args = [...argv, "--no-service"];
        await controlMain(args, vi.fn(), path.join(home, ".npm", "_npx", "hash", "dist"));
        expect(execFileSync).toHaveBeenLastCalledWith(path.join(prefix, "bin", "sessionpipe"), args, expect.anything());
        vi.mocked(execFileSync).mockClear();
        await controlMain(args, vi.fn(), path.join(prefix, "lib", "node_modules", "sessionpipe", "dist"));
        expect(pair).toHaveBeenCalledTimes(1);
        expect(execFileSync).not.toHaveBeenCalled();
      });
    });
  }

  it("names a first pairing like the hooks do: the hostname without its .local suffix", async () => {
    vi.spyOn(os, "hostname").mockReturnValue("Build-Box.local");
    vi.mocked(readControl).mockReturnValueOnce(null);
    const args = argv.filter((a) => a !== "--name" && a !== "my machine");
    await controlMain(
      [...args, "--no-service"],
      vi.fn(),
      path.join(home, ".local", "lib", "node_modules", "sessionpipe", "dist"),
    );
    expect(pair).toHaveBeenCalledWith(expect.objectContaining({ name: "Build-Box" }));
  });

  it("does not pair or write a service if global installation fails", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("npm failed");
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit 1");
    });
    await expect(controlMain(argv, vi.fn(), path.join(home, ".npm", "_npx", "hash", "dist"))).rejects.toThrow("exit 1");
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(pair).not.toHaveBeenCalled();
  });

  it("uses Homebrew's versioned-formula opt link and falls back only to a matching bin link", () => {
    const node = brewNode("node@22");
    expect(stableNode(node.versioned)).toBe(node.stable);
    rmSync(node.stable);
    const fallback = path.join(home, "brew", "bin", "node");
    mkdirSync(path.dirname(fallback), { recursive: true });
    symlinkSync(node.versioned, fallback);
    expect(stableNode(node.versioned)).toBe(fallback);
    rmSync(fallback);
    writeFileSync(fallback, "another node");
    expect(stableNode(node.versioned)).toBe(node.versioned);
  });
});
