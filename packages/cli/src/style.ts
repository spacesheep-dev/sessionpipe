// SPDX-License-Identifier: Apache-2.0
// How sessionpipe looks at a terminal, in one place and with no dependency: when colour
// is on, the marks, the width a line may take, and how a long line folds.
//
//   colour   --no-color, then FORCE_COLOR (0 or false: off; anything else: on), then
//            NO_COLOR, then TERM=dumb, then whether the output is a terminal. Only the
//            eight basic colours, bold and dim, so a dark and a light theme both read.
//   meaning  never by colour alone: every state has a mark (✓ ! ✗ ·) and a word.
//   width    a terminal's columns, at most 100; a long line folds at a space, under
//            its own text, and never inside a `command`. A pipe gets whole lines, so
//            grep and scripts see one fact per line, exactly as before.
//   Windows  Windows Terminal and anything that sets TERM get ✓ and ✗; the old console
//            (cmd, PowerShell in conhost), whose fonts lack them, gets √ and ×.
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
  const color = o.noColor
    ? false
    : force !== undefined
      ? force !== "0" && force !== "false"
      : env.NO_COLOR
        ? false
        : env.TERM === "dumb"
          ? false
          : tty;
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

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
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
 *  out, folded to the width. A pipe gets the line back byte for byte. */
export function paint(ui: Ui, text: string): string {
  if (!ui.color && ui.unicode && ui.width === Number.POSITIVE_INFINITY) return text;
  return text
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
 *  is left of the line and folds under itself. */
export function table(ui: Ui, rows: readonly (readonly string[])[], indent = 2, gap = 2): string[] {
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
 *  it the one command, alone on its line so it can be copied whole. */
export interface Fix {
  say: string;
  run?: string;
}
export function fixes(ui: Ui, list: readonly Fix[]): string[] {
  const lines: string[] = [];
  const w = String(list.length).length;
  list.forEach((f, i) => {
    const n = `  ${String(i + 1).padStart(w)}. `;
    lines.push(...fold(ui, n, f.say).map((l) => commands(ui, l)));
    if (f.run) lines.push(`${" ".repeat(n.length + 2)}${tint(ui, "cyan", f.run)}`);
  });
  return lines;
}

/** A command that failed: one line that says what is wrong and one that says what to
 *  type next. The command to try is the one the message itself names, else `fallback`. */
export function failure(ui: Ui, message: string, fallback: string): string {
  const named = /`(sessionpipe [^`\n]+)`/.exec(message)?.[1];
  // A placeholder (`<receiver>`, `…`) can't be typed as it stands: the help can.
  const run = named && !/[<…]/.test(named) ? named : fallback;
  const said = fold(ui, `${tint(ui, "red", tint(ui, "bold", "error"))}  `, message).map((l) => commands(ui, l));
  return `${said.join("\n")}\n${tint(ui, "dim", "try")}    ${tint(ui, "cyan", run)}\n`;
}

/** A length of time, in the two units a person reads: "12 s", "3 min", "2 h", "5 days". */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} days`;
}
