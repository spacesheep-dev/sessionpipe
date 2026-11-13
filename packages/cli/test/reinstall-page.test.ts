// SPDX-License-Identifier: Apache-2.0
// The two screens `sessionpipe reinstall` shows before it does anything (reinstall/page.ts):
// what it found and what will happen. As whole lines for a pipe, and folded for an
// 80-column terminal, where every line must fit and no word may be lost.
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Copy, Inventory } from "../src/reinstall/find.js";
import { found, planned } from "../src/reinstall/page.js";
import { type Facts, type Plan, plan, slotIn } from "../src/reinstall/plan.js";
import { cols, makeUi, mark, PLAIN, plain, tint, type Ui } from "../src/style.js";

const TTY: Ui = makeUi({ isTTY: true, columns: 80, env: {}, platform: "darwin" });

const ROOT = path.resolve(path.sep, "w");
/** The folder a place stands for here: nothing is opened, a plan only compares them. */
const folder = (where: string): string => path.join(ROOT, ...where.split(/[^\w.-]+/).filter(Boolean));
const LOCAL = folder("~/.local");
/** A published copy as the look lists it: whole, running, used by nothing. `where` is
 *  all the page shows of its place. */
const copy = (where: string, over: Partial<Copy> = {}): Copy => {
  const prefix = folder(where);
  return {
    dir: slotIn(prefix, "linux"),
    where,
    prefix,
    slot: "global",
    not: null,
    aside: false,
    version: "1.2.0",
    runs: true,
    wrong: null,
    bins: [],
    uses: [],
    writable: true,
    keeper: null,
    ...over,
  };
};
const inv = (copies: Copy[], over: Partial<Inventory> = {}): Inventory => ({
  platform: "linux",
  reach: true,
  copies,
  dangling: [],
  strangers: [],
  onPath: [],
  homes: [
    {
      prefix: LOCAL,
      shown: "~/.local",
      why: "where the one you type is",
      bin: path.join(LOCAL, "bin"),
      pathAt: 0,
      blocked: null,
    },
  ],
  prefixes: [],
  ...over,
});
type Service = NonNullable<Facts["service"]>;
const service = (over: Partial<Service> = {}): Service => ({
  file: "/home/u/.config/systemd/user/sessionpipe-control.service",
  loaded: true,
  pid: 100,
  node: "/usr/bin/node",
  nodeOk: true,
  cliOk: true,
  ...over,
});
/** Nothing wrong beside the copies: no service file, no daemon. */
const facts = (over: Partial<Facts> = {}): Facts => ({
  latest: { version: "1.2.0" },
  npm: true,
  harnesses: ["claude"],
  hooks: { version: "1.2.0", wrong: [] },
  hookFiles: ["/home/u/.local/share/sessionpipe/hook", "/home/u/.claude/settings.json"],
  wanted: true,
  service: null,
  staleSocket: false,
  daemon: null,
  apart: null,
  ...over,
});
const aPlan = (over: Partial<Plan> = {}): Plan => ({
  nothing: null,
  refuse: null,
  target: "1.2.0",
  home: null,
  steps: [
    { do: "fetch", version: "1.2.0", touches: [], why: "sessionpipe 1.2.0, the newest release, is fetched from npm." },
    { do: "prove", touches: [], why: "Then it is checked: `sessionpipe --version` says 1.2.0." },
  ],
  left: [],
  notes: [],
  first: null,
  ...over,
});

const ONE = copy("~/.local", { uses: ["typed", "service", "this", "hooks"] });
const BROKEN = "its dist/cli.js is missing (an install that was cut off?)";
const CUT_OFF = "left behind by an install that was cut off";
const CHECKOUT = "it holds src, which no published sessionpipe has (a checkout or a build?)";
/** A copy in the npx cache: its place is the cache entry it is in. */
const NPX = copy("~/.npm/_npx/0a1b2c3d4e5f6a7b", { slot: "npx", prefix: null, uses: ["this"] });
/** A computer after several installs: two releases in use, a copy in the npx cache, a
 *  broken one, npm's own leftover, and a checkout. Every folder is short. */
const SEVERAL = [
  copy("~/.local", { version: "1.1.0", uses: ["typed", "this"] }),
  copy("~/.nvm/versions/node/v22.1.0", { version: "1.1.0", uses: ["service", "hooks"] }),
  NPX,
  copy("/opt/homebrew", { version: null, runs: false, wrong: BROKEN }),
  copy("/usr/local", { aside: true, runs: false, wrong: CUT_OFF }),
  copy("~/code/sessionpipe", { version: "1.3.0", slot: null, not: CHECKOUT }),
];
/** Volta's copy, whose folder is longer than a column of the table may be. */
const VOLTA = copy("~/.volta/tools/image/packages/sessionpipe", {
  slot: null,
  runs: false,
  wrong: "it doesn't run: `--version` printed nothing",
  not: "Volta keeps it",
  keeper: "volta uninstall sessionpipe",
});
/** fnm's prefix for one Node: longer still. */
const FNM = "~/.local/share/fnm/node-versions/v22.11.0/installation";

/** Every word of a screen, in order: what folding must keep. */
const words = (lines: string[]): string[] => plain(lines.join(" ")).split(/\s+/).filter(Boolean);
/** A screen fits an 80-column terminal, and says what the unfolded one says. */
const fits = (folded: string[], whole: string[]) => {
  for (const l of folded) expect(cols(l), plain(l)).toBeLessThan(80);
  expect(words(folded)).toEqual(words(whole));
};

describe("found: every copy, its release, and what uses it", () => {
  it("one clean copy: one row, and nothing else to say", () => {
    expect(found(PLAIN, inv([ONE]), facts())).toEqual([
      "Found one copy of sessionpipe on this computer",
      "  · 1.2.0  ~/.local  you type this, the background service, the hooks",
    ]);
    // A service that runs what it should, with the daemon that is its own, is nothing to say.
    expect(
      found(PLAIN, inv([ONE]), facts({ service: service(), daemon: { pid: 100, version: "1.2.0" } })),
    ).toHaveLength(2);
    // Nor is a daemon someone runs by hand where there is no service file.
    expect(found(PLAIN, inv([ONE]), facts({ daemon: { pid: 222, version: "1.2.0" } }))).toHaveLength(2);
  });

  it("several: a row each in columns, the release first; a leftover and a broken copy are named there and marked", () => {
    expect(found(PLAIN, inv(SEVERAL), facts())).toEqual([
      "Found 6 copies of sessionpipe on this computer",
      "  · 1.1.0      ~/.local                      you type this",
      "  · 1.1.0      ~/.nvm/versions/node/v22.1.0  the background service, the hooks",
      "  · 1.2.0      ~/.npm/_npx/0a1b2c3d4e5f6a7b  this command",
      "  ✗ broken     /opt/homebrew                 nothing uses it · its dist/cli.js is missing (an install that was cut off?)",
      "  ✗ left over  /usr/local                    nothing uses it · left behind by an install that was cut off",
      "  · 1.3.0      ~/code/sessionpipe            nothing uses it · not an install: it holds src, which no published sessionpipe has (a checkout or a build?)",
    ]);
  });

  it("a folder too long for a column: every copy's folder gets a line of its own, and the rest goes under it", () => {
    expect(found(PLAIN, inv([...SEVERAL, VOLTA]), facts())).toEqual([
      "Found 7 copies of sessionpipe on this computer",
      "  · ~/.local",
      "      1.1.0 · you type this",
      "  · ~/.nvm/versions/node/v22.1.0",
      "      1.1.0 · the background service, the hooks",
      "  · ~/.npm/_npx/0a1b2c3d4e5f6a7b",
      "      1.2.0 · this command",
      "  ✗ /opt/homebrew",
      "      broken · nothing uses it · its dist/cli.js is missing (an install that was cut off?)",
      "  ✗ /usr/local",
      "      left over · nothing uses it · left behind by an install that was cut off",
      "  · ~/code/sessionpipe",
      "      1.3.0 · nothing uses it · not an install: it holds src, which no published sessionpipe has (a checkout or a build?)",
      "  ✗ ~/.volta/tools/image/packages/sessionpipe",
      "      1.2.0 · nothing uses it · it doesn't run: `--version` printed nothing · not an install: Volta keeps it",
    ]);
    // One such folder is enough, wherever it is in the list, and with one copy too.
    expect(found(PLAIN, inv([copy(FNM, { uses: ["typed"] }), NPX]), facts())).toEqual([
      "Found 2 copies of sessionpipe on this computer",
      `  · ${FNM}`,
      "      1.2.0 · you type this",
      "  · ~/.npm/_npx/0a1b2c3d4e5f6a7b",
      "      1.2.0 · this command",
    ]);
    expect(found(PLAIN, inv([copy(FNM)]), facts())).toEqual([
      "Found one copy of sessionpipe on this computer",
      `  · ${FNM}`,
      "      1.2.0 · nothing uses it",
    ]);
  });

  it("36 columns of folder still fit the column; one more and the folders have their own lines", () => {
    const fits36 = `~/${"a".repeat(34)}`;
    expect(found(PLAIN, inv([copy(fits36)]), facts())).toEqual([
      "Found one copy of sessionpipe on this computer",
      `  · 1.2.0  ${fits36}  nothing uses it`,
    ]);
    expect(found(PLAIN, inv([copy(`${fits36}a`)]), facts())).toEqual([
      "Found one copy of sessionpipe on this computer",
      `  · ${fits36}a`,
      "      1.2.0 · nothing uses it",
    ]);
  });

  it("a copy that doesn't run is marked even where nothing more is known of it", () => {
    const [, row] = found(PLAIN, inv([copy("~/.local", { runs: false })]), facts());
    expect(row).toBe("  ✗ 1.2.0  ~/.local  nothing uses it");
    // On a line of its own the folder carries the mark.
    expect(found(PLAIN, inv([copy(FNM, { runs: false })]), facts()).slice(1)).toEqual([
      `  ✗ ${FNM}`,
      "      1.2.0 · nothing uses it",
    ]);
  });

  it("'this command' is said only of a copy nobody types", () => {
    const used = (uses: Copy["uses"]) => found(PLAIN, inv([copy("~", { uses })]), facts())[1];
    expect(used(["typed", "this"])).toBe("  · 1.2.0  ~  you type this");
    expect(used(["typed", "service", "this", "hooks"])).toBe(
      "  · 1.2.0  ~  you type this, the background service, the hooks",
    );
    expect(used(["this"])).toBe("  · 1.2.0  ~  this command");
    expect(used(["service", "this", "hooks"])).toBe("  · 1.2.0  ~  the background service, this command, the hooks");
    expect(used(["typed"])).toBe("  · 1.2.0  ~  you type this");
    expect(used([])).toBe("  · 1.2.0  ~  nothing uses it");
    // The same where the folder has its own line.
    const under = (uses: Copy["uses"]) => found(PLAIN, inv([copy(FNM, { uses })]), facts())[2];
    expect(under(["typed", "this"])).toBe("      1.2.0 · you type this");
    expect(under(["this"])).toBe("      1.2.0 · this command");
  });

  it("also found: links that lead nowhere, files that are no install, and what is wrong with the hooks and the service", () => {
    const i = inv([ONE], {
      dangling: ["/usr/local/bin/sessionpipe", "/home/u/.nvm/versions/node/v20.0.0/bin/sessionpipe"],
      strangers: [{ file: "/home/u/bin/sessionpipe", why: "a file of that name that npm didn't put there" }],
    });
    const f = facts({
      hooks: {
        version: "1.1.0",
        wrong: ["the hook file names a node that is gone", "claude: missing (~/.claude/settings.json)"],
      },
      service: service({ loaded: false, pid: null, node: "/gone/bin/node", nodeOk: false, cliOk: false }),
      staleSocket: true,
    });
    expect(found(PLAIN, i, f)).toEqual([
      "Found one copy of sessionpipe on this computer",
      "  · 1.2.0  ~/.local  you type this, the background service, the hooks",
      "",
      "Also found",
      "  ! /usr/local/bin/sessionpipe is a link to a sessionpipe that is gone",
      "  ! /home/u/.nvm/versions/node/v20.0.0/bin/sessionpipe is a link to a sessionpipe that is gone",
      "  ! /home/u/bin/sessionpipe is a file of that name that npm didn't put there",
      "  ! the hooks: the hook file names a node that is gone",
      "  ! the hooks: claude: missing (~/.claude/settings.json)",
      "  ! the service file names a node that is gone (/gone/bin/node)",
      "  ! the service file names a copy of sessionpipe that is gone",
      "  ! a socket file is there with no daemon behind it (the next one that starts replaces it)",
      "  ! the service file is there, and the service is not loaded",
    ]);
  });

  it("a link that leads nowhere and a file that is no install are named as the caller shows a path; nothing else is", () => {
    /** A `show` that marks what it was handed, as the command's `~/…` would shorten it. */
    const show = (p: string) => `<${p}>`;
    const i = inv([ONE, copy("/opt/homebrew", { version: null, runs: false, wrong: BROKEN })], {
      dangling: ["/usr/local/bin/sessionpipe", "/home/u/.nvm/versions/node/v20.0.0/bin/sessionpipe"],
      strangers: [{ file: "/home/u/bin/sessionpipe", why: "a file of that name that npm didn't put there" }],
    });
    const f = facts({
      hooks: { version: "1.1.0", wrong: ["claude: missing (/home/u/.claude/settings.json)"] },
      service: service({ node: "/gone/bin/node", nodeOk: false }),
      daemon: { pid: 100, version: "1.2.0" },
    });
    const lines = found(PLAIN, i, f, show);
    expect(lines).toEqual([
      "Found 2 copies of sessionpipe on this computer",
      // A copy's place is the look's own word for it, shortened already.
      "  · 1.2.0   ~/.local       you type this, the background service, the hooks",
      "  ✗ broken  /opt/homebrew  nothing uses it · its dist/cli.js is missing (an install that was cut off?)",
      "",
      "Also found",
      "  ! </usr/local/bin/sessionpipe> is a link to a sessionpipe that is gone",
      "  ! </home/u/.nvm/versions/node/v20.0.0/bin/sessionpipe> is a link to a sessionpipe that is gone",
      "  ! </home/u/bin/sessionpipe> is a file of that name that npm didn't put there",
      // What the hooks say is theirs, word for word.
      "  ! the hooks: claude: missing (/home/u/.claude/settings.json)",
      // The node the service file names is a path as any other.
      "  ! the service file names a node that is gone (</gone/bin/node>)",
    ]);
    // A service file with no program in it names none: there is no path to show.
    expect(
      found(
        PLAIN,
        inv([ONE]),
        facts({ ...f, hooks: { version: "1.2.0", wrong: [] }, service: service({ node: null, nodeOk: false }) }),
        show,
      ).slice(-1),
    ).toEqual(["  ! the service file names a node that is gone (?)"]);
    // With nothing said about how, each is the path as it was found; the rest is the same.
    const whole = found(PLAIN, i, f);
    expect(whole.join("\n")).not.toContain("<");
    expect(whole).toEqual(lines.map((l) => l.replace(/[<>]/g, "")));
    expect(whole).toEqual(found(PLAIN, i, f, (p) => p));
    // Shown before it is folded: at a terminal the line breaks by the width of the words
    // as they are shown, a word later here than with the whole path.
    const short = (p: string) => p.replace("/home/u/", "~/");
    const folded = found(TTY, i, f, short);
    fits(folded, found(PLAIN, i, f, short));
    expect(folded.map(plain)).toContain("  ! ~/.nvm/versions/node/v20.0.0/bin/sessionpipe is a link to a sessionpipe");
    expect(folded.map(plain)).toContain("    that is gone");
    const unshown = found(TTY, i, f).map(plain);
    expect(unshown).toContain("  ! /home/u/.nvm/versions/node/v20.0.0/bin/sessionpipe is a link to a");
    expect(unshown).toContain("    sessionpipe that is gone");
  });

  it("also found, of the service alone: each thing by itself", () => {
    const also = (f: Partial<Facts>) => found(PLAIN, inv([ONE]), facts(f)).slice(2);
    const up = { pid: 100, version: "1.2.0" };
    // A service file with no program in it names no node.
    expect(also({ service: service({ node: null, nodeOk: false }), daemon: up })).toEqual([
      "",
      "Also found",
      "  ! the service file names a node that is gone (?)",
    ]);
    expect(also({ service: service({ cliOk: false }), daemon: up })).toEqual([
      "",
      "Also found",
      "  ! the service file names a copy of sessionpipe that is gone",
    ]);
    expect(also({ staleSocket: true })).toEqual([
      "",
      "Also found",
      "  ! a socket file is there with no daemon behind it (the next one that starts replaces it)",
    ]);
    expect(also({ service: service({ loaded: false }), daemon: up })).toEqual([
      "",
      "Also found",
      "  ! the service file is there, and the service is not loaded",
    ]);
    expect(also({ service: service(), daemon: null })).toEqual([
      "",
      "Also found",
      "  ! the service is loaded, and nothing answers",
    ]);
    expect(also({ service: service(), daemon: { pid: 222, version: "1.2.0" } })).toEqual([
      "",
      "Also found",
      "  ! a daemon someone started by hand (pid 222) holds the socket the service needs",
    ]);
    // Not loaded, and a daemon answers all the same: both are said.
    expect(also({ service: service({ loaded: false, pid: null }), daemon: { pid: 222, version: "1.2.0" } })).toEqual([
      "",
      "Also found",
      "  ! the service file is there, and the service is not loaded",
      "  ! a daemon someone started by hand (pid 222) holds the socket the service needs",
    ]);
  });

  it("at an 80-column terminal every line fits, in colour, and says what the whole lines say", () => {
    // The places a copy usually is, and each kind of row.
    const copies = [
      copy("~/.local", { version: "1.1.0", uses: ["typed", "this"] }),
      copy("~/.nvm/versions/node/v22.1.0", { version: "1.1.0", uses: ["service", "hooks"] }),
      copy("~/.npm/_npx/0a1b2c3d4e5f6a7b", { slot: "npx", prefix: null }),
      copy("/opt/homebrew", { version: null, runs: false, wrong: BROKEN }),
      copy("~/code/sessionpipe", { version: "1.3.0", slot: null, not: CHECKOUT }),
    ];
    const i = inv(copies, {
      dangling: ["/usr/local/bin/sessionpipe", "/home/u/.nvm/versions/node/v20.0.0/bin/sessionpipe"],
      strangers: [{ file: "/home/u/bin/sessionpipe", why: "a file of that name that npm didn't put there" }],
    });
    const f = facts({
      hooks: { version: "1.1.0", wrong: ["claude: missing (~/.claude/settings.json)"] },
      service: service({ loaded: false, pid: null, node: "/gone/bin/node", nodeOk: false, cliOk: false }),
      staleSocket: true,
      daemon: { pid: 222, version: "1.1.0" },
    });
    const lines = found(TTY, i, f);
    fits(lines, found(PLAIN, i, f));
    // What uses a copy folds under its own column.
    expect(lines.length).toBeGreaterThan(found(PLAIN, i, f).length);
    expect(lines[0]).toBe(tint(TTY, "bold", "Found 5 copies of sessionpipe on this computer"));
    expect(lines).toContain(tint(TTY, "bold", "Also found"));
    // The marks are in their colours: a copy that is whole, a broken one, a finding.
    expect(lines[1]?.startsWith(`  ${mark(TTY, "info")} 1.1.0 `)).toBe(true);
    expect(lines.some((l) => l.startsWith(`  ${mark(TTY, "bad")} broken `))).toBe(true);
    expect(lines.some((l) => l.startsWith(`  ${mark(TTY, "warn")} /usr/local/bin/sessionpipe is a link`))).toBe(true);
    // What is said of a copy folds under its own column, past the release and the folder.
    const column = plain(lines[1] as string).indexOf("you type this");
    expect(column).toBeGreaterThan(0);
    const broken = lines.findIndex((l) => l.startsWith(`  ${mark(TTY, "bad")} broken `));
    expect(plain(lines[broken + 1] as string)).toMatch(new RegExp(`^ {${column}}\\S`));
    // A finding too long for the line goes on under its own words, not under its mark.
    const also = lines.slice(lines.indexOf(tint(TTY, "bold", "Also found")) + 1);
    expect(also.length).toBeGreaterThan(found(PLAIN, i, f).length - found(PLAIN, i, f).indexOf("Also found") - 1);
    for (const l of also) expect(l.startsWith(`  ${mark(TTY, "warn")} `) || /^ {4}\S/.test(l), plain(l)).toBe(true);
    const long = also.findIndex((l) => plain(l).startsWith("  ! /home/u/.nvm/versions/node/v20.0.0/bin/sessionpipe "));
    expect(plain(also[long + 1] as string)).toMatch(/^ {4}\S/);
    // A leftover's row too, beside copies in short places.
    const withLeftover = inv([copies[0] as Copy, copies[1] as Copy, copy("~/.local", { aside: true, wrong: CUT_OFF })]);
    fits(found(TTY, withLeftover, facts()), found(PLAIN, withLeftover, facts()));
    fits(found(TTY, inv([ONE]), facts()), found(PLAIN, inv([ONE]), facts()));
  });

  it("at 80 columns a copy in the npx cache beside a leftover fits: the widest row the table has", () => {
    // `npx -y sessionpipe@latest reinstall` on a computer whose install was cut off.
    const copies = [
      copy("~/.local", { version: null, runs: false, wrong: BROKEN, uses: ["typed"] }),
      copy("~/.local", { aside: true, runs: false, wrong: CUT_OFF }),
      NPX,
      copy("~/.nvm/versions/node/v22.1.0", { version: "1.1.0", uses: ["service", "hooks"] }),
    ];
    const lines = found(TTY, inv(copies), facts());
    const whole = found(PLAIN, inv(copies), facts());
    fits(lines, whole);
    // Still one row a copy: the folder beside the release, on the copy's first line.
    expect(whole).toHaveLength(5);
    expect(plain(lines.find((l) => plain(l).includes("_npx")) as string)).toBe(
      "  · 1.2.0      ~/.npm/_npx/0a1b2c3d4e5f6a7b  this command",
    );
    expect(lines.some((l) => plain(l).startsWith("  ✗ left over  ~/.local "))).toBe(true);
  });

  it("at 80 columns an fnm prefix fits: the folder whole on its own line, the rest folded under it", () => {
    const copies = [
      copy(FNM, { version: "1.1.0", uses: ["typed", "service", "hooks"] }),
      NPX,
      copy("/usr/local", { aside: true, runs: false, wrong: CUT_OFF }),
      copy("/opt/homebrew", { version: null, runs: false, wrong: BROKEN }),
      VOLTA,
    ];
    const lines = found(TTY, inv(copies), facts());
    fits(lines, found(PLAIN, inv(copies), facts()));
    expect(lines).toContain(`  ${mark(TTY, "info")} ${FNM}`);
    expect(lines).toContain(`  ${mark(TTY, "bad")} ${VOLTA.where}`);
    // Under each folder: six spaces, then the release and what uses it, on as many lines as it takes.
    const at = lines.indexOf(`  ${mark(TTY, "bad")} ${VOLTA.where}`);
    expect(lines.slice(at + 1)).toEqual([
      "      1.2.0 · nothing uses it · it doesn't run: `--version` printed nothing ·",
      "      not an install: Volta keeps it",
    ]);
    for (const l of lines.slice(1)) expect(/^ {2}\S|^ {6}\S/.test(plain(l)), plain(l)).toBe(true);
  });

  /** The lines a copy's folder takes at 80 columns, in an inventory where folders have
   *  lines of their own: without the mark and the indent, as the pieces of the path. */
  const pieces = (where: string): string[] => {
    const lines = found(TTY, inv([copy(where), copy(FNM)]), facts()).slice(1);
    const own = lines.slice(
      0,
      lines.findIndex((l) => plain(l).startsWith("      ")),
    );
    // The mark on the first line, in its colour; every further one under the folder's first character.
    expect(own[0]?.startsWith(`  ${mark(TTY, "info")} `), plain(own[0] as string)).toBe(true);
    for (const l of own.slice(1)) expect(l).toMatch(/^ {4}\S/);
    return own.map((l) => plain(l).slice(4));
  };

  it("at 80 columns a folder longer than the line is broken after a separator, and goes on under its first character", () => {
    // A hundred columns of path, ten folders deep.
    const long = `/${Array.from({ length: 10 }, (_, n) => `folder-0${n}`).join("/")}`;
    expect(cols(long)).toBe(100);
    const copies = [copy(long, { uses: ["typed"] }), NPX];
    const lines = found(TTY, inv(copies), facts());
    for (const l of lines) expect(cols(l), plain(l)).toBeLessThan(80);
    expect(lines.slice(1).map(plain)).toEqual([
      "  · /folder-00/folder-01/folder-02/folder-03/folder-04/folder-05/folder-06/",
      "    folder-07/folder-08/folder-09",
      "      1.2.0 · you type this",
      "  · ~/.npm/_npx/0a1b2c3d4e5f6a7b",
      "      1.2.0 · this command",
    ]);
    // The pieces give the path back, and it is broken only after a separator.
    expect(pieces(long).join("")).toBe(long);
    expect(pieces(long)).toHaveLength(2);
    expect(pieces(long)[0]).toMatch(/\/$/);
    // Twice the line and more: as many lines as it takes, each full to its last whole folder.
    const longer = `~/${Array.from({ length: 30 }, (_, n) => `folder-${n}`).join("/")}`;
    const parts = pieces(longer);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.join("")).toBe(longer);
    for (const part of parts.slice(0, -1)) {
      expect(part).toMatch(/\/$/);
      expect(cols(part)).toBeLessThanOrEqual(75);
      expect(cols(part)).toBeGreaterThan(64);
    }
    // Into a pipe the folder is one line, whatever its length.
    expect(found(PLAIN, inv(copies), facts())[1]).toBe(`  · ${long}`);
  });

  it("a folder that just fits the line is whole; one column more and it is broken", () => {
    // The line has 79 columns, four of them the mark's.
    const fits75 = `/${"a".repeat(36)}/${"b".repeat(37)}`;
    expect(cols(fits75)).toBe(75);
    expect(pieces(fits75)).toEqual([fits75]);
    expect(pieces(`${fits75}b`)).toEqual([`/${"a".repeat(36)}/`, "b".repeat(38)]);
  });

  it("a Windows path is broken after a backslash, and a name with spaces in it is never split", () => {
    const win =
      "C:\\Users\\Someone With A Long Name\\AppData\\Roaming\\fnm\\node-versions\\v22.11.0\\installation\\node_modules";
    expect(cols(win)).toBeGreaterThan(79);
    const parts = pieces(win);
    expect(parts).toEqual([
      // 68 columns; the next name would make it 77, and the line has 75.
      "C:\\Users\\Someone With A Long Name\\AppData\\Roaming\\fnm\\node-versions\\",
      "v22.11.0\\installation\\node_modules",
    ]);
    expect(parts.join("")).toBe(win);
    for (const part of parts) expect(cols(part)).toBeLessThanOrEqual(75);
  });

  it("one name longer than the line stays whole: nothing in it can be broken", () => {
    const name = "x".repeat(90);
    // Between two folders: it has a line of its own, which is the one line too long.
    const between = pieces(`~/code/${name}/dist`);
    expect(between).toEqual(["~/code/", `${name}/`, "dist"]);
    // At the start, and with no separator in the whole of it.
    expect(pieces(`${name}/dist`)).toEqual([`${name}/`, "dist"]);
    expect(pieces(name)).toEqual([name]);
    // Every other line of the screen still fits.
    const lines = found(TTY, inv([copy(`~/code/${name}/dist`), copy(FNM)]), facts());
    expect(lines.filter((l) => cols(l) >= 80).map(plain)).toEqual([`    ${name}/`]);
  });
});

describe("planned: what will happen, and what is left alone", () => {
  it("the steps in order, numbered, and what is kept", () => {
    expect(planned(PLAIN, aPlan())).toEqual([
      "What happens",
      "  1. sessionpipe 1.2.0, the newest release, is fetched from npm.",
      "  2. Then it is checked: `sessionpipe --version` says 1.2.0.",
      "     Pairings, settings, keys and what waits to be sent are kept.",
    ]);
  });

  it("left alone: where, the release where it says one, why, and the command that removes it where there is one", () => {
    // Each has its whole path beside what a person reads: the page shows only the second.
    const left = [
      {
        where: "~/code/sessionpipe",
        path: "/whole/home/u/code/sessionpipe",
        version: "1.3.0",
        why: CHECKOUT,
        line: null,
        ours: false,
      },
      {
        where: "/usr/local",
        path: "/whole/usr/local/lib/node_modules/sessionpipe",
        version: "1.1.0",
        why: "you may not write where it is",
        line: "sudo npm uninstall -g --prefix /usr/local sessionpipe",
        ours: true,
      },
      {
        where: "/home/u/bin/sessionpipe",
        path: "/whole/home/u/bin/sessionpipe",
        version: null,
        why: "a file of that name that npm didn't put there",
        line: null,
        ours: false,
      },
      {
        where: "~/.volta/tools/image/packages/sessionpipe",
        path: "/whole/home/u/.volta/tools/image/packages/sessionpipe/lib/node_modules/sessionpipe",
        version: null,
        why: "Volta keeps it",
        line: "volta uninstall sessionpipe",
        ours: false,
      },
    ];
    expect(planned(PLAIN, aPlan({ left })).join("\n")).not.toContain("/whole/");
    expect(planned(TTY, aPlan({ left })).join("\n")).not.toContain("/whole/");
    expect(planned(PLAIN, aPlan({ left })).slice(4)).toEqual([
      "",
      "Left alone",
      "  1. ~/code/sessionpipe (1.3.0): it holds src, which no published sessionpipe has (a checkout or a build?).",
      "  2. /usr/local (1.1.0): you may not write where it is. This removes it:",
      "       sudo npm uninstall -g --prefix /usr/local sessionpipe",
      "  3. /home/u/bin/sessionpipe: a file of that name that npm didn't put there.",
      "  4. ~/.volta/tools/image/packages/sessionpipe: Volta keeps it. This removes it:",
      "       volta uninstall sessionpipe",
    ]);
  });

  it("the notes come last, each marked; with nothing left alone they follow the steps", () => {
    const notes = [
      "/home/u/.local/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.",
      "What a shell finds first is /home/u/bin/sessionpipe, which is not this copy: typing `sessionpipe` starts that one.",
      "The background service isn't running, and nothing here starts it by itself: `sessionpipe control run` does.",
    ];
    expect(planned(PLAIN, aPlan({ notes })).slice(4)).toEqual([
      "",
      "  ! /home/u/.local/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.",
      "  ! What a shell finds first is /home/u/bin/sessionpipe, which is not this copy: typing `sessionpipe` starts that one.",
      "  ! The background service isn't running, and nothing here starts it by itself: `sessionpipe control run` does.",
    ]);
    const left = [
      { where: "~/code", path: "/home/u/code", version: null, why: "it holds src", line: null, ours: false },
    ];
    expect(planned(PLAIN, aPlan({ left, notes: notes.slice(0, 1) })).slice(4)).toEqual([
      "",
      "Left alone",
      "  1. ~/code: it holds src.",
      "",
      "  ! /home/u/.local/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.",
    ]);
  });

  it("at an 80-column terminal the plan of a real repair fits, a command alone on its line", () => {
    // The plan itself, from a computer with every kind of copy on it and a copy that
    // can't be written; the home's bin folder is not on PATH, and what a shell finds
    // first is a file that is no install.
    const copies = [...SEVERAL, VOLTA, copy("/usr", { version: "1.0.0", prefix: "/usr", writable: false })];
    const i = inv(copies, {
      dangling: ["/usr/local/bin/sessionpipe"],
      strangers: [{ file: "/home/u/bin/sessionpipe", why: "a file of that name that npm didn't put there" }],
      onPath: [{ file: "/home/u/bin/sessionpipe", dir: null, at: 0 }],
      homes: [
        {
          prefix: LOCAL,
          shown: "~/.local",
          why: "where the one you type is",
          bin: path.join(LOCAL, "bin"),
          pathAt: null,
          blocked: null,
        },
      ],
    });
    const p = plan(i, facts({ hooks: { version: "1.1.0", wrong: [] } }));
    expect(p.steps.map((s) => s.do)).toEqual([
      "fetch",
      "install",
      "use",
      "remove",
      "remove",
      "remove",
      "remove",
      "remove",
      "prove",
    ]);
    expect(p.left).toHaveLength(4);
    expect(p.notes).toHaveLength(3);
    const lines = planned(TTY, p);
    const whole = planned(PLAIN, p);
    fits(lines, whole);
    expect(lines.length).toBeGreaterThan(whole.length);
    expect(lines[0]).toBe(tint(TTY, "bold", "What happens"));
    expect(lines).toContain(tint(TTY, "bold", "Left alone"));
    expect(lines).toContain(`     ${tint(TTY, "dim", "Pairings, settings, keys and what waits to be sent are kept.")}`);
    // The commands a person may paste are each whole, on a line of their own.
    expect(lines).toContain(`       ${tint(TTY, "cyan", "volta uninstall sessionpipe")}`);
    expect(lines).toContain(`       ${tint(TTY, "cyan", "sudo npm uninstall -g --prefix /usr sessionpipe")}`);
    expect(lines.filter((l) => l.startsWith(`  ${mark(TTY, "warn")} `))).toHaveLength(3);
    // A note too long for the line goes on under its own words, not under its mark; each
    // of these three is.
    const notes = lines.slice(lines.lastIndexOf("") + 1);
    expect(notes).toHaveLength(6);
    notes.forEach((l, n) => {
      if (n % 2) expect(l, plain(l)).toMatch(/^ {4}\S/);
      else expect(l.startsWith(`  ${mark(TTY, "warn")} `), plain(l)).toBe(true);
    });
    expect(plain(notes[3] as string)).toBe("    copy: typing `sessionpipe` starts that one.");
    // A command a note names is shown as one, as on every other line: whole, in its colour.
    expect(notes[3]).toBe(`    copy: typing ${tint(TTY, "cyan", "`sessionpipe`")} starts that one.`);
    expect(notes[0]).toContain(tint(TTY, "cyan", "`sessionpipe`"));
    expect(notes[5]).toBe(`    ${tint(TTY, "cyan", "`sessionpipe control run`")} does.`);
    // Into a pipe a note is the sentence as the plan wrote it.
    expect(whole.slice(-3)).toEqual(p.notes.map((n) => `  ! ${n}`));
    // A plan with nothing left alone and nothing to note is the steps and the one line.
    const short = planned(TTY, aPlan());
    fits(short, planned(PLAIN, aPlan()));
    expect(short).toHaveLength(4);
  });
});
