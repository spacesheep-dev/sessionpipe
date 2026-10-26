// SPDX-License-Identifier: Apache-2.0
import type { Adapter, HookInput, HookResult } from "./adapters/types.js";

/** PROTOCOL.md §3 `launched_by`: a launcher that starts a session for another one (a
 *  script running `claude -p`) names itself here as `<harness>:<id>`, and the hook
 *  carries it along. */
export const LAUNCHED_BY_ENV = "SESSIONPIPE_LAUNCHED_BY";
const LAUNCHED_BY = /^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$/;

/** The launcher the environment names, or nothing when it is absent or malformed. */
export function launchedBy(env: Record<string, string | undefined>): string | undefined {
  const v = env[LAUNCHED_BY_ENV]?.trim();
  return v && LAUNCHED_BY.test(v) ? v : undefined;
}

/** An adapter's reading of a hook, plus what every harness shares: the launcher, unless
 *  the harness gave the session a parent of its own (a subagent's launcher is its parent)
 *  or the value names the session itself (a launcher that forgot to reset it). */
export function readHook(adapter: Adapter, input: HookInput): HookResult | null {
  const r = adapter.fromHook(input);
  if (r && !r.session.parent_id) {
    const launcher = launchedBy(input.env);
    if (launcher && launcher !== `${adapter.name}:${r.session.id}`) r.session.launched_by = launcher;
  }
  return r;
}
