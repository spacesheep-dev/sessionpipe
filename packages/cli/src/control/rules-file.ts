// SPDX-License-Identifier: Apache-2.0
// The person's trigger rules on disk (spec/CONTROL.md §14.1): `<config>/triggers.json`, beside
// control.json, mode 0600, in config.proto's TriggersFile shape. The CLI writes it, whole and
// atomically, after the person confirmed the change at this machine's terminal; the daemon reads
// it, whole or not at all, and never writes it. What the daemon keeps of the rules' runs (their
// history, today's counts, a pause the machine made itself) is its own, in
// `<state>/control/triggers-state.json`, which the CLI only reads.
//
// "The mode, like the folders, is the person's choice at the machine's own terminal, and no
// command changes it" (CONTROL.md §2): the same goes for these rules, so every command that
// changes them refuses inside a harness session (`harnessSession`).
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { checkTriggers, configFile, readTriggers, type TriggersFile, triggerPlaces } from "@sessionpipe/core";
import { controlState, writePrivate } from "./store.js";

export const triggersFile = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(path.dirname(configFile(env)), "triggers.json");

/** What the daemon keeps of the rules' runs (control/triggers.ts), beside its other state. */
export const triggerStateFile = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(controlState(env), "triggers-state.json");

/** The rules file as a machine reads it: not there, read whole, or refused whole with every
 *  problem (CONTROL.md §14.1: "a file that does not fit this, or is not there, is read as no
 *  rules with triggers off"). */
export type RulesRead =
  | { state: "none" }
  | { state: "ok"; file: TriggersFile }
  | { state: "refused"; problems: string[] };

/** The rules file is at most this large: 50 rules of 4 000 characters of words each, every one
 *  of them written out as a six-byte JSON escape at worst, with every other field at its limit,
 *  is under 1.3 MB. A larger file is refused whole, never parsed. */
export const RULES_MAX_BYTES = 2 * 1024 * 1024;

export function readRules(env: NodeJS.ProcessEnv = process.env): RulesRead {
  return readRulesText(env).read;
}

/** The rules file as read, and its exact text (null when it is not there): what a command
 *  compares after the person said `yes`, so a change made meanwhile is never written over. */
export function readRulesText(env: NodeJS.ProcessEnv = process.env): { read: RulesRead; text: string | null } {
  let text: string;
  try {
    if (statSync(triggersFile(env)).size > RULES_MAX_BYTES)
      return { read: { state: "refused", problems: [`$: larger than ${RULES_MAX_BYTES} bytes`] }, text: null };
    text = readFileSync(triggersFile(env), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { read: { state: "none" }, text: null };
    // The system's own words name the file and why (EACCES, EISDIR): no text from inside it.
    return {
      read: { state: "refused", problems: [`$: can't be read (${(e as NodeJS.ErrnoException).code})`] },
      text: null,
    };
  }
  const r = readTriggers(text, triggerPlaces(env));
  return { read: r.ok ? { state: "ok", file: r.file } : { state: "refused", problems: r.problems }, text };
}

/** The file a machine runs: the rules, or null for none (triggers off). */
export const rulesOf = (r: RulesRead): TriggersFile | null => (r.state === "ok" ? r.file : null);

/** Write the rules file whole (a temporary file renamed over it, mode 0600). A file that would
 *  not read back is never written: the check is the reader's own. */
export function writeRules(file: TriggersFile, env: NodeJS.ProcessEnv = process.env): void {
  const r = checkTriggers(file, triggerPlaces(env));
  if (!r.ok) throw new Error(`the rules would not read back: ${r.problems.join("; ")}`);
  writePrivate(triggersFile(env), file);
}

/** The harness session this command runs inside, by the variable that says so, or null: the
 *  guard `ask on` uses (Claude Code's and Codex's session ids, the daemon's job mark), with
 *  Claude Code's own `CLAUDECODE` beside it (CONTROL.md §14.1). */
export function harnessSession(env: NodeJS.ProcessEnv): string | null {
  for (const v of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "SESSIONPIPE_CONTROL_JOB"])
    if (env[v]) return v;
  return null;
}
