// SPDX-License-Identifier: Apache-2.0
// Which Claude Code accounts are signed in on a machine, for control's pair and hello:
// the id events carry as `session.account_id`, and the email the receiver names it by.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeFacts } from "../src/adapters/claude-code.js";
import { claudeAccounts } from "../src/adapters/index.js";

let home: string;
const login = (file: string, oauthAccount: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ numStartups: 3, oauthAccount }));
};
// A home that runs Claude Code on another API, as `claude-kimi setup` writes one: the
// endpoint in settings.json's env, next to a placeholder token and the proxy's headers.
const TOKEN = "sk-placeholder-0123456789abcdef";
const HEADERS = "Modal-Key: wk-secret-key\nModal-Secret: ws-secret-value";
const onApi = (dir: string, base: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_CUSTOM_HEADERS: HEADERS },
      hooks: {},
    }),
  );
};
const apiId = (origin: string) => `api-${createHash("sha256").update(origin).digest("hex").slice(0, 16)}`;
const KIMI = "https://someone--ep-kimi-k3-server.us-west.modal.direct";

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

describe("a home that runs on another API", () => {
  it("is the endpoint's account: an id from its origin, named by its host, and no token anywhere", () => {
    const kimi = path.join(home, ".claude-kimi-modal");
    onApi(kimi, `${KIMI}/v1`);
    const got = claudeAccounts([kimi], home);
    expect(got).toEqual([{ harness: "claude-code", id: apiId(KIMI), name: new URL(KIMI).host }]);
    expect(JSON.stringify(got)).not.toMatch(/placeholder|secret|Modal-Key/);
  });
  it("is one account in every home that uses the endpoint, and a login next to it wins", () => {
    onApi(path.join(home, ".claude-kimi"), KIMI);
    onApi(path.join(home, ".claude-kimi-2"), `${KIMI}/`);
    onApi(path.join(home, ".claude-work"), KIMI);
    login(path.join(home, ".claude-work", ".claude.json"), { accountUuid: "acct-w", emailAddress: "me@work.example" });
    const dirs = [".claude-kimi", ".claude-kimi-2", ".claude-work"].map((d) => path.join(home, d));
    expect(claudeAccounts(dirs, home)).toEqual([
      { harness: "claude-code", id: apiId(KIMI), name: new URL(KIMI).host },
      { harness: "claude-code", id: "acct-w", email: "me@work.example" },
    ]);
  });
  it("keeps only the origin: no path, no user:password, and the port stays", () => {
    const dir = path.join(home, ".claude-proxy");
    onApi(dir, "https://user:hunter2@Proxy.Example:8443/key/abc123/v1");
    const [a] = claudeAccounts([dir], home);
    expect(a).toEqual({ harness: "claude-code", id: apiId("https://proxy.example:8443"), name: "proxy.example:8443" });
    expect(JSON.stringify(a)).not.toMatch(/hunter2|abc123|user/);
  });
  it("is nobody for Anthropic's own API, a URL that isn't one, or settings with no endpoint", () => {
    const dirs = ["https://api.anthropic.com", "not a url", "ftp://files.example", 42].map((base, i) => {
      const d = path.join(home, `.claude-${i}`);
      onApi(d, base);
      return d;
    });
    const bare = path.join(home, ".claude-bare");
    mkdirSync(bare);
    writeFileSync(path.join(bare, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: "high" } }));
    const broken = path.join(home, ".claude-broken");
    mkdirSync(broken);
    writeFileSync(path.join(broken, "settings.json"), "{ not json");
    expect(claudeAccounts([...dirs, bare, broken], home)).toEqual([]);
  });
  it("is the account_id its sessions' events carry", () => {
    const kimi = path.join(home, ".claude-kimi-modal");
    onApi(kimi, KIMI);
    const sid = "9ddcdfe3-383c-4c34-9aa2-0362e082b77f";
    const file = path.join(kimi, "projects", "-tmp-x", `${sid}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(
      file,
      `${[
        { type: "user", sessionId: sid, timestamp: at, message: { role: "user", content: "hostname?" } },
        { type: "assistant", sessionId: sid, timestamp: at, message: { model: "moonshotai/Kimi-K3", content: [] } },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")}\n`,
    );
    const facts = claudeFacts(file, sid, {}, { get: () => ({}), save: () => {} });
    expect(facts.account_id).toBe(apiId(KIMI));
    expect(facts.model).toBe("moonshotai/Kimi-K3");
    expect(JSON.stringify(facts)).not.toMatch(/placeholder|secret|modal\.direct/);
  });
});
