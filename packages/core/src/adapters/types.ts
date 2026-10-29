// SPDX-License-Identifier: Apache-2.0
// What an adapter is: the only vendor-specific code in the tree, one file per
// harness. It maps a hook invocation to protocol events, says where its config
// lives and how to write the hooks there, reads its transcript for tier 2, and
// gathers facts (title, url, model, account) from the harness's own files.
import type { Session } from "../types.js";

export interface HookInput {
  /** [harness, event, ...] as the hook was invoked. */
  argv: string[];
  stdin: string;
  env: Record<string, string | undefined>;
  cwd: string;
}

/** An event as an adapter emits it: no id/time/seq/tier yet (core adds them). */
export interface AdapterEvent {
  type: string;
  data: Record<string, unknown>;
  /** The harness's own event name, for `harness.event`. */
  harnessEvent: string;
}

export interface HookResult {
  session: { id: string } & Partial<Session>;
  events: AdapterEvent[];
  /** The transcript file, when the payload names it (tier-2 reads). */
  transcript?: string;
  /** What the harness must see on stdout, if anything. */
  stdout?: string;
  /** Hints for the facts pass (pids, workspaces, a desktop id). */
  hints?: Record<string, unknown>;
}

export interface Turn {
  user: string;
  assistant: string;
  at: number;
  endLine: number;
}

export interface TranscriptRead {
  turns: Turn[];
  /** The line the cursor may advance to once every turn is delivered. */
  line: number;
  /** A prompt after the last turn with no reply yet (a turn that just began). */
  open?: { user: string; at: number };
}

export interface SessionFacts extends Partial<Session> {
  first_ask?: string;
  started_at?: number;
  last_at?: number;
  harness_version?: string;
}

export interface BackfillRow {
  session: { id: string } & Partial<Session>;
  started_at: number;
  last_at: number;
  turns?: number;
}

/** The command a hook entry runs: absolute node, absolute script, then args. */
export type HookCommand = (args: string[]) => { argv: string[]; command: string };

export interface InstallReport {
  file: string;
  changed: boolean;
  note?: string;
  /** The file did not exist before this install; uninstall may delete it when empty. */
  created?: boolean;
  /** The file was left alone (not plain JSON, another tool's slot); `note` says why. */
  skipped?: boolean;
}

export interface InstallOptions {
  /** No sink takes tier ≥ 1: hook one tool event per harness (the heartbeat needs
   *  one), not every one — each hook is a Node start the harness waits for. */
  lean?: boolean;
  /** Files sessionpipe created on an earlier install (from the config), so
   *  uninstall may delete them once they are empty again. */
  created?: string[];
}

export type InstalledState = "current" | "stale" | "missing" | "misplaced" | "inactive";

export interface InstalledReport {
  file: string;
  state: InstalledState;
  /** Why (an inactive harness, a slot another tool holds). */
  note?: string;
}

export interface Adapter {
  readonly name: string;
  /** The harness's own event names this adapter hooks. */
  readonly events: readonly string[];
  /** Is the harness on this machine (a config dir exists)? */
  detect(env?: NodeJS.ProcessEnv): boolean;
  /** Config files the installer would write. */
  configFiles(env?: NodeJS.ProcessEnv): string[];
  install(cmd: HookCommand, env?: NodeJS.ProcessEnv, opts?: InstallOptions): InstallReport[];
  uninstall(env?: NodeJS.ProcessEnv, opts?: InstallOptions): InstallReport[];
  /** Is our hook present, current, and will the harness run it? */
  installed(cmd: HookCommand, env?: NodeJS.ProcessEnv, opts?: InstallOptions): InstalledReport[];
  fromHook(input: HookInput): HookResult | null;
  readTranscript(file: string, fromLine: number): TranscriptRead;
  /** `env` is the hook's own environment, not necessarily this process's: a job swept
   *  by a worker that a different harness's hook spawned has to resolve the harness's
   *  home from the job, the way `install` and `backfill` already do. */
  facts(
    session: { id: string } & Partial<Session>,
    transcript: string | undefined,
    hints: Record<string, unknown>,
    state: FactsState,
    env?: NodeJS.ProcessEnv,
  ): SessionFacts;
  /** What only the harness's own service knows about a session (claude.ai's name for a
   *  Claude Code session), asked over the network with the person's own sign-in. The
   *  worker calls it after `facts`, and only when the person turned it on (config.json
   *  `remote_titles`); never on the hook path. What it returns replaces what `facts`
   *  found; an empty object leaves it. Never rejects: a service it can't ask, or a
   *  sign-in it can't read, is an empty object. */
  remoteFacts?(
    session: { id: string } & Partial<Session>,
    local: SessionFacts,
    transcript: string | undefined,
    state: FactsState,
    env?: NodeJS.ProcessEnv,
  ): Promise<Partial<SessionFacts>>;
  backfill(sinceMs: number, env?: NodeJS.ProcessEnv): BackfillRow[];
}

/** Small per-session memory the facts pass keeps under <state>/facts/. */
export interface FactsState {
  get(harness: string, session: string): Record<string, unknown>;
  save(harness: string, session: string, patch: Record<string, unknown>): void;
}
