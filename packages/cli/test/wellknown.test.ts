// SPDX-License-Identifier: Apache-2.0
// A receiver's well-known file onto a sink (wellknown.ts): what is read, what is kept,
// when a worker reads it again, and what it says to the person.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, readConfig, type SinkConfig, writeConfig } from "@sessionpipe/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyWellKnown,
  readWellKnown,
  refreshSinks,
  refreshWellKnown,
  WELL_KNOWN_MAX_AGE_MS,
  wellKnownUrl,
} from "../src/wellknown.js";

const DAY = WELL_KNOWN_MAX_AGE_MS;
const T0 = Date.parse("2026-11-03T12:00:00Z");
const http = (over: Partial<SinkConfig> = {}): SinkConfig => ({
  name: "rx",
  url: "https://rx.example/",
  tier: 2,
  pii: false,
  ...over,
});
/** A fetch that answers the well-known URL with `body` at `status`, or throws. */
const answers = (body: unknown, status = 200) =>
  vi.fn(async (url: string | URL | Request) => {
    expect(String(url)).toBe("https://rx.example/.well-known/sessionpipe");
    return { ok: status < 400, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;

describe("readWellKnown", () => {
  it("reads the file at the receiver's origin, and says HTTP <status> when it isn't served", async () => {
    expect(wellKnownUrl("https://rx.example/")).toBe("https://rx.example/.well-known/sessionpipe");
    expect(await readWellKnown("https://rx.example", 1000, answers({ max_tier: 1 }))).toEqual({ max_tier: 1 });
    await expect(readWellKnown("https://rx.example", 1000, answers({}, 404))).rejects.toThrow("HTTP 404");
  });
});

describe("applyWellKnown", () => {
  it("keeps the cap, the endpoints and the tool events the receiver asked for, and says what matters", () => {
    const s = http();
    const now = new Date(T0);
    expect(applyWellKnown(s, { max_tier: 1, endpoints: { events: "/in" }, tools: "main" }, 2, now)).toEqual([
      "receiver's max_tier is 1: sending tier 1, not 2",
      "the receiver asks for tool events `main` (--tools all keeps every one)",
    ]);
    expect(s).toMatchObject({
      max_tier: 1,
      endpoints: { events: "/in" },
      receiver_tools: "main",
      well_known_at: now.toISOString(),
      well_known_checked_at: now.toISOString(),
    });
    // Said once: the same ask again is no news, and neither is `all`, nor an ask the owner overrode.
    expect(applyWellKnown(s, { max_tier: 2, tools: "main" }, 2, now)).toEqual([]);
    expect(applyWellKnown(s, { tools: "all" }, 2, now)).toEqual([]);
    expect(s.receiver_tools).toBe("all");
    expect(applyWellKnown(http({ tools: "all" }), { tools: "beat" }, 2, now)).toEqual([]);
    // A value nobody knows, or none: the receiver asked for nothing in particular.
    expect(applyWellKnown(s, { tools: "some" }, 2, now)).toEqual([]);
    expect(s).not.toHaveProperty("receiver_tools");
    expect(s.max_tier).toBe(2);
  });
});

describe("refreshWellKnown", () => {
  it("reads again only an HTTP sink nobody looked at for a day; a failed read is noted as tried, with what was known kept", async () => {
    const fresh = http({
      name: "fresh",
      well_known_checked_at: new Date(T0 - DAY + 60_000).toISOString(),
      receiver_tools: "main",
    });
    const stale = http({ name: "stale", well_known_at: new Date(T0 - DAY).toISOString() });
    const never = http({ name: "never" });
    const odd = http({ name: "odd", well_known_at: "not a date" });
    const file: SinkConfig = { name: "f", url: "file:/tmp/x", tier: 1, pii: false };
    const cfg = { ...DEFAULT_CONFIG, sinks: [fresh, stale, never, odd, file] };
    const fetchFn = answers({ max_tier: 1, tools: "main" });
    expect(await refreshWellKnown(cfg, { now: () => T0, fetchFn })).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fresh).toMatchObject({ receiver_tools: "main" });
    expect(fresh.well_known_at).toBeUndefined();
    for (const s of [stale, never, odd])
      expect(s).toMatchObject({ max_tier: 1, receiver_tools: "main", well_known_at: new Date(T0).toISOString() });
    expect(file).not.toHaveProperty("well_known_checked_at");
    // Nothing stale now: nothing read, nothing changed.
    expect(await refreshWellKnown(cfg, { now: () => T0 + 1000, fetchFn })).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // A day on, a read that fails leaves the cap and the ask, and dates the try.
    const failing = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    expect(await refreshWellKnown(cfg, { now: () => T0 + DAY, fetchFn: failing })).toBe(true);
    expect(stale).toMatchObject({
      max_tier: 1,
      receiver_tools: "main",
      well_known_at: new Date(T0).toISOString(),
      well_known_checked_at: new Date(T0 + DAY).toISOString(),
    });
  });
});

describe("refreshSinks (the worker's call)", () => {
  let tmp: string;
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it("writes the config only when a sink was read again, and swallows whatever goes wrong", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "sp-wk-"));
    const file = path.join(tmp, "config.json");
    vi.stubEnv("SESSIONPIPE_CONFIG", file);
    writeConfig({ ...DEFAULT_CONFIG, sinks: [http()] }, file);
    await refreshSinks({ now: () => T0, fetchFn: answers({ tools: "main" }) });
    expect(readConfig(file).sinks[0]).toMatchObject({
      receiver_tools: "main",
      well_known_at: new Date(T0).toISOString(),
    });
    // Fresh now: no read, and the file is left as it is.
    const before = readConfig(file);
    await refreshSinks({ now: () => T0 + 1000, fetchFn: answers({ tools: "beat" }) });
    expect(readConfig(file)).toEqual(before);
    // A config that can't be written back: nothing thrown.
    writeFileSync(file, "{ broken");
    await expect(refreshSinks({ now: () => T0 + DAY, fetchFn: answers({}) })).resolves.toBeUndefined();
  });
});
