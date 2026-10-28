// SPDX-License-Identifier: Apache-2.0
// The `env` block in every Claude Code settings.json that sends requests through the
// pool: ANTHROPIC_BASE_URL (the loopback listener), ANTHROPIC_AUTH_TOKEN (the pool's
// bearer, so Claude Code skips its own OAuth) and _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
// (so it keeps the first-party context window behind a custom base URL). Only `pool on`
// writes it and `pool off` removes it (DESIGN decision 3). The rules are
// claude-shaped.ts's: a file that isn't plain JSON is skipped and the report says why;
// a file is written back in its own indent, line ending and final newline; off removes
// exactly our keys and an `env` object that is empty without them, and deletes a file
// we created once it is empty.
//
// "Ours" means our port or our token, never any loopback address: claude-code-router,
// LiteLLM and bb's pooler all live on 127.0.0.1 too, and a value we did not write is
// never overwritten or deleted; that file is skipped and reported. The bearer in this
// file is worth every pooled account on the machine, so the file is made 0600 once it
// carries one (Claude Code itself creates it 0644), a symlinked settings.json is
// followed to its target and the report names where the token went, and a config dir
// anyone else can write to is skipped.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { InstallReport } from "@sessionpipe/core";

export const POOL_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
] as const;

export const poolBaseUrl = (port: number): string => `http://127.0.0.1:${port}`;

/** The three values for a listener on `port` with bearer `token`. */
export function poolEnv(port: number, token: string): Record<(typeof POOL_ENV_KEYS)[number], string> {
  return {
    ANTHROPIC_BASE_URL: poolBaseUrl(port),
    ANTHROPIC_AUTH_TOKEN: token,
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
  };
}

/** What identifies a block as ours: this listener, or the one it moved from, or this
 *  token, or the one before it while a rotation is under way. */
export interface Ours {
  port: number;
  token: string;
  /** The port before the listener moved (pool.json's `last_port`). */
  lastPort?: number | undefined;
  /** The bearer before `pool on` minted this one. */
  lastToken?: string | undefined;
}

const isOurs = (env: Record<string, unknown>, o: Ours): boolean => {
  const base = env.ANTHROPIC_BASE_URL;
  const tok = env.ANTHROPIC_AUTH_TOKEN;
  return (
    base === poolBaseUrl(o.port) ||
    (o.lastPort !== undefined && base === poolBaseUrl(o.lastPort)) ||
    (typeof tok === "string" && tok.length > 0 && (tok === o.token || tok === o.lastToken))
  );
};
/** Any of the three keys set at all, by anyone. */
const anySet = (env: Record<string, unknown>): boolean => POOL_ENV_KEYS.some((k) => env[k] !== undefined);

type Shape = { indent: string; eol: string; finalNewline: boolean };
type JsonFile =
  | { ok: true; existed: boolean; value: Record<string, unknown>; shape: Shape }
  | { ok: false; existed: true; reason: string };

/** Mirrors claude-shaped.ts's readJsonFile (not exported from core): a parse failure
 *  is a refusal to touch the file, not an empty object. */
function readJsonFile(file: string): JsonFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ok: true, existed: false, value: {}, shape: { indent: "  ", eol: "\n", finalNewline: true } };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    const hint = /^\s*\/\/|\/\*/m.test(raw) ? "not plain JSON (it has comments)" : "not plain JSON";
    return { ok: false, existed: true, reason: hint };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, existed: true, reason: "not a JSON object" };
  const m = /^( +|\t+)\S/m.exec(raw);
  return {
    ok: true,
    existed: true,
    value: value as Record<string, unknown>,
    shape: { indent: m?.[1] ?? "  ", eol: raw.includes("\r\n") ? "\r\n" : "\n", finalNewline: /\r?\n$/.test(raw) },
  };
}

function formatJson(value: unknown, f: Shape): string {
  const text = JSON.stringify(value, null, f.indent).replace(/\n/g, f.eol);
  return f.finalNewline ? text + f.eol : text;
}

const settingsIn = (dir: string) => path.join(dir, "settings.json");
const envOf = (settings: Record<string, unknown>): Record<string, unknown> | null =>
  settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? (settings.env as Record<string, unknown>)
    : null;

/** The file to read and write: a symlink's target, so the chmod reaches the real file
 *  and the report names where the token went. */
const target = (file: string): { file: string; linked: boolean } => {
  try {
    if (!lstatSync(file).isSymbolicLink()) return { file, linked: false };
    return { file: realpathSync(file), linked: true };
  } catch {
    return { file, linked: false };
  }
};

/** A config dir another user could write to: a token written there is theirs too. */
const looseDir = (dir: string): boolean => {
  try {
    return process.platform !== "win32" && (statSync(dir).mode & 0o022) !== 0;
  } catch {
    return false;
  }
};

/** Write the block into each config dir's settings.json. */
export function installPoolEnv(dirs: readonly string[], o: Ours): InstallReport[] {
  const want = poolEnv(o.port, o.token);
  return dirs.map((dir) => {
    const link = settingsIn(dir);
    if (looseDir(dir))
      return { file: link, changed: false, skipped: true, note: "skipped: the config dir is group/world-writable" };
    const { file, linked } = target(link);
    const f = readJsonFile(file);
    if (!f.ok) return { file, changed: false, skipped: true, note: `${f.reason}; not touched` };
    const settings = f.value;
    if (settings.env !== undefined && !envOf(settings))
      return { file, changed: false, skipped: true, note: "env is not an object; not touched" };
    const env = envOf(settings) ?? {};
    if (anySet(env) && !isOurs(env, o))
      return {
        file,
        changed: false,
        skipped: true,
        note: `skipped: already set by someone else (${POOL_ENV_KEYS.filter((k) => env[k] !== undefined).join(", ")})`,
      };
    let changed = false;
    for (const k of POOL_ENV_KEYS)
      if (env[k] !== want[k]) {
        env[k] = want[k];
        changed = true;
      }
    const note = linked ? { note: `a symlink; the token is in ${file}` } : {};
    if (!changed) return { file, changed: false, ...note };
    settings.env = env;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, formatJson(settings, f.shape));
    // Claude Code's own file is 0644; with our bearer in it, it is ours to tighten.
    try {
      chmodSync(file, 0o600);
    } catch {}
    return { file, changed: true, created: !f.existed, ...note };
  });
}

/** Remove exactly what we wrote. `created` names the files `pool on` made, deleted
 *  again once nothing else is in them. */
export function uninstallPoolEnv(dirs: readonly string[], o: Ours & { created?: readonly string[] }): InstallReport[] {
  return dirs.map((dir) => {
    const { file } = target(settingsIn(dir));
    if (!existsSync(file)) return { file, changed: false };
    const f = readJsonFile(file);
    if (!f.ok) return { file, changed: false, skipped: true, note: `${f.reason}; not touched` };
    const settings = f.value;
    const env = envOf(settings);
    if (!env || !anySet(env)) return { file, changed: false };
    if (!isOurs(env, o)) return { file, changed: false, skipped: true, note: "left alone: set by someone else" };
    for (const k of POOL_ENV_KEYS) delete env[k];
    if (!Object.keys(env).length) delete settings.env;
    if (o.created?.includes(file) && !Object.keys(settings).length) {
      unlinkSync(file);
      return { file, changed: true, note: "removed (sessionpipe created it)" };
    }
    writeFileSync(file, formatJson(settings, f.shape));
    return { file, changed: true };
  });
}

export type PoolEnvState =
  /** Our block, pointing at this port with this token. */
  | "current"
  /** Our block, but another port or token: `pool on` again rewrites it. */
  | "stale"
  | "missing"
  /** Someone else's base URL or token: that config dir does not go through the pool. */
  | "other"
  /** A config dir anyone else can write to: `pool on` won't put a token there. */
  | "unsafe"
  | "unreadable";

/** Per settings.json: does Claude Code there go through this listener? */
export function installedPoolEnv(
  dirs: readonly string[],
  o: Ours,
): { file: string; state: PoolEnvState; note?: string }[] {
  const want = poolEnv(o.port, o.token);
  return dirs.map((dir) => {
    const link = settingsIn(dir);
    if (looseDir(dir)) return { file: link, state: "unsafe", note: "the config dir is group/world-writable" };
    const { file } = target(link);
    const f = readJsonFile(file);
    if (!f.ok) return { file, state: "unreadable", note: f.reason };
    const env = envOf(f.value);
    if (!env || !anySet(env)) return { file, state: "missing" };
    if (!isOurs(env, o))
      return { file, state: "other", note: `ANTHROPIC_BASE_URL is ${String(env.ANTHROPIC_BASE_URL ?? "unset")}` };
    return { file, state: POOL_ENV_KEYS.every((k) => env[k] === want[k]) ? "current" : "stale" };
  });
}

/** An environment for a child that must talk to the vendor directly: the pool's
 *  variables (and bb's, which are the same names) taken out. Note what it is not: Claude
 *  Code also reads `env` from settings.json, so a `claude` child still goes through the
 *  pool while it is on; `claude auth status` needs no network and is unaffected either
 *  way. The daemon's own usage polls use fetch, never Claude Code. */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of POOL_ENV_KEYS) delete out[k];
  return out;
}
