// SPDX-License-Identifier: Apache-2.0
// The HTTP sink (spec/HTTP.md §2): POST {events} with the protocol header, a bearer
// token and optional Standard Webhooks signature; errors map to what the sender
// does next. The cursor moves only on 202. Retry/backoff is the worker's cadence
// (each hook run drains the backlog); this class reports, it does not sleep.
import { createHash, createHmac } from "node:crypto";
import type { DeliveryResult, Event, Sink, SinkConfig, Tier } from "@sessionpipe/core";

const TIMEOUT_MS = 15_000;

/** The Standard Webhooks message id (HTTP.md §2): the same batch sent again carries
 *  the same id, so a receiver that dedupes on webhook-id sees a retry as one message.
 *  Derived from the events' own ids, which the outbox keeps across retries. */
export function webhookId(events: Pick<Event, "id">[]): string {
  return `msg_${createHash("sha256")
    .update(events.map((e) => e.id).join(","))
    .digest("base64url")
    .slice(0, 32)}`;
}

/** HTTP.md §2 429: wait as `retry-after` says, seconds or an HTTP date (RFC 9110
 *  §10.2.3); a minute when the header is missing or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (header === null || header.trim() === "") return 60_000;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs) * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : 60_000;
}

export class HttpSink implements Sink {
  readonly name: string;
  readonly pii: boolean;
  private readonly url: string;
  constructor(
    private readonly cfg: SinkConfig,
    readonly tier: Tier,
  ) {
    this.name = cfg.name;
    this.pii = !!cfg.pii;
    this.url = cfg.url.replace(/\/$/, "");
  }

  private eventsUrl(): string {
    // The endpoint from the well-known file is stored beside the url at `sink add`;
    // until then the spec's default path.
    const ep = (this.cfg as { endpoints?: { events?: string } }).endpoints?.events ?? "/api/sessionpipe/v1/events";
    return /^https?:\/\//.test(ep) ? ep : this.url + ep;
  }

  async send(events: Event[]): Promise<DeliveryResult> {
    const body = JSON.stringify({ events });
    const headers: Record<string, string> = { "content-type": "application/json", "sessionpipe-protocol": "1" };
    if (this.cfg.token) headers.authorization = `Bearer ${this.cfg.token}`;
    if (this.cfg.secret?.startsWith("whsec_")) {
      const id = webhookId(events);
      const ts = Math.floor(Date.now() / 1000);
      const key = Buffer.from(this.cfg.secret.slice(6), "base64");
      const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
      headers["webhook-id"] = id;
      headers["webhook-timestamp"] = String(ts);
      headers["webhook-signature"] = `v1,${sig}`;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(this.eventsUrl(), { method: "POST", headers, body, signal: ctl.signal });
      const text = await r.text();
      let j: Record<string, unknown> = {};
      try {
        j = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {}
      if (r.status === 202 || r.status === 200) {
        return {
          ok: true,
          acknowledged: events.length,
          accepted: Number(j.accepted ?? events.length),
          duplicates: Number(j.duplicates ?? 0),
          rejected: Array.isArray(j.rejected) ? (j.rejected as { id: string; reason: string }[]) : [],
          ...(typeof j.max_tier === "number" ? { max_tier: j.max_tier as Tier } : {}),
          status: r.status,
        };
      }
      const err = typeof j.reason === "string" ? j.reason : text.slice(0, 200);
      if (r.status === 400) return { ok: false, acknowledged: 0, status: 400, error: err, action: "drop" };
      if (r.status === 401) return { ok: false, acknowledged: 0, status: 401, error: err, action: "pause" };
      if (r.status === 403)
        return {
          ok: false,
          acknowledged: 0,
          status: 403,
          error: err,
          action: "lower-tier",
          ...(typeof j.max_tier === "number" ? { max_tier: j.max_tier as Tier } : {}),
        };
      if (r.status === 413) return { ok: false, acknowledged: 0, status: 413, error: err, action: "split" };
      if (r.status === 429)
        return {
          ok: false,
          acknowledged: 0,
          status: 429,
          error: err,
          action: "retry",
          retryAfterMs: retryAfterMs(r.headers.get("retry-after")),
        };
      return { ok: false, acknowledged: 0, status: r.status, error: err, action: "retry" };
    } catch (e) {
      return { ok: false, acknowledged: 0, error: String((e as Error).message ?? e), action: "retry" };
    } finally {
      clearTimeout(t);
    }
  }
}
