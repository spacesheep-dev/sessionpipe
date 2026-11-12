// SPDX-License-Identifier: Apache-2.0
// update.ts: every copy of sessionpipe that matters on a computer brought to one
// version (`installEverywhere`), which copy a person types (`copyOnPath`), and which
// registry is asked.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyOnPath,
  type Exec,
  installEverywhere,
  latestVersion,
  REGISTRY_LATEST,
  rearmHooks,
  registryLatest,
  samePath,
  versionAt,
} from "../src/update.js";

const posix = process.platform !== "win32";
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-every-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

/** A global npm install of sessionpipe under `<tmp>/<name>`: its dist folder. With no
 *  version it has the shape and no package.json. */
function copy(name: string, version: string | null): string {
  const pkg = path.join(tmp, name, "lib", "node_modules", "sessionpipe");
  mkdirSync(path.join(pkg, "dist"), { recursive: true });
  mkdirSync(path.join(tmp, name, "bin"), { recursive: true });
  writeFileSync(path.join(pkg, "dist", "cli.js"), "");
  if (version !== null) writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "sessionpipe", version }));
  if (posix) symlinkSync(path.join(pkg, "dist", "cli.js"), path.join(tmp, name, "bin", "sessionpipe"));
  return path.join(pkg, "dist");
}

describe("the registry that is asked", () => {
  it("is npm's own, or the one npm itself is told to use", () => {
    expect(registryLatest({})).toBe(REGISTRY_LATEST);
    expect(registryLatest({ npm_config_registry: "https://npm.example.com/" })).toBe(
      "https://npm.example.com/sessionpipe/latest",
    );
    expect(registryLatest({ NPM_CONFIG_REGISTRY: "http://127.0.0.1:4873" })).toBe(
      "http://127.0.0.1:4873/sessionpipe/latest",
    );
    // Not an address: npm's own.
    expect(registryLatest({ npm_config_registry: "file:///tmp/x" })).toBe(REGISTRY_LATEST);
    expect(registryLatest()).toMatch(/\/sessionpipe\/latest$/);
  });

  it("`latest` is read from there", async () => {
    const asked: string[] = [];
    const f = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ version: "1.2.3" }));
    }) as unknown as typeof fetch;
    expect(await latestVersion(f, 1000, { npm_config_registry: "http://127.0.0.1:4873" })).toBe("1.2.3");
    expect(asked).toEqual(["http://127.0.0.1:4873/sessionpipe/latest"]);
  });
});

describe("the version of a copy on disk", () => {
  it("is its package.json's; null when that can't be read as sessionpipe's, or says no version", () => {
    expect(versionAt(copy("a", "1.2.3"))).toBe("1.2.3");
    expect(versionAt(copy("b", null))).toBeNull();
    expect(versionAt(copy("c", "latest"))).toBeNull();
    const d = copy("d", null);
    writeFileSync(path.join(d, "..", "package.json"), JSON.stringify({ name: "sessionpipe" }));
    expect(versionAt(d)).toBeNull();
    // Another package's, and a file that is no object at all.
    writeFileSync(path.join(d, "..", "package.json"), JSON.stringify({ name: "left-pad", version: "1.2.3" }));
    expect(versionAt(d)).toBeNull();
    writeFileSync(path.join(d, "..", "package.json"), "null");
    expect(versionAt(d)).toBeNull();
  });
});

describe("two paths to one place", () => {
  it.runIf(posix)("are the same through a link; a path that isn't there is itself", () => {
    const d = copy("a", "1.0.0");
    symlinkSync(path.join(tmp, "a"), path.join(tmp, "link"));
    expect(samePath(path.join(tmp, "link", "lib", "node_modules", "sessionpipe", "dist"), d)).toBe(true);
    expect(samePath(path.join(tmp, "none"), path.join(tmp, "none"))).toBe(true);
    expect(samePath(path.join(tmp, "none"), d)).toBe(false);
  });
});

describe("the copy a person types", () => {
  it.runIf(posix)("is the first `sessionpipe` on PATH, where npm installed it globally", () => {
    const a = copy("a", "1.0.0");
    copy("b", "1.1.0");
    const PATH = [path.join(tmp, "empty"), path.join(tmp, "a", "bin"), path.join(tmp, "b", "bin")].join(path.delimiter);
    expect(samePath(copyOnPath({ PATH }) as string, a)).toBe(true);
    expect(copyOnPath({ PATH: path.join(tmp, "empty") })).toBeNull();
    expect(copyOnPath({})).toBeNull();
    // Asked nothing, it reads this process's own PATH.
    vi.stubEnv("PATH", path.join(tmp, "b", "bin"));
    expect(samePath(copyOnPath() as string, path.join(tmp, "b", "lib", "node_modules", "sessionpipe", "dist"))).toBe(
      true,
    );
  });

  it.runIf(posix)("not a script of that name, nor a link to nowhere", () => {
    const bin = path.join(tmp, "scripts");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "sessionpipe"), "#!/bin/sh\n");
    expect(copyOnPath({ PATH: bin })).toBeNull();
    const dead = path.join(tmp, "dead");
    mkdirSync(dead);
    symlinkSync(path.join(tmp, "gone", "cli.js"), path.join(dead, "sessionpipe"));
    expect(copyOnPath({ PATH: dead })).toBeNull();
  });

  it.runIf(posix)("nor a folder that has an install's shape and no package.json that says sessionpipe", () => {
    // A link someone planted ahead of the real install on PATH (a project's node_modules/.bin).
    const shaped = copy("elsewhere", null);
    const planted = path.join(tmp, "proj", "node_modules", ".bin");
    mkdirSync(planted, { recursive: true });
    symlinkSync(path.join(shaped, "cli.js"), path.join(planted, "sessionpipe"));
    copy("real", "1.0.0");
    const PATH = [planted, path.join(tmp, "real", "bin")].join(path.delimiter);
    // The first one decides, as in a shell; it is no install, so there is none to write to.
    expect(copyOnPath({ PATH })).toBeNull();
    writeFileSync(path.join(shaped, "..", "package.json"), JSON.stringify({ name: "other", version: "1.0.0" }));
    expect(copyOnPath({ PATH })).toBeNull();
    writeFileSync(path.join(shaped, "..", "package.json"), JSON.stringify({ name: "sessionpipe", version: "1.0.0" }));
    expect(samePath(copyOnPath({ PATH }) as string, shaped)).toBe(true);
  });

  it("on Windows it is the shim's own folder, when that holds the install and not just the name", () => {
    const prefix = path.join(tmp, "win");
    const pkg = path.join(prefix, "node_modules", "sessionpipe");
    const dist = path.join(pkg, "dist");
    const PATH = [path.join(tmp, "other"), prefix].join(path.delimiter);
    mkdirSync(prefix, { recursive: true });
    // A wrapper script someone called sessionpipe.cmd: its folder is no npm prefix.
    writeFileSync(path.join(prefix, "sessionpipe.cmd"), "");
    expect(copyOnPath({ PATH }, "win32")).toBeNull();
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "cli.js"), "");
    expect(copyOnPath({ PATH }, "win32")).toBeNull();
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "sessionpipe", version: "1.0.0" }));
    expect(copyOnPath({ PATH }, "win32")).toBe(dist);
    rmSync(path.join(dist, "cli.js"));
    expect(copyOnPath({ PATH }, "win32")).toBeNull();
  });
});

describe.runIf(posix)("installEverywhere (npm stood in for)", () => {
  /** npm "installs" by writing the version into the prefix's package.json. */
  function fake(o: { fail?: string } = {}) {
    const calls: string[][] = [];
    const exec: Exec = async (argv) => {
      calls.push(argv);
      if (argv.includes("--global")) {
        const prefix = argv[argv.indexOf("--prefix") + 1] as string;
        if (o.fail && prefix.endsWith(o.fail)) return { code: 1, stdout: "", stderr: "npm error EACCES" };
        writeFileSync(
          path.join(prefix, "lib", "node_modules", "sessionpipe", "package.json"),
          JSON.stringify({ name: "sessionpipe", version: (argv.at(-1) as string).split("@")[1] }),
        );
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv.includes("--version"))
        return { code: 0, stdout: `${versionAt(path.dirname(argv[1] as string))}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    return { calls, exec };
  }
  const npmRuns = (calls: string[][]) =>
    calls.filter((c) => c.includes("--global")).map((c) => c[c.indexOf("--prefix") + 1]);

  it("brings the running copy up, then each other copy that is older, then writes the hooks once", async () => {
    const mine = copy("mine", "1.0.0");
    const typed = copy("typed", "0.9.0");
    const { calls, exec } = fake();
    const r = await installEverywhere("1.1.0", {
      node: "n",
      distDir: mine,
      others: [typed, typed],
      harnesses: ["codex"],
      exec,
    });
    expect(r).toMatchObject({ ok: true, rearmed: true, hooks: "hooks re-armed for codex", along: [typed] });
    expect(npmRuns(calls)).toEqual([path.join(tmp, "mine"), path.join(tmp, "typed")]);
    expect(versionAt(mine)).toBe("1.1.0");
    expect(versionAt(typed)).toBe("1.1.0");
    // The hooks come from the running copy, after every install.
    expect(calls.at(-1)).toEqual(["n", path.join(mine, "cli.js"), "install", "--backfill", "0", "--codex"]);
  });

  it("leaves alone itself named twice, and a copy that is already there or newer", async () => {
    const mine = copy("mine", "1.0.0");
    const same = copy("same", "1.1.0");
    const newer = copy("newer", "1.2.0-beta.1");
    const { calls, exec } = fake();
    const r = await installEverywhere("1.1.0", {
      node: "n",
      distDir: mine,
      others: [mine, same, newer],
      harnesses: [],
      exec,
    });
    expect(r).toMatchObject({ ok: true });
    expect(r).not.toHaveProperty("along");
    expect(r).not.toHaveProperty("others");
    expect(npmRuns(calls)).toEqual([path.join(tmp, "mine")]);
  });

  it("another copy that can't be updated is said, and never holds the rest back", async () => {
    const mine = copy("mine", "1.0.0");
    const typed = copy("typed", "0.9.0");
    const { exec } = fake({ fail: "typed" });
    const r = await installEverywhere("1.1.0", {
      node: "n",
      distDir: mine,
      others: [typed],
      harnesses: ["codex"],
      exec,
    });
    expect(r).toMatchObject({
      ok: true,
      rearmed: true,
      others: [{ dir: typed, error: expect.stringContaining("EACCES") }],
    });
    expect(versionAt(mine)).toBe("1.1.0");
  });

  it("npm is never run on a folder that doesn't say it holds sessionpipe", async () => {
    const mine = copy("mine", "1.0.0");
    const shaped = copy("shaped", null);
    const other = copy("other", null);
    writeFileSync(path.join(other, "..", "package.json"), JSON.stringify({ name: "other", version: "0.1.0" }));
    const { calls, exec } = fake();
    const r = await installEverywhere("1.1.0", {
      node: "n",
      distDir: mine,
      others: [shaped, other],
      harnesses: [],
      exec,
    });
    expect(npmRuns(calls)).toEqual([path.join(tmp, "mine")]);
    const error = "no package.json there says it is sessionpipe, so npm was not run on it";
    expect(r).toMatchObject({
      ok: true,
      others: [
        { dir: shaped, error },
        { dir: other, error },
      ],
    });
    expect(r).not.toHaveProperty("along");
  });

  it("the running copy failing is the whole thing failing: nothing else is tried", async () => {
    const mine = copy("mine", "1.0.0");
    const typed = copy("typed", "0.9.0");
    const { calls, exec } = fake({ fail: "mine" });
    const r = await installEverywhere("1.1.0", {
      node: "n",
      distDir: mine,
      others: [typed],
      harnesses: ["codex"],
      exec,
    });
    expect(r).toMatchObject({ ok: false, stage: "npm" });
    expect(npmRuns(calls)).toEqual([path.join(tmp, "mine")]);
    expect(versionAt(typed)).toBe("0.9.0");
  });

  it("the hooks alone: written from the copy on disk, or said to have failed", async () => {
    const mine = copy("mine", "1.0.0");
    const calls: string[][] = [];
    const ok: Exec = async (argv, o) => {
      calls.push([...argv, String(o.env.PATH)]);
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(
      await rearmHooks({
        node: "/opt/node/bin/node",
        distDir: mine,
        harnesses: ["codex"],
        exec: ok,
        env: { PATH: "/usr/bin" },
      }),
    ).toEqual({
      ok: true,
      said: "hooks re-armed for codex",
    });
    // The node that runs this copy is found first by whatever the install starts.
    expect(calls[0]?.at(-1)).toBe(["/opt/node/bin", "/usr/bin"].join(path.delimiter));
    expect(await rearmHooks({ node: "n", distDir: mine, harnesses: [], exec: ok })).toEqual({
      ok: true,
      said: "no harness set up here; nothing to re-arm",
    });
    // With nothing stood in, this node runs the copy's own CLI: here there is none to run.
    const none = await rearmHooks({ node: process.execPath, distDir: path.join(tmp, "nothing"), harnesses: ["codex"] });
    expect(none.ok).toBe(false);
    expect(none.said).toMatch(/^re-arming the hooks failed \(.+\); `sessionpipe install` does it$/);
    const bad: Exec = async () => ({ code: 1, stdout: "", stderr: "refusing to downgrade" });
    expect(await rearmHooks({ node: "n", distDir: mine, harnesses: ["codex"], exec: bad })).toEqual({
      ok: false,
      said: "re-arming the hooks failed (refusing to downgrade); `sessionpipe install` does it",
    });
  });
});
