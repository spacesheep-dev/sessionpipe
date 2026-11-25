// SPDX-License-Identifier: Apache-2.0
// The places a rule's folder may not be, hold or lie in, for this machine (CONTROL.md §14.1): the
// home folder, the folder config.json (and triggers.json) is in, and the state folder. The CLI and
// the daemon both read them here, so they agree on which folders a rule is refused for.
import path from "node:path";
import { configFile, homeDir, stateDir } from "../paths.js";
import type { TriggerPlaces } from "./rules.js";

/** This machine's places, from the environment the CLI or the daemon runs in. */
export function triggerPlaces(env: NodeJS.ProcessEnv = process.env): TriggerPlaces {
  return { home: homeDir(), config: path.dirname(configFile(env)), state: stateDir(env) };
}
