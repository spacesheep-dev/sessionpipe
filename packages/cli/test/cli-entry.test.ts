// SPDX-License-Identifier: Apache-2.0
// The entrypoint guard, the way an install runs it: npm's bin link is a symlink to
// dist/cli.js, so argv[1] is the link and the module's own URL is the real file. The
// module must run the command then — and run nothing when it is merely imported.
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "../src/cli.ts");
let tmp: string;
let argv: string[];
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-entry-")));
  argv = process.argv;
  vi.resetModules();
});
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("the entrypoint", () => {
  it("runs the command when the process was started through a link to the module", async () => {
    const link = path.join(tmp, "sessionpipe");
    symlinkSync(entry, link);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    process.argv = [process.execPath, link, "--version"];
    await import("../src/cli.js");
    await new Promise((r) => setImmediate(r));
    expect(stdout).toHaveBeenCalledWith(`${VERSION}\n`);
    // A closed pipe (`sessionpipe tail | head`) ends the process quietly; any other
    // stdout error is left to Node.
    process.stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockClear();
    process.stdout.emit("error", Object.assign(new Error("other"), { code: "EIO" }));
    expect(exit).not.toHaveBeenCalled();
  });

  it("runs nothing when imported by another module", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.argv = [process.execPath, path.join(tmp, "some-test.js"), "--version"];
    const cli = await import("../src/cli.js");
    await new Promise((r) => setImmediate(r));
    expect(stdout).not.toHaveBeenCalled();
    expect(typeof cli.main).toBe("function");
  });
});
