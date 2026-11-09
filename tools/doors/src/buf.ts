// SPDX-License-Identifier: Apache-2.0
// `buf lint` and `buf build` on proto/: the FileDescriptorSet with comments, as bytes. The buf
// binary is the npm package's; its cache goes under the OS temp dir unless BUF_CACHE_DIR says
// otherwise, so a build needs nothing in the home directory.
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface BufOptions {
  /** The repository root: where node_modules and proto/ are. */
  root: string;
  /** The module to build; `<root>/proto` when left out. */
  protoDir?: string;
  /** The buf binary; the npm package's when left out. */
  buf?: string;
  /** For the tests: Windows needs a shell for the `.cmd` shim. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function run(args: string[], o: BufOptions): Buffer {
  const platform = o.platform ?? process.platform;
  const win = platform === "win32";
  const r = spawnSync(o.buf ?? path.join(o.root, "node_modules", ".bin", win ? "buf.cmd" : "buf"), args, {
    cwd: o.protoDir ?? path.join(o.root, "proto"),
    env: { BUF_CACHE_DIR: path.join(os.tmpdir(), "sessionpipe-buf-cache"), ...(o.env ?? process.env) },
    maxBuffer: 64 * 1024 * 1024,
    shell: win,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`buf ${args[0]} failed:\n${r.stderr.toString()}`);
  return r.stdout;
}

/** `buf lint`; throws with buf's words on a miss. */
export function lint(o: BufOptions): void {
  run(["lint"], o);
}

/** The descriptors of every file in the module, with source info (comments). */
export function build(o: BufOptions): Uint8Array {
  return new Uint8Array(run(["build", "-o", "-"], o));
}
