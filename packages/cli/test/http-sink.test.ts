// SPDX-License-Identifier: Apache-2.0
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { HttpSink, retryAfterMs, webhookId } from "../src/http-sink.js";

describe("webhook-id (HTTP.md §2: retries reuse it)", () => {
  it("is the same for the same batch and differs for another", () => {
    const a = [{ id: "01K6ABCXYZ0123456789ABCDEF" }, { id: "01K6ABCXYZ0123456789ABCDEG" }];
    expect(webhookId(a)).toBe(webhookId([...a]));
    expect(webhookId(a)).not.toBe(webhookId(a.slice(0, 1)));
    expect(webhookId(a)).toMatch(/^msg_[A-Za-z0-9_-]{32}$/);
  });
});

describe("retry-after (HTTP.md §2 429: wait as told)", () => {
  it("reads seconds, or an HTTP date (RFC 9110 §10.2.3); a minute when missing or unreadable", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    expect(retryAfterMs("7")).toBe(7000);
    expect(retryAfterMs("-5")).toBe(0);
    expect(retryAfterMs("Thu, 16 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs("Thu, 16 Oct 2026 11:59:30 GMT", now)).toBe(0);
    expect(retryAfterMs(null)).toBe(60_000);
    expect(retryAfterMs("   ")).toBe(60_000);
    expect(retryAfterMs("soon")).toBe(60_000);
  });
  it("a 429 with a dated retry-after asks to wait until then, not for the backoff ladder", async () => {
    const soon = new Date(Date.now() + 30_000).toUTCString();
    const server = createServer((_req, res) =>
      res.writeHead(429, { "content-type": "application/json", "retry-after": soon }).end("{}"),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await new HttpSink({ name: "h", url, tier: 3, token: "t" }, 3).send([
        {
          protocol: 1,
          id: "01K6ABCXYZ0123456789ABCDEF",
          type: "session.heartbeat",
          time: new Date().toISOString(),
          tier: 3,
          harness: { name: "codex" },
          session: { id: "s", seq: 0 },
          privacy: { rulesets: [], pii: false },
          data: {},
        },
      ]);
      expect(res).toMatchObject({ ok: false, status: 429, action: "retry" });
      expect(res.retryAfterMs).toBeGreaterThan(25_000);
      expect(res.retryAfterMs).toBeLessThanOrEqual(31_000);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
