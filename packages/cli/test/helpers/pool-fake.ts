// SPDX-License-Identifier: Apache-2.0
// A stand-in for core's claude-code-pool adapter, shaped like the real one but with
// nothing of the vendor in it: what the pool engine's tests code against, so they
// never depend on the real adapter's internals. Headers and bodies follow the shapes
// DESIGN §0 lists, only as far as the engine reads them through this interface.
import { createHash } from "node:crypto";
import type {
  ImportableLogin,
  LimitWindow,
  PendingLogin,
  PoolAdapter,
  PoolCredential,
  PoolLimits,
  PoolProfile,
} from "../../src/pool/types.js";

export class FakeAuthError extends Error {}

export interface FakeAdapter extends PoolAdapter {
  logins: Map<string, { credential: PoolCredential; profile: PoolProfile }>;
  refresh: (c: PoolCredential, now: number) => Promise<PoolCredential>;
  usage: (access: string, now: number) => Promise<PoolLimits | null>;
  profile: (access: string) => Promise<PoolProfile>;
  importable: ImportableLogin[];
  calls: { refresh: number; usage: number; completeLogin: number; importable: number };
}

const USER_ID = /^user_([0-9a-f]+)_account_([0-9a-f-]+)_session_([0-9a-f-]+)$/;

export function fakeAdapter(): FakeAdapter {
  const calls = { refresh: 0, usage: 0, completeLogin: 0, importable: 0 };
  const a: FakeAdapter = {
    POOL_ENDPOINTS: { api: "http://upstream.invalid" },
    PoolAuthError: FakeAuthError,
    logins: new Map(),
    importable: [],
    calls,
    refresh: async (c, now) => ({ ...c, access: `${c.access}+`, expires_at: now + 3_600_000 }),
    usage: async () => null,
    profile: async () => ({ account_uuid: uuidOf("profiled"), email: "profiled@x.y" }),
    readLimits(headers, _now) {
      const windows: LimitWindow[] = [];
      for (const [id, key] of [
        ["five_hour", "5h"],
        ["seven_day", "7d"],
      ] as const) {
        const u = headers.get(`anthropic-ratelimit-unified-${key}-utilization`);
        if (u === null) continue;
        const reset = headers.get(`anthropic-ratelimit-unified-${key}-reset`);
        windows.push({
          id,
          used_percent: Math.round(Number(u) * 100),
          ...(reset ? { resets_at: new Date(Number(reset) * 1000).toISOString() } : {}),
        });
      }
      const status = headers.get("anthropic-ratelimit-unified-status");
      if (!windows.length && !status) return null;
      const reset = headers.get("anthropic-ratelimit-unified-reset");
      return {
        windows,
        ...(status ? { status } : {}),
        ...(reset ? { claim: "seven_day", resets_at: new Date(Number(reset) * 1000).toISOString() } : {}),
        observed_at: _now,
      };
    },
    usageLimits(json, _now) {
      const j = json as Record<string, { utilization?: number; resets_at?: string }>;
      const windows: LimitWindow[] = [];
      for (const id of ["five_hour", "seven_day"]) {
        const w = j?.[id];
        if (w && typeof w.utilization === "number")
          windows.push({ id, used_percent: w.utilization, ...(w.resets_at ? { resets_at: w.resets_at } : {}) });
      }
      return windows.length ? { windows, observed_at: _now } : null;
    },
    parseUserId(body) {
      try {
        const j = JSON.parse(body.toString("utf8")) as { metadata?: { user_id?: string } };
        const m = USER_ID.exec(j.metadata?.user_id ?? "");
        return m ? { account: m[2] as string, session: m[3] as string } : null;
      } catch {
        return null;
      }
    },
    withAccount(body, uuid) {
      let j: { metadata?: { user_id?: string } };
      try {
        j = JSON.parse(body.toString("utf8"));
      } catch {
        return body;
      }
      const m = USER_ID.exec(j.metadata?.user_id ?? "");
      if (!m) return body;
      j.metadata = { ...j.metadata, user_id: `user_${m[1]}_account_${uuid}_session_${m[3]}` };
      return Buffer.from(JSON.stringify(j));
    },
    upstreamHeaders(h, access) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(h)) {
        if (typeof v !== "string") continue;
        if (["host", "connection", "content-length", "authorization", "transfer-encoding"].includes(k)) continue;
        out[k] = v;
      }
      out.authorization = `Bearer ${access}`;
      out["anthropic-beta"] = "oauth-2025-04-20";
      return out;
    },
    beginLogin(random = () => Buffer.from("r4nd0m")): PendingLogin {
      const state = random(6).toString();
      return { url: `https://claude.ai/oauth/authorize?state=${state}`, verifier: `v-${state}`, state };
    },
    async completeLogin(code, pending, _fetch, now) {
      calls.completeLogin++;
      now();
      const [c, state] = code.split("#");
      if (state !== pending.state) throw new FakeAuthError("state mismatch");
      const hit = a.logins.get(c as string);
      if (!hit) throw new FakeAuthError("bad code");
      return hit;
    },
    async refreshCredential(cred, _fetch, now) {
      calls.refresh++;
      return a.refresh(cred, now());
    },
    async fetchProfile(access) {
      return a.profile(access);
    },
    async fetchUsage(access, _fetch, now) {
      calls.usage++;
      return a.usage(access, now());
    },
    importableLogins() {
      calls.importable++;
      return a.importable;
    },
  };
  return a;
}

export const uuidOf = (name: string): string => {
  const h = createHash("sha256").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export const credential = (name: string, expiresIn = 3_600_000, now = 0): PoolCredential => ({
  access: `access-${name}`,
  refresh: `refresh-${name}`,
  expires_at: now + expiresIn,
});

/** A Claude Code request body for `session` on `account`. */
export const body = (session: string, account = uuidOf("own"), extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    model: "claude-opus-4-1",
    messages: [{ role: "user", content: "hi" }],
    metadata: { user_id: `user_abc123_account_${account}_session_${session}` },
    ...extra,
  });
