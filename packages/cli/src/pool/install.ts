// SPDX-License-Identifier: Apache-2.0
// The `env` block in every Claude Code settings.json that sends requests through the
// pool: ANTHROPIC_BASE_URL (the loopback listener), ANTHROPIC_AUTH_TOKEN (the pool's
// bearer, so Claude Code skips its own OAuth) and _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
// (so it keeps the first-party context window behind a custom base URL). Only `pool on`
// writes it and `pool off` removes it (DESIGN decision 3). The rules are
// claude-shaped.ts's: a file that isn't plain JSON is skipped and the report says why;
// a file is written back in its own indent, line ending and final newline; off removes
// exactly our keys and an `env` object that is empty without them, and deletes a file
// we created once it is empty; a value we did not write is never touched — a base URL
// someone else set (bb's pool, a gateway) means that file is skipped and reported.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

/** A base URL of ours: the loopback, any port (a port that moved is still ours). */
const OURS_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/;

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

/** Write the block into each config dir's settings.json. */
export function installPoolEnv(dirs: readonly string[], o: { port: number; token: string }): InstallReport[] {
  const want = poolEnv(o.port, o.token);
  return dirs.map((dir) => {
    const file = settingsIn(dir);
    const f = readJsonFile(file);
    if (!f.ok) return { file, changed: false, skipped: true, note: `${f.reason}; not touched` };
    const settings = f.value;
    if (settings.env !== undefined && !envOf(settings))
      return { file, changed: false, skipped: true, note: "env is not an object; not touched" };
    const env = envOf(settings) ?? {};
    const base = env.ANTHROPIC_BASE_URL;
    if (typeof base === "string" && !OURS_URL.test(base))
      return { file, changed: false, skipped: true, note: `skipped: ANTHROPIC_BASE_URL already set (${base})` };
    if (base !== undefined && typeof base !== "string")
      return { file, changed: false, skipped: true, note: "skipped: ANTHROPIC_BASE_URL already set" };
    let changed = false;
    for (const k of POOL_ENV_KEYS)
      if (env[k] !== want[k]) {
        env[k] = want[k];
        changed = true;
      }
    if (!changed) return { file, changed: false };
    settings.env = env;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, formatJson(settings, f.shape));
    return { file, changed: true, created: !f.existed };
  });
}

/** Remove exactly what we wrote. `created` names the files `pool on` made, deleted
 *  again once nothing else is in them. */
export function uninstallPoolEnv(dirs: readonly string[], o: { created?: readonly string[] } = {}): InstallReport[] {
  return dirs.map((dir) => {
    const file = settingsIn(dir);
    if (!existsSync(file)) return { file, changed: false };
    const f = readJsonFile(file);
    if (!f.ok) return { file, changed: false, skipped: true, note: `${f.reason}; not touched` };
    const settings = f.value;
    const env = envOf(settings);
    if (!env || typeof env.ANTHROPIC_BASE_URL !== "string" || !OURS_URL.test(env.ANTHROPIC_BASE_URL))
      return { file, changed: false };
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
  /** Someone else's base URL: that config dir does not go through the pool. */
  | "other"
  | "unreadable";

/** Per settings.json: does Claude Code there go through this listener? */
export function installedPoolEnv(
  dirs: readonly string[],
  o: { port: number; token: string },
): { file: string; state: PoolEnvState; note?: string }[] {
  const want = poolEnv(o.port, o.token);
  return dirs.map((dir) => {
    const file = settingsIn(dir);
    const f = readJsonFile(file);
    if (!f.ok) return { file, state: "unreadable", note: f.reason };
    const env = envOf(f.value);
    const base = env?.ANTHROPIC_BASE_URL;
    if (base === undefined) return { file, state: "missing" };
    if (typeof base !== "string" || !OURS_URL.test(base))
      return { file, state: "other", note: `ANTHROPIC_BASE_URL is ${String(base)}` };
    return { file, state: POOL_ENV_KEYS.every((k) => env?.[k] === want[k]) ? "current" : "stale" };
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
