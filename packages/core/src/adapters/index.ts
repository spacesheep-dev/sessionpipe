// SPDX-License-Identifier: Apache-2.0
// The registry: the only place that lists vendors. A new harness is one file here
// plus its fixtures and its row in spec/ADAPTERS.md.
import { acpHarnesses } from "./acp-control.js";
import { antigravity } from "./antigravity.js";
import { findAgy } from "./antigravity-control.js";
import { claudeCode } from "./claude-code.js";
import { findClaude } from "./claude-code-control.js";
import { codex } from "./codex.js";
import { findCodex } from "./codex-control.js";
import { devin } from "./devin.js";
import { geminiCli } from "./gemini-cli.js";
import type { Adapter } from "./types.js";

export const ADAPTERS: readonly Adapter[] = [claudeCode, codex, geminiCli, antigravity, devin];
export const adapterByName = (name: string): Adapter | undefined => ADAPTERS.find((a) => a.name === name);
export * as acpControl from "./acp-control.js";
export { AG_STALE_PRETOOL, antigravityAnswer } from "./antigravity.js";
export * as antigravityControl from "./antigravity-control.js";
export { claudeAccounts, claudeDirs, notClaudeCode } from "./claude-code.js";
export * as claudeControl from "./claude-code-control.js";
export * as codexControl from "./codex-control.js";
export { DEVIN_EVENTS, devinConfigDir, devinDataDir, readDevinChain } from "./devin.js";
export {
  deniedNote,
  JOB_TIMEOUT_MS,
  jobEnv,
  type Login,
  type Reading,
  type RunOptions,
  type RunResult,
  runHeadless,
} from "./headless.js";

/** How many harnesses a pairing request or a hello lists at most (control-pair.json,
 *  control-hello.json). */
export const HELLO_HARNESSES_MAX = 20;

/** The harnesses a control daemon here can drive headlessly (CONTROL.md §6): each whose
 *  CLI is installed on this machine, and every ACP agent that is. What `control pair`
 *  and every hello advertise: the three with their own drivers first, then the ACP
 *  agents in the registry's order, at most HELLO_HARNESSES_MAX of them. */
export function drivableHarnesses(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...(findClaude(env) ? ["claude-code"] : []),
    ...(findCodex(env) ? ["codex"] : []),
    ...(findAgy(env) ? ["antigravity"] : []),
    ...acpHarnesses(env),
  ].slice(0, HELLO_HARNESSES_MAX);
}
export type {
  Adapter,
  AdapterEvent,
  BackfillRow,
  FactsState,
  HookCommand,
  HookInput,
  HookResult,
  InstallReport,
  SessionFacts,
  TranscriptRead,
  Turn,
} from "./types.js";
export { antigravity, claudeCode, codex, devin, geminiCli };
