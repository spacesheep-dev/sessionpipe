// SPDX-License-Identifier: Apache-2.0
// What `sessionpipe reinstall` shows before it does anything: what it found, and what
// will happen, a row an action. The same screens for a dry run and for a real one.
import { cols, commands, fold, heading, mark, type Tint, table, tint, type Ui } from "../style.js";
import type { Copy, Inventory, Use } from "./find.js";
import type { Facts, Left, Plan, Step } from "./plan.js";

const USED: Record<Use, string> = {
  typed: "you type this",
  service: "the background service",
  hooks: "the hooks",
  this: "this command",
};

/** What uses a copy, in a few words. "this command" says something only of a copy nobody
 *  types. */
export const usedBy = (c: Copy): string =>
  c.uses
    .filter((u) => u !== "this" || !c.uses.includes("typed"))
    .map((u) => USED[u])
    .join(", ") || "nothing uses it";

const version = (c: Copy): string => (c.aside ? "left over" : (c.version ?? "broken"));

/** A folder set after `first`, and one longer than the line broken after a `/` or `\`,
 *  each further line starting under the folder's first character: a path has no spaces
 *  to fold at. */
function folder(ui: Ui, first: string, where: string): string[] {
  const room = ui.width - cols(first);
  const lines: string[] = [];
  let cur = "";
  for (const part of where.split(/(?<=[\\/])/)) {
    if (cur && cols(cur) + cols(part) > room) {
      lines.push(cur);
      cur = part;
    } else cur += part;
  }
  lines.push(cur);
  return lines.map((l, i) => (i ? " ".repeat(cols(first)) + l : first + l));
}

/** Words set after `first` and folded under their own first letter; a word longer than
 *  the line (a folder) is broken as `folder` breaks one. */
function wrap(ui: Ui, first: string, body: string): string[] {
  const hang = " ".repeat(cols(first));
  return fold(ui, first, body).flatMap((line, i) => {
    const lead = i ? hang : first;
    return cols(line) > ui.width ? folder(ui, lead, line.slice(lead.length)) : [line];
  });
}

/** What was found: every copy, its release, and what uses it; then what else is wrong.
 *  `show`: how a path is said in a sentence (the caller's `~/…`). What is no install of
 *  sessionpipe is not wrong: it is under "Left alone". */
export function found(ui: Ui, inv: Inventory, f: Facts, show: (p: string) => string = (p) => p): string[] {
  const n = inv.copies.length;
  // Why a folder is no install is said once, on its row under "Left alone".
  const about = (c: Copy): string =>
    [usedBy(c), ...(c.wrong ? [c.wrong] : []), ...(c.not ? ["not an install"] : [])].join(" · ");
  const sign = (c: Copy): string => mark(ui, c.wrong || !c.runs ? "bad" : "info");
  // One line a copy while the folders are short; a folder too long for that (an fnm or
  // asdf one) gets the line to itself, and the rest goes under it.
  const wide = inv.copies.some((c) => cols(c.where) > 36);
  const lines = [
    heading(
      ui,
      n === 1 ? "Found one copy of sessionpipe on this computer" : `Found ${n} copies of sessionpipe on this computer`,
    ),
    ...(wide
      ? inv.copies.flatMap((c) => [
          ...folder(ui, `  ${sign(c)} `, c.where),
          ...fold(ui, "      ", `${version(c)} · ${about(c)}`),
        ])
      : table(
          ui,
          inv.copies.map((c) => [`${sign(c)} ${version(c)}`, c.where, about(c)]),
        )),
  ];
  const wrong = [
    ...inv.dangling.map((file) => `${show(file)} is a link to a sessionpipe that is gone`),
    ...f.hooks.wrong.map((w) => `the hooks: ${w}`),
    ...(f.service && !f.service.nodeOk
      ? [`the service file names a node that is gone (${f.service.node ? show(f.service.node) : "?"})`]
      : []),
    ...(f.service && !f.service.cliOk ? ["the service file names a copy of sessionpipe that is gone"] : []),
    ...(f.staleSocket
      ? ["a socket file is there with no daemon behind it (the next one that starts replaces it)"]
      : []),
    ...(f.service && !f.service.loaded ? ["the service file is there, and the service is not loaded"] : []),
    ...(f.service?.loaded && !f.daemon ? ["the service is loaded, and nothing answers"] : []),
    ...(f.service && !f.wanted && !f.daemon
      ? ["nothing here needs the background service: paired with nobody, the pool off, asking off"]
      : []),
    ...(f.service && f.daemon && f.service.pid !== f.daemon.pid
      ? [`a daemon someone started by hand (pid ${f.daemon.pid}) holds the socket the service needs`]
      : []),
  ];
  if (wrong.length)
    lines.push("", heading(ui, "Also found"), ...wrong.flatMap((w) => fold(ui, `  ${mark(ui, "warn")} `, w)));
  return lines;
}

/** The kinds of row a plan has: its sign, and the one colour of its kind. The sign and
 *  the verb say it without colour. */
const KIND = {
  install: { sign: "+", tint: "green" },
  switch: { sign: "~", tint: "yellow" },
  stop: { sign: "~", tint: "yellow" },
  remove: { sign: "-", tint: "red" },
  keep: { sign: "=", tint: "dim" },
} as const satisfies Record<string, { sign: string; tint: Tint }>;
type Kind = keyof typeof KIND;

/** The verb a step's row starts with. Taking the service file away is a removal too. */
const VERB = {
  install: "install",
  stop: "stop",
  unserve: "remove",
  use: "switch",
  remove: "remove",
} as const satisfies {
  [K in Extract<Step, { say: unknown }>["do"]]: Kind;
};

/** What no run touches, said as the last row of every plan. */
const KEPT = "pairings, settings, keys, messages waiting to be sent";

/** One action: its sign and verb in the colour of its kind, then what it is done to. A
 *  removal is the row the eye should land on: its verb is bold as well. */
function row(ui: Ui, kind: Kind, what: string): string[] {
  const k = KIND[kind];
  const verb = tint(ui, k.tint, `${k.sign} ${kind.padEnd(7)}`);
  return wrap(ui, `  ${kind === "remove" ? tint(ui, "bold", verb) : verb}  `, what);
}

/** What stays as it is, a row a thing: where it is, then why in a few words. A copy that
 *  would have gone is marked, and the command that removes it is not said here: a run
 *  ends with it, once, where it can be copied whole. */
export function leftAlone(ui: Ui, left: readonly Left[]): string[] {
  if (!left.length) return [];
  const sign = (l: Left): string => mark(ui, l.ours ? "warn" : "info");
  const why = (l: Left): string =>
    l.ours
      ? `${l.version ?? "a broken copy"} · ${l.line ? "needs sudo: a run ends with its line" : l.why}`
      : `${l.why}${l.line ? `: \`${l.line}\` removes it` : ""}`;
  const wide = left.some((l) => cols(l.where) > 36);
  return [
    heading(ui, "Left alone"),
    ...(wide
      ? left.flatMap((l) => [...folder(ui, `  ${sign(l)} `, l.where), ...fold(ui, "      ", why(l))])
      : table(
          ui,
          left.map((l) => [`${sign(l)} ${l.where}`, why(l)]),
        )
    ).map((l) => commands(ui, l)),
  ];
}

/** A note: under its mark, a second line of it under its words, a command shown as one. */
const noted = (ui: Ui, notes: readonly string[]): string[] =>
  notes.flatMap((n) => fold(ui, `  ${mark(ui, "warn")} `, n).map((l) => commands(ui, l)));

/** What will happen, a row an action in the order they are taken; what is left alone and
 *  why; and the line that says what keeps it safe. */
export function planned(ui: Ui, p: Plan): string[] {
  const lines = [
    heading(ui, "This will"),
    ...p.steps.flatMap((s) => ("say" in s && s.say ? row(ui, VERB[s.do], s.say) : [])),
    ...row(ui, "keep", KEPT),
  ];
  for (const more of [leftAlone(ui, p.left), noted(ui, p.notes)]) if (more.length) lines.push("", ...more);
  lines.push("", ...p.safety.flatMap((s) => fold(ui, "", s)));
  return lines;
}
