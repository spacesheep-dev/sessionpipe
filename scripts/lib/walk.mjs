// SPDX-License-Identifier: Apache-2.0
// Every file under a fixture folder, for the scripts that read conformance/: the conformance
// check, the secret scan and the tier-golden recorder. A fixture tree is plain files in plain
// folders. A symbolic link in it would have a script read (or write) somewhere the folder's
// name does not say, on a maintainer's machine or a CI runner, so one is an error that names
// it, never followed and never skipped.
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

/** Throws when `p` is a symbolic link; a path that is not there is fine. */
export function refuseLink(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`${p} is a symbolic link; fixtures are plain files in plain folders`);
}

/** The files under `dir`, sorted, folders walked; [] when `dir` is not there. */
export function walkFiles(dir) {
  refuseLink(dir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return entries
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${p} is a symbolic link; fixtures are plain files in plain folders`);
      return entry.isDirectory() ? walkFiles(p) : [p];
    });
}
