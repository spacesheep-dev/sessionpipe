// SPDX-License-Identifier: Apache-2.0
// The name claude.ai shows for a session (claude-remote-title.ts and claudeCode.remoteFacts):
// where the sign-in is read from, which one is usable, what the call sends, what an answer
// becomes, and how often a session is asked. No test reaches the network or a real sign-in.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeCode } from "../src/adapters/claude-code.js";
import {
  claudeToken,
  fetchRemoteTitle,
  keychainServices,
  REMOTE_TITLE_BETA,
  REMOTE_TITLE_REFRESH_MS,
  REMOTE_TITLE_RETRY_MS,
  REMOTE_TITLE_URL,
  type RemoteTitleDeps,
  runSecurity,
  usableToken,
} from "../src/adapters/claude-remote-title.js";
import type { FactsState, SessionFacts } from "../src/adapters/types.js";

/** The adapter's method with its test seam, the deps the interface leaves out. */
const remoteFacts = claudeCode.remoteFacts as (
  session: { id: string },
  facts: SessionFacts,
  transcript: string | undefined,
  state: FactsState,
  env?: NodeJS.ProcessEnv,
  deps?: RemoteTitleDeps,
) => Promise<SessionFacts>;

const NOW = Date.parse("2026-10-28T19:00:00Z");
const TOKEN = `sk-ant-oat01-${"a1B2_c3-".repeat(12)}`;
const signIn = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: { accessToken: TOKEN, refreshToken: "never-read", expiresAt: NOW + 3_600_000, ...o },
  });
const named = (s: string) =>
  `Claude Code-credentials-${createHash("sha256").update(s.normalize("NFC")).digest("hex").slice(0, 8)}`;
const answer = (body: unknown, status = 200) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-remote-title-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("runSecurity", () => {
  it("is stdout on success, null on a failure, an empty answer, or no such program", () => {
    expect(runSecurity(["-e", "process.stdout.write('blob')"], process.execPath)).toBe("blob");
    expect(runSecurity(["-e", "process.exit(44)"], process.execPath)).toBeNull();
    expect(runSecurity(["-e", ""], process.execPath)).toBeNull();
    // `security` itself: no such item on a Mac, no such program elsewhere. Either way, nothing.
    expect(runSecurity(["find-generic-password", "-s", `sessionpipe-test-${process.pid}-none`, "-w"])).toBeNull();
  });
});

describe("keychainServices: the item Claude Code keeps a config dir's sign-in in", () => {
  it("the default ~/.claude, with CLAUDE_CONFIG_DIR unset, is the bare name", () => {
    const d = path.join(home, ".claude");
    expect(keychainServices(d, undefined, home)).toEqual(["Claude Code-credentials", named(d)]);
  });
  it("a named dir is the hash of CLAUDE_CONFIG_DIR as given, checked against a real item", () => {
    const d = "/Users/yaroslavvb/.claude-yaroslavvb-mlcollective";
    expect(keychainServices(d, d, "/Users/yaroslavvb")).toEqual(["Claude Code-credentials-a9871376"]);
    expect(keychainServices(`${d}/`, `${d}/`, "/Users/yaroslavvb")).toEqual([named(`${d}/`)]);
    // Spelled differently from the transcript's path: both spellings are tried, as given first.
    expect(keychainServices(d, `${d}/`, "/Users/yaroslavvb")).toEqual([named(`${d}/`), named(d)]);
  });
  it("a variable naming another dir is not this session's: ignored", () => {
    const d = path.join(home, ".claude-work");
    expect(keychainServices(d, path.join(home, ".claude-other"), home)).toEqual([named(d)]);
    const def = path.join(home, ".claude");
    expect(keychainServices(def, path.join(home, ".claude-other"), home)).toEqual([
      "Claude Code-credentials",
      named(def),
    ]);
  });
});

describe("usableToken", () => {
  it("is the access token of a sign-in that is good for more than a minute", () => {
    expect(usableToken(signIn(), NOW)).toBe(TOKEN);
    expect(usableToken(signIn({ expiresAt: undefined }), NOW)).toBe(TOKEN);
    expect(usableToken(signIn({ expiresAt: "soon" }), NOW)).toBe(TOKEN);
  });
  it("is null for no blob, a broken one, another shape, a bad token, or one about to expire", () => {
    expect(usableToken(null, NOW)).toBeNull();
    expect(usableToken("{not json", NOW)).toBeNull();
    expect(usableToken("null", NOW)).toBeNull();
    expect(usableToken(JSON.stringify({ claudeAiOauth: null }), NOW)).toBeNull();
    expect(usableToken(JSON.stringify({ other: 1 }), NOW)).toBeNull();
    expect(usableToken(signIn({ accessToken: 42 }), NOW)).toBeNull();
    expect(usableToken(signIn({ accessToken: "short" }), NOW)).toBeNull();
    expect(usableToken(signIn({ accessToken: `${TOKEN} injected` }), NOW)).toBeNull();
    expect(usableToken(signIn({ expiresAt: NOW + 30_000 }), NOW)).toBeNull();
    expect(usableToken(signIn({ expiresAt: NOW - 1 }), NOW)).toBeNull();
  });
});

describe("claudeToken", () => {
  const dir = () => path.join(home, ".claude-work");
  const now = () => NOW;
  it("a Mac reads the dir's Keychain item, by account first", () => {
    const security = vi.fn((args: string[]) => (args.includes("-a") ? signIn() : null));
    const env = { HOME: home, USER: "ana", CLAUDE_CONFIG_DIR: dir() };
    expect(claudeToken(dir(), env, { platform: "darwin", security, now })).toBe(TOKEN);
    expect(security).toHaveBeenCalledWith(["find-generic-password", "-a", "ana", "-s", named(dir()), "-w"]);
  });
  it("then without one, and LOGNAME stands in for USER", () => {
    const seen: string[][] = [];
    const security = (args: string[]) => {
      seen.push(args);
      return args.includes("-a") ? null : signIn();
    };
    expect(claudeToken(dir(), { HOME: home, LOGNAME: "bo" }, { platform: "darwin", security, now })).toBe(TOKEN);
    expect(seen).toEqual([
      ["find-generic-password", "-a", "bo", "-s", named(dir()), "-w"],
      ["find-generic-password", "-s", named(dir()), "-w"],
    ]);
  });
  it("with no user named, only the bare lookup runs; items are tried in order", () => {
    const def = path.join(home, ".claude");
    const security = vi.fn((args: string[]) => (args.includes(named(def)) ? signIn() : null));
    expect(claudeToken(def, { HOME: home }, { platform: "darwin", security, now })).toBe(TOKEN);
    expect(security.mock.calls.map((c) => c[0])).toEqual([
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      ["find-generic-password", "-s", named(def), "-w"],
    ]);
  });
  it("an expired item is not renewed, and not swapped for the file", () => {
    const readFile = vi.fn(() => signIn());
    const security = () => signIn({ expiresAt: NOW - 1 });
    expect(claudeToken(dir(), { HOME: home }, { platform: "darwin", security, readFile, now })).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
  });
  it("a Mac with no item, and every other system, reads <dir>/.credentials.json", () => {
    const readFile = vi.fn(() => signIn());
    expect(claudeToken(dir(), {}, { platform: "darwin", security: () => null, readFile, now })).toBe(TOKEN);
    expect(readFile).toHaveBeenCalledWith(path.join(dir(), ".credentials.json"));
    expect(claudeToken(dir(), {}, { platform: "linux", readFile, now })).toBe(TOKEN);
    const missing = () => {
      throw new Error("ENOENT");
    };
    expect(claudeToken(dir(), {}, { platform: "linux", readFile: missing, now })).toBeNull();
  });
  it("by default, the real file (and on a Mac, a Keychain with no such item first)", () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(path.join(dir(), ".credentials.json"), signIn({ expiresAt: Date.now() + 3_600_000 }));
    expect(claudeToken(dir(), { HOME: home })).toBe(TOKEN);
    expect(claudeToken(dir(), { HOME: home }, { platform: "darwin" })).toBe(TOKEN);
  });
});

describe("fetchRemoteTitle", () => {
  const deps = (fetch: typeof globalThis.fetch) => ({
    platform: "linux" as const,
    readFile: () => signIn(),
    fetch,
    now: () => NOW,
  });
  it("asks claude.ai for the session with the sign-in's token and its beta, and takes its title", async () => {
    const fetch = answer({ id: "session_01AbC", title: "  Session title\n discrepancy  " });
    expect(await fetchRemoteTitle("session_01AbC", home, {}, deps(fetch))).toBe("Session title discrepancy");
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${REMOTE_TITLE_URL}session_01AbC`);
    expect(init.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": REMOTE_TITLE_BETA,
      accept: "application/json",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("cuts a long title at 120 characters", async () => {
    const t = await fetchRemoteTitle("session_1", home, {}, deps(answer({ title: `${"word ".repeat(30)}end` })));
    expect(t).toBe("word ".repeat(24).trim());
  });
  it("is null, and asks nothing, for an id that is no claude.ai session or a dir with no usable sign-in", async () => {
    const fetch = answer({ title: "x" });
    expect(await fetchRemoteTitle("cse_01AbC", home, {}, deps(fetch))).toBeNull();
    expect(await fetchRemoteTitle("session_1/../x", home, {}, deps(fetch))).toBeNull();
    expect(await fetchRemoteTitle("session_1", home, {}, { ...deps(fetch), readFile: () => "{}" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("is null for a refusal, an answer with no title, or a failed call", async () => {
    expect(await fetchRemoteTitle("session_1", home, {}, deps(answer({ error: "not_found" }, 404)))).toBeNull();
    expect(await fetchRemoteTitle("session_1", home, {}, deps(answer(null)))).toBeNull();
    expect(await fetchRemoteTitle("session_1", home, {}, deps(answer({ title: 7 })))).toBeNull();
    expect(await fetchRemoteTitle("session_1", home, {}, deps(answer({ title: " \n " })))).toBeNull();
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchRemoteTitle("session_1", home, {}, deps(down))).toBeNull();
    const notJson = vi.fn(async () => new Response("<html>", { status: 200 }));
    expect(await fetchRemoteTitle("session_1", home, {}, deps(notJson))).toBeNull();
  });
  it("by default uses the global fetch", async () => {
    const fetch = answer({ title: "From the app" });
    vi.stubGlobal("fetch", fetch);
    expect(
      await fetchRemoteTitle("session_1", home, {}, { platform: "linux", readFile: () => signIn(), now: () => NOW }),
    ).toBe("From the app");
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("claudeCode.remoteFacts", () => {
  const SID = "ed6c7665-589f-40c7-b7b4-e38ee662b7bc";
  const LINK = "https://claude.ai/code/session_01N8ZGDLoGYbGjGkmmFPrm87";
  const file = () => path.join(home, ".claude-work", "projects", "-w-app", `${SID}.jsonl`);
  function memState(seed: Record<string, unknown> = {}): FactsState & { mem: Record<string, unknown>; keys: string[] } {
    const mem: Record<string, unknown> = { ...seed };
    const keys: string[] = [];
    return {
      mem,
      keys,
      get: (_h, s) => {
        keys.push(s);
        return mem;
      },
      save: (_h, _s, patch) => Object.assign(mem, patch),
    };
  }
  const facts: SessionFacts = {
    url: LINK,
    title: "Fix issue showing up in my accounts, http://intel/...",
    title_source: "first-ask",
  };
  const deps = (fetch: typeof globalThis.fetch, at = NOW) => ({
    platform: "linux" as const,
    readFile: () => signIn(),
    fetch,
    now: () => at,
  });
  const remote = (
    f: SessionFacts,
    state: FactsState,
    fetch: typeof globalThis.fetch,
    at = NOW,
    session: { id: string } = { id: SID },
  ) => remoteFacts(session, f, file(), state, {}, deps(fetch, at));

  it("takes the name the app shows, as harness, and remembers when it asked", async () => {
    const state = memState();
    const fetch = answer({ title: "test_claude_fleet health check failures" });
    expect(await remote(facts, state, fetch)).toEqual({
      ...facts,
      title: "test_claude_fleet health check failures",
      title_source: "harness",
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(`${REMOTE_TITLE_URL}session_01N8ZGDLoGYbGjGkmmFPrm87`);
    expect(state.mem).toEqual({ remote_title: "test_claude_fleet health check failures", remote_title_at: NOW });
    expect(state.keys).toEqual([SID]);
  });
  it("a name of Claude Code's own (an ai-title, a registry auto name) gives way too", async () => {
    const own = { ...facts, title: "Daily Maintenance list for 07:30", title_source: "harness" as const };
    expect((await remote(own, memState(), answer({ title: "Daily maintenance 26Oct26" }))).title).toBe(
      "Daily maintenance 26Oct26",
    );
  });
  it("leaves alone a session the person named, one with no claude.ai link, and one with no transcript", async () => {
    const fetch = answer({ title: "x" });
    const custom = { ...facts, title: "gyroscope-mini-bot", title_source: "custom" as const };
    expect(await remote(custom, memState(), fetch)).toBe(custom);
    const desktop = { ...facts, url: "claude://code/continue/local_1" };
    expect(await remote(desktop, memState(), fetch)).toBe(desktop);
    const cloud = { ...facts, url: "https://claude.ai/code/cse_01AbC" };
    expect(await remote(cloud, memState(), fetch)).toBe(cloud);
    const bare = { title: "ask", title_source: "first-ask" as const };
    expect(await remote(bare, memState(), fetch)).toBe(bare);
    expect(await remoteFacts({ id: SID }, facts, undefined, memState(), {}, deps(fetch))).toBe(facts);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("asks again ten minutes after a name, and keeps the last name when that fails", async () => {
    const state = memState({ remote_title: "Old name", remote_title_at: NOW });
    const fetch = vi.fn(async () => new Response("", { status: 503 }));
    const soon = await remote(facts, state, fetch, NOW + REMOTE_TITLE_REFRESH_MS - 1);
    expect(soon.title).toBe("Old name");
    expect(fetch).not.toHaveBeenCalled();
    const later = await remote(facts, state, fetch, NOW + REMOTE_TITLE_REFRESH_MS);
    expect(later).toMatchObject({ title: "Old name", title_source: "harness" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(state.mem.remote_title_at).toBe(NOW + REMOTE_TITLE_REFRESH_MS);
  });
  it("with no name yet, asks again after a minute, and sends the files' title meanwhile", async () => {
    const state = memState({ remote_title: null, remote_title_at: NOW });
    const fetch = answer({ title: "" });
    expect(await remote(facts, state, fetch, NOW + REMOTE_TITLE_RETRY_MS - 1)).toBe(facts);
    expect(fetch).not.toHaveBeenCalled();
    expect(await remote(facts, state, fetch, NOW + REMOTE_TITLE_RETRY_MS)).toBe(facts);
    expect(fetch).toHaveBeenCalledOnce();
    expect(state.mem).toEqual({ remote_title: null, remote_title_at: NOW + REMOTE_TITLE_RETRY_MS });
  });
  it("files its memory under the transcript's id when the session's is empty", async () => {
    const state = memState();
    await remote(facts, state, answer({ title: "t" }), NOW, { id: "" });
    expect(state.keys).toEqual([SID]);
  });
  it("by default asks with the process's env and clock (a fresh name: nothing to ask)", async () => {
    const state = memState({ remote_title: "Fresh", remote_title_at: Date.now() });
    expect(await remoteFacts({ id: SID }, facts, file(), state)).toMatchObject({
      title: "Fresh",
      title_source: "harness",
    });
  });
});
