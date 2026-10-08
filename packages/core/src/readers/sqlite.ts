// SPDX-License-Identifier: Apache-2.0
// Read-only SQLite, for a harness that keeps its sessions in a database instead of a
// JSONL file. Three ways in, tried in order, because `node:sqlite` does not exist on
// Node 20 (the floor this package builds for) and is behind --experimental-sqlite on
// 22.5–22.12:
//   "node"   in this process, through createRequire — no static import, so the bundle
//            still loads on a Node without the module;
//   "child"  one `node --experimental-sqlite -e …` run through execFileSync: no shell,
//            arguments passed as argv, a short timeout;
//   "cli"    the `sqlite3` binary, when it is on PATH and every parameter is a plain
//            scalar that can be written as a literal.
// Every path opens the file read-only, is bounded in time, and returns null instead of
// throwing: a database that is busy, missing, locked or unreadable costs the caller
// nothing but an empty read.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

export type SqliteParam = string | number;
export type SqliteRow = Record<string, unknown>;
export type SqliteEngine = "auto" | "node" | "child" | "cli";

export interface SqliteOptions {
  /** Busy timeout and the child's wall clock, in ms (default 2000). */
  timeoutMs?: number;
  /** Force one way in; "auto" tries node, then child, then cli (default). */
  engine?: SqliteEngine;
  /** Largest reply a child or the CLI may print (default 32 MB). */
  maxBuffer?: number;
}

interface Statement {
  all(...params: SqliteParam[]): unknown[];
}
interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}
type DbCtor = new (path: string, options?: Record<string, unknown>) => Db;

let ctorCache: DbCtor | null | undefined;
/** `node:sqlite` if this Node has it; null if it does not (Node 20, or 22.x unflagged). */
function dbCtor(): DbCtor | null {
  if (ctorCache !== undefined) return ctorCache;
  ctorCache = null;
  try {
    const req = createRequire(import.meta.url);
    const m = req("node:sqlite") as { DatabaseSync?: unknown };
    if (typeof m?.DatabaseSync === "function") ctorCache = m.DatabaseSync as DbCtor;
  } catch {}
  return ctorCache;
}

/** SQLite gives back strings, numbers, null, BigInt and Uint8Array; the protocol takes JSON. */
function plain(row: unknown): SqliteRow | null {
  if (!row || typeof row !== "object") return null;
  const out: SqliteRow = {};
  for (const [k, v] of Object.entries(row as SqliteRow)) {
    if (typeof v === "bigint") out[k] = Number(v);
    else if (v instanceof Uint8Array) out[k] = null;
    else out[k] = v;
  }
  return out;
}
const rows = (v: unknown): SqliteRow[] | null => {
  if (!Array.isArray(v)) return null;
  const out: SqliteRow[] = [];
  for (const r of v) {
    const p = plain(r);
    if (p) out.push(p);
  }
  return out;
};

function viaNode(file: string, sql: string, params: SqliteParam[], o: Required<SqliteOptions>): SqliteRow[] | null {
  const C = dbCtor();
  if (!C) return null;
  let db: Db;
  try {
    db = new C(file, { readOnly: true, timeout: o.timeoutMs });
  } catch {
    return null;
  }
  try {
    try {
      db.exec(`PRAGMA busy_timeout = ${Math.round(o.timeoutMs)}`);
    } catch {}
    return rows(db.prepare(sql).all(...params));
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

/** Runs in a child Node, with the file, the SQL, the parameters and the timeout as argv. */
const CHILD = `const { DatabaseSync } = require("node:sqlite");
const [, file, sql, params, ms] = process.argv;
const db = new DatabaseSync(file, { readOnly: true, timeout: Number(ms) });
try { db.exec("PRAGMA busy_timeout = " + Number(ms)); } catch {}
const out = db.prepare(sql).all(...JSON.parse(params));
db.close();
process.stdout.write(JSON.stringify(out));`;

function viaChild(file: string, sql: string, params: SqliteParam[], o: Required<SqliteOptions>): SqliteRow[] | null {
  try {
    const out = execFileSync(
      process.execPath,
      ["--experimental-sqlite", "--no-warnings", "-e", CHILD, file, sql, JSON.stringify(params), String(o.timeoutMs)],
      {
        encoding: "utf8",
        timeout: o.timeoutMs + 3000,
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: o.maxBuffer,
        windowsHide: true,
      },
    );
    return rows(JSON.parse(out || "null"));
  } catch {
    return null;
  }
}

/** A parameter safe to write into SQL as a literal: no quote, no backslash, no newline. */
const SAFE = /^[A-Za-z0-9 ._:@/+-]{0,256}$/;
export function inlineParams(sql: string, params: SqliteParam[]): string | null {
  if (sql.includes("'")) return null; // a literal in the SQL would make the `?` count a guess
  const holes = sql.split("?").length - 1;
  if (holes !== params.length) return null;
  let i = 0;
  let bad = false;
  const out = sql.replace(/\?/g, () => {
    const p = params[i++];
    if (typeof p === "number") {
      if (!Number.isFinite(p)) {
        bad = true;
        return "NULL";
      }
      return String(p);
    }
    if (typeof p !== "string" || !SAFE.test(p)) {
      bad = true;
      return "NULL";
    }
    return `'${p}'`;
  });
  return bad ? null : out;
}

function viaCli(file: string, sql: string, params: SqliteParam[], o: Required<SqliteOptions>): SqliteRow[] | null {
  const text = inlineParams(sql, params);
  if (!text) return null;
  try {
    const out = execFileSync("sqlite3", ["-readonly", "-json", file, text], {
      encoding: "utf8",
      timeout: o.timeoutMs + 3000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: o.maxBuffer,
      windowsHide: true,
    }).trim();
    if (!out) return [];
    return rows(JSON.parse(out));
  } catch {
    return null;
  }
}

/** One read-only query. Null means "could not read it", never an exception. */
export function querySqlite(
  file: string,
  sql: string,
  params: SqliteParam[] = [],
  opts: SqliteOptions = {},
): SqliteRow[] | null {
  const o: Required<SqliteOptions> = {
    timeoutMs: opts.timeoutMs ?? 2000,
    engine: opts.engine ?? "auto",
    maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
  };
  if (!file) return null;
  try {
    if (!existsSync(file)) return null;
  } catch {
    return null;
  }
  const ways =
    o.engine === "auto"
      ? ([viaNode, viaChild, viaCli] as const)
      : o.engine === "node"
        ? ([viaNode] as const)
        : o.engine === "child"
          ? ([viaChild] as const)
          : ([viaCli] as const);
  for (const way of ways) {
    const r = way(file, sql, params, o);
    if (r) return r;
  }
  return null;
}

/** Is `node:sqlite` in this process? (Tests skip what they cannot set up.) */
export const sqliteInProcess = (): boolean => dbCtor() !== null;
