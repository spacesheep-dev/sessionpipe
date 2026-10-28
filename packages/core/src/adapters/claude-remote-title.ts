// SPDX-License-Identifier: Apache-2.0
// The name claude.ai keeps for a Remote Control session: the one the Claude app lists.
// Claude Code never writes it on this machine for a session the app started (its registry
// keeps `<folder>-NN` as `derived`, its transcript no `ai-title`), so without this the
// session goes by its first ask everywhere but in the app (spec/ADAPTERS.md, Claude Code,
// Facts).
//
// Off unless the person turns it on (`sessionpipe remote-titles on`, config.json
// `remote_titles`): it is the one place sessionpipe reads a credential and calls a vendor
// API. The worker runs it, never the hook. The token is the session's own config dir's
// Claude Code access token, from the macOS Keychain item Claude Code keeps for that dir,
// else `<dir>/.credentials.json`. It goes to api.anthropic.com and nowhere else, and it
// is never refreshed, stored or logged: an expired one is skipped until Claude Code
// renews it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const REMOTE_TITLE_URL = "https://api.anthropic.com/v1/sessions/";
/** Claude Code's own beta for listing claude.ai sessions (`--teleport`). */
export const REMOTE_TITLE_BETA = "ccr-byoc-2025-07-29";
/** A read stands a minute while claude.ai has no name for the session yet (it names one
 *  after the first turn), and ten minutes once it has one (it renames as the work moves). */
export const REMOTE_TITLE_RETRY_MS = 60_000;
export const REMOTE_TITLE_REFRESH_MS = 10 * 60_000;
/** A Keychain item whose access list leaves out `security` asks the person on screen, and
 *  nobody may be there to answer: the read gives up instead. */
const KEYCHAIN_TIMEOUT_MS = 3000;
const FETCH_TIMEOUT_MS = 5000;
const SERVICE = "Claude Code-credentials";

export interface RemoteTitleDeps {
  platform?: NodeJS.Platform;
  /** Runs `security` with these arguments: its stdout, or null when it fails. */
  security?: (args: string[]) => string | null;
  readFile?: (file: string) => string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** `security`, given up on after KEYCHAIN_TIMEOUT_MS. `cmd` is for tests. */
export function runSecurity(args: string[], cmd = "security"): string | null {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: KEYCHAIN_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

/** The Keychain items Claude Code may keep a config dir's sign-in in, best first. Claude
 *  Code names the item after CLAUDE_CONFIG_DIR as it was given (the first 8 hex of the
 *  SHA-256 of its NFC form), and the default ~/.claude, with that variable unset, after
 *  nothing: so the variable is trusted only when it names this dir. */
export function keychainServices(dir: string, configEnv: string | undefined, home: string): string[] {
  const named = (s: string) =>
    `${SERVICE}-${createHash("sha256").update(s.normalize("NFC")).digest("hex").slice(0, 8)}`;
  const mine = !!configEnv && path.resolve(configEnv) === path.resolve(dir);
  const out = mine ? [named(configEnv)] : path.resolve(dir) === path.resolve(home, ".claude") ? [SERVICE] : [];
  if (!out.includes(named(dir))) out.push(named(dir));
  return out;
}

/** The access token in a stored sign-in, when it is one and still valid; else null. */
export function usableToken(blob: string | null, now: number): string | null {
  if (!blob) return null;
  let o: unknown;
  try {
    o = (JSON.parse(blob) as { claudeAiOauth?: unknown }).claudeAiOauth;
  } catch {
    return null;
  }
  const { accessToken: t, expiresAt } = (o ?? {}) as { accessToken?: unknown; expiresAt?: unknown };
  if (typeof t !== "string" || !/^[A-Za-z0-9._-]{20,1024}$/.test(t)) return null;
  // Claude Code renews it; this never does. A token a minute from expiring is let go too.
  if (typeof expiresAt === "number" && expiresAt <= now + 60_000) return null;
  return t;
}

/** The session's config dir's Claude Code access token, or null. */
export function claudeToken(dir: string, env: NodeJS.ProcessEnv, deps: RemoteTitleDeps = {}): string | null {
  const now = (deps.now ?? Date.now)();
  if ((deps.platform ?? process.platform) === "darwin") {
    const security = deps.security ?? runSecurity;
    const user = env.USER || env.LOGNAME;
    for (const service of keychainServices(dir, env.CLAUDE_CONFIG_DIR, env.HOME || "")) {
      // By account first: a service can hold a second, stale item a bare lookup returns.
      const blob =
        (user ? security(["find-generic-password", "-a", user, "-s", service, "-w"]) : null) ??
        security(["find-generic-password", "-s", service, "-w"]);
      if (blob) return usableToken(blob, now);
    }
  }
  let blob: string | null = null;
  try {
    blob = (deps.readFile ?? ((f: string) => readFileSync(f, "utf8")))(path.join(dir, ".credentials.json"));
  } catch {}
  return usableToken(blob, now);
}

/** The title claude.ai shows for `bridgeId` (`session_…`), or null: no usable token, a
 *  refusal, a timeout, an answer without a title. */
export async function fetchRemoteTitle(
  bridgeId: string,
  dir: string,
  env: NodeJS.ProcessEnv,
  deps: RemoteTitleDeps = {},
): Promise<string | null> {
  if (!/^session_[A-Za-z0-9]+$/.test(bridgeId)) return null;
  const token = claudeToken(dir, env, deps);
  if (!token) return null;
  try {
    const res = await (deps.fetch ?? fetch)(REMOTE_TITLE_URL + bridgeId, {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": REMOTE_TITLE_BETA,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const title = ((await res.json()) as { title?: unknown } | null)?.title;
    const t = typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 120).trim() : "";
    return t || null;
  } catch {
    return null;
  }
}
