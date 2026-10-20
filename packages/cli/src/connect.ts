// SPDX-License-Identifier: Apache-2.0
// The pure half of `sessionpipe connect`: which folders a machine allows sessions you
// message to run in, when nobody said. Never the home folder or anything above it:
// "allow everything I own" is not a default anyone should find out about later.
import path from "node:path";

/** The home folder, or a folder that contains it (/, /Users), or the filesystem root. */
export function isBroad(dir: string, home: string): boolean {
  const d = path.resolve(dir);
  const h = path.resolve(home);
  if (d === path.parse(d).root) return true;
  // A resolved path ends with the separator only when it is the root, answered above.
  return d === h || h.startsWith(/* v8 ignore next */ d.endsWith(path.sep) ? d : d + path.sep);
}

// `parent` is a resolved, non-root folder (isBroad keeps the root out): it never ends with the separator.
const inside = (child: string, parent: string): boolean =>
  child !== parent && child.startsWith(/* v8 ignore next */ parent.endsWith(path.sep) ? parent : parent + path.sep);

export interface FolderChoice {
  folders: string[];
  /** Where they came from: the flags, the machine's own list, the folder this ran in,
   *  the folders recent sessions ran in, or nowhere. */
  from: "flags" | "existing" | "here" | "recent" | "none";
}

/** `recent`: the folders this machine's sessions ran in, newest first. */
export function connectFolders(o: {
  cwd: string;
  home: string;
  flags: string[];
  existing: string[];
  recent: string[];
  exists?: (dir: string) => boolean;
  max?: number;
}): FolderChoice {
  if (o.flags.length) return { folders: o.flags.map((d) => path.resolve(d)), from: "flags" };
  if (o.existing.length) return { folders: [], from: "existing" };
  if (!isBroad(o.cwd, o.home)) return { folders: [path.resolve(o.cwd)], from: "here" };
  const exists = o.exists ?? (() => true);
  const picked: string[] = [];
  for (const raw of o.recent) {
    if (!raw || !path.isAbsolute(raw)) continue;
    const d = path.resolve(raw);
    if (isBroad(d, o.home) || picked.includes(d) || !exists(d)) continue;
    if (picked.some((p) => inside(d, p))) continue;
    // A wider folder replaces the narrower ones already picked under it.
    for (let i = picked.length - 1; i >= 0; i--) if (inside(picked[i] as string, d)) picked.splice(i, 1);
    picked.push(d);
    if (picked.length >= (o.max ?? 8)) break;
  }
  return picked.length ? { folders: picked, from: "recent" } : { folders: [], from: "none" };
}

/** The tier `connect` reports at: --tier when given; otherwise 2 (what a session board
 *  needs: the asks and the answers, secrets removed), never lowering a sink set higher. */
export function connectTier(flag: string | undefined, current: number | undefined): 0 | 1 | 2 | 3 {
  if (flag !== undefined && flag !== "")
    return Math.max(0, Math.min(3, Math.trunc(Number(flag)) || 0)) as 0 | 1 | 2 | 3;
  return Math.max(2, Math.min(3, current ?? 0)) as 2 | 3;
}
