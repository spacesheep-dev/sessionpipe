// SPDX-License-Identifier: Apache-2.0
// Which Claude Code accounts are signed in on a machine, for control's pair and hello:
// the id events carry as `session.account_id`, and the email the receiver names it by.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeAccounts } from "../src/adapters/index.js";

let home: string;
const login = (file: string, oauthAccount: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ numStartups: 3, oauthAccount }));
};

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-account-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("claudeAccounts", () => {
  it("reads the default dir's ~/.claude.json and a second dir's own file", () => {
    login(path.join(home, ".claude.json"), { accountUuid: "acct-1", emailAddress: "me@example.com" });
    login(path.join(home, ".claude-work", ".claude.json"), { accountUuid: "acct-2", emailAddress: "me@work.example" });
    // The same account signed in twice keeps the email seen first.
    login(path.join(home, ".claude-again", ".claude.json"), {
      accountUuid: "acct-1",
      emailAddress: "me@other.example",
    });
    const dirs = [path.join(home, ".claude"), path.join(home, ".claude-work"), path.join(home, ".claude-again")];
    expect(claudeAccounts(dirs, home)).toEqual([
      { harness: "claude-code", id: "acct-1", email: "me@example.com" },
      { harness: "claude-code", id: "acct-2", email: "me@work.example" },
    ]);
  });
  it("names an account once, and skips a dir signed in to nothing", () => {
    login(path.join(home, ".claude.json"), { accountUuid: "acct-1", emailAddress: "not an email" });
    login(path.join(home, ".claude-copy", ".claude.json"), { accountUuid: "acct-1", emailAddress: "me@example.com" });
    login(path.join(home, ".claude-out", ".claude.json"), { emailAddress: "gone@example.com" });
    mkdirSync(path.join(home, ".claude-bad"));
    writeFileSync(path.join(home, ".claude-bad", ".claude.json"), "{ not json");
    const dirs = [".claude", ".claude-copy", ".claude-out", ".claude-bad", ".claude-none"].map((d) =>
      path.join(home, d),
    );
    expect(claudeAccounts(dirs, home)).toEqual([{ harness: "claude-code", id: "acct-1", email: "me@example.com" }]);
  });
  it("keeps an id whose file has no usable email", () => {
    login(path.join(home, ".claude.json"), { accountUuid: "acct-1", emailAddress: "not an email" });
    expect(claudeAccounts([path.join(home, ".claude")], home)).toEqual([{ harness: "claude-code", id: "acct-1" }]);
  });
  it("reads again on every call: a new sign-in is seen without a restart", () => {
    const dirs = [path.join(home, ".claude")];
    expect(claudeAccounts(dirs, home)).toEqual([]);
    login(path.join(home, ".claude.json"), { accountUuid: "acct-3", emailAddress: "new@example.com" });
    expect(claudeAccounts(dirs, home)).toEqual([{ harness: "claude-code", id: "acct-3", email: "new@example.com" }]);
  });
});
