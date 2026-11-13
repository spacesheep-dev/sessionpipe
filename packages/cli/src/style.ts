// SPDX-License-Identifier: Apache-2.0
// How sessionpipe looks at a terminal, in one place and with no dependency: when colour
// is on, the marks, the width a line may take, how a long line folds, and what is taken
// out of text that came from somewhere else.
//
//   colour   only at a terminal. There --no-color, then FORCE_COLOR (0 or false: off;
//            anything else: on, NO_COLOR or not), then NO_COLOR, then TERM=dumb decide.
//            A pipe is never coloured, whatever the environment says: a program reads
//            it. Only the eight basic colours, bold and dim, so a dark and a light theme
//            both read.
//   meaning  never by colour alone: every state has a mark (✓ ! ✗ ·) and a word.
//   width    a terminal's columns, at most 100; a long line folds at a space, under
//            its own text, and never inside a `command`. A pipe gets whole lines, so
//            grep and scripts see one fact per line, exactly as before.
//   Windows  Windows Terminal and anything that sets TERM get ✓ and ✗; the old console
//            (cmd, PowerShell in conhost), whose fonts lack them, gets √ and ×.
//   outside  a receiver's reason, npm's last words, a line of a log: `clean` takes out
//            of them everything a terminal would act on (see there).
//
// Nothing a program reads comes through here: hook output, the worker, the status
// line, every --json and the daemon's log are written as they always were.

export interface Ui {
  /** Colour codes may be written. */
  color: boolean;
  /** ✓ and ✗ can be shown. */
  unicode: boolean;
  /** Columns a line may take; Infinity for a pipe, which gets whole lines. */
  width: number;
  /** The output is a terminal. */
  tty: boolean;
}

export interface UiOptions {
  isTTY?: boolean | undefined;
  columns?: number | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** `--no-color` was given. */
  noColor?: boolean;
}

/** The widest a line of prose is set, however wide the terminal. */
export const MAX_WIDTH = 100;
const MIN_WIDTH = 40;

export function makeUi(o: UiOptions = {}): Ui {
  const env = o.env ?? process.env;
  const tty = !!o.isTTY;
  const force = env.FORCE_COLOR;
  // A pipe is never coloured: FORCE_COLOR says how a terminal looks, not what a program reads.
  const color =
    tty &&
    !o.noColor &&
    (force !== undefined ? force !== "0" && force !== "false" : !env.NO_COLOR && env.TERM !== "dumb");
  const oldConsole =
    tty && (o.platform ?? process.platform) === "win32" && !env.WT_SESSION && !env.TERM && !env.TERM_PROGRAM;
  return {
    color,
    unicode: !oldConsole,
    // One column short of the terminal's: a line that fills the last one wraps in some.
    width: tty ? Math.max(MIN_WIDTH, Math.min((o.columns || 80) - 1, MAX_WIDTH)) : Number.POSITIVE_INFINITY,
    tty,
  };
}

/** A pipe, as every command wrote before there was any of this. */
export const PLAIN: Ui = { color: false, unicode: true, width: Number.POSITIVE_INFINITY, tty: false };

const SGR = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39] } as const;
export type Tint = keyof typeof SGR;

/** `s` in a colour or weight, when colour is on. Each ends only what it began, so a
 *  bold line may hold a coloured word. */
export function tint(ui: Ui, how: Tint, s: string): string {
  return ui.color && s ? `\x1b[${SGR[how][0]}m${s}\x1b[${SGR[how][1]}m` : s;
}

// --- text from outside -----------------------------------------------------------------
// A receiver's reason for saying no, npm's last words, a line of a log, a name out of a
// file: none of it is ours, and any of it may hold what a terminal acts on rather than
// shows. An escape sequence clears the screen, moves the cursor, sets the window's title
// or hides what follows; a bidi control turns the reading order round; a line break
// starts a line of its own, which could be made to look like one of ours. `clean` is the
// one strip for all of it.
//
// Where it runs is what makes it hold. It runs where text leaves, not only where a value
// comes in: `main` (cli.ts) writes every line a person reads through it, and a failure
// goes through `failure`. So a command that forgets to clean a value changes nothing:
// there is no other way to the terminal. A finished line holds our own colour codes, so
// there the strip lets through exactly the codes `tint` writes (bold, dim, four colours,
// and their two ends) and no other sequence. The most a value could then do is colour
// itself. And it can't do that either where a function is handed text before any colour
// is on it (`paint`, `failure`, `fixes`, a row of a report): there it is cleaned as
// well, and harder. No code at all is left, and in a value a line break becomes a space.
// (A line a command writes itself may be several lines, so `paint` keeps the breaks: a
// command that puts a receiver's words on such a line cleans them where it does.)

const ESC = String.fromCharCode(27);
/** The codes `tint` writes: the only ones `clean` ever leaves in. */
const OWN = new Set(Object.values(SGR).flatMap((pair) => pair.map((n) => `${ESC}[${n}m`)));
/** One thing to take out, tried in this order so no sequence is left half on the line:
 *  a CSI sequence whole (ESC [ … and its final byte); a string sent to the terminal
 *  itself (OSC, DCS, SOS, PM, APC) up to the BEL or ST that ends it; any other ESC with
 *  the byte it introduces; a run of line breaks; then single characters: C0 but tab,
 *  DEL, C1, and the bidi overrides and isolates (U+202A–202E, U+2066–2069). */
const STRIP = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}[\\]PX^_][^\\u0007\\n\\r${ESC}]*(?:\\u0007|${ESC}\\\\)`,
    `${ESC}[ -/]*[0-~]`,
    "(?:\\r?\\n)+",
    "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]",
  ].join("|"),
  "g",
);

/** `s` with nothing in it a terminal would act on. As it stands, for a value from
 *  outside: no escape sequence, no control character but a tab, no bidi control, and a
 *  line break turned into a space. `ours` says what a line of our own making may keep:
 *  its line `breaks`, and the `colour` codes `tint` wrote, and only those. */
export function clean(s: string, ours: { breaks?: boolean; colour?: boolean } = {}): string {
  return s.replace(STRIP, (m) => {
    if (m.endsWith("\n")) return ours.breaks ? m.replaceAll("\r", "") : " ";
    return ours.colour && OWN.has(m) ? m : "";
  });
}

export type Mark = "ok" | "warn" | "bad" | "info" | "same";
const MARKS: Record<Mark, { sign: string; old: string; tint: Tint }> = {
  ok: { sign: "✓", old: "√", tint: "green" },
  warn: { sign: "!", old: "!", tint: "yellow" },
  bad: { sign: "✗", old: "×", tint: "red" },
  info: { sign: "·", old: "·", tint: "dim" },
  same: { sign: "=", old: "=", tint: "dim" },
};
const BY_SIGN = new Map(Object.values(MARKS).map((m) => [m.sign, m]));

/** The sign for a state, in its colour. */
export function mark(ui: Ui, m: Mark): string {
  const k = MARKS[m];
  return tint(ui, k.tint, ui.unicode ? k.sign : k.old);
}

/** `a command` in a sentence: the backticks stay, so it reads the same without colour. */
export function commands(ui: Ui, s: string): string {
  return ui.color ? s.replace(/`[^`\n]+`/g, (c) => tint(ui, "cyan", c)) : s;
}

const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
/** `s` without colour codes. */
export const plain = (s: string): string => s.replace(ANSI, "");
/** How many columns `s` takes. */
export const cols = (s: string): number => [...plain(s)].length;
/** `s` padded with spaces to `n` columns. */
export const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - cols(s)));

/** The words of a line. A `command in backticks` is one word, with whatever touches it. */
const words = (s: string): string[] => s.match(/(?:[^\s`]|`[^`]*`|`)+/g) ?? [];

/** `body` set after `first` (a mark, a label, an indent), folded at spaces to the
 *  terminal's width, each further line starting under the body's first letter. */
export function fold(ui: Ui, first: string, body: string, hang = cols(first)): string[] {
  if (ui.width === Number.POSITIVE_INFINITY) return [first + body];
  const room = Math.max(20, ui.width - hang);
  const lines: string[] = [];
  let cur = "";
  for (const w of words(body)) {
    if (cur && cols(cur) + 1 + cols(w) > room) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  lines.push(cur);
  return lines.map((l, i) => (i ? " ".repeat(hang) + l : first + l));
}

/** A line as the commands have always written it (`  ✓ done`, `  ! look`, `  label:  value`,
 *  a plain sentence), as a terminal shows it: the mark in its colour, `commands` picked
 *  out, folded to the width. A pipe gets the line back byte for byte, less only what
 *  `clean` takes out of any text: the line breaks are the command's own and stay. */
export function paint(ui: Ui, text: string): string {
  const safe = clean(text, { breaks: true });
  if (!ui.color && ui.unicode && ui.width === Number.POSITIVE_INFINITY) return safe;
  return safe
    .split("\n")
    .flatMap((line) => {
      // Always matches: an indent, then a mark or a short label or neither, then the rest.
      const m = /^(\s*)(?:([✓✗!·=])(\s+)|((?:\d+\.|[A-Za-z][\w' -]{0,18}:)\s+))?(.*)$/.exec(line) as RegExpExecArray;
      const k = BY_SIGN.get(m[2] as string);
      const first = m[1] + (k ? tint(ui, k.tint, ui.unicode ? k.sign : k.old) + m[3] : (m[4] ?? ""));
      return fold(ui, first, m[5] as string).map((l) => commands(ui, l));
    })
    .join("\n");
}

/** Rows in columns, each column as wide as its widest cell. The last column takes what
 *  is left of the line and folds under itself. A cell may come already coloured, so each
 *  is cleaned as a line of ours is: it keeps `tint`'s codes, and is one line. */
export function table(ui: Ui, cells: readonly (readonly string[])[], indent = 2, gap = 2): string[] {
  const rows = cells.map((r) => r.map((cell) => clean(cell, { colour: true })));
  const n = Math.max(0, ...rows.map((r) => r.length));
  const widths = Array.from({ length: Math.max(0, n - 1) }, (_, c) =>
    Math.max(...rows.map((r) => (c < r.length - 1 ? cols(r[c] as string) : 0))),
  );
  return rows.flatMap((r) => {
    const lead =
      " ".repeat(indent) +
      r
        .slice(0, -1)
        .map((cell, c) => pad(cell, (widths[c] as number) + gap))
        .join("");
    return fold(ui, lead, r.at(-1) ?? "");
  });
}

/** A group's heading. */
export const heading = (ui: Ui, s: string): string => tint(ui, "bold", s);

/** What to do about something, numbered in the order to do it: one sentence, and under
 *  it the one command, alone on its line so it can be copied whole. `run` is a command
 *  for the person to paste, so only a todo that has one asks anything of them. */
export interface Fix {
  say: string;
  run?: string;
}
export function fixes(ui: Ui, list: readonly Fix[]): string[] {
  const lines: string[] = [];
  const w = String(list.length).length;
  list.forEach((f, i) => {
    const n = `  ${String(i + 1).padStart(w)}. `;
    lines.push(...fold(ui, n, clean(f.say)).map((l) => commands(ui, l)));
    if (f.run) lines.push(`${" ".repeat(n.length + 2)}${tint(ui, "cyan", clean(f.run))}`);
  });
  return lines;
}

/** A command that failed. At a terminal: one line that says what is wrong and one that
 *  says what to type next. `next` is the caller's: the command the code that failed
 *  named (a `Refusal`), or the help of the command that ran. It is never read out of
 *  the message, whose words may be a receiver's, a file's or npm's: those are shown as
 *  the text they are, with no `command` picked out in them.
 *
 *  Anywhere else it is the one line a failure has always been, `sessionpipe: <message>`:
 *  programs read it (the GUI shows the last line a failed `control pair` wrote, and the
 *  update keeps the last lines of a failed `install`). */
export function failure(ui: Ui, message: string, next: string, mild = false): string {
  const what = clean(message);
  if (!ui.tty) return `sessionpipe: ${what}\n`;
  // `mild`: the command did its job and something is left for the person to do: said
  // under the mark for that, not as an error. The line to run is the same.
  const label = mild
    ? `${tint(ui, "yellow", tint(ui, "bold", "!"))}      `
    : `${tint(ui, "red", tint(ui, "bold", "error"))}  `;
  return `${fold(ui, label, what).join("\n")}\n${tint(ui, "dim", "try")}    ${tint(ui, "cyan", clean(next))}\n`;
}

/** A length of time, in the two units a person reads: "12 s", "3 min", "2 h", "5 days". */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} days`;
}
