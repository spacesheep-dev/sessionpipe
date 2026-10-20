// SPDX-License-Identifier: Apache-2.0

/** A thread another thread started — a subagent, a review — names a `source.subagent`
 *  in its own metadata (the rollout's first record). A fork the person made carries
 *  only `forked_from_id`, and is a session of its own. */
export function codexSubagent(meta: Record<string, unknown> | null | undefined): boolean {
  if (meta?.type !== "session_meta") return false;
  const p = meta.payload as { source?: { subagent?: unknown } } | undefined;
  return !!p?.source?.subagent;
}

/** A fork starts with its own metadata, then replays the parent's history. Only
 *  an event naming the new thread establishes where its own records begin. */
export function codexReplayBoundary(meta: Record<string, unknown> | null | undefined) {
  if (meta?.type !== "session_meta") return undefined;
  const p = meta.payload as { id?: unknown; forked_from_id?: unknown; source?: { subagent?: unknown } } | undefined;
  if (!p || (!p.forked_from_id && !p.source?.subagent)) return undefined;
  return (record: Record<string, unknown> | null) =>
    typeof p.id === "string" &&
    !!p.id &&
    record?.type === "event_msg" &&
    (record.payload as { thread_id?: unknown } | undefined)?.thread_id === p.id;
}
