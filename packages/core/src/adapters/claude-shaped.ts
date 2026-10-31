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
// newline, a byte-order mark) so uninstall leaves it byte-identical. A file that did not exist before
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
      bom: boolean;
    }
  | {
      ok: true;
      existed: false;
      value: Record<string, unknown>;
      raw: "";
      indent: "  ";
      eol: "\n";
      finalNewline: true;
      bom: false;
    }
  | { ok: false; existed: true; reason: string };

/** Read a JSON config file with its shape. Never guesses: a parse failure is a
 *  refusal to touch the file, not an empty object. */
export function readJsonFile(file: string): JsonFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ok: true, existed: false, value: {}, raw: "", indent: "  ", eol: "\n", finalNewline: true, bom: false };
  }
  // A UTF-8 byte-order mark (PowerShell 5's UTF8 encoding, older Windows editors): JSON.parse
  // refuses it, the harnesses read past it. Kept, and written back, like the line ends.
  const bom = raw.charCodeAt(0) === 0xfeff;
  if (bom) raw = raw.slice(1);
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
    bom,
  };
}

/** Serialise in the file's own shape. */
export function formatJson(
  value: unknown,
  f: { indent: string; eol: string; finalNewline: boolean; bom?: boolean },
): string {
  const text = JSON.stringify(value, null, f.indent).replace(/\n/g, f.eol);
  return (f.bom ? "\uFEFF" : "") + (f.finalNewline ? text + f.eol : text);
}

/** Back-compat helper for callers that only read. */
export function readJson(file: string): Record<string, unknown> {
  const f = readJsonFile(file);
  return f.ok ? f.value : {};
}

/** The report for a config file the system would not let us change, with the error's
 *  code, so `install` and `uninstall` go on to the next file instead of ending on this
 *  one. Node opens a file for truncation before it writes, so an error from the open
 *  (EACCES; EPERM, which Windows gives a read-only file; EROFS) or from making its
 *  folder left the file as it was, and so does a delete refused; the note says so. Only
 *  an error from the write itself (ENOSPC, EIO) can have left the file cut short, and
 *  that note says to check it instead. */
function refused(
  file: string,
  e: unknown,
  what: "write" | "remove",
  existed: boolean,
): InstallReport & { note: string } {
  const { code, syscall } = e as NodeJS.ErrnoException;
  const why = `can't ${what} it (${code ?? String(e)})`;
  if (what === "remove" || syscall === "open" || syscall === "mkdir")
    return { file, changed: false, skipped: true, note: `${why}; not touched` };
  return {
    file,
    changed: true,
    skipped: true,
    ...(existed ? {} : { created: true }),
    note: `${why} part way; check the file before the harness reads it`,
  };
}

/** Write a config file back, its folder made first. Null once written; otherwise the
 *  report for the refusal (see `refused`), which the caller returns in place of its own.
 *  `existed` is whether the file was there before: a file cut short is still one
 *  sessionpipe made, and the config remembers it as `created`. */
export function writeBack(file: string, text: string, existed = true): InstallReport | null {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return null;
  } catch (e) {
    return refused(file, e, "write", existed);
  }
}

/** Remove a config file sessionpipe created and uninstall has emptied. A delete needs
 *  the folder's leave where a write needs only the file's, so a delete refused (a
 *  ~/.claude owned by root, a folder ACL on Windows) writes the file back empty instead:
 *  our hooks come out either way, and the note says what stayed. */
export function removeEmptied(file: string, empty: string): InstallReport {
  try {
    unlinkSync(file);
    return { file, changed: true, note: "removed (sessionpipe created it)" };
  } catch (e) {
    const bad = refused(file, e, "remove", true);
    return (
      writeBack(file, empty) ?? {
        file,
        changed: true,
        note: `emptied; ${bad.note.replace(/; not touched$/, "")}, so the empty file stays`,
      }
    );
  }
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
    const bad = writeBack(file, formatJson(settings, f), f.existed);
    if (bad) return bad;
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
  if (opts.created && !Object.keys(settings).length) return removeEmptied(file, formatJson(settings, f));
  return writeBack(file, formatJson(settings, f)) ?? { file, changed: true };
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
