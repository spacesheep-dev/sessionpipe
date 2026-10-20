// SPDX-License-Identifier: Apache-2.0
// The receiver package before the milestone that builds it: the protocol it will
// speak, and a command that says so, run only as the script node started.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { PROTOCOL_VERSION } from "../src/index.js";

const LINE = "sessionpipe protocol 1: this command lands in a later milestone (see ROADMAP.md)\n";
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-receiver-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

it("speaks protocol 1", () => {
  expect(PROTOCOL_VERSION).toBe(1);
});

it("the command says which protocol and that it is still to come", () => {
  const out: string[] = [];
  main({ stdout: { write: (s: string) => out.push(s) } });
  expect(out.join("")).toBe(LINE);
});

describe("as the script node started", () => {
  const cli = path.resolve(here, "../src/cli.ts");
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
    vi.resetModules();
  });
  async function load(args: string[]) {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => {
      out.push(s);
      return true;
    }) as typeof process.stdout.write);
    process.argv = args;
    vi.resetModules();
    await import("../src/cli.js");
    return out.join("");
  }
  it("runs with the script's own path and through a symlink to it", async () => {
    expect(await load([process.execPath, cli])).toBe(LINE);
    if (process.platform !== "win32") {
      const link = path.join(tmp, "bin", "sessionpipe-receiver");
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(cli, link);
      expect(await load([process.execPath, link])).toBe(LINE);
    }
  });
  it("stays quiet when imported: another script, a script that is not there, no script at all", async () => {
    expect(await load([process.execPath, fileURLToPath(import.meta.url)])).toBe("");
    expect(await load([process.execPath, path.join(tmp, "missing.js")])).toBe("");
    expect(await load([process.execPath])).toBe("");
  });
});
