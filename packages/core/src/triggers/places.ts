// SPDX-License-Identifier: Apache-2.0
// The places a rule's folder is checked against, for this machine (CONTROL.md §14.1, *The folder's
// floor*), and the check on real paths. The CLI, when it adds a rule, and the daemon, when it runs
// one, both read them here, so they agree on which folders a rule is refused for.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { ADAPTERS } from "../adapters/index.js";
import { configFile, homeDir, stateDir } from "../paths.js";
import { expandFolder, folderProblem, type TriggerPlaces } from "./rules.js";

/** This machine's places, from the environment the CLI or the daemon runs in: the home folder,
 *  the folder config.json (and triggers.json) is in, the state folder, and the folder each
 *  adapter's own config files are in (`~/.claude`, or `CLAUDE_CONFIG_DIR`; `~/.codex`, or
 *  `CODEX_HOME`; …), read from the adapters rather than listed here, and on Windows `%APPDATA%`
 *  and `%LOCALAPPDATA%`. Read from the environment of the process that checks: `trigger add` sees
 *  the person's shell and the daemon its own (CONTROL.md §14.1), and a rule must pass both. */
export function triggerPlaces(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TriggerPlaces {
  const harnesses = [...new Set(ADAPTERS.flatMap((a) => a.configFiles(env)).map((f) => path.dirname(f)))];
  // On Windows, where the system starts things from and reads at sign-in.
  const system = platform === "win32" ? [env.APPDATA, env.LOCALAPPDATA].filter((d): d is string => !!d) : [];
  return { home: homeDir(), config: path.dirname(configFile(env)), state: stateDir(env), harnesses, system, platform };
}

/** A path with every link resolved and in the case the file system keeps (`realpathSync.native`:
 *  plain `realpathSync` keeps the case it was typed in): for a path that isn't there yet, its
 *  nearest existing folder resolved and the rest appended. */
export function realPath(p: string): string {
  const abs = path.resolve(p);
  // The root always exists, so this ends there at the latest.
  if (existsSync(abs)) return realpathSync.native(abs);
  return path.join(realPath(path.dirname(abs)), path.basename(abs));
}

/** folderProblem on real paths: the folder and every place resolved first, so a link to the home
 *  folder or to sessionpipe's config is refused for what it points at. What the CLI checks when it
 *  adds a rule and the daemon at every run. */
export function realFolderProblem(folder: string, places: TriggerPlaces): string | null {
  const home = realPath(places.home);
  return folderProblem(realPath(expandFolder(folder, places.home, places.platform)), {
    home,
    config: realPath(places.config),
    state: realPath(places.state),
    harnesses: places.harnesses.map(realPath),
    system: places.system.map(realPath),
    platform: places.platform,
  });
}
