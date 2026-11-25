// SPDX-License-Identifier: Apache-2.0
// The Claude Code pool adapter: limit headers and the usage endpoint into windows,
// metadata.user_id read and rewritten byte-for-byte, the headers a request carries
// upstream, PKCE sign-in / refresh / profile / usage over an injected fetch, and Claude
// Code's own logins read through an injected `security` and a sandbox home. Nothing
// here touches the network or the real keychain.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginLogin,
  completeLogin,
  fetchProfile,
  fetchUsage,
  importableLogins,
  keychainService,
  POOL_ENDPOINTS,
  PoolAuthError,
  PoolUpstreamError,
  parseUserId,
  readLimits,
  refreshCredential,
  upstreamHeaders,
  usageLimits,
  withAccount,
} from "../src/adapters/claude-code-pool.js";
import { claudePool } from "../src/index.js";
import { redactSecrets } from "../src/privacy/secrets.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = <T = Record<string, Record<string, string>>>(name: string): T =>
  JSON.parse(readFileSync(path.join(fixtures, `claude-pool-${name}.json`), "utf8")) as T;
const HEADERS = fixture("headers");
const USAGE = fixture<Record<string, unknown>>("usage");
const OAUTH = fixture<Record<string, unknown>>("oauth");
const CREDS = fixture<Record<string, unknown>>("credentials");
const BODIES = fixture<Record<string, string>>("bodies");
const NOW = 1_761_700_000_000;
const ACCOUNT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER = "99999999-8888-4777-8666-555555555555";
const SESSION = "12345678-1234-4123-8123-123456789abc";

describe("readLimits: the account's windows from a response's headers", () => {
  it("reads 5h and 7d as five_hour and seven_day, utilization as a percent to one decimal", () => {
    expect(readLimits(HEADERS.allowed!, NOW)).toEqual({
      windows: [
        { id: "five_hour", used_percent: 23.7, resets_at: "2025-10-29T11:40:00.000Z", window_minutes: 300 },
        { id: "seven_day", used_percent: 61.5, resets_at: "2025-11-03T11:00:00.000Z", window_minutes: 10080 },
      ],
      status: "allowed",
      observed_at: NOW,
    });
  });
  it("takes a Headers object too, and array or missing values in a record", () => {
    expect(readLimits(new Headers(HEADERS.allowed!), NOW)).toEqual(readLimits(HEADERS.allowed!, NOW));
    const r = readLimits(
      {
        "Anthropic-RateLimit-Unified-5h-Utilization": ["0.5", "0.9"],
        "anthropic-ratelimit-unified-5h-reset": undefined,
        "anthropic-ratelimit-unified-reset": "2025-10-29T12:20:00+02:00",
        "anthropic-ratelimit-unified-7d-reset": "1761738000.5",
        "anthropic-ratelimit-unified-7d-utilization": "0.1",
        "anthropic-ratelimit-unified-7d_opus-utilization": "0.2",
        "anthropic-ratelimit-unified-7d_opus-reset": "2025-99-99T99:99:99Z",
      },
      NOW,
    );
    expect(r).toEqual({
      windows: [
        { id: "five_hour", used_percent: 50, window_minutes: 300 },
        { id: "seven_day", used_percent: 10, resets_at: "2025-10-29T11:40:00.500Z", window_minutes: 10080 },
        { id: "seven_day_opus", used_percent: 20 },
      ],
      resets_at: "2025-10-29T10:20:00.000Z",
      observed_at: NOW,
    });
  });
  it("keeps a per-model 7d window under its own id, with no known length", () => {
    const r = readLimits(HEADERS.warning_with_model_window!, NOW)!;
    expect(r.status).toBe("allowed_warning");
    expect(r.windows.map((w) => [w.id, w.used_percent, w.window_minutes])).toEqual([
      ["five_hour", 90, 300],
      ["seven_day", 40, 10080],
      ["seven_day_opus", 96.1, undefined],
    ]);
  });
  it("7d_oi is Fable's weekly limit: seven_day_fable, so the usage endpoint and every receiver name it the same", () => {
    expect(readLimits(HEADERS.fable_window!, NOW)).toEqual({
      windows: [
        { id: "five_hour", used_percent: 12, resets_at: "2025-10-29T11:40:00.000Z", window_minutes: 300 },
        { id: "seven_day", used_percent: 40, resets_at: "2025-11-03T11:00:00.000Z", window_minutes: 10080 },
        { id: "seven_day_fable", used_percent: 33.5, resets_at: "2025-11-03T11:00:00.000Z" },
      ],
      status: "allowed",
      observed_at: NOW,
    });
    // Any other model's part keeps the id it always had.
    expect(
      readLimits({ "anthropic-ratelimit-unified-7d_sonnet-utilization": "0.5" }, NOW)!.windows.map((w) => w.id),
    ).toEqual(["seven_day_sonnet"]);
  });
  it("a refusal by the Fable limit names seven_day_fable, not Claude Code's own key for it", () => {
    expect(readLimits(HEADERS.rejected_fable!, NOW)).toMatchObject({
      status: "rejected",
      claim: "seven_day_fable",
      resets_at: "2025-11-03T11:00:00.000Z",
      windows: [{ id: "five_hour" }, { id: "seven_day" }, { id: "seven_day_fable", used_percent: 100 }],
    });
  });
  it("one header part per window: 7d_oi and a 7d_fable beside it are not mixed, the fuller is taken whole", () => {
    const P = "anthropic-ratelimit-unified-";
    expect(
      readLimits(
        {
          [`${P}7d_oi-utilization`]: "0.2",
          [`${P}7d_fable-utilization`]: "0.9",
          [`${P}7d_oi-reset`]: "1764583200",
          [`${P}7d_fable-reset`]: "1",
        },
        NOW,
      )!.windows,
    ).toEqual([{ id: "seven_day_fable", used_percent: 90, resets_at: "1970-01-01T00:00:01.000Z" }]);
    // In either order; a part with no utilization is no window, and a tie keeps the first.
    expect(
      readLimits(
        {
          [`${P}7d_fable-utilization`]: "0.2",
          [`${P}7d_oi-utilization`]: "1",
          [`${P}7d_oi-reset`]: "1764583200",
          [`${P}7d_x-reset`]: "1",
          [`${P}7d-utilization`]: "0.5",
          [`${P}7d-reset`]: "1",
        },
        NOW,
      )!.windows.map((w) => [w.id, w.used_percent, w.resets_at]),
    ).toEqual([
      ["seven_day_fable", 100, "2025-12-01T10:00:00.000Z"],
      ["seven_day", 50, "1970-01-01T00:00:01.000Z"],
    ]);
  });
  it("a time past the year 9999 is no time: the wire spells four digits", () => {
    expect(
      readLimits(
        {
          "anthropic-ratelimit-unified-7d-utilization": "0.1",
          "anthropic-ratelimit-unified-7d-reset": "9999-12-31T23:59:59-01:00",
        },
        NOW,
      )!.windows,
    ).toEqual([{ id: "seven_day", used_percent: 10, window_minutes: 10080 }]);
  });
  it("a claim that names something on the object prototype is that word, nothing inherited", () => {
    for (const c of ["constructor", "__proto__", "tostring"])
      expect(readLimits({ "anthropic-ratelimit-unified-representative-claim": c }, NOW)?.claim).toBe(c);
  });
  it("on a refusal names the window that refused and when it resets", () => {
    expect(readLimits(HEADERS.rejected!, NOW)).toMatchObject({
      status: "rejected",
      claim: "five_hour",
      resets_at: "2025-10-29T11:40:00.000Z",
      windows: [
        { id: "five_hour", used_percent: 100 },
        { id: "seven_day", used_percent: 72 },
      ],
    });
  });
  it("a status alone is kept; garbage values are dropped one by one; no header at all is null", () => {
    expect(readLimits(HEADERS.status_only!, NOW)).toEqual({ windows: [], status: "allowed", observed_at: NOW });
    expect(readLimits(HEADERS.garbage!, NOW)).toEqual({ windows: [], observed_at: NOW });
    expect(readLimits(HEADERS.none!, NOW)).toBeNull();
    expect(readLimits({}, NOW)).toBeNull();
  });
});

describe("usageLimits: the usage endpoint's JSON", () => {
  it("reads every window-shaped key, utilization already a percent, resets_at in either form", () => {
    expect(usageLimits(USAGE.typical, NOW)).toEqual({
      windows: [
        { id: "five_hour", used_percent: 23.7, resets_at: "2025-10-29T12:00:00.000Z", window_minutes: 300 },
        { id: "seven_day", used_percent: 61.5, resets_at: "2025-11-03T11:00:00.000Z", window_minutes: 10080 },
        { id: "seven_day_opus", used_percent: 12, resets_at: "2025-11-03T11:00:00.000Z" },
      ],
      observed_at: NOW,
    });
  });
  it("judges on the top-level windows as it always did; shows each model's week from the lists after the week's own", () => {
    const sonnet = { id: "seven_day_sonnet", used_percent: 17, resets_at: "2025-11-03T11:00:00.000Z" };
    const five = { id: "five_hour", used_percent: 8, resets_at: "2025-10-29T12:00:00.000Z", window_minutes: 300 };
    const week = { id: "seven_day", used_percent: 41, resets_at: "2025-11-03T11:00:00.000Z", window_minutes: 10080 };
    expect(usageLimits(USAGE.per_model, NOW)).toEqual({
      windows: [five, week, sonnet, { id: "extra_usage", used_percent: 12.5 }],
      shown: [
        five,
        week,
        // The top-level key wins over the list's row for the same model (17, not 16).
        sonnet,
        { id: "seven_day_fable", used_percent: 33.5, resets_at: "2025-11-03T11:00:00.000Z" },
        { id: "seven_day_opus_5_5", used_percent: 62, resets_at: "2025-11-03T11:00:00.000Z" },
        { id: "extra_usage", used_percent: 12.5 },
      ],
      names: { seven_day_fable: "Fable", seven_day_opus_5_5: "Opus 5.5" },
      observed_at: NOW,
    });
  });
  it("reads model_scoped rows too, the list's row winning; any Fable is seven_day_fable, first; no reset is no reset", () => {
    expect(usageLimits(USAGE.model_scoped_only, NOW)).toEqual({
      windows: [{ id: "five_hour", used_percent: 1, window_minutes: 300 }],
      shown: [
        { id: "five_hour", used_percent: 1, window_minutes: 300 },
        { id: "seven_day_fable", used_percent: 100 },
        { id: "seven_day_opus_5_5", used_percent: 70, resets_at: "2025-11-03T11:00:00.000Z" },
      ],
      names: { seven_day_fable: "Fable 5.1", seven_day_opus_5_5: "Opus 5.5" },
      observed_at: NOW,
    });
    // Only lists: nothing to judge, the rows to show; a name keeps its words, not its control characters.
    expect(
      usageLimits(
        {
          limits: [
            { kind: "weekly_scoped", percent: 5, scope: { model: { display_name: " Haiku\u0007 \n 4 " } } },
            { kind: "weekly_scoped", percent: 6, resets_at: null, scope: { model: { display_name: "fable" } } },
            // Accents go before the id is made; the name keeps them.
            { kind: "weekly_scoped", percent: 7, scope: { model: { display_name: "Ópus 5.5" } } },
          ],
        },
        NOW,
      ),
    ).toEqual({
      windows: [],
      shown: [
        { id: "seven_day_fable", used_percent: 6 },
        { id: "seven_day_haiku_4", used_percent: 5 },
        { id: "seven_day_opus_5_5", used_percent: 7 },
      ],
      names: { seven_day_fable: "fable", seven_day_haiku_4: "Haiku 4", seven_day_opus_5_5: "Ópus 5.5" },
      observed_at: NOW,
    });
  });
  it("judges on the first eight as always; shows all, Fable's week first among the lists' rows", () => {
    const keys = Object.fromEntries("abcdefgh".split("").map((k, i) => [k, { utilization: i }]));
    const r = usageLimits(
      {
        ...keys,
        seven_day: { utilization: 50 },
        limits: [{ kind: "weekly_scoped", percent: 20, scope: { model: { display_name: "Fable" } } }],
      },
      NOW,
    )!;
    // Judged: the first eight, as always.
    expect(r.windows.map((w) => w.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    // Shown: all, in order; which eight an account shows is the pool's cut (policy).
    expect(r.shown?.map((w) => w.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "seven_day", "seven_day_fable"]);
    // Six top-level limits, Extra usage, and three models' rows: Fable's goes first among them.
    const crowd = usageLimits(
      {
        five_hour: { utilization: 1 },
        seven_day: { utilization: 1 },
        seven_day_opus: { utilization: 1 },
        seven_day_sonnet: { utilization: 1 },
        seven_day_oauth_apps: { utilization: 1 },
        seven_day_cowork: { utilization: 1 },
        extra_usage: { utilization: 100, is_enabled: true },
        limits: ["Opus 5.5", "Sonnet 4.6", "Fable"].map((name) => ({
          kind: "weekly_scoped",
          percent: 1,
          scope: { model: { display_name: name } },
        })),
      },
      NOW,
    )!;
    expect(crowd.windows.map((w) => w.id)).toContain("extra_usage");
    expect(crowd.shown?.map((w) => w.id)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "seven_day_sonnet",
      "seven_day_oauth_apps",
      "seven_day_cowork",
      "seven_day_fable",
      "seven_day_opus_5_5",
      "seven_day_sonnet_4_6",
      "extra_usage",
    ]);
    expect(crowd.names).toEqual({
      seven_day_fable: "Fable",
      seven_day_opus_5_5: "Opus 5.5",
      seven_day_sonnet_4_6: "Sonnet 4.6",
    });
  });
  it("reads 64 rows of a list at most, each id once, quickly", () => {
    const row = (name: string) => ({ kind: "weekly_scoped", percent: 1, scope: { model: { display_name: name } } });
    const many = Array.from({ length: 20_000 }, (_, i) => row(`Model ${i % 70}`));
    const t0 = performance.now();
    const r = usageLimits({ five_hour: { utilization: 1 }, limits: many }, NOW)!;
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.shown).toHaveLength(65);
    // Row 64 and after are not read: Fable there is not shown.
    const late = usageLimits({ limits: [...Array.from({ length: 64 }, () => row("Same")), row("Fable")] }, NOW)!;
    expect(late.shown?.map((w) => w.id)).toEqual(["seven_day_same"]);
  });
  it("a key from the wire finds nothing on the object prototype", () => {
    const r = usageLimits(
      JSON.parse('{"__proto__":{"utilization":5},"constructor":{"utilization":6},"toString":{"utilization":7}}'),
      NOW,
    )!;
    expect(r.windows).toEqual([
      { id: "__proto__", used_percent: 5 },
      { id: "constructor", used_percent: 6 },
    ]);
  });
  it("skips what is not a window, judges on eight at most, and is null with none", () => {
    const r = usageLimits(USAGE.odd, NOW)!;
    // Judged as it always was: every top-level key shaped like a window, the first eight.
    expect(r.windows.map((w) => w.id)).toEqual(["seven_day", "model_scoped", "a", "b", "c", "d", "e", "f"]);
    expect(r.windows[0]).toEqual({ id: "seven_day", used_percent: 150, window_minutes: 10080 });
    // Shown: all of those (what is judged is always shown); no row of its limits list is a
    // model's weekly limit, and model_scoped is no list of rows here.
    expect(r.shown?.map((w) => w.id)).toEqual([
      "seven_day",
      "model_scoped",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
    ]);
    expect(r.names).toBeUndefined();
    expect(
      usageLimits(
        { five_hour: { utilization: 1, resets_at: 1762167600000 }, x: { utilization: 2, resets_at: 0 } },
        NOW,
      ),
    ).toEqual({
      windows: [
        { id: "five_hour", used_percent: 1, window_minutes: 300 },
        { id: "x", used_percent: 2 },
      ],
      observed_at: NOW,
    });
    expect(usageLimits(USAGE.empty, NOW)).toBeNull();
    expect(usageLimits(null, NOW)).toBeNull();
    expect(usageLimits([USAGE.typical], NOW)).toBeNull();
    expect(usageLimits("five_hour", NOW)).toBeNull();
  });
});

describe("the pool's answers in conformance/remote/claude-code (pool-*.json, made up in the shapes Claude Code reads)", () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../conformance/remote/claude-code");
  const files = readdirSync(dir).filter((f) => f.startsWith("pool-") && f.endsWith(".json"));
  it("has the usage answer and the header set for Fable", () => {
    expect(files.sort()).toEqual(["pool-headers-fable.json", "pool-usage-fable.json"]);
  });
  it.each(files)("%s", (f) => {
    const fx = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as {
      made_up: string;
      request: { method: string; path: string };
      response: { status: number; body?: unknown; headers?: Record<string, string> };
      expect: { windows: unknown[]; shown?: unknown[]; names?: Record<string, string>; status?: string };
    };
    expect(fx.made_up).toMatch(/^NOT a recording/);
    if (fx.response.headers) {
      expect(readLimits(fx.response.headers, NOW)).toEqual({
        windows: fx.expect.windows,
        status: fx.expect.status,
        observed_at: NOW,
      });
      return;
    }
    expect(fx.request).toEqual({ method: "GET", path: new URL(POOL_ENDPOINTS.usage).pathname });
    expect(usageLimits(fx.response.body, NOW)).toEqual({
      windows: fx.expect.windows,
      shown: fx.expect.shown,
      names: fx.expect.names,
      observed_at: NOW,
    });
  });
});

describe("parseUserId: who a request body says it is", () => {
  it("reads the JSON form Claude Code 2.1 sends, from bytes or a parsed body", () => {
    expect(parseUserId(Buffer.from(BODIES.json_form!))).toEqual({ session: SESSION, account: ACCOUNT });
    expect(parseUserId(JSON.parse(BODIES.json_form!))).toEqual({ session: SESSION, account: ACCOUNT });
    expect(parseUserId(BODIES.no_account!)).toEqual({ session: SESSION });
  });
  it("reads the older user_<hash>_account_<uuid>_session_<uuid> form", () => {
    expect(parseUserId(BODIES.legacy_form!)).toEqual({ session: SESSION, account: ACCOUNT });
    expect(parseUserId({ metadata: { user_id: `user_x_session_${SESSION}` } })).toEqual({ session: SESSION });
    expect(parseUserId({ metadata: { user_id: `account_${ACCOUNT}` } })).toEqual({ account: ACCOUNT });
  });
  it("is null with no user_id and empty with one it cannot read", () => {
    expect(parseUserId(BODIES.no_metadata!)).toBeNull();
    expect(parseUserId(Buffer.from("not json"))).toBeNull();
    expect(parseUserId(null)).toBeNull();
    expect(parseUserId({ metadata: { user_id: 7 } })).toBeNull();
    expect(parseUserId({ metadata: { user_id: `{"x":${"1".repeat(5000)}}` } })).toBeNull();
    expect(parseUserId({ metadata: { user_id: "{oops" } })).toEqual({});
    expect(parseUserId({ metadata: { user_id: '{"account_uuid":"nope","session_id":""}' } })).toEqual({});
    expect(parseUserId({ metadata: { user_id: "plain" } })).toEqual({});
  });
});

describe("withAccount: the account part rewritten in place", () => {
  const onlyUuidMoved = (before: string, after: Buffer) => {
    const a = after.toString("utf8");
    expect(a).toBe(before.replace(ACCOUNT, OTHER));
    expect(a.length).toBe(before.length);
    expect(parseUserId(after)!.account).toBe(OTHER);
  };
  it("rewrites the JSON form and leaves every other byte, number form and escape included", () => {
    onlyUuidMoved(BODIES.json_form!, withAccount(Buffer.from(BODIES.json_form!), OTHER));
    expect(BODIES.json_form).toContain("1e-7");
  });
  it("rewrites the older form", () => {
    onlyUuidMoved(BODIES.legacy_form!, withAccount(Buffer.from(BODIES.legacy_form!), OTHER));
  });
  it("picks metadata's user_id, not one quoted inside a message", () => {
    const out = withAccount(Buffer.from(BODIES.user_id_twice!), OTHER);
    onlyUuidMoved(BODIES.user_id_twice!, out);
    expect(out.toString()).toContain('{\\"user_id\\":\\"x\\"}');
  });
  it("a twin user_id literal earlier in the body (a tool's schema) never takes metadata's place", () => {
    const id = `user_h_account_${ACCOUNT}_session_11111111-2222-4333-8444-555555555555`;
    const twin = `{"tools":[{"input_schema":{"user_id":"${id}"}}],"metadata":{"user_id":"${id}"}}`;
    const out = JSON.parse(withAccount(Buffer.from(twin), OTHER).toString()) as {
      tools: { input_schema: { user_id: string } }[];
      metadata: { user_id: string };
    };
    expect(parseUserId(Buffer.from(JSON.stringify(out)))!.account).toBe(OTHER);
    expect(out.tools[0]!.input_schema.user_id).toBe(id);
  });
  it("N2: Claude Code 2.1.312 under ANTHROPIC_AUTH_TOKEN sends an empty account_uuid; the slot is filled", () => {
    // The exact shape from the live proof's calls.jsonl (device id and session as recorded).
    const inner =
      '{"device_id":"652db2c0e1f24b7a9d3e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708","account_uuid":"","session_id":"155a60bd-f887-4961-8776-0a11db10fa12"}';
    const body = JSON.stringify({
      model: "claude-opus-5-5",
      max_tokens: 32000,
      messages: [{ role: "user", content: "Reply with the single word pooled." }],
      metadata: { user_id: inner },
      stream: true,
    });
    const out = withAccount(Buffer.from(body), OTHER);
    expect(parseUserId(out)).toEqual({ session: "155a60bd-f887-4961-8776-0a11db10fa12", account: OTHER });
    expect(out.toString()).toBe(body.replace('\\"account_uuid\\":\\"\\"', `\\"account_uuid\\":\\"${OTHER}\\"`));
    expect(out.length).toBe(body.length + OTHER.length);
    // The same, with a twin literal in a tool schema: structural, metadata's slot filled.
    const twin = `{"tools":[{"input_schema":{"user_id":${JSON.stringify(inner)}}}],"metadata":{"user_id":${JSON.stringify(inner)}}}`;
    const t = JSON.parse(withAccount(Buffer.from(twin), OTHER).toString()) as { metadata: { user_id: string } };
    expect(JSON.parse(t.metadata.user_id)).toMatchObject({
      account_uuid: OTHER,
      session_id: "155a60bd-f887-4961-8776-0a11db10fa12",
    });
    // A JSON form with no account key at all, or the legacy form with none: left alone.
    const noKey = Buffer.from(JSON.stringify({ metadata: { user_id: '{"device_id":"d","session_id":"s"}' } }));
    expect(withAccount(noKey, OTHER)).toBe(noKey);
    const broken = Buffer.from(JSON.stringify({ metadata: { user_id: "{oops" } }));
    expect(withAccount(broken, OTHER)).toBe(broken);
  });
  it("returns the same bytes when there is nothing to do", () => {
    const same = (text: string, to = OTHER) => {
      const b = Buffer.from(text);
      expect(withAccount(b, to)).toBe(b);
    };
    same(BODIES.json_form!, ACCOUNT.toUpperCase()); // already that account
    same(BODIES.json_form!, "not-a-uuid");
    same(BODIES.no_account!);
    same(BODIES.no_metadata!);
    same("not json at all");
    same(BODIES.escaped_literal!); // escaped another way: left alone, not guessed at
  });
});

describe("upstreamHeaders: what goes to Anthropic", () => {
  it("drops hop-by-hop, host, length, our token and any key; sets the bearer and the beta", () => {
    const h = upstreamHeaders(
      {
        Host: "127.0.0.1:7474",
        "content-length": "12",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        te: "trailers",
        trailer: "x",
        upgrade: "h2c",
        "proxy-authorization": "Basic abc",
        "proxy-connection": "close",
        authorization: "Bearer pool-token-FAKE",
        "x-api-key": "sk-ant-api03-FAKE",
        "content-type": "application/json",
        "x-stainless-lang": ["js", "ts"],
        "user-agent": undefined,
        "anthropic-version": "2023-06-01",
      },
      "sk-ant-oat01-ACCESS",
    );
    expect(h).toEqual({
      "content-type": "application/json",
      "x-stainless-lang": "js, ts",
      "anthropic-version": "2023-06-01",
      authorization: "Bearer sk-ant-oat01-ACCESS",
      "anthropic-beta": POOL_ENDPOINTS.beta,
    });
  });
  it("appends the OAuth beta to a list and leaves one that has it", () => {
    expect(
      upstreamHeaders({ "anthropic-beta": "fine-grained-tool-streaming-2025-05-14, context-1m" }, "t")[
        "anthropic-beta"
      ],
    ).toBe("fine-grained-tool-streaming-2025-05-14,context-1m,oauth-2025-04-20");
    expect(upstreamHeaders({ "Anthropic-Beta": "oauth-2025-04-20" }, "t")["anthropic-beta"]).toBe("oauth-2025-04-20");
  });
});

describe("beginLogin: PKCE as Claude Code builds it", () => {
  it("builds the URL from the verifier's S256 challenge, parameters in Claude Code's order", () => {
    const random = (n: number) => Buffer.alloc(n, 7);
    const { url, verifier, state } = beginLogin(random);
    expect(verifier).toBe(Buffer.alloc(32, 7).toString("base64url"));
    expect(verifier.length).toBe(43);
    expect(state).toBe(verifier);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(POOL_ENDPOINTS.authorize);
    expect([...u.searchParams.entries()]).toEqual([
      ["code", "true"],
      ["client_id", POOL_ENDPOINTS.clientId],
      ["response_type", "code"],
      ["redirect_uri", POOL_ENDPOINTS.callback],
      [
        "scope",
        "user:inference user:profile org:create_api_key user:sessions:claude_code user:mcp_servers user:file_upload",
      ],
      ["code_challenge", challenge],
      ["code_challenge_method", "S256"],
      ["state", state],
    ]);
  });
  it("uses real randomness by default: two logins never share a verifier", () => {
    const a = beginLogin();
    const b = beginLogin();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(a.verifier);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

/** A fetch that answers from a script and remembers what it was asked. */
function fakeFetch(...answers: (unknown | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const res = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const a = answers.shift();
    if (a instanceof Error) throw a;
    const [status, body] = a as [number, unknown];
    return res(status, body);
  }) as typeof fetch;
  return { fetch: f, calls };
}
const PENDING = { verifier: "v".repeat(43), state: "state-FAKE" };
const now = () => NOW;

describe("completeLogin: the pasted code for a credential and whose it is", () => {
  it("exchanges code#state with Claude Code's request, then reads the profile", async () => {
    const { fetch, calls } = fakeFetch([200, OAUTH.token], [200, OAUTH.profile]);
    const { credential, profile } = await completeLogin("  the-code#state-FAKE ", PENDING, fetch, now);
    const token = OAUTH.token as { access_token: string; refresh_token: string };
    expect(credential).toEqual({
      access: token.access_token,
      refresh: token.refresh_token,
      expires_at: NOW + 28_800_000,
    });
    expect(profile).toEqual({ account_uuid: ACCOUNT, email: "pool-one@example.com", org: "Example Org", plan: "max" });
    expect(calls[0]!.url).toBe(POOL_ENDPOINTS.token);
    expect(calls[0]!.init!.method).toBe("POST");
    expect(calls[0]!.init!.headers).toEqual({
      "content-type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      state: "state-FAKE",
      client_id: POOL_ENDPOINTS.clientId,
      redirect_uri: POOL_ENDPOINTS.callback,
      code_verifier: PENDING.verifier,
    });
    expect(calls[1]!.url).toBe(POOL_ENDPOINTS.profile);
    expect(calls[1]!.init!.headers).toEqual({
      authorization: `Bearer ${token.access_token}`,
      "anthropic-beta": "oauth-2025-04-20",
    });
  });
  it("takes a bare code, a code with an empty state, or the callback URL itself", async () => {
    for (const pasted of [
      "the-code",
      "the-code#",
      `${POOL_ENDPOINTS.callback}?code=the-code&state=state-FAKE`,
      `${POOL_ENDPOINTS.callback}?code=the-code`,
    ]) {
      const { fetch, calls } = fakeFetch([200, OAUTH.token], [200, OAUTH.profile_bare]);
      const { profile } = await completeLogin(pasted, PENDING, fetch, now);
      expect(JSON.parse(calls[0]!.init!.body as string).code).toBe("the-code");
      expect(profile).toEqual({ account_uuid: ACCOUNT, email: "pool-one@example.com" });
    }
  });
  it("refuses a paste that is empty, another login's, or a URL with no code, before any request", async () => {
    const bad: [string, string][] = [
      ["", "Paste the code"],
      ["#state-FAKE", "Paste the code"],
      ["the-code#other", "another sign-in"],
      [`${POOL_ENDPOINTS.callback}?code=x&state=other`, "another sign-in"],
      [`${POOL_ENDPOINTS.callback}?state=state-FAKE`, "no code"],
      ["https://", "not the sign-in page"],
    ];
    for (const [pasted, msg] of bad) {
      const { fetch, calls } = fakeFetch();
      await expect(completeLogin(pasted, PENDING, fetch, now)).rejects.toThrow(PoolAuthError);
      await expect(completeLogin(pasted, PENDING, fetch, now)).rejects.toThrow(msg);
      expect(calls).toHaveLength(0);
    }
  });
  it("a 4xx is the person's problem, a 5xx or a dead wire is Anthropic's, and a tokenless answer is too", async () => {
    await expect(completeLogin("c", PENDING, fakeFetch([401, { error: "invalid_grant" }]).fetch, now)).rejects.toThrow(
      PoolAuthError,
    );
    await expect(completeLogin("c", PENDING, fakeFetch([503, "down"]).fetch, now)).rejects.toThrow(PoolUpstreamError);
    await expect(completeLogin("c", PENDING, fakeFetch(new Error("ECONNRESET")).fetch, now)).rejects.toThrow(
      /sign-in: ECONNRESET/,
    );
    await expect(completeLogin("c", PENDING, fakeFetch(new Error("")).fetch, now)).rejects.toThrow(/no answer/);
    await expect(completeLogin("c", PENDING, fakeFetch([200, "<html>"]).fetch, now)).rejects.toThrow(/no token/);
    await expect(completeLogin("c", PENDING, fakeFetch([200, OAUTH.token_without_refresh]).fetch, now)).rejects.toThrow(
      PoolUpstreamError,
    );
  });
});

describe("refreshCredential", () => {
  const cred = { access: "old", refresh: "sk-ant-ort01-OLD", expires_at: NOW };
  it("posts the refresh grant and keeps the old refresh token when the answer has none", async () => {
    const { fetch, calls } = fakeFetch([200, OAUTH.token_without_refresh]);
    const fresh = await refreshCredential(cred, fetch, now);
    expect(fresh).toEqual({
      access: (OAUTH.token_without_refresh as { access_token: string }).access_token,
      refresh: cred.refresh,
      expires_at: NOW + 28_800_000,
    });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      grant_type: "refresh_token",
      refresh_token: cred.refresh,
      client_id: POOL_ENDPOINTS.clientId,
    });
    const rotated = await refreshCredential(cred, fakeFetch([200, OAUTH.token]).fetch, now);
    expect(rotated.refresh).toBe((OAUTH.token as { refresh_token: string }).refresh_token);
  });
  it("400 and 401 mean sign in again; anything else is temporary", async () => {
    await expect(refreshCredential(cred, fakeFetch([400, {}]).fetch, now)).rejects.toThrow(PoolAuthError);
    await expect(refreshCredential(cred, fakeFetch([401, {}]).fetch, now)).rejects.toThrow(/sign in again/);
    await expect(refreshCredential(cred, fakeFetch([429, {}]).fetch, now)).rejects.toThrow(PoolUpstreamError);
    await expect(refreshCredential(cred, fakeFetch(new Error("ETIMEDOUT")).fetch, now)).rejects.toThrow(
      PoolUpstreamError,
    );
  });
});

describe("fetchProfile and fetchUsage", () => {
  it("profile: 401/403 is a dead token, other failures and a shapeless answer are upstream's", async () => {
    await expect(fetchProfile("t", fakeFetch([403, {}]).fetch)).rejects.toThrow(PoolAuthError);
    await expect(fetchProfile("t", fakeFetch([500, {}]).fetch)).rejects.toThrow(PoolUpstreamError);
    await expect(fetchProfile("t", fakeFetch([200, OAUTH.profile_broken]).fetch)).rejects.toThrow(/whose token/);
    await expect(fetchProfile("t", fakeFetch([200, null]).fetch)).rejects.toThrow(PoolUpstreamError);
    await expect(fetchProfile("t", fakeFetch(new Error("EAI_AGAIN")).fetch)).rejects.toThrow(/profile: EAI_AGAIN/);
  });
  it("usage: the windows, null when there are none, the same error split", async () => {
    const { fetch, calls } = fakeFetch([200, USAGE.typical]);
    expect((await fetchUsage("t", fetch, now))!.windows).toHaveLength(3);
    expect(calls[0]!.url).toBe(POOL_ENDPOINTS.usage);
    expect(await fetchUsage("t", fakeFetch([200, USAGE.empty]).fetch, now)).toBeNull();
    await expect(fetchUsage("t", fakeFetch([401, {}]).fetch, now)).rejects.toThrow(PoolAuthError);
    await expect(fetchUsage("t", fakeFetch([502, ""]).fetch, now)).rejects.toThrow(PoolUpstreamError);
    await expect(fetchUsage("t", fakeFetch(new Error("")).fetch, now)).rejects.toThrow(/usage: no answer/);
  });
});

describe("importableLogins: Claude Code's own logins on this machine", () => {
  let home: string;
  const dirs: string[] = [];
  const makeHome = () => {
    home = mkdtempSync(path.join(os.tmpdir(), "sp-pool-"));
    dirs.push(home);
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(home, ".claude-work"), { recursive: true });
    writeFileSync(path.join(home, ".claude-work", "settings.json"), "{}");
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify(CREDS.claude_json));
    writeFileSync(path.join(home, ".claude-work", ".claude.json"), JSON.stringify(CREDS.claude_json_two));
    return { HOME: home, USER: "misha" } as NodeJS.ProcessEnv;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const keychain = JSON.stringify(CREDS.keychain);
  const expectKeychainCred = {
    access: (CREDS.keychain as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken,
    refresh: (CREDS.keychain as { claudeAiOauth: { refreshToken: string } }).claudeAiOauth.refreshToken,
    expires_at: 1_761_765_600_000,
  };

  it("on a Mac asks `security` per config dir, by service and the login user, and reads who from .claude.json", () => {
    const env = makeHome();
    const asked: string[][] = [];
    const work = path.join(home, ".claude-work");
    const exec = (cmd: string, args: string[]) => {
      asked.push([cmd, ...args]);
      if (args[2] === "Claude Code-credentials") return `${keychain}\n`;
      if (args[2] === keychainService(work, home) && !args.includes("-a")) return keychain;
      throw new Error("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.");
    };
    const logins = importableLogins(env, exec, undefined, "darwin");
    expect(logins).toEqual([
      {
        dir: path.join(home, ".claude"),
        credential: expectKeychainCred,
        account_uuid: ACCOUNT,
        email: "pool-one@example.com",
        source: "keychain",
      },
      {
        dir: work,
        credential: expectKeychainCred,
        account_uuid: "ffffffff-0000-4111-8222-333333333333",
        source: "keychain",
      },
    ]);
    const suffix = createHash("sha256").update(work).digest("hex").slice(0, 8);
    expect(asked).toEqual([
      ["security", "find-generic-password", "-s", "Claude Code-credentials", "-a", "misha", "-w"],
      ["security", "find-generic-password", "-s", `Claude Code-credentials-${suffix}`, "-a", "misha", "-w"],
      ["security", "find-generic-password", "-s", `Claude Code-credentials-${suffix}`, "-w"],
    ]);
    expect(JSON.stringify(logins)).not.toContain("misha"); // the user is an argument, never a value
  });
  it("falls back to .credentials.json when the keychain item is signed out or missing", () => {
    const env = makeHome();
    writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify(CREDS.no_expiry));
    const answers = [JSON.stringify(CREDS.signed_out), "security: not even JSON"];
    const exec = () => answers.shift() ?? "";
    const logins = importableLogins(env, exec, undefined, "darwin");
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatchObject({ dir: path.join(home, ".claude"), source: "file", account_uuid: ACCOUNT });
    expect(logins[0]!.credential.expires_at).toBe(0); // no expiry on record: refresh before use
  });
  it("elsewhere reads only the file, through the injected reader, and skips a dir with none", () => {
    const env = makeHome();
    const exec = vi.fn(() => keychain);
    const files: Record<string, string> = {
      [path.join(home, ".claude-work", ".credentials.json")]: keychain,
      [path.join(home, ".claude-work", ".claude.json")]: "{not json",
    };
    const readFile = (f: string) => {
      const v = files[f];
      if (v === undefined) throw new Error("ENOENT");
      return v;
    };
    expect(importableLogins(env, exec, readFile, "linux")).toEqual([
      { dir: path.join(home, ".claude-work"), credential: expectKeychainCred, source: "file" },
    ]);
    expect(exec).not.toHaveBeenCalled();
    expect(importableLogins(env, exec, () => "{}", "win32")).toEqual([]);
    // No HOME in the env: the process's own home (the sandbox's, under test).
    expect(importableLogins({ USER: "misha" }, exec, readFile, "linux")).toEqual([]);
  });
  it("names the keychain item's account the way Claude Code does", () => {
    const env = makeHome();
    const asked: string[][] = [];
    const exec = (_: string, args: string[]) => {
      asked.push(args);
      throw new Error("not found");
    };
    importableLogins({ ...env, USER: "bad user" }, exec, undefined, "darwin");
    expect(asked[0]).toContain("claude-code-user");
    asked.length = 0;
    vi.spyOn(os, "userInfo").mockReturnValue({ username: "from_userinfo" } as ReturnType<typeof os.userInfo>);
    importableLogins({ ...env, USER: "" }, exec, undefined, "darwin");
    expect(asked[0]).toContain("from_userinfo");
    asked.length = 0;
    vi.spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("no passwd entry");
    });
    importableLogins({ ...env, USER: undefined }, exec, undefined, "darwin");
    expect(asked[0]).toContain("claude-code-user");
  });
  it("keychainService: bare for the default dir, sha256-suffixed for any other", () => {
    // Paths as this file system writes them, so the same cases hold on every runner.
    const home = path.resolve(path.sep, "Users", "x");
    const work = path.join(home, ".claude-work");
    const suffixed = (dir: string) =>
      `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
    expect(keychainService(path.join(home, ".claude"), home, "darwin")).toBe("Claude Code-credentials");
    expect(keychainService(`${path.join(home, ".claude")}${path.sep}`, home, "darwin")).toBe("Claude Code-credentials");
    expect(keychainService(work, home, "darwin")).toBe(suffixed(work));
    // Case matters on a Unix; on Windows the same folder may arrive in either case.
    const upper = path.join(path.resolve(path.sep, "Users", "X"), ".claude");
    expect(keychainService(upper, home, "linux")).toBe(suffixed(upper));
    expect(keychainService(upper, home, "win32")).toBe("Claude Code-credentials");
    expect(keychainService(work.toUpperCase(), home, "win32")).toBe(suffixed(work.toUpperCase()));
    // The default platform is this one.
    expect(keychainService(path.join(os.homedir(), ".claude"), os.homedir())).toBe("Claude Code-credentials");
  });
});

describe("what leaves the module", () => {
  it("is exported from core as the claudePool namespace", () => {
    expect(claudePool.readLimits).toBe(readLimits);
    expect(claudePool.POOL_ENDPOINTS.api).toBe("https://api.anthropic.com");
  });
  it("redaction already catches a pool token and a bearer header, should one reach a string", () => {
    const token = (OAUTH.token as { access_token: string }).access_token;
    expect(redactSecrets(`refreshed ${token} ok`)).toBe("refreshed [redacted] ok");
    expect(redactSecrets(`authorization: Bearer ${token}`)).toBe("authorization: Bearer [redacted]");
    expect(redactSecrets("Authorization: Bearer pool-abcdefghijklmnopqrstuv")).toBe("Authorization: Bearer [redacted]");
  });
});
