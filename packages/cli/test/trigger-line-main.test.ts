// SPDX-License-Identifier: Apache-2.0
// `sessionpipe trigger line` through the CLI's own main (cli.ts): what a program reads back is the
// line's bytes as they are, at a terminal of any width as in a pipe, never folded or styled; and
// words that look like the CLI's own options (`--help`, `-h`, `--no-color`) come back as words.
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TriggerRule } from "@sessionpipe/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeRules } from "../src/control/rules-file.js";
import { writeControl } from "../src/control/store.js";
import type { TriggerDeps } from "../src/triggers.js";

let interactive = false;
vi.mock("../src/triggers.js", async (original) => {
  const real = await original<typeof import("../src/triggers.js")>();
  return {
    ...real,
    defaultTriggerDeps: (_dist: string, env: NodeJS.ProcessEnv = process.env): TriggerDeps => ({
      env,
      interactive: () => interactive,
      confirm: async () => "no",
      harnesses: () => ["claude-code", "codex"],
      local: async () => null,
      wellKnown: async () => ({ control: { notices: true } }),
      sessionThere: () => false,
      sessionFolder: () => null,
      installService: () => "not installed",
      now: () => Date.parse("2026-11-24T09:30:00.000Z"),
      zone: "UTC",
    }),
  };
});
const { main } = await import("../src/cli.js");

const clock = (name: string, words: string): TriggerRule => ({
  name,
  paused: false,
  source: { every: "mon 09:00" },
  target: { start: "codex" },
  folder: "~/work/acme",
  level: "safe",
  cap: { per_day: 1 },
  words,
});
const at = async (where: { tty?: boolean; columns?: number }, ...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  await main(argv, { out: (s = "") => void out.push(s), err: (s) => void err.push(s), exit: () => {}, ...where });
  return { out, err };
};

beforeEach(() => {
  interactive = false;
  const home = os.homedir();
  mkdirSync(path.join(home, "work", "acme"), { recursive: true });
  writeControl({ name: "studio-mac", folders: [path.join(home, "work")], mode: "safe", receivers: [] });
  writeRules({
    v: 1,
    on: true,
    rules: [
      clock(
        "long",
        `Make last week's sales report for the whole team,  twice spaced,\nand a second line. ${"x".repeat(80)}`,
      ),
      clock("help", "--help"),
      clock("short", "-h"),
      clock("color", "--no-color"),
    ],
  });
});

describe("trigger line through main", () => {
  it("writes its bytes as they are: never folded, never styled, at any width or in a pipe", async () => {
    const piped = await at({}, "trigger", "line", "long");
    expect(piped.out).toHaveLength(1);
    expect(piped.out[0]).toContain("twice spaced,\nand a second line.");
    expect(piped.out[0]).toContain("team,  twice");
    for (const columns of [40, 200]) {
      const tty = await at({ tty: true, columns }, "trigger", "line", "long");
      expect(tty.out, String(columns)).toEqual(piped.out);
      expect(tty.err).toEqual([]);
    }
  });

  it("a note beside the line goes to stderr, never into the line", async () => {
    writeRules({
      v: 1,
      on: true,
      rules: [{ ...clock("abs", "Go."), folder: path.join(os.homedir(), "work", "acme") }],
    });
    const { out, err } = await at({ tty: true, columns: 80 }, "trigger", "line", "abs");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("--folder '~/work/acme'");
    expect(err.join("")).toContain("The rules file writes folder in a spelling `trigger add` doesn't");
  });

  it("words that look like the CLI's own options are written --words=<value>, and read back as words", async () => {
    for (const [name, words] of [
      ["help", "--help"],
      ["short", "-h"],
      ["color", "--no-color"],
    ] as const) {
      const { out } = await at({ tty: true, columns: 80 }, "trigger", "line", name);
      expect(out[0]?.endsWith(` --words='${words}'`)).toBe(true);
      // Pasted back, it is `add` with those words, not the CLI's help or its colour switch: `add`
      // refuses here (no terminal, or a coding session's environment), and says so as `add`.
      const argv = (out[0] as string)
        .replace(/^sessionpipe /, "")
        .split(" ")
        .map((w) => w.replace(/^'(.*)'$/, "$1"));
      const back = await at({}, ...argv.map((w) => w.replace(/^(--words=)'(.*)'$/, "$1$2")));
      expect(back.out).toEqual([]);
      expect(back.err.join("")).toContain("Adding a rule");
    }
  });
});
