// SPDX-License-Identifier: Apache-2.0
// What the daemon does with a `pool` request, whoever asked: a signed `pool` command
// from a receiver (CONTROL.md §6) or `sessionpipe pool …` over the local socket. One
// mapping from action to façade call to ack, so both paths answer the same way. The
// receiver's actions are the spec's; `import` and `status` are the terminal's own.
import type { ControlCommand } from "@sessionpipe/core/control";
import { type Pool, type PoolAccount, PoolError, type PoolStatus, summaryLine } from "../pool/index.js";
import type { PoolOp } from "./local.js";

export interface PoolRequest {
  action: PoolOp;
  account?: string;
  order?: string[];
  code?: string;
}

/** What `pool add --import` did, without the credentials the façade also returns:
 *  those go to the secrets store and nowhere else, the socket included. */
export interface Imported {
  added: { account: PoolAccount; dir: string }[];
  skipped: { dir: string; email?: string; why: string }[];
}

export type PoolOutcome =
  | { outcome: "delivered"; detail: string; status: PoolStatus; imported?: Imported }
  | { outcome: "refused" | "failed" | "unsupported"; code?: string; detail: string; status?: PoolStatus };

/** A signed `pool` command's fields, as parseCommand already checked them (the action
 *  is one of the spec's, and each action carries exactly its own fields). */
export function poolRequestOf(cmd: ControlCommand): PoolRequest {
  return {
    action: cmd.pool_action as PoolOp,
    ...(cmd.pool_account !== undefined ? { account: cmd.pool_account } : {}),
    ...(cmd.pool_order !== undefined ? { order: cmd.pool_order } : {}),
    ...(cmd.pool_code !== undefined ? { code: cmd.pool_code } : {}),
  };
}

/** Run one request against the façade. `unsupported` when this daemon has no pool;
 *  a PoolError becomes the ack its code names (refused: pool_account, pool_order,
 *  pool_off; failed: login, pool); anything else that throws is `failed` `pool`.
 *  `detail` never carries a token, a code or an email the asker didn't name.
 *
 *  `terminal`: the person at the machine asked (the local socket, the CLI). The
 *  vendor is then called whether or not the pool is on — signing an account in or
 *  reading its usage is theirs to ask for, as `pool add` works while off — where a
 *  receiver gets `pool_off` (CONTROL.md §6, PRIVACY.md §3). */
export async function runPoolRequest(
  pool: Pool | undefined,
  req: PoolRequest,
  o: { terminal?: boolean } = {},
): Promise<PoolOutcome> {
  if (!pool) return { outcome: "unsupported", detail: "this machine can't pool: its daemon runs without the pool" };
  const gate = () => {
    if (!o.terminal) pool.requireOn();
  };
  try {
    switch (req.action) {
      case "status":
        break;
      case "on":
        await pool.setOn(true);
        break;
      case "off":
        await pool.setOn(false);
        break;
      case "enable":
        pool.enable(req.account as string);
        break;
      case "disable":
        pool.disable(req.account as string);
        break;
      case "remove":
        pool.remove(req.account as string);
        break;
      case "order":
        pool.order(req.order ?? []);
        break;
      case "refresh":
        gate();
        await pool.refresh(req.account);
        break;
      case "login.begin": {
        gate();
        const b = pool.beginLogin();
        return { outcome: "delivered", detail: `${b.id} ${b.url}`, status: pool.status() };
      }
      case "login.complete":
        gate();
        await pool.completeLogin(req.code as string, req.account);
        break;
      case "import": {
        // The terminal's own: a receiver may not ask a machine to read its logins.
        if (!o.terminal) return { outcome: "refused", code: "bad_fields", detail: "import is asked at the machine" };
        const r = await pool.addImport();
        const s = pool.status();
        return {
          outcome: "delivered",
          detail: summaryLine(s),
          status: s,
          imported: { added: r.added.map(({ account, dir }) => ({ account, dir })), skipped: r.skipped },
        };
      }
      default:
        return { outcome: "refused", code: "bad_fields", detail: `no pool action ${String(req.action)}` };
    }
  } catch (e) {
    const status = pool.status();
    if (e instanceof PoolError)
      return {
        outcome: e.code === "login" || e.code === "pool" ? "failed" : "refused",
        code: e.code,
        detail: e.message,
        status,
      };
    return { outcome: "failed", code: "pool", detail: String((e as Error)?.message || e), status };
  }
  const s = pool.status();
  return { outcome: "delivered", detail: summaryLine(s), status: s };
}
