// SPDX-License-Identifier: Apache-2.0
// The two screens `sessionpipe reinstall` shows before it does anything (reinstall/page.ts):
// what it found, and what will happen, a row an action. As whole lines for a pipe, and
// folded for a terminal of 80 columns and of 120 (a line is never set wider than 100),
// where every line must fit and no word may be lost; with colour and without it, where
// the sign and the verb of a row must say its kind by themselves.
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Copy, Inventory } from "../src/reinstall/find.js";
import { found, leftAlone, planned, usedBy } from "../src/reinstall/page.js";
import { type Facts, type Left, type Plan, plan, type Step, slotIn } from "../src/reinstall/plan.js";
import { cols, MAX_WIDTH, makeUi, mark, PLAIN, plain, tint, type Ui } from "../src/style.js";

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
const SAFE = "Nothing is touched until 1.2.0 has downloaded. A failed install is undone.";
const RESTARTS = "The service keeps its environment and restarts once it holds nothing.";
/** The two steps every plan has, neither with a row of its own. */
const FETCH: Step = { do: "fetch", version: "1.2.0", touches: [] };
const PROVE: Step = { do: "prove", touches: [] };
const aPlan = (over: Partial<Plan> = {}): Plan => ({
  nothing: null,
  refuse: null,
  target: "1.2.0",
  home: null,
  steps: [FETCH, PROVE],
  safety: [SAFE],
  left: [],
  notes: [],
  first: null,
  ...over,
});
/** A step as the plan writes one, by what its row says: the page reads nothing else of it. */
const install = (say: string): Step => ({
  do: "install",
  version: "1.2.0",
  prefix: LOCAL,
  dir: slotIn(LOCAL, "linux"),
  replaces: true,
  touches: [],
  say,
});
const stop = (say: string): Step => ({ do: "stop", pid: 222, touches: [], say });
const unserve = (say: string): Step => ({ do: "unserve", file: service().file, touches: [], say });
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
      // Why it is no install is said once, on its row under "Left alone": here, only that it is none.
      "  · 1.3.0      ~/code/sessionpipe            nothing uses it · not an install",
    ]);
    expect(found(PLAIN, inv(SEVERAL), facts()).join("\n")).not.toContain(CHECKOUT);
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
      "      1.3.0 · nothing uses it · not an install",
      "  ✗ ~/.volta/tools/image/packages/sessionpipe",
      // What is wrong with it is said; who keeps it, and the command that removes it, are not.
      "      1.2.0 · nothing uses it · it doesn't run: `--version` printed nothing · not an install",
    ]);
    expect(found(PLAIN, inv([...SEVERAL, VOLTA]), facts()).join("\n")).not.toMatch(/Volta keeps it|volta uninstall/);
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

  it("also found: links that lead nowhere, and what is wrong with the hooks and the service; a file that is no install is not among them", () => {
    const i = inv([ONE], {
      dangling: ["/usr/local/bin/sessionpipe", "/home/u/.nvm/versions/node/v20.0.0/bin/sessionpipe"],
      // Not wrong, and not this command's: it is a row under "Left alone", and no finding.
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

  it("also found: a service file on a computer that needs no service, which is why the plan removes it", () => {
    const also = (f: Partial<Facts>) => found(PLAIN, inv([ONE]), facts(f)).slice(2);
    const unneeded = "  ! nothing here needs the background service: paired with nobody, the pool off, asking off";
    // Loaded, and nothing answers: said after that.
    expect(also({ service: service(), wanted: false, daemon: null })).toEqual([
      "",
      "Also found",
      "  ! the service is loaded, and nothing answers",
      unneeded,
    ]);
    // Not loaded either.
    expect(also({ service: service({ loaded: false, pid: null }), wanted: false })).toEqual([
      "",
      "Also found",
      "  ! the service file is there, and the service is not loaded",
      unneeded,
    ]);
    // While a daemon answers the file stays (the plan moves it onto the fresh copy): not said.
    expect(also({ service: service(), wanted: false, daemon: { pid: 100, version: "1.2.0" } })).toEqual([]);
    expect(also({ service: service(), wanted: false, daemon: { pid: 222, version: "1.2.0" } })).toEqual([
      "",
      "Also found",
      "  ! a daemon someone started by hand (pid 222) holds the socket the service needs",
    ]);
    // Something here needs it, or there is no file to speak of: not said.
    expect(also({ service: service(), daemon: null }).join("\n")).not.toContain("nothing here needs");
    expect(also({ wanted: false })).toEqual([]);
    expect(also({ wanted: false, daemon: { pid: 222, version: "1.2.0" } })).toEqual([]);
    // It is the state the plan answers with the removal of the file, and no other.
    for (const f of [
      { service: service(), wanted: false, daemon: null },
      { service: service(), wanted: false, daemon: { pid: 100, version: "1.2.0" } },
      { service: service(), daemon: null },
      { wanted: false },
    ]) {
      const unserved = plan(inv([ONE]), facts(f)).steps.some((s) => s.do === "unserve");
      expect(found(PLAIN, inv([ONE]), facts(f)).includes(unneeded)).toBe(unserved);
    }
    // At a terminal it folds under its own words, as every finding does.
    const folded = found(TTY, inv([ONE]), facts({ service: service(), wanted: false, daemon: null })).slice(-2);
    expect(folded.map(plain)).toEqual([
      "  ! nothing here needs the background service: paired with nobody, the pool",
      "    off, asking off",
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
      "      not an install",
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
    expect(usedBy(copy("~/.local", { uses: ["hooks"], runs: false, wrong: BROKEN, version: null }))).toBe("the hooks");
  });
});

describe("planned: what will happen, a row an action", () => {
  /** One of each kind of row, in the order a plan takes its steps. (No plan stops a
   *  daemon and removes the service file both: the page shows what it is handed.) */
  const EACH: Step[] = [
    FETCH,
    install("1.2.0, the newest release, fresh in ~/.local (replaces 1.1.0)"),
    stop("the daemon started by hand (pid 222), once it holds nothing"),
    unserve("the service file, which nothing here needs"),
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
      // Taking the service file away is a removal as any other.
      "  - remove   the service file, which nothing here needs",
      "  ~ switch   the hooks and the background service to it",
      "  - remove   /usr/local/bin/sessionpipe (a link to a copy that is gone)",
      "  - remove   a leftover folder in /usr/local",
      "  - remove   1.1.0 in ~/.nvm/versions/node/v22.1.0",
      KEEP,
      "",
      SAFE,
    ]);
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
      expect(rows).toHaveLength(8);
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
      // Red and bold: what goes. It is the row the eye should land on.
      `  ${ESC}[1m${ESC}[31m- remove ${ESC}[39m${ESC}[22m  the service file, which nothing here needs`,
      `  ${ESC}[33m~ switch ${ESC}[39m  the hooks and the background service to it`,
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
    expect(verb(lines[4])).toBe(tint(TTY, "yellow", "~ switch "));
    expect(verb(lines[3])).toBe(tint(TTY, "bold", tint(TTY, "red", "- remove ")));
    expect(verb(lines[8])).toBe(tint(TTY, "dim", "= keep   "));
    // Each code a row opens it closes before its words begin: the words are in no colour.
    expect(lines.slice(1, 9).map((l) => codes(l).length)).toEqual([2, 2, 4, 2, 4, 4, 4, 2]);
    for (const l of lines.slice(1, 9)) {
      expect(l.slice(2 + verb(l).length)).toMatch(/^ {2}\S/);
      expect(codes(l.slice(2 + verb(l).length))).toEqual([]);
    }
    // Only a removal is bold, and nothing but a removal is red.
    for (const l of lines.slice(1, 9))
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
      "Typing `sessionpipe` starts /home/u/bin/sessionpipe, not the copy in ~/.local.",
      "The background service isn't running, and nothing here starts it by itself: `sessionpipe control run` does.",
    ];
    // Into a pipe a note is the sentence as the plan wrote it.
    expect(planned(PLAIN, aPlan({ notes })).slice(2)).toEqual(["", ...notes.map((n) => `  ! ${n}`), "", SAFE]);
    expect(planned(MONO, aPlan({ notes })).slice(3, -2)).toEqual([
      "  ! /home/u/.local/bin is not on your PATH: add it, or `sessionpipe` is not",
      "    found when you type it.",
      "  ! Typing `sessionpipe` starts /home/u/bin/sessionpipe, not the copy in",
      "    ~/.local.",
      "  ! The background service isn't running, and nothing here starts it by itself:",
      "    `sessionpipe control run` does.",
    ]);
    // At 120 columns only the longest folds, and its command goes whole to the next line.
    expect(planned(MONO_WIDE, aPlan({ notes })).slice(3, -2)).toEqual([
      "  ! /home/u/.local/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.",
      "  ! Typing `sessionpipe` starts /home/u/bin/sessionpipe, not the copy in ~/.local.",
      "  ! The background service isn't running, and nothing here starts it by itself:",
      "    `sessionpipe control run` does.",
    ]);
    // In colour: the mark yellow, each command whole and in its colour, on every line of a note.
    const coloured = planned(TTY, aPlan({ notes })).slice(3, -2);
    expect(coloured).toEqual([
      `  ${mark(TTY, "warn")} /home/u/.local/bin is not on your PATH: add it, or ${tint(TTY, "cyan", "`sessionpipe`")} is not`,
      "    found when you type it.",
      `  ${mark(TTY, "warn")} Typing ${tint(TTY, "cyan", "`sessionpipe`")} starts /home/u/bin/sessionpipe, not the copy in`,
      "    ~/.local.",
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
    const long = "Nothing is touched until 10.20.30-beta.12 has downloaded. A failed install is undone.";
    expect(cols(long)).toBeGreaterThan(79);
    expect(planned(TTY, aPlan({ safety: [long, RESTARTS] })).slice(-4)).toEqual([
      "",
      "Nothing is touched until 10.20.30-beta.12 has downloaded. A failed install is",
      "undone.",
      RESTARTS,
    ]);
    expect(planned(WIDE, aPlan({ safety: [long, RESTARTS] })).slice(-3)).toEqual(["", long, RESTARTS]);
    expect(planned(PLAIN, aPlan({ safety: [long, RESTARTS] })).slice(-3)).toEqual(["", long, RESTARTS]);
  });

  it("no command is printed on a line of its own: a copy that needs sudo says so, and a run ends with the line", () => {
    const sudo = "sudo npm uninstall -g --prefix /usr/local sessionpipe";
    const stays = [
      left("/usr/local", "you may not write where it is", { version: "1.1.0", line: sudo, ours: true }),
      left("~/.volta", "Volta keeps it", { line: "volta uninstall sessionpipe" }),
    ];
    for (const ui of [PLAIN, MONO, TTY, WIDE]) {
      const lines = planned(ui, aPlan({ steps: EACH, left: stays })).map(plain);
      expect(lines.join("\n")).not.toContain("sudo npm");
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
  const SUDO = "sudo npm uninstall -g --prefix /usr/local sessionpipe";
  /** One of each kind of thing that stays, every place short. */
  const EACH: Left[] = [
    // What is no install of it, and nobody's to remove.
    left("~/code/sessionpipe", CHECKOUT, { version: "1.3.0" }),
    // A copy this command would have removed, with the line that does it.
    left("/usr/local", "you may not write where it is", { version: "1.1.0", line: SUDO, ours: true }),
    // A file of the name that is no install.
    left("/home/u/bin/sessionpipe", "a file of that name that npm didn't put there"),
    // What a tool of its own keeps, and removes.
    left("~/.volta", "Volta keeps it", { line: "volta uninstall sessionpipe" }),
    // A copy that would have gone, with no line for it (Windows; npm's own leftover), and no release.
    left("C:\\nodejs", "you may not write where it is", { ours: true }),
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
      "  · /home/u/bin/sessionpipe       a file of that name that npm didn't put there",
      "  · ~/.volta                      Volta keeps it: `volta uninstall sessionpipe` removes it",
      "  ! C:\\nodejs                     a broken copy · you may not write where it is",
      "  · ~/.npm/_npx/0a1b2c3d4e5f6a7b  npm's cache of what npx ran",
    ]);
    // Each by itself, the column as wide as its own place.
    const row = (l: Left) => leftAlone(PLAIN, [l])[1];
    expect(row(left("~/code", "it holds src"))).toBe("  · ~/code  it holds src");
    expect(row(left("~/.volta", "Volta keeps it", { line: "volta uninstall sessionpipe" }))).toBe(
      "  · ~/.volta  Volta keeps it: `volta uninstall sessionpipe` removes it",
    );
    const ours = (over: Partial<Left>) =>
      row(left("/usr/local", "you may not write where it is", { ours: true, ...over }));
    expect(ours({ version: "1.1.0", line: SUDO })).toBe("  ! /usr/local  1.1.0 · needs sudo: a run ends with its line");
    expect(ours({ version: null, line: SUDO })).toBe(
      "  ! /usr/local  a broken copy · needs sudo: a run ends with its line",
    );
    expect(ours({ version: "1.1.0" })).toBe("  ! /usr/local  1.1.0 · you may not write where it is");
    expect(ours({ version: null })).toBe("  ! /usr/local  a broken copy · you may not write where it is");
    // What is not ours says no release, whatever it is, and never "needs sudo".
    expect(row(left("~/code", "it holds src", { version: "9.9.9" }))).toBe("  · ~/code  it holds src");
  });

  it("only what a person reads is shown: never the whole path of what stays, never a line to paste", () => {
    for (const ui of [PLAIN, MONO, TTY, WIDE]) {
      const text = leftAlone(ui, EACH).map(plain).join("\n");
      expect(text).not.toContain(path.join(ROOT, "whole"));
      expect(text).not.toContain("sudo npm");
    }
  });

  it("at a terminal: the heading bold, the marks in their colours, a command picked out, the words plain", () => {
    expect(leftAlone(WIDE, EACH)).toEqual([
      `${ESC}[1mLeft alone${ESC}[22m`,
      `  ${ESC}[2m·${ESC}[22m ~/code/sessionpipe            it holds src, which no published sessionpipe has (a checkout or a`,
      "                                  build?)",
      // Yellow: the one kind of row that leaves the job unfinished.
      `  ${ESC}[33m!${ESC}[39m /usr/local                    1.1.0 · needs sudo: a run ends with its line`,
      `  ${ESC}[2m·${ESC}[22m /home/u/bin/sessionpipe       a file of that name that npm didn't put there`,
      `  ${ESC}[2m·${ESC}[22m ~/.volta                      Volta keeps it: ${ESC}[36m\`volta uninstall sessionpipe\`${ESC}[39m removes it`,
      `  ${ESC}[33m!${ESC}[39m C:\\nodejs                     a broken copy · you may not write where it is`,
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
      "  · /home/u/bin/sessionpipe       a file of that name that npm didn't put there",
      "  · ~/.volta                      Volta keeps it: `volta uninstall sessionpipe`",
      "                                  removes it",
      "  ! C:\\nodejs                     a broken copy · you may not write where it is",
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
    left("/home/u/bin/sessionpipe", "a file of that name that npm didn't put there"),
    left(LONG, "you may not write where it is", { version: "1.0.0", line: SUDO, ours: true }),
    left("/usr", "you may not write where it is", { ours: true }),
  ];

  it("a place too long for a column: each kind of row with its place on a line of its own, and why under it", () => {
    expect(leftAlone(PLAIN, WIDE_ROWS)).toEqual([
      "Left alone",
      "  · ~/code/sessionpipe",
      "      it holds src, which no published sessionpipe has (a checkout or a build?)",
      `  · ${VOLTA_AT}`,
      "      Volta keeps it: `volta uninstall sessionpipe` removes it",
      "  · /home/u/bin/sessionpipe",
      "      a file of that name that npm didn't put there",
      // Into a pipe the folder is one line, whatever its length.
      `  ! ${LONG}`,
      "      1.0.0 · needs sudo: a run ends with its line",
      "  ! /usr",
      "      a broken copy · you may not write where it is",
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
    expect(leftAlone(MONO, [left(win, "you may not write where it is", { version: "1.1.0", ours: true })])).toEqual([
      "Left alone",
      // A name with spaces in it is never split.
      "  ! C:\\Users\\Someone With A Long Name\\AppData\\Roaming\\fnm\\node-versions\\",
      "    v22.11.0\\installation\\node_modules",
      "      1.1.0 · you may not write where it is",
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

describe("the two screens of a real repair, from the plan itself", () => {
  // A computer with every kind of copy on it and a copy that can't be written; the
  // home's bin folder is not on PATH, and what a shell finds first is a file that is no
  // install. A service file is there, and a daemon someone started by hand answers.
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
  const f = facts({
    hooks: { version: "1.1.0", wrong: [] },
    service: service(),
    daemon: { pid: 222, version: "1.1.0" },
  });
  const p = plan(i, f);

  it("the plan has a step of every kind but the removal of the service file, things left of each kind, and two notes", () => {
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
    expect(p.notes).toHaveLength(2);
    expect(p.safety).toEqual([SAFE, RESTARTS]);
  });

  it("into a pipe: the rows, what is left alone, the notes, what keeps it safe", () => {
    expect(planned(PLAIN, p)).toEqual([
      "This will",
      "  + install  1.2.0, the newest release, fresh in ~/.local (replaces 1.1.0)",
      "  ~ stop     the daemon started by hand (pid 222), once it holds nothing",
      "  ~ switch   the hooks and the background service to it",
      "  - remove   /usr/local/bin/sessionpipe (a link to a copy that is gone)",
      "  - remove   a leftover folder in /usr/local",
      "  - remove   the broken copy in /opt/homebrew",
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
      "      a file of that name that npm didn't put there",
      "  ! /usr",
      "      1.0.0 · needs sudo: a run ends with its line",
      "",
      ...p.notes.map((n) => `  ! ${n}`),
      "",
      SAFE,
      RESTARTS,
    ]);
    expect(p.notes[1]).toBe("Typing `sessionpipe` starts /home/u/bin/sessionpipe, not the copy in ~/.local.");
  });

  it("why a folder is no install is said once, on its row of what is left; the table says only that it is none", () => {
    const table = found(PLAIN, i, f).join("\n");
    const rows = planned(PLAIN, p).join("\n");
    for (const why of [CHECKOUT, "Volta keeps it", "a file of that name that npm didn't put there"]) {
      expect(table).not.toContain(why);
      expect(rows.split(why)).toHaveLength(2);
    }
    expect(table.match(/ · not an install$/gm)).toHaveLength(2);
    // The file that is no install is no finding, and no copy: only a row of what is left.
    expect(table).not.toContain("/home/u/bin/sessionpipe");
    // What is found beside the copies is what the plan answers: the link, and the daemon.
    expect(found(PLAIN, i, f).slice(-4)).toEqual([
      "",
      "Also found",
      "  ! /usr/local/bin/sessionpipe is a link to a sessionpipe that is gone",
      "  ! a daemon someone started by hand (pid 222) holds the socket the service needs",
    ]);
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
      // The command a tool of its own removes its copy with is whole, in its colour; the
      // line that needs sudo is not on the screen.
      expect(lines).toContain(`      Volta keeps it: ${tint(ui, "cyan", "`volta uninstall sessionpipe`")} removes it`);
      expect(lines.map(plain).join("\n")).not.toContain("sudo npm");
      // The notes are marked, and what keeps it safe ends the screen in plain text.
      expect(
        lines.filter((l) => l.startsWith(`  ${mark(ui, "warn")} `) && !plain(l).startsWith("  ! /usr")),
      ).toHaveLength(2);
      expect(lines.slice(-3)).toEqual(["", SAFE, RESTARTS]);
    }
    // At 80 columns each of the two notes takes a second line, under its own words.
    const notes = planned(TTY, p).slice(-8, -3);
    expect(notes[0]).toBe("");
    expect(notes.slice(1).map((l) => plain(l).slice(0, 4))).toEqual(["  ! ", "    ", "  ! ", "    "]);
    expect(notes[3]).toBe(
      `  ${mark(TTY, "warn")} Typing ${tint(TTY, "cyan", "`sessionpipe`")} starts /home/u/bin/sessionpipe, not the copy in`,
    );
    expect(notes[4]).toBe("    ~/.local.");
  });
});
