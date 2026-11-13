// SPDX-License-Identifier: Apache-2.0
// What `sessionpipe reinstall` shows before it does anything: what it found, and what
// will happen. The same two screens for a dry run and for a real one.
import { cols, commands, fixes, fold, heading, mark, table, tint, type Ui } from "../style.js";
import type { Copy, Inventory, Use } from "./find.js";
import type { Facts, Plan } from "./plan.js";

const USED: Record<Use, string> = {
  typed: "you type this",
  service: "the background service",
  hooks: "the hooks",
  this: "this command",
};

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

/** What was found: every copy, its release, and what uses it; then what else is wrong.
 *  `show`: how a path is said in a sentence (the caller's `~/…`). */
export function found(ui: Ui, inv: Inventory, f: Facts, show: (p: string) => string = (p) => p): string[] {
  const n = inv.copies.length;
  // What uses a copy and what is wrong with it. "this command" says something only of a
  // copy nobody types.
  const about = (c: Copy): string =>
    [
      c.uses
        .filter((u) => u !== "this" || !c.uses.includes("typed"))
        .map((u) => USED[u])
        .join(", ") || "nothing uses it",
      ...(c.wrong ? [c.wrong] : []),
      ...(c.not ? [`not an install: ${c.not}`] : []),
    ].join(" · ");
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
    ...inv.strangers.map((s) => `${show(s.file)} is ${s.why}`),
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
    ...(f.service && f.daemon && f.service.pid !== f.daemon.pid
      ? [`a daemon someone started by hand (pid ${f.daemon.pid}) holds the socket the service needs`]
      : []),
  ];
  if (wrong.length)
    lines.push("", heading(ui, "Also found"), ...wrong.flatMap((w) => fold(ui, `  ${mark(ui, "warn")} `, w)));
  return lines;
}

/** What will happen, in the order it happens, and what is left alone and why. */
export function planned(ui: Ui, p: Plan): string[] {
  const lines = [
    heading(ui, "What happens"),
    ...fixes(
      ui,
      p.steps.map((s) => ({ say: s.why })),
    ),
    `     ${tint(ui, "dim", "Pairings, settings, keys and what waits to be sent are kept.")}`,
  ];
  if (p.left.length)
    lines.push(
      "",
      heading(ui, "Left alone"),
      ...fixes(
        ui,
        p.left.map((l) => ({
          say: `${l.where}${l.version ? ` (${l.version})` : ""}: ${l.why}.${l.line ? " This removes it:" : ""}`,
          ...(l.line ? { run: l.line } : {}),
        })),
      ),
    );
  // Each note under its mark, a second line of it under its words.
  // A command it names is shown as one, as on every other line.
  if (p.notes.length)
    lines.push("", ...p.notes.flatMap((n) => fold(ui, `  ${mark(ui, "warn")} `, n).map((l) => commands(ui, l))));
  return lines;
}
