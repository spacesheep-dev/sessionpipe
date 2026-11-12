// SPDX-License-Identifier: Apache-2.0
// shell.ts and refusal.ts: a word of a command printed for a person to paste, and the
// error that carries its own next command.
import { describe, expect, it } from "vitest";
import { Refusal } from "../src/refusal.js";
import { shq } from "../src/shell.js";

describe("a word of a printed command", () => {
  it("is left alone when a shell would read it as it stands", () => {
    for (const w of ["sessionpipe", "~/.claude-second", "/usr/local/lib", "https://r.example:8443/x", "a_b@c%d+e=f,g"])
      expect(shq(w, "darwin")).toBe(w);
  });

  it("is quoted when it holds a space, a quote, a `$` or anything else a shell acts on", () => {
    expect(shq("/Users/me/My Projects/x", "linux")).toBe("'/Users/me/My Projects/x'");
    expect(shq("it's", "linux")).toBe(`'it'\\''s'`);
    expect(shq("$(rm -rf ~)", "darwin")).toBe("'$(rm -rf ~)'");
    expect(shq("a;b&&c|d>e`f`", "darwin")).toBe("'a;b&&c|d>e`f`'");
    expect(shq("", "darwin")).toBe("''");
    // A word that starts like an option is quoted, so it reads as the value it is.
    expect(shq("-rf", "darwin")).toBe("'-rf'");
  });

  it("uses double quotes where the shell is cmd or PowerShell; this platform's by default", () => {
    expect(shq("C:\\Program Files\\x", "win32")).toBe('"C:\\Program Files\\x"');
    expect(shq('say "hi"', "win32")).toBe('"say ""hi"""');
    expect(shq("a b")).toBe(process.platform === "win32" ? '"a b"' : "'a b'");
  });
});

describe("a refusal", () => {
  it("is an error that names the one command to run next", () => {
    const r = new Refusal("npm can't write the prefix", "sessionpipe update");
    expect(r).toBeInstanceOf(Error);
    expect(r.message).toBe("npm can't write the prefix");
    expect(r.next).toBe("sessionpipe update");
  });
});
