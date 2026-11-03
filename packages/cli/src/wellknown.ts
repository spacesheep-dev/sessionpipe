// SPDX-License-Identifier: Apache-2.0
// A receiver's /.well-known/sessionpipe (spec/HTTP.md §1), read onto a sink: its tier
// cap, its endpoints, and the tool events it asked for (`tools`, PROTOCOL.md §4). Read
// at `sink add` and `connect`, and again by a worker once a day, so a receiver that
// starts asking for thinned tool events (or raises its cap) is heard without anyone
// touching the machine. A read that fails leaves what was learned before.
import { type Config, readConfig, type SinkConfig, type Tier, writeConfig } from "@sessionpipe/core";
import { isToolsMode, type ToolsMode } from "./fold.js";

export interface WellKnownRead {
  max_tier?: number;
  endpoints?: { events?: string };
  capabilities?: string[];
  tools?: unknown;
}

/** How long what a worker learned stands before it reads the file again. */
export const WELL_KNOWN_MAX_AGE_MS = 24 * 60 * 60_000;

export const wellKnownUrl = (sinkUrl: string): string => `${sinkUrl.replace(/\/$/, "")}/.well-known/sessionpipe`;

/** The file, parsed; throws with a sentence (`HTTP 404`, the fetch's own words) when it can't be read. */
export async function readWellKnown(
  sinkUrl: string,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<WellKnownRead> {
  const r = await fetchFn(wellKnownUrl(sinkUrl), { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as WellKnownRead;
}

/** What the file says, onto the sink. Returns what changed for the person, in words:
 *  a cap below the tier asked for, and the tool events the receiver asked for. */
export function applyWellKnown(s: SinkConfig, wk: WellKnownRead, tier: Tier, now = new Date()): string[] {
  const notes: string[] = [];
  if (typeof wk.max_tier === "number") {
    s.max_tier = wk.max_tier as Tier;
    if (wk.max_tier < tier)
      notes.push(`receiver's max_tier is ${wk.max_tier}: sending tier ${wk.max_tier}, not ${tier}`);
  }
  if (wk.endpoints) (s as SinkConfig & { endpoints?: unknown }).endpoints = wk.endpoints;
  const before = s.receiver_tools;
  if (isToolsMode(wk.tools)) s.receiver_tools = wk.tools;
  else delete s.receiver_tools;
  if (s.receiver_tools !== before && s.receiver_tools && s.receiver_tools !== "all" && !isToolsMode(s.tools))
    notes.push(`the receiver asks for tool events \`${s.receiver_tools}\` (--tools all keeps every one)`);
  s.well_known_at = now.toISOString();
  s.well_known_checked_at = s.well_known_at;
  return notes;
}

const stale = (s: SinkConfig, now: number): boolean => {
  const last = Date.parse(s.well_known_checked_at ?? s.well_known_at ?? "");
  return !Number.isFinite(last) || now - last >= WELL_KNOWN_MAX_AGE_MS;
};

/** Read again the well-known file of every HTTP sink a worker hasn't looked at for a
 *  day, and keep what changed. One short read per sink per day, never on the hook's
 *  own path; a failed read is noted as tried, so the next try is a day away. */
export async function refreshWellKnown(
  cfg: Config,
  o: { now?: () => number; fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const now = o.now ?? Date.now;
  let changed = false;
  for (const s of cfg.sinks) {
    if (!/^https?:\/\//.test(s.url) || !stale(s, now())) continue;
    const at = new Date(now());
    try {
      applyWellKnown(s, await readWellKnown(s.url, o.timeoutMs ?? 3000, o.fetchFn), s.tier, at);
    } catch {
      s.well_known_checked_at = at.toISOString();
    }
    changed = true;
  }
  return changed;
}

/** The worker's call: the config read, refreshed where stale, and written back only when
 *  something was learned or tried. Nothing a drain depends on; errors are swallowed. */
export async function refreshSinks(o: Parameters<typeof refreshWellKnown>[1] = {}): Promise<void> {
  try {
    const cfg = readConfig();
    if (await refreshWellKnown(cfg, o)) writeConfig(cfg);
  } catch {}
}

export type { ToolsMode };
