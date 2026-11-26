// SPDX-License-Identifier: Apache-2.0
// The one `sessionpipe trigger add` command that makes a rule again (spec/CONTROL.md §14.1,
// `trigger line`), to make the same rule on another machine. A program reads it back (a page that
// takes the line pasted in), so it is a contract, fixed by conformance/triggers/trigger-line.json:
//
//   - the flags in one order: --on --topic --event | --every; --when state= --when for= --when by=;
//     --subject; --start | --continue; --folder; --level; --tools; --cap; --words;
//   - --level and --cap (`<n>/day`) always, --event, --when, --subject and --tools only when the
//     rule has them; a `when` key's values joined by `,` in one flag, in the rule's order, and the
//     tools the same;
//   - a value bare when it is not empty, holds only `A-Z a-z 0-9 _ . / : @ = + -`, and does not
//     start with `=` (zsh expands it) or `-`; else in POSIX single quotes, a `'` in it written
//     `'\''`, a line feed kept as itself inside them;
//   - a value that starts with `-` written as one word `--flag=<value>` (the value quoted as
//     above), so no reader takes it for a flag; `add` takes `--flag=<value>` for every flag.
// It is read as POSIX sh, bash and zsh read it; fish, PowerShell and cmd read quotes otherwise,
// and take `--json` instead.
import type { TriggerRule } from "../types.js";
import { isNoticeSource, isStart } from "./rules.js";

const BARE = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./:@=+-");

/** A value as one POSIX shell word (bare, or in single quotes), as the line writes it. */
export function shellWord(v: string): string {
  const bare = v !== "" && v[0] !== "=" && v[0] !== "-" && [...v].every((c) => BARE.has(c));
  return bare ? v : `'${v.replaceAll("'", "'\\''")}'`;
}

/** The command that makes `r` again: its words from `trigger` on (`argv`), and the line a person
 *  pastes (`sessionpipe` and those words, each as one POSIX shell word, one space apart). A rule
 *  is made unpaused. */
export function triggerLine(r: TriggerRule): { line: string; argv: string[] } {
  const argv = ["trigger", "add", r.name];
  const words = ["trigger", "add", r.name];
  const put = (flag: string, value: string) => {
    if (value.startsWith("-")) {
      argv.push(`${flag}=${value}`);
      words.push(`${flag}=${shellWord(value)}`);
    } else {
      argv.push(flag, value);
      words.push(flag, shellWord(value));
    }
  };
  const s = r.source;
  if (isNoticeSource(s)) {
    put("--on", s.receiver);
    put("--topic", s.topic);
    if (s.event !== undefined) put("--event", s.event);
  } else put("--every", s.every);
  for (const k of ["state", "for", "by"] as const) {
    const v = r.when?.[k];
    if (v?.length) put("--when", `${k}=${v.join(",")}`);
  }
  if (r.subject !== undefined) put("--subject", r.subject);
  if (isStart(r.target)) put("--start", r.target.start);
  else put("--continue", r.target.continue);
  put("--folder", r.folder);
  put("--level", r.level);
  if (r.tools?.length) put("--tools", r.tools.join(","));
  put("--cap", `${r.cap.per_day}/day`);
  put("--words", r.words);
  return { line: `sessionpipe ${words.join(" ")}`, argv };
}
