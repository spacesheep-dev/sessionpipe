// SPDX-License-Identifier: Apache-2.0
// How `doctor`, `status` and `control status` are laid out: a verdict first, then what
// was looked at in groups of aligned rows, each with a mark and a word, then what to do
// about it, in the order to do it. The commands gather; this only sets it on the page.
import {
  clean,
  cols,
  commands,
  type Fix,
  fixes,
  heading,
  type Mark,
  mark,
  pad,
  table,
  tint,
  type Ui,
} from "./style.js";

export interface Row {
  mark: Mark;
  /** What the row is about. */
  label: string;
  /** What was found, in a few words. */
  value: string;
  /** What `status` calls it when it is fine, where the label alone says too little. */
  brief?: string;
}

export interface Group {
  title: string;
  rows: Row[];
}

/** Something to do, and where it comes in the order: a full disk before an update, an
 *  update before the hooks, the hooks before a sign-in. */
export interface Todo extends Fix {
  order: number;
}

export interface Checkup {
  groups: Group[];
  todo: Todo[];
}

/** "All good", or how many things need a look. */
export function verdict(ui: Ui, n: number): string {
  if (!n) return `${mark(ui, "ok")} ${tint(ui, "bold", tint(ui, "green", "All good"))}`;
  return `${mark(ui, "warn")} ${tint(ui, "bold", tint(ui, "yellow", `${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention`))}`;
}

/** A group as it may be set on the page. What a row says is often not ours (a receiver's
 *  last error, npm's words, a name from a file), so every word of it is cleaned here,
 *  before any colour is on it: a row stays one row, whatever it was handed. */
const safe = (g: Group): Group => ({
  title: clean(g.title),
  rows: g.rows.map((r) => ({
    mark: r.mark,
    label: clean(r.label),
    value: clean(r.value),
    ...(r.brief === undefined ? {} : { brief: clean(r.brief) }),
  })),
});

/** A group: its heading, then its rows with the labels in one column. */
export function group(ui: Ui, given: Group): string[] {
  const g = safe(given);
  const w = Math.max(...g.rows.map((r) => cols(r.label)));
  return [
    heading(ui, g.title),
    ...table(
      ui,
      g.rows.map((r) => [`${mark(ui, r.mark)} ${pad(r.label, w)}`, r.value]),
    ).map((l) => commands(ui, l)),
  ];
}

/** The todo list in the order to do it; the same thing asked for twice is said once. */
export function inOrder(todo: readonly Todo[]): Fix[] {
  const seen = new Set<string>();
  return [...todo]
    .sort((a, b) => a.order - b.order)
    .filter((t) => {
      const k = `${t.say}\n${t.run ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/** The whole page: the verdict, the groups, and "To fix". */
export function page(ui: Ui, c: Checkup): string[] {
  const todo = inOrder(c.todo);
  const lines = [verdict(ui, todo.length)];
  for (const g of c.groups) if (g.rows.length) lines.push("", ...group(ui, g));
  if (todo.length) lines.push("", heading(ui, "To fix"), ...fixes(ui, todo));
  return lines;
}

const WORST: readonly Mark[] = ["bad", "warn", "ok"];

/** The groups in a line each, for `status`: the worst mark in the group, then what is
 *  fine by its name and what isn't with what was found. A row that only informs is left
 *  out, unless the group has nothing else to say: then each is named with the first
 *  thing it says. */
export function brief(ui: Ui, groups: readonly Group[]): string[] {
  const live = groups.filter((g) => g.rows.length).map(safe);
  const w = Math.max(...live.map((g) => cols(g.title)));
  return table(
    ui,
    live.map((g) => {
      const said = g.rows
        .filter((r) => r.mark !== "info")
        .map((r) => (r.mark === "ok" ? (r.brief ?? r.label) : `${r.label}: ${r.value}`));
      return [
        `${mark(ui, WORST.find((m) => g.rows.some((r) => r.mark === m)) ?? "info")} ${pad(g.title, w)}`,
        [...new Set(said.length ? said : g.rows.map((r) => `${r.label}: ${r.value.split(" · ")[0]}`))].join(", "),
      ];
    }),
  ).map((l) => commands(ui, l));
}
