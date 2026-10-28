// SPDX-License-Identifier: Apache-2.0
/** @sessionpipe/core — protocol types, adapters, privacy, outbox, sinks. Zero runtime dependencies. */
export const PROTOCOL_VERSION = 1 as const;
export * as claudePool from "./adapters/claude-code-pool.js";
export * from "./adapters/index.js";
export { type Config, DEFAULT_CONFIG, machineName, readConfig, type SinkConfig, writeConfig } from "./config.js";
export { type EventContext, makeEvent } from "./events.js";
export { LAUNCHED_BY_ENV, launchedBy, readHook } from "./launched-by.js";
export { Cursors, Outbox, type OutboxRef, processAlive, takeLock, takeNamedLock } from "./outbox.js";
export { configFile, homeDir, safeId, stateDir, tilde, untilde } from "./paths.js";
export * from "./privacy/index.js";
export { gitFacts, stripCredentials } from "./readers/git.js";
export { isInjected, pairTurns, readAntigravity, readClaude, readCodex, readGemini } from "./readers/transcripts.js";
export { shortId } from "./short-id.js";
export * from "./sinks/index.js";
export type * from "./types.js";
export { isUlid, ulid } from "./ulid.js";
