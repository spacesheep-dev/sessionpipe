// SPDX-License-Identifier: Apache-2.0
/** @sessionpipe/core — protocol types, adapters, privacy, outbox, sinks. Zero runtime dependencies. */
export const PROTOCOL_VERSION = 1 as const;
export * from "./adapters/index.js";
export { type Config, DEFAULT_CONFIG, machineName, readConfig, type SinkConfig, writeConfig } from "./config.js";
export { type EventContext, makeEvent } from "./events.js";
export { Cursors, Outbox, type OutboxRef, processAlive, takeLock, takeNamedLock } from "./outbox.js";
export { configFile, HOME, safeId, stateDir, tilde } from "./paths.js";
export * from "./privacy/index.js";
export { gitFacts, stripCredentials } from "./readers/git.js";
export { isInjected, pairTurns, readAntigravity, readClaude, readCodex, readGemini } from "./readers/transcripts.js";
export * from "./sinks/index.js";
export type * from "./types.js";
export { isUlid, ulid } from "./ulid.js";
