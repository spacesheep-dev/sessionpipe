// SPDX-License-Identifier: Apache-2.0
// `sessionpipe control status` at a terminal: the background service's own account of
// itself, set out for a person. A pipe and --json still get the JSON it always printed
// (control/cli.ts), which is what scripts and other tools read.
import { type Group, group } from "../report.js";
import { mark, span, tint, type Ui } from "../style.js";
import { ago, type UpdateRecord } from "./autoupdate.js";
import type { Status } from "./daemon.js";

/** A URL's host, or the word itself where it isn't one. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

const many = (n: number, one: string, more = `${one}s`): string => `${n} ${n === 1 ? one : more}`;

/** How long ago a receiver was last heard from: a long-poll answers every 25 s at most,
 *  so anything under five seconds is "just now". */
export const heardAgo = (ms: number): string => (ms < 5000 ? "just now" : `${span(ms)} ago`);

/** Whether a receiver is being heard from now. A normal long-poll takes 25 s (35 s
 *  deadline): one minute is allowed at startup and between answers, and a loop that
 *  stopped or is backing off is said at once. */
export function isLive(r: { polling: boolean; last_poll_age_ms: number | null }): boolean {
  return r.polling && (r.last_poll_age_ms === null || r.last_poll_age_ms < 60_000);
}

export function statusView(ui: Ui, st: Status, now: number): string[] {
  const messages: Group = {
    title: "Messages from",
    rows: st.receivers.map((r) =>
      isLive(r)
        ? {
            mark: "ok" as const,
            label: hostOf(r.url),
            value: `live · ${r.last_poll === null ? "just connected" : `heard ${heardAgo(r.last_poll_age_ms)}`} · ${many(r.keys, "key")} trusted`,
          }
        : {
            mark: "bad" as const,
            label: hostOf(r.url),
            value: `not live for ${span(r.last_poll_age_ms)}: ${r.last_error ?? (r.polling ? "no answer yet" : "it stopped asking")}`,
          },
    ),
  };
  if (!messages.rows.length)
    messages.rows.push({ mark: "info", label: "nobody", value: "this computer takes no messages" });
  const now_: Group = {
    title: "Right now",
    rows: [
      { mark: "info", label: "in hand", value: st.busy ?? "nothing: it could restart at any moment" },
      {
        mark: "info",
        label: "sessions",
        value: `${st.mid_turn.length} mid-turn · ${st.waiting.length} waiting for a message · ${many(st.attentions.length, "question")} held`,
      },
      ...(st.sdk.length ? [{ mark: "info" as const, label: "kept open", value: many(st.sdk.length, "session") }] : []),
      ...(st.acks_pending ? [{ mark: "info" as const, label: "to send", value: many(st.acks_pending, "answer") }] : []),
    ],
  };
  const can: Group = {
    title: "It can",
    rows: [
      {
        mark: "info",
        label: "start a session in",
        value: Object.keys(st.start).join(", ") || "no agent on this computer",
      },
      {
        mark: "info",
        label: "let agents ask agents",
        value: st.ask.on ? `yes: ${st.ask.harnesses.join(", ") || "none installed"}` : "no (`sessionpipe ask on`)",
      },
      // A pool nobody set up is nothing this service can do yet.
      ...(st.pool && (st.pool.on || st.pool.accounts)
        ? [
            {
              mark: (st.pool.on && !st.pool.listening && !st.pool.another_daemon ? "bad" : "info") as "bad" | "info",
              label: "pool Claude accounts",
              value: st.pool.on
                ? `on · ${many(st.pool.accounts, "account")}, ${st.pool.with_room} with room left · ${
                    st.pool.listening
                      ? `127.0.0.1:${st.pool.port}`
                      : st.pool.another_daemon
                        ? "another service answers for it"
                        : "its listener is not up"
                  }`
                : `off · ${many(st.pool.accounts, "account")}`,
            },
          ]
        : []),
    ],
  };
  const u = (st.update ?? null) as UpdateRecord | null;
  const updates: Group = { title: "Updates", rows: [] };
  if (u) {
    updates.rows.push(
      u.off
        ? { mark: "info", label: "by hand", value: u.off }
        : {
            mark: "ok",
            label: "automatic",
            value: u.checked_at
              ? u.error
                ? `the check ${ago(u.checked_at, now)} failed: ${u.error}`
                : `checked ${ago(u.checked_at, now)}: ${u.latest ?? "?"} is the newest`
              : "once a day; not checked yet",
          },
    );
    if (u.pending)
      updates.rows.push({ mark: "info", label: "waiting", value: `${u.pending}, until nothing is in hand` });
    if (u.failed)
      updates.rows.push({
        mark: "warn",
        label: "failed",
        value: `installing ${u.failed.version} ${ago(u.failed.at, now)}: ${u.failed.error}`,
      });
  }
  return [
    `${mark(ui, "ok")} ${tint(ui, "bold", tint(ui, "green", "The background service is running"))}`,
    tint(ui, "dim", `  sessionpipe ${st.version} · pid ${st.pid} · ${st.name}`),
    ...[messages, now_, can, updates].filter((g) => g.rows.length).flatMap((g) => ["", ...group(ui, g)]),
    "",
    tint(ui, "dim", "  Every field: sessionpipe control status --json"),
  ];
}
