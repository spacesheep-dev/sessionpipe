// SPDX-License-Identifier: Apache-2.0
// The two session fields every harness shares and no hook payload carries: who started
// this session on purpose, and which session it answers. Both come from the environment
// the session was started in, and the hook carries them along (PROTOCOL.md §3).
import type { Adapter, HookInput, HookResult } from "./adapters/types.js";

/** PROTOCOL.md §3 `launched_by`: a launcher that starts a session for another one (a
 *  script running `claude -p`) names itself here as `<harness>:<id>`, and the hook
 *  carries it along. */
export const LAUNCHED_BY_ENV = "SESSIONPIPE_LAUNCHED_BY";
/** PROTOCOL.md §3 `delegated_by`: the control daemon that starts or resumes a session
 *  for another session's ask (CONTROL.md §13) or a handoff (§6) names that session
 *  here, and the child's hooks stamp it on every event. */
export const DELEGATED_BY_ENV = "SESSIONPIPE_ASKED_BY";
/** CONTROL.md §13: the asks a session is nested in, comma-joined, read by the next ask. */
export const ASK_CHAIN_ENV = "SESSIONPIPE_ASK_CHAIN";
/** The three lineage variables. They are inherited like any environment, so anything
 *  that starts a further session resets them (PROTOCOL.md §3, CONTROL.md §13); the
 *  daemon most of all, which starts sessions for receivers and askers alike and must
 *  not stamp its own shell's lineage on them. */
export const LINEAGE_ENV = [LAUNCHED_BY_ENV, DELEGATED_BY_ENV, ASK_CHAIN_ENV] as const;
const SESSION_REF = /^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$/;

/** `env` without the lineage variables: what a child that is nobody's gets. */
export function withoutLineage(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e = { ...env };
  for (const k of LINEAGE_ENV) delete e[k];
  return e;
}

/** The `<harness>:<id>` a variable names, or nothing when it is absent or malformed. */
function refIn(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name]?.trim();
  return v && SESSION_REF.test(v) ? v : undefined;
}

/** The launcher the environment names, or nothing when it is absent or malformed. */
export function launchedBy(env: Record<string, string | undefined>): string | undefined {
  return refIn(env, LAUNCHED_BY_ENV);
}

/** The session this one was started or resumed for, or nothing when the environment
 *  doesn't say or says it badly. */
export function delegatedBy(env: Record<string, string | undefined>): string | undefined {
  return refIn(env, DELEGATED_BY_ENV);
}

/** An adapter's reading of a hook, plus what every harness shares: the launcher and the
 *  asker, unless the harness gave the session a parent of its own (a subagent's lineage
 *  is its parent, which carries both) or the value names the session itself (a
 *  launcher that forgot to reset it). */
export function readHook(adapter: Adapter, input: HookInput): HookResult | null {
  const r = adapter.fromHook(input);
  if (r && !r.session.parent_id) {
    const self = `${adapter.name}:${r.session.id}`;
    const launcher = launchedBy(input.env);
    if (launcher && launcher !== self) r.session.launched_by = launcher;
    const asker = delegatedBy(input.env);
    if (asker && asker !== self) r.session.delegated_by = asker;
  }
  return r;
}
