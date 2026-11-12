// SPDX-License-Identifier: Apache-2.0
// What `--help` prints: the page of every command, in groups a person can scan, and one
// command's usage folded to the terminal. The usage lines themselves are help.ts's.
import { helpFor, usageTable } from "./help.js";
import { cols, fold, heading, pad, table, tint, type Ui } from "./style.js";

/** Every command in a few groups, each with what it is for in a line that fits 80
 *  columns: the page `sessionpipe` and `sessionpipe --help` print. The usage of one
 *  command, with every option, is `sessionpipe <command> --help` (the table above). */
export const GROUPS: readonly { title: string; rows: readonly (readonly [string, string])[] }[] = [
  {
    title: "Set up",
    rows: [
      ["connect <receiver>", "All in one go: hooks, a sink, messages, keys"],
      ["install", "Only the hooks; nothing is sent anywhere"],
      ["uninstall", "Take the hooks out again"],
      ["update [off|on]", "Bring this whole computer up to date, in one step"],
    ],
  },
  {
    title: "Check",
    rows: [
      ["doctor", "Is this computer fine, and what to fix"],
      ["status", "The same in a few lines"],
      ["tail", "Watch events as they happen, on this computer"],
    ],
  },
  {
    title: "Where events go",
    rows: [
      ["sink add <url>", "Send events to a receiver, a file or stdout"],
      ["sink list|remove|test", "The sinks, one taken away, a test event to one"],
      ["secrets [move <store>]", "Where this computer's keys are kept"],
      ["backfill", "Queue the last 30 days of sessions"],
      ["replay", "Send again what the outbox holds"],
      ["forget <agent> <id>", "Delete one session here and at every sink"],
      ["titles [on|off|refresh]", "Name Claude Code sessions as claude.ai does"],
    ],
  },
  {
    title: "Messages from your devices",
    rows: [
      ["control pair <receiver>", "Trust a device's key, at this computer's terminal"],
      ["control status", "The background service: what it hears and holds"],
      ["control mode <mode>", "What a session you message may do"],
      ["control folders", "Where sessions you message may run"],
      ["control keys", "The keys this computer trusts"],
      ["control off", "Stop taking messages"],
      ["control run", "What the background service runs"],
    ],
  },
  {
    title: "Several Claude accounts",
    rows: [
      ["pool", "The accounts in order, and the room each has left"],
      ["pool on|off", "Point every Claude Code here at the pool, or stop"],
      ["pool add", "Add an account: --import or --login"],
      ["pool remove|enable|disable", "Take an account out, or turn it on or off"],
      ["pool order|refresh", "Set the order; read each account's usage now"],
    ],
  },
  {
    title: "Agents asking agents",
    rows: [
      ['ask <agent> "<task>"', "Give another agent a task; the answer is stdout"],
      ["ask on|off|status|setup", "Allow it or not, see it, tell the agents of it"],
      ["wait", "A session runs this to take messages"],
      ["channel", "Claude Code runs this as a channel"],
    ],
  },
  {
    title: "Everywhere",
    rows: [
      ["-h, --help", "A command's usage, without running it"],
      ["--json", "For a program: status, doctor, pool, tail, ask"],
      ["--no-color", "No colour; NO_COLOR and FORCE_COLOR work too"],
      ["--version", "The installed version"],
    ],
  },
];

/** The page of every command: what each is for, all in one column. */
export function overview(ui: Ui, version: string): string {
  const w = Math.max(...GROUPS.flatMap((g) => g.rows.map(([cmd]) => cols(cmd))));
  return [
    `${tint(ui, "bold", `sessionpipe ${version}`)} · what your coding agents are doing, sent where you choose`,
    "",
    `${tint(ui, "bold", "Usage:")} sessionpipe <command> [options]`,
    "       sessionpipe <command> --help    every option of one command",
    ...GROUPS.flatMap((g) => [
      "",
      heading(ui, g.title),
      ...table(
        ui,
        g.rows.map(([cmd, about]) => [tint(ui, "cyan", pad(cmd, w)), about]),
      ),
    ]),
    "",
    "Docs: https://sessionpipe.org · nothing is sent anywhere until you add a sink.",
  ].join("\n");
}

/** A usage line's parts: an option with its value, a choice, a note in brackets each
 *  stay whole, so a fold never lands inside `[--tier 0-3]`. */
function parts(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of line) {
    if (ch === " " && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** One command's usage. A pipe gets the line whole, as before; a terminal gets it
 *  folded between options, each further line under the first thing after the command,
 *  and the line's closing note as a sentence of its own. */
export function usage(ui: Ui, args: readonly string[], harnesses: readonly string[]): string | undefined {
  const name = helpFor(args);
  const whole = usageTable(harnesses)[name];
  if (!whole) return undefined;
  const lead = `${tint(ui, "bold", "Usage:")} sessionpipe `;
  const end = "\n\n  -h, --help  Show help without running the command.";
  if (ui.width === Number.POSITIVE_INFINITY) return lead + whole + end;
  const noted = /^(.*?) \(([^()]*)\)$/.exec(whole);
  const hang = cols(lead) + cols(name) + 1;
  const lines: string[] = [];
  let cur = lead;
  // A part too long for any line (a list of every agent's flag) folds at its own spaces.
  const room = ui.width - hang;
  for (const w of parts(noted?.[1] ?? whole).flatMap((p) => (cols(p) > room ? p.split(" ") : [p]))) {
    if (cols(cur) > hang && cols(cur) + 1 + cols(w) > ui.width) {
      lines.push(cur);
      cur = " ".repeat(hang) + w;
    } else cur += cur === lead ? w : ` ${w}`;
  }
  lines.push(cur);
  if (noted) lines.push("", ...fold(ui, "  ", noted[2] as string));
  return lines.join("\n") + end;
}
