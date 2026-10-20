// SPDX-License-Identifier: Apache-2.0
// The hooks file shape Claude Code introduced and Codex, Droid and (with
// `version: 1`) Cursor and Copilot reuse: {"hooks":{"<Event>":[{"matcher"?,
// "hooks":[{"type":"command","command","timeout"}]}]}}. Ours is one entry per
// event; a re-install replaces a stale entry of ours (an old node path) and never
// touches anyone else's.
//
// Two rules from issue #8: a file that is not plain JSON (a comment, a trailing
// comma, a write in progress) is never written back — the harness is skipped and
// the report says why; and a file is written back in its own shape (indent, final
// newline) so uninstall leaves it byte-identical. A file that did not exist before
// install is reported `created`, and uninstall deletes it once it is empty again.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HookCommand, InstallReport } from "./types.js";

export interface ClaudeShapedOptions {
  /** Which events take a `matcher` (tool and permission events). */
  matcherFor: (event: string) => string | undefined;
  /** Seconds (milliseconds for Gemini CLI). */
  timeout: number;
  /** A longer timeout for one event (Claude Code's PermissionRequest, which may wait
   *  for a verified control answer: spec/CONTROL.md §6). */
  timeoutFor?: (event: string) => number | undefined;
  /** Extra top-level keys the file must carry (Cursor/Copilot: version: 1). */
  top?: Record<string, unknown>;
}

/** A command of ours: a path that contains "sessionpipe" and ends in hook.js (or in
 *  sessionpipe-hook, the launcher that outlives a node upgrade), then a harness and an event. */
export const OURS = /(?:sessionpipe[^"\n]*[\\/]hook\.js|[\\/]sessionpipe-hook)"?\s+[a-z][a-z-]*\s+[A-Za-z]+\s*$/;
export const isOurs = (h: { hooks?: { command?: string }[] }): boolean =>
  Array.isArray(h?.hooks) && h.hooks.some((x) => typeof x.command === "string" && OURS.test(x.command));

export type JsonFile =
  | {
      ok: true;
      existed: true;
      value: Record<string, unknown>;
      raw: string;
      indent: string;
      eol: string;
      finalNewline: boolean;
    }
  | { ok: true; existed: false; value: Record<string, unknown>; raw: ""; indent: "  "; eol: "\n"; finalNewline: true }
  | { ok: false; existed: true; reason: string };

/** Read a JSON config file with its shape. Never guesses: a parse failure is a
 *  refusal to touch the file, not an empty object. */
export function readJsonFile(file: string): JsonFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ok: true, existed: false, value: {}, raw: "", indent: "  ", eol: "\n", finalNewline: true };
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
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const m = /^( +|\t+)\S/m.exec(raw);
  const indent = m?.[1] ?? "  ";
  return {
    ok: true,
    existed: true,
    value: value as Record<string, unknown>,
    raw,
    indent,
    eol,
    finalNewline: /\r?\n$/.test(raw),
  };
}

/** Serialise in the file's own shape. */
export function formatJson(value: unknown, f: { indent: string; eol: string; finalNewline: boolean }): string {
  const text = JSON.stringify(value, null, f.indent).replace(/\n/g, f.eol);
  return f.finalNewline ? text + f.eol : text;
}

/** Back-compat helper for callers that only read. */
export function readJson(file: string): Record<string, unknown> {
  const f = readJsonFile(file);
  return f.ok ? f.value : {};
}

function entryFor(event: string, harness: string, cmd: HookCommand, o: ClaudeShapedOptions) {
  const matcher = o.matcherFor(event);
  return {
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: "command", command: cmd([harness, event]).command, timeout: o.timeoutFor?.(event) ?? o.timeout }],
  };
}

export function installClaudeShaped(
  file: string,
  harness: string,
  events: readonly string[],
  cmd: HookCommand,
  o: ClaudeShapedOptions,
): InstallReport {
  const f = readJsonFile(file);
  if (!f.ok) return { file, changed: false, skipped: true, note: `${f.reason}; not touched` };
  const settings = f.value;
  const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<
    string,
    unknown[]
  >;
  let changed = false;
  const want = new Set(events);
  // Events we no longer hook (a lean install) lose their entry of ours.
  for (const ev of Object.keys(hooks)) {
    if (want.has(ev)) continue;
    const list = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const kept = list.filter((h) => !isOurs(h as never));
    if (kept.length !== list.length) {
      changed = true;
      if (kept.length) hooks[ev] = kept;
      else delete hooks[ev];
    }
  }
  for (const ev of events) {
    const list = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const entry = entryFor(ev, harness, cmd, o);
    const mine = list.filter((h) => isOurs(h as never));
    if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(entry)) continue;
    hooks[ev] = list.filter((h) => !isOurs(h as never)).concat([entry]);
    changed = true;
  }
  if (o.top)
    for (const [k, v] of Object.entries(o.top))
      if (settings[k] !== v) {
        settings[k] = v;
        changed = true;
      }
  if (changed) {
    settings.hooks = hooks;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, formatJson(settings, f));
  }
  return { file, changed, created: !f.existed && changed };
}

export function uninstallClaudeShaped(
  file: string,
  events: readonly string[],
  opts: { created?: boolean | undefined } = {},
): InstallReport {
  if (!existsSync(file)) return { file, changed: false };
  const f = readJsonFile(file);
  if (!f.ok) return { file, changed: false, skipped: true, note: `${f.reason}; not touched` };
  const settings = f.value;
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || typeof hooks !== "object") return { file, changed: false };
  let changed = false;
  for (const ev of [...events, ...Object.keys(hooks)]) {
    const list = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const kept = list.filter((h) => !isOurs(h as never));
    if (kept.length !== list.length) {
      changed = true;
      if (kept.length) hooks[ev] = kept;
      else delete hooks[ev];
    }
  }
  if (!changed) return { file, changed: false };
  if (!Object.keys(hooks).length) delete settings.hooks;
  if (opts.created && !Object.keys(settings).length) {
    unlinkSync(file);
    return { file, changed: true, note: "removed (sessionpipe created it)" };
  }
  writeFileSync(file, formatJson(settings, f));
  return { file, changed: true };
}

export function installedClaudeShaped(
  file: string,
  harness: string,
  events: readonly string[],
  cmd: HookCommand,
  o: ClaudeShapedOptions,
): "current" | "stale" | "missing" {
  const f = readJsonFile(file);
  const hooks = (f.ok ? (f.value.hooks ?? {}) : {}) as Record<string, unknown[]>;
  let present = 0;
  let current = 0;
  for (const ev of events) {
    const list = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const mine = list.filter((h) => isOurs(h as never));
    if (mine.length) present++;
    if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(entryFor(ev, harness, cmd, o))) current++;
  }
  // An entry of ours on an event outside the wanted set (a lean install after a full one) is stale.
  for (const ev of Object.keys(hooks))
    if (!events.includes(ev) && (Array.isArray(hooks[ev]) ? hooks[ev] : []).some((h) => isOurs(h as never)))
      return "stale";
  if (!present) return "missing";
  return current === events.length ? "current" : "stale";
}
