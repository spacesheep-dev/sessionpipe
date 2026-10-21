// SPDX-License-Identifier: Apache-2.0
// Every test file starts in a sandbox home. Runs before each file (vitest setupFiles):
// a fresh temp directory is HOME, and every variable sessionpipe or a harness adapter
// resolves a path from points inside it, so a test that forgets a stub still cannot
// reach the real ~/.config/sessionpipe, ~/.claude, ~/.codex or ~/.gemini. On 21 Oct
// 2026 a CLI test run rewrote the maintainer's real config.json that way. PATH is
// left alone: tests set it themselves when a command must or must not be found.
//
// The values are assigned, not vi.stubEnv'd, so a test's vi.unstubAllEnvs() falls
// back to the sandbox, never to the real home. Tests that build their own temp home
// keep doing so on top of this one.
//
// A tripwire watches the real files anyway: their mtimes, read once before the
// sandbox is set, are compared after each file, and a change fails that file by name.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const real = { ...process.env };
const realHome = os.homedir();
const under = (envVar: string | undefined, ...fallback: string[]) => envVar || path.join(realHome, ...fallback);
/** The files a stray install, connect, sink add, uninstall or writeConfig would touch. */
const watched = [
  real.SESSIONPIPE_CONFIG || path.join(under(real.XDG_CONFIG_HOME, ".config"), "sessionpipe", "config.json"),
  path.join(under(real.XDG_CONFIG_HOME, ".config"), "sessionpipe", "control.json"),
  path.join(under(real.CLAUDE_CONFIG_DIR, ".claude"), "settings.json"),
  path.join(under(real.CODEX_HOME, ".codex"), "hooks.json"),
  path.join(under(real.CODEX_HOME, ".codex"), "config.toml"),
  path.join(under(real.GEMINI_CLI_HOME, ".gemini"), "settings.json"),
  path.join(under(real.GEMINI_CLI_HOME, ".gemini"), "config", "hooks.json"),
  path.join(under(real.XDG_CONFIG_HOME, ".config"), "devin", "config.json"),
];
const stamp = (file: string): string => {
  const s = statSync(file, { throwIfNoEntry: false });
  return s ? `${s.mtimeMs}:${s.size}` : "absent";
};
const before = new Map(watched.map((f) => [f, stamp(f)]));

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-home-")));
const home = path.join(tmp, "home");
mkdirSync(home);
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  CODEX_HOME: path.join(home, ".codex"),
  GEMINI_CLI_HOME: path.join(home, ".gemini"),
  SESSIONPIPE_CONFIG: path.join(home, ".config", "sessionpipe", "config.json"),
  SESSIONPIPE_STATE: path.join(home, ".local", "state", "sessionpipe"),
  SESSIONPIPE_DATA: path.join(home, ".local", "share", "sessionpipe"),
  // Short: a socket path is capped at 104 bytes on macOS.
  SESSIONPIPE_SOCKET: path.join(tmp, "ctl.sock"),
  SESSIONPIPE_SECRETS: "file",
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  const changed = watched.filter((f) => stamp(f) !== before.get(f));
  if (changed.length)
    throw new Error(
      `A test in this file reached outside its sandbox home and changed: ${changed.join(", ")}. Restore the file, then find the test that resolved a path from the real home.`,
    );
});
