// SPDX-License-Identifier: Apache-2.0
// Issue #205 on every harness with a JSON config: install puts only our entries into the
// file's text and uninstall takes only them out, so a file laid out any way at all is
// byte-identical afterwards. Lists and objects on one line, any indent, CRLF, a byte-order
// mark, no final newline, a foreign hook on our event; a second install changes nothing,
// and an upgrade rewrites our commands and nothing else. Generated files go through the
// same steps beside their JSON.stringify-shaped twin, which the old whole-file writer laid
// out, and the two must hold the same values after every step.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { antigravity, autopilot, claudeCode, codex, devin, geminiCli, grokBuild } from "../src/adapters/index.js";
import { formatJson } from "../src/adapters/json-text.js";
import type { Adapter, HookCommand, InstallOptions } from "../src/adapters/types.js";
import { layout, pick, randomShape, rng } from "./helpers/json-layout.js";

const cmd: HookCommand = (a) => ({
  argv: ["/usr/local/bin/node", "/opt/sessionpipe/dist/hook.js", ...a],
  command: `"/usr/local/bin/node" "/opt/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});
const cmd2: HookCommand = (a) => ({
  argv: ["/new/node", "/new/sessionpipe/dist/hook.js", ...a],
  command: `"/new/node" "/new/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});
/** The text of a command in a JSON file, without the harness and event. */
const inText = (c: HookCommand) => JSON.stringify(c([]).command).slice(1, -1);

/** Each JSON config, and the install options that write all of it (Claude Code's status line too). */
const JSON_ADAPTERS: [Adapter, string, InstallOptions][] = [
  [claudeCode, ".claude/settings.json", { statusLine: true }],
  [codex, ".codex/hooks.json", {}],
  [geminiCli, ".gemini/settings.json", {}],
  [antigravity, ".gemini/config/hooks.json", {}],
  [devin, ".config/devin/config.json", {}],
  [grokBuild, ".grok/hooks/sessionpipe.json", {}],
  [autopilot, ".config/autopilot/settings.json", {}],
];

let home: string;
const envIn = (h: string): NodeJS.ProcessEnv => ({
  HOME: h,
  CLAUDE_CONFIG_DIR: path.join(h, ".claude"),
  CODEX_HOME: path.join(h, ".codex"),
  GEMINI_CLI_HOME: path.join(h, ".gemini"),
  XDG_CONFIG_HOME: path.join(h, ".config"),
  // Devin's config is under %APPDATA% on Windows: the same folder there.
  APPDATA: path.join(h, ".config"),
  GROK_HOME: path.join(h, ".grok"),
});
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-layout-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (file: string) => readFileSync(file, "utf8");

const ISSUE =
  '{\n  "permissions": { "allow": ["Read", "Bash(ls)"] },\n' +
  '  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "echo bye" }] }] }\n}\n';
const FOREIGN = { hooks: [{ type: "command", command: "/other/tool", timeout: 1 }] };
const CASES: Record<string, string> = {
  "the issue's settings.json": ISSUE,
  "CRLF, a byte-order mark and tabs": `﻿${ISSUE.replace(/\n {2}/g, "\n\t").replace(/\n/g, "\r\n")}`,
  "four spaces and no final newline": '{\n    "model": "opus",\n    "permissions": {\n        "allow": []\n    }\n}',
  "a mixed indent": '{\n\t"permissions": {\n    "allow": [ "Read" ]\n\t},\n  "model": "opus"\n}\n',
  "one line, hooks first among other keys":
    '{"hooks": {"Other": [], "Stop": [{"hooks": [{"type": "command", "command": "echo bye"}]}]}, "z": 1, "a": [1, 2]}',
  "our events among foreign entries": `${JSON.stringify(
    { model: "x", hooks: { Stop: [FOREIGN, FOREIGN], SessionStart: [FOREIGN], Other: [FOREIGN] } },
    null,
    2,
  )}\n`,
  "JSON.stringify's shape": `${JSON.stringify({ model: "opus", theme: "dark" }, null, 2)}\n`,
  "an empty object": "{}",
  "escapes and numbers": '{ "a\\"b": "\\u00e9\\n", "n": -1.5e3, "t": [true, null] }\n',
};

describe("install then uninstall leaves a JSON config byte-identical (#205)", () => {
  for (const [a, rel, opts] of JSON_ADAPTERS)
    for (const [name, before] of Object.entries(CASES))
      it(`${a.name}: ${name}`, () => {
        const env = envIn(home);
        const file = path.join(home, rel);
        put(file, before);
        a.install(cmd, env, opts);
        const installed = read(file);
        expect(installed).not.toBe(before);
        expect(installed.includes(inText(cmd))).toBe(true);
        // A second install changes nothing; an upgrade changes our commands only.
        a.install(cmd, env, opts);
        expect(read(file)).toBe(installed);
        a.install(cmd2, env, opts);
        expect(read(file).replaceAll(inText(cmd2), inText(cmd))).toBe(installed);
        a.uninstall(env);
        expect(read(file)).toBe(before);
      });

  for (const [a, rel, opts] of JSON_ADAPTERS)
    it(`${a.name}: a file it creates is laid out as JSON.stringify does, and goes again`, () => {
      const env = envIn(home);
      const file = path.join(home, rel);
      const created = a
        .install(cmd, env, opts)
        .filter((r) => r.created)
        .map((r) => r.file);
      expect(created).toContain(file);
      const text = read(file);
      expect(text).toBe(formatJson(JSON.parse(text), { indent: "  ", eol: "\n", finalNewline: true }));
      a.uninstall(env, { created });
      expect(existsSync(file)).toBe(false);
    });

  for (const [a, rel, opts] of JSON_ADAPTERS)
    it(`${a.name}: a file with a trailing comma is never written`, () => {
      const env = envIn(home);
      const file = path.join(home, rel);
      put(file, '{ "a": 1, }\n');
      expect(a.install(cmd, env, opts).find((r) => r.file === file)?.skipped).toBe(true);
      a.uninstall(env);
      expect(read(file)).toBe('{ "a": 1, }\n');
    });

  // Uninstall cannot tell an empty hooks object or event list that was there from one
  // install made, so it takes the empty one out as it always has; the rest stays as it was.
  for (const [a, rel, opts] of JSON_ADAPTERS)
    it(`${a.name}: an empty hooks object, or event list, our entries went into`, () => {
      const env = envIn(home);
      const file = path.join(home, rel);
      const ev = a.name === "antigravity" ? "Stop" : a.events[0]!;
      const cases = [
        ['{\n  "model": "opus",\n  "hooks": {}\n}\n', '{\n  "model": "opus"\n}\n'],
        [`{ "hooks": { "Other": [1], ${JSON.stringify(ev)}: [] } }`, '{ "hooks": { "Other": [1] } }'],
      ];
      for (const [before, after] of cases) {
        put(file, before!);
        a.install(cmd, env, opts);
        a.uninstall(env);
        // Antigravity's entries are a group of their own: its `hooks` is anyone's key.
        expect(read(file)).toBe(a.name === "antigravity" ? before : after);
      }
    });
});

/** A config with foreign entries on our events and others, its keys in any order. */
function config(r: () => number, a: Adapter): Record<string, unknown> {
  const events = [...a.events.slice(0, 3), "Other"];
  const entry = () =>
    pick(r, [
      FOREIGN,
      { matcher: "Bash", hooks: [{ type: "command", command: "/x y" }] },
      { id: "theirs", command: "z" },
    ]);
  const hooks: Record<string, unknown> = {};
  for (const ev of events) if (r() < 0.6) hooks[ev] = Array.from({ length: 1 + Math.floor(r() * 2) }, entry);
  const parts: [string, unknown][] = [
    ["model", pick(r, ["opus", "x"])],
    ["permissions", { allow: pick(r, [["Read"], ["Read", "Bash(ls)"], []]), deny: [] }],
    ["env", { A: "1" }],
  ];
  if (Object.keys(hooks).length) parts.push(["hooks", hooks]);
  parts.sort(() => r() - 0.5);
  return Object.fromEntries(parts.filter(() => r() < 0.8));
}

describe("the text edit against the whole-file writer, over generated configs", () => {
  for (const [a, rel, opts] of JSON_ADAPTERS)
    it(`${a.name}: the same values after every step, and the file's own bytes at the end`, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const r = rng(seed);
        const s = randomShape(r);
        const v = config(r, a);
        const text = layout(r, v, s.indent, s.eol) + (s.finalNewline ? s.eol : "");
        const before = (s.bom ? "﻿" : "") + text;
        // The twin: the same values as the whole-file writer lays them out.
        const twin = formatJson(v, s);
        const [mine, old] = ["a", "b"].map((d) => {
          const h = path.join(home, `${seed}${d}`);
          return { env: envIn(h), file: path.join(h, rel) };
        });
        put(mine!.file, before);
        put(old!.file, twin);
        const steps: ((env: NodeJS.ProcessEnv) => unknown)[] = [
          (env) => a.install(cmd, env, opts),
          (env) => a.install(cmd, env, opts),
          (env) => a.install(cmd2, env, { ...opts, lean: true }),
          (env) => a.uninstall(env),
        ];
        for (const step of steps) {
          step(mine!.env);
          step(old!.env);
          const [x, y] = [read(mine!.file), read(old!.file)];
          const value = (t: string) => JSON.stringify(JSON.parse(t.replace(/^﻿/, "")));
          expect(value(x), `seed ${seed}`).toBe(value(y));
          // The twin is written exactly as the old writer wrote it.
          expect(y, `seed ${seed}`).toBe(formatJson(JSON.parse(y.replace(/^﻿/, "")), s));
        }
        expect(read(mine!.file), `seed ${seed}`).toBe(before);
        expect(read(old!.file), `seed ${seed}`).toBe(twin);
      }
    });
});
