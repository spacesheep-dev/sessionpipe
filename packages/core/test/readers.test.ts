// SPDX-License-Identifier: Apache-2.0
// The git facts of a folder: the remote with its credentials stripped.
import { describe, expect, it } from "vitest";
import { stripCredentials } from "../src/readers/git.js";

describe("stripCredentials", () => {
  it("drops user:token, turns ssh forms into host/path, loses the scheme and .git", () => {
    expect(stripCredentials("https://user:ghp_x@github.com/a/b.git")).toBe("github.com/a/b");
    expect(stripCredentials("https://token@gitlab.com/g/r")).toBe("gitlab.com/g/r");
    expect(stripCredentials("http://example.com/a/b.git")).toBe("example.com/a/b");
    expect(stripCredentials("git@github.com:a/b.git")).toBe("github.com/a/b");
    expect(stripCredentials("git@github.com:a/b")).toBe("github.com/a/b");
    expect(stripCredentials("ssh://git@host.example/a/b.git")).toBe("host.example/a/b");
    expect(stripCredentials("/srv/git/repo.git")).toBe("/srv/git/repo");
  });
});
