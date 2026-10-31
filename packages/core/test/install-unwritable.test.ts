// SPDX-License-Identifier: Apache-2.0
// A harness config file the system will not let us change: read-only (EACCES; EPERM,
// which Windows gives such a file), a read-only filesystem (EROFS), a folder that
// can't be made, a delete refused. Each is one file's report, with the code, and the
// adapter goes on to its next file; nothing throws out of `install` or `uninstall`.
// Only a failure in the write itself (ENOSPC) may have cut the file short, and only
// that report says so. The refusals are faked at node:fs, since a chmod means nothing
// on Windows and nothing to root.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installClaudeShaped, removeEmptied, uninstallClaudeShaped, writeBack } from "../src/adapters/claude-shaped.js";
import { antigravity, claudeCode, codex, geminiCli } from "../src/adapters/index.js";
import type { HookCommand } from "../src/adapters/types.js";

/** A refusal: the error's code and the syscall it comes from; `after` lets that many
 *  calls on the path through first. No code: a plain Error, as a non-fs failure throws. */
type Refusal = { code?: string; syscall?: string; after?: number };
const fake = vi.hoisted(() => ({
  refuse: new Map<string, { code?: string; syscall?: string; after?: number }[]>(),
}));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const due = (syscall: string, p: unknown) => {
    const r = (typeof p === "string" ? fake.refuse.get(p) : undefined)?.find((x) => (x.syscall ?? "open") === syscall);
    if (!r) return null;
    if (r.after) {
      r.after--;
      return null;
    }
    return Object.assign(new Error(r.code ? `${r.code}: refused, ${syscall} '${p}'` : "boom"), {
      ...(r.code ? { code: r.code } : {}),
      syscall: r.syscall,
    });
  };
  const writeFileSync = ((p: unknown, data: unknown, ...rest: unknown[]) => {
    const atOpen = due("open", p);
    if (atOpen) throw atOpen;
    const inWrite = due("write", p);
    if (inWrite) {
      // What a write that fails part way leaves: the file opened for truncation, then nothing.
      (real.writeFileSync as (...a: unknown[]) => void)(p, "");
      throw inWrite;
    }
    return (real.writeFileSync as (...a: unknown[]) => void)(p, data, ...rest);
  }) as typeof real.writeFileSync;
  const mkdirSync = ((p: unknown, ...rest: unknown[]) => {
    const e = due("mkdir", p);
    if (e) throw e;
    return (real.mkdirSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.mkdirSync;
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    const e = due("read", p);
    if (e) throw e;
    return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.readFileSync;
  const unlinkSync = ((p: unknown) => {
    const e = due("unlink", p);
    if (e) throw e;
    return real.unlinkSync(p as string);
  }) as typeof real.unlinkSync;
  return { ...real, readFileSync, writeFileSync, mkdirSync, unlinkSync };
});

const cmd: HookCommand = (a) => ({
  argv: ["/usr/local/bin/node", "/opt/sessionpipe/dist/hook.js", ...a],
  command: `"/usr/local/bin/node" "/opt/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});
const OPTS = { matcherFor: (e: string) => (/Tool/.test(e) ? "" : undefined), timeout: 5 };
const EVENTS = ["Stop", "PreToolUse"];
const refuse = (file: string, ...rs: Refusal[]) =>
  fake.refuse.set(file, rs.length ? rs : [{ code: "EACCES", syscall: "open" }]);
const NOT_TOUCHED = { changed: false, skipped: true, note: "can't write it (EACCES); not touched" };
/** Codex's config.toml refused: without the notify line, the hooks alone report nothing until their review. */
const NOTIFY_NOT_TOUCHED = {
  ...NOT_TOUCHED,
  note: `${NOT_TOUCHED.note}. Codex will report nothing until you approve the hooks: start \`codex\` and accept the hook review`,
};

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-unwritable-"));
  env = {
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    GEMINI_CLI_HOME: path.join(home, ".gemini"),
  };
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
});
afterEach(() => {
  fake.refuse.clear();
  rmSync(home, { recursive: true, force: true });
});

describe("writeBack and removeEmptied: the one place a config file is changed", () => {
  it("a write refused at the open (EACCES, EPERM, EROFS) is reported with the code, the file as it was", () => {
    const file = path.join(home, "a.json");
    writeFileSync(file, "{}\n");
    for (const code of ["EACCES", "EPERM", "EROFS"]) {
      refuse(file, { code, syscall: "open" });
      expect(writeBack(file, '{"x":1}')).toEqual({
        file,
        changed: false,
        skipped: true,
        note: `can't write it (${code}); not touched`,
      });
      expect(readFileSync(file, "utf8")).toBe("{}\n");
    }
    fake.refuse.clear();
    expect(writeBack(file, '{"x":1}')).toBeNull();
    expect(readFileSync(file, "utf8")).toBe('{"x":1}');
  });

  it("a folder that can't be made is the same refusal, and the file is not made either", () => {
    const file = path.join(home, "deeper", "a.json");
    refuse(path.dirname(file), { code: "ENOTDIR", syscall: "mkdir" });
    expect(writeBack(file, "{}", false)).toEqual({
      file,
      changed: false,
      skipped: true,
      note: "can't write it (ENOTDIR); not touched",
    });
    expect(existsSync(file)).toBe(false);
  });

  it("only a failure in the write itself says the file may be cut short; one it made is still `created`", () => {
    const file = path.join(home, "a.json");
    refuse(file, { code: "ENOSPC", syscall: "write" });
    expect(writeBack(file, "{}", false)).toEqual({
      file,
      changed: true,
      skipped: true,
      created: true,
      note: "can't write it (ENOSPC) part way; check the file before the harness reads it",
    });
    expect(readFileSync(file, "utf8")).toBe("");
    expect(writeBack(file, "{}")).toEqual({
      file,
      changed: true,
      skipped: true,
      note: "can't write it (ENOSPC) part way; check the file before the harness reads it",
    });
  });

  it("an error with no code is reported by its message, and never claims the file is untouched", () => {
    const file = path.join(home, "a.json");
    refuse(file, { syscall: "open" });
    expect(writeBack(file, "{}")?.note).toBe("can't write it (Error: boom); not touched");
    refuse(file, {});
    expect(writeBack(file, "{}")?.note).toBe(
      "can't write it (Error: boom) part way; check the file before the harness reads it",
    );
  });

  it("a delete refused writes the file back empty instead, and says so with the code; both refused leaves it", () => {
    const file = path.join(home, "a.json");
    writeFileSync(file, '{"hooks":{}}\n');
    refuse(file, { code: "EACCES", syscall: "unlink" }, { code: "EACCES", syscall: "open" });
    expect(removeEmptied(file, "{}\n")).toEqual({
      file,
      changed: false,
      skipped: true,
      note: "can't write it (EACCES); not touched",
    });
    expect(readFileSync(file, "utf8")).toBe('{"hooks":{}}\n');
    // The folder refuses the delete (root's ~/.claude, a folder ACL); the file takes the write.
    refuse(file, { code: "EACCES", syscall: "unlink" });
    expect(removeEmptied(file, "{}\n")).toEqual({
      file,
      changed: true,
      note: "emptied; can't remove it (EACCES), so the empty file stays",
    });
    expect(readFileSync(file, "utf8")).toBe("{}\n");
    fake.refuse.clear();
    expect(removeEmptied(file, "{}\n")).toEqual({ file, changed: true, note: "removed (sessionpipe created it)" });
    expect(existsSync(file)).toBe(false);
  });
});

describe("the Claude-shaped file: install and uninstall report the refusal in the parse refusal's shape", () => {
  it("install: an existing file is left byte-identical, a missing one is not made, and neither is `created`", () => {
    const file = path.join(home, "hooks.json");
    refuse(file);
    expect(installClaudeShaped(file, "h", EVENTS, cmd, OPTS)).toEqual({ file, ...NOT_TOUCHED });
    expect(existsSync(file)).toBe(false);
    fake.refuse.clear();
    const before = '{\n  "model": "opus"\n}\n';
    writeFileSync(file, before);
    refuse(file);
    expect(installClaudeShaped(file, "h", EVENTS, cmd, OPTS)).toEqual({ file, ...NOT_TOUCHED });
    expect(readFileSync(file, "utf8")).toBe(before);
    // Once writable: hooked, and `created` only for a file that was not there.
    fake.refuse.clear();
    expect(installClaudeShaped(file, "h", EVENTS, cmd, OPTS)).toEqual({ file, changed: true, created: false });
  });

  it("install: a file it made that the disk cut short is `created`, so uninstall knows it was ours", () => {
    const file = path.join(home, "hooks.json");
    refuse(file, { code: "ENOSPC", syscall: "write" });
    expect(installClaudeShaped(file, "h", EVENTS, cmd, OPTS)).toMatchObject({
      file,
      changed: true,
      skipped: true,
      created: true,
      note: "can't write it (ENOSPC) part way; check the file before the harness reads it",
    });
  });

  it("uninstall: a write refused keeps our hooks in the file and says so; a delete refused empties the file", () => {
    const file = path.join(home, "hooks.json");
    writeFileSync(file, '{"model":"opus"}\n');
    installClaudeShaped(file, "h", EVENTS, cmd, OPTS);
    const hooked = readFileSync(file, "utf8");
    refuse(file);
    expect(uninstallClaudeShaped(file, EVENTS)).toEqual({ file, ...NOT_TOUCHED });
    expect(readFileSync(file, "utf8")).toBe(hooked);
    const made = path.join(home, "made.json");
    installClaudeShaped(made, "h", EVENTS, cmd, OPTS);
    const ours = readFileSync(made, "utf8");
    refuse(made, { code: "EPERM", syscall: "unlink" }, { code: "EPERM", syscall: "open" });
    expect(uninstallClaudeShaped(made, EVENTS, { created: true })).toEqual({
      file: made,
      changed: false,
      skipped: true,
      note: "can't write it (EPERM); not touched",
    });
    expect(readFileSync(made, "utf8")).toBe(ours);
    refuse(made, { code: "EPERM", syscall: "unlink" });
    expect(uninstallClaudeShaped(made, EVENTS, { created: true })).toEqual({
      file: made,
      changed: true,
      note: "emptied; can't remove it (EPERM), so the empty file stays",
    });
    expect(readFileSync(made, "utf8")).toBe("{}\n");
  });
});

describe("each adapter goes on to its next file", () => {
  it("claude-code: the second config dir is hooked when the first is refused; the refused file gets one report, not a status line's too", () => {
    const first = path.join(home, ".claude", "settings.json");
    const second = path.join(home, ".claude-work", "settings.json");
    writeFileSync(first, "{}\n");
    mkdirSync(path.dirname(second));
    writeFileSync(second, "{}\n");
    refuse(first);
    const reports = claudeCode.install(cmd, env, { statusLine: true });
    expect(reports).toEqual([
      { file: first, ...NOT_TOUCHED },
      { file: second, changed: true, created: false },
      { file: second, changed: true, note: "status line written (account limits)" },
    ]);
    expect(readFileSync(first, "utf8")).toBe("{}\n");
    expect(JSON.parse(readFileSync(second, "utf8")).statusLine.command).toContain("claude-code StatusLine");
    // Hooked, then the file turns read-only: uninstall reports it and takes the other's out.
    fake.refuse.clear();
    claudeCode.install(cmd, env, { statusLine: true });
    refuse(first);
    expect(claudeCode.uninstall(env)).toEqual([
      { file: first, ...NOT_TOUCHED },
      { file: second, changed: true },
    ]);
    expect(JSON.parse(readFileSync(first, "utf8")).hooks.Stop).toBeDefined();
    expect(JSON.parse(readFileSync(second, "utf8"))).toEqual({});
  });

  it("claude-code: a status line taken out, then the hooks' write cut short: the report is the hooks' refusal", () => {
    const file = path.join(home, ".claude", "settings.json");
    writeFileSync(file, "{}\n");
    claudeCode.install(cmd, env, { statusLine: true });
    // The status line's write goes through; the second write, the hooks', fails in the write.
    refuse(file, { code: "ENOSPC", syscall: "write", after: 1 });
    expect(claudeCode.uninstall(env)).toEqual([
      {
        file,
        changed: true,
        skipped: true,
        note: "status line removed, hooks not: can't write it (ENOSPC) part way; check the file before the harness reads it",
      },
    ]);
    // The same with the second write refused at its open: the file is not "not touched".
    fake.refuse.clear();
    writeFileSync(file, "{}\n");
    claudeCode.install(cmd, env, { statusLine: true });
    refuse(file, { code: "EACCES", syscall: "open", after: 1 });
    expect(claudeCode.uninstall(env)).toEqual([
      { file, changed: false, skipped: true, note: "status line removed, hooks not: can't write it (EACCES)" },
    ]);
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("statusLine");
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.Stop).toBeDefined();
  });

  it("claude-code: the status line's own write refused, on install and on uninstall", () => {
    const file = path.join(home, ".claude", "settings.json");
    writeFileSync(file, "{}\n");
    claudeCode.install(cmd, env);
    refuse(file);
    // The hooks are current (no write), so the status line's write is the one refused.
    expect(claudeCode.install(cmd, env, { statusLine: true })).toEqual([
      { file, changed: false, created: false },
      { file, ...NOT_TOUCHED },
    ]);
    fake.refuse.clear();
    claudeCode.install(cmd, env, { statusLine: true });
    refuse(file);
    expect(claudeCode.uninstall(env)).toEqual([{ file, ...NOT_TOUCHED }]);
    expect(JSON.parse(readFileSync(file, "utf8")).statusLine).toBeDefined();
  });

  it("codex: a config.toml that is there but can't be read, then cut short in the write, is not `created`", () => {
    const config = path.join(home, ".codex", "config.toml");
    writeFileSync(config, 'model = "o3"\n');
    refuse(config, { code: "EACCES", syscall: "read" }, { code: "ENOSPC", syscall: "write" });
    const r = codex.install(cmd, env)[1];
    expect(r).toMatchObject({ file: config, changed: true, skipped: true });
    expect(r).not.toHaveProperty("created");
    expect(r?.note).toContain("can't write it (ENOSPC) part way");
  });

  it("codex: hooks.json written and `created` before config.toml is refused keeps its report; uninstall the same way", () => {
    const hooks = path.join(home, ".codex", "hooks.json");
    const config = path.join(home, ".codex", "config.toml");
    writeFileSync(config, 'model = "o3"\n');
    refuse(config);
    expect(codex.install(cmd, env)).toEqual([
      { file: hooks, changed: true, created: true },
      { file: config, ...NOTIFY_NOT_TOUCHED },
    ]);
    expect(readFileSync(config, "utf8")).toBe('model = "o3"\n');
    fake.refuse.clear();
    codex.install(cmd, env);
    const withNotify = readFileSync(config, "utf8");
    expect(withNotify).toContain("notify = ");
    refuse(config);
    expect(codex.uninstall(env, { created: [hooks] })).toEqual([
      { file: hooks, changed: true, note: "removed (sessionpipe created it)" },
      { file: config, ...NOT_TOUCHED },
    ]);
    expect(readFileSync(config, "utf8")).toBe(withNotify);
  });

  it("codex: a notify chained after Codex Computer Use: the chain refused on install, the unchain refused on uninstall", () => {
    const config = path.join(home, ".codex", "config.toml");
    const cu = 'notify = ["/Applications/X/SkyComputerUseClient", "turn-ended"]\n';
    writeFileSync(config, cu);
    refuse(config);
    expect(codex.install(cmd, env)[1]).toEqual({ file: config, ...NOTIFY_NOT_TOUCHED });
    expect(readFileSync(config, "utf8")).toBe(cu);
    fake.refuse.clear();
    expect(codex.install(cmd, env)[1]?.note).toBe("chained after Codex Computer Use (--previous-notify)");
    const chained = readFileSync(config, "utf8");
    refuse(config);
    expect(codex.uninstall(env)[1]).toEqual({ file: config, ...NOT_TOUCHED });
    expect(readFileSync(config, "utf8")).toBe(chained);
  });

  it("gemini-cli: the refusal carries the file, with no note about hooks being off", () => {
    const file = path.join(home, ".gemini", "settings.json");
    writeFileSync(file, '{"tools":{"enableHooks":false}}\n');
    refuse(file);
    expect(geminiCli.install(cmd, env)).toEqual([{ file, ...NOT_TOUCHED }]);
  });

  it("antigravity: install refused, then uninstall's write and its delete refused", () => {
    const file = path.join(home, ".gemini", "config", "hooks.json");
    refuse(file);
    expect(antigravity.install(cmd, env)).toEqual([{ file, ...NOT_TOUCHED }]);
    expect(existsSync(file)).toBe(false);
    fake.refuse.clear();
    expect(antigravity.install(cmd, env)[0]).toMatchObject({ changed: true, created: true });
    const hooked = readFileSync(file, "utf8");
    refuse(file);
    expect(antigravity.uninstall(env)).toEqual([{ file, ...NOT_TOUCHED }]);
    expect(readFileSync(file, "utf8")).toBe(hooked);
    refuse(file, { code: "EACCES", syscall: "unlink" });
    expect(antigravity.uninstall(env, { created: [file] })).toEqual([
      { file, changed: true, note: "emptied; can't remove it (EACCES), so the empty file stays" },
    ]);
    expect(readFileSync(file, "utf8")).toBe("{}\n");
  });
});
