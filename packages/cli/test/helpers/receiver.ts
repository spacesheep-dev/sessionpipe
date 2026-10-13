// SPDX-License-Identifier: Apache-2.0
// A receiver that speaks the control half of HTTP.md §3, in-process, for the daemon
// tests: well-known, pairing (with a passkey's proof), the per-machine poll with
// redelivery until acked (paused by `taken`), acks, hello and off. The person's side
// (signing) uses the core test authenticator, so every signature is real.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sha256 } from "../../../core/src/control/verify.js";
import { commandStr, DayKey, nonce, Passkey } from "../../../core/test/helpers/authenticator.js";

export interface Queued {
  id: string;
  cmd: string;
  csig?: string | null;
  grant?: unknown;
  confirm?: unknown;
  at: string;
  expires_at: string;
  takenAt?: number;
}

let seq = 0;
const ulid = () => {
  const s = `01K6${String(Date.now()).padStart(13, "0")}${String(++seq).padStart(9, "0")}`;
  return s.replace(/[ILOU]/g, "0").slice(0, 26);
};

export class FakeReceiver {
  server!: Server;
  url = "";
  readonly queue = new Map<string, Queued[]>();
  readonly acks: Record<string, unknown>[] = [];
  readonly hellos: Record<string, unknown>[] = [];
  readonly pairs: Record<string, unknown>[] = [];
  readonly polls: number[] = [];
  machine = "m_fakemachine0000000001";
  token = "tok_machine_0123456789abcdef";
  sinkToken = "sink_token_abc";
  passkey!: Passkey;
  day!: DayKey;
  pairCode = "PAIR-1234";
  paired = false;
  /** Hand the machine this key (a key swap attack when it isn't the one that proved). */
  handKey: "same" | "other" = "same";
  other!: Passkey;
  offCalled = false;
  /** Declare control.open_pairing: pairing may start with no token and a poll_key. */
  openPairing = false;
  /** The first code this pairing is handed expires unapproved; the next one pairs. */
  expireFirst = false;
  codesIssued = 0;
  pollKey: string | null = null;

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", () => r()));
    this.url = `http://localhost:${(this.server.address() as AddressInfo).port}`;
    this.passkey = await Passkey.create({ rpId: "localhost", origin: this.url });
    this.other = await Passkey.create({ rpId: "localhost", origin: this.url });
    this.day = await DayKey.create();
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  /** The person signs a command and the receiver queues it for the machine (`hold`:
   *  signed only, so several can be enqueued together and arrive in one poll). */
  async send(
    fields: Record<string, unknown>,
    o: { confirm?: boolean; expiresInMs?: number; tamper?: (c: string) => string; as?: Passkey; hold?: boolean } = {},
  ): Promise<Queued> {
    const now = Date.now();
    const cmd = commandStr({ machine: this.machine, iat: now, nonce: nonce(), ...fields });
    let signed: { cmd: string; csig?: string; grant?: unknown; confirm?: unknown };
    const pk = o.as ?? this.passkey;
    if (o.confirm) signed = { cmd, confirm: await pk.assert(await sha256(cmd)) };
    else {
      const grant = await this.day.grant(pk, { iat: now - 60_000, exp: now + 3600_000 });
      signed = { cmd, csig: await this.day.sign(cmd), grant };
    }
    if (o.tamper) signed.cmd = o.tamper(signed.cmd);
    const q: Queued = {
      id: ulid(),
      ...signed,
      at: new Date(now).toISOString(),
      expires_at: new Date(now + (o.expiresInMs ?? 3600_000)).toISOString(),
    };
    if (!o.hold) this.enqueue(q);
    return q;
  }

  enqueue(q: Queued): void {
    const list = this.queue.get(this.machine) ?? [];
    list.push(q);
    this.queue.set(this.machine, list);
    for (const w of this.waiters.splice(0)) w();
  }

  private waiters: (() => void)[] = [];

  finalAck(id: string): Record<string, unknown> | undefined {
    return this.acks.find((a) => a.id === id && a.outcome !== "taken" && a.outcome !== "progress");
  }

  /** The `progress` acks for one message, in the order they came. */
  progress(id: string): Record<string, unknown>[] {
    return this.acks.filter((a) => a.id === id && a.outcome === "progress");
  }

  async waitAck(id: string, ms = 10_000): Promise<Record<string, unknown>> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const a = this.finalAck(id);
      if (a) return a;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no final ack for ${id}; acks: ${JSON.stringify(this.acks)}`);
  }

  private pending(): Queued[] {
    const now = Date.now();
    const list = (this.queue.get(this.machine) ?? []).filter((q) => Date.parse(q.expires_at) > now);
    this.queue.set(this.machine, list);
    return list.filter((q) => !q.takenAt || now - q.takenAt > 35 * 60_000);
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let b = "";
    for await (const c of req) b += c;
    try {
      return JSON.parse(b || "{}");
    } catch {
      return {};
    }
  }

  private async route(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", this.url);
    const auth = req.headers.authorization ?? "";
    const send = (status: number, j?: unknown) => {
      res.writeHead(status, j ? { "content-type": "application/json" } : {});
      res.end(j ? JSON.stringify(j) : "");
    };
    const machineAuth = auth === `Bearer ${this.token}`;
    const sinkAuth = auth === `Bearer ${this.sinkToken}`;
    if (u.pathname === "/.well-known/sessionpipe")
      return send(200, {
        protocol: [1],
        max_tier: 2,
        capabilities: ["events", "control"],
        auth: ["bearer"],
        endpoints: { events: "/api/sessionpipe/v1/events", control: "/api/sessionpipe/v1/control" },
        batch: { max_events: 50, max_bytes: 262144 },
        control: {
          wait_max_s: 25,
          ...(this.openPairing ? { open_pairing: true } : {}),
          signing: { rp_id: "localhost", algs: [-7, -257] },
        },
      });
    const base = "/api/sessionpipe/v1/control";
    if (u.pathname === `${base}/pair` && req.method === "POST") {
      const b = await this.body(req);
      this.pairs.push(b);
      if (!sinkAuth) {
        if (!this.openPairing || auth || typeof b.poll_key !== "string") return send(401);
        this.pollKey = b.poll_key;
      }
      const stale = this.expireFirst && this.codesIssued++ === 0;
      return send(201, {
        machine: this.machine,
        code: stale ? "PAIR-STALE" : this.pairCode,
        url: `${this.url}/pair/${this.pairCode}`,
        check: "123456",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    if (u.pathname === `${base}/pair` && req.method === "GET") {
      const open = this.pollKey !== null && auth === `Bearer ${this.pollKey}`;
      if (!sinkAuth && !open) return send(401);
      if (u.searchParams.get("code") === "PAIR-STALE") return send(200, { status: "expired" });
      if (u.searchParams.get("code") !== this.pairCode) return send(404);
      if (!this.paired) return send(200, { status: "pending" });
      const proof = await this.passkey.enroll(this.machine, this.pairCode);
      const key = this.handKey === "same" ? this.passkey.key : this.other.key;
      return send(200, {
        status: "paired",
        key,
        proof,
        token: this.token,
        ...(open ? { sink_token: "sink_from_pairing_0123456789", account: "@fake on localhost" } : {}),
      });
    }
    if (!u.pathname.startsWith(base)) return send(404);
    if (!machineAuth) return send(401);
    if (u.pathname === `${base}/hello`) {
      this.hellos.push(await this.body(req));
      return send(204);
    }
    if (u.pathname === `${base}/ack`) {
      const b = (await this.body(req)) as { acks?: Record<string, unknown>[] };
      for (const a of b.acks ?? []) {
        this.acks.push(a);
        if (a.outcome === "progress") continue;
        const list = this.queue.get(this.machine) ?? [];
        const q = list.find((x) => x.id === a.id);
        if (!q) continue;
        if (a.outcome === "taken") q.takenAt = Date.now();
        else list.splice(list.indexOf(q), 1);
      }
      return send(202);
    }
    if (u.pathname === `${base}/off`) {
      this.offCalled = true;
      return send(204);
    }
    if (u.pathname === base && req.method === "GET") {
      if (u.searchParams.get("machine") !== this.machine) return send(404);
      this.polls.push(Date.now());
      const wait = Math.min(Number(u.searchParams.get("wait") ?? 25), 25) * 1000;
      const until = Date.now() + wait;
      for (;;) {
        const p = this.pending();
        if (p.length) return send(200, { messages: p.map(({ takenAt: _t, ...q }) => q) });
        if (Date.now() >= until || req.destroyed) return send(204);
        await new Promise<void>((r) => {
          const t = setTimeout(r, Math.min(until - Date.now(), 200));
          this.waiters.push(() => {
            clearTimeout(t);
            r();
          });
        });
      }
    }
    return send(404);
  }
}
