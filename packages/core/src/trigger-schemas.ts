// SPDX-License-Identifier: Apache-2.0
// The schemas of the machine's own trigger files and what `sessionpipe trigger … --json` prints
// (config.proto, generated into gen/config-schemas.ts), and the checker, for the CLI and the
// background service: the package's main entry, so a build of the CLI reaches them as it reaches
// everything else of core.
export { CONFIG_SCHEMAS } from "../gen/config-schemas.js";
export { problems } from "./schema/validate.js";
