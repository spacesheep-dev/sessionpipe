// SPDX-License-Identifier: Apache-2.0
// The routing rule (spec/CONTROL.md §6): the first delivery mode that fits, top to
// bottom. Pure, so every branch is a unit test.
import { acpControl, isUlid, shortId } from "@sessionpipe/core";
import { type ControlKind, type CopyWhy, frameHandoff as handoffFrame } from "@sessionpipe/core/control";

// The words around a delivered message have one definition, in core, where the
// transcript readers take them off again (sessionpipe-core/control `deliveredWords`):
// the daemon builds every frame with these, so a sentence cannot change on one side only.
export {
  copyNote,
  frame,
  frameAsk,
  frameMarked,
  frameStart,
  hostOf,
  IN_PLACE_ANSWER,
  messageMark,
  unframe,
} from "@sessionpipe/core/control";

export type DeliveryMode = "sdk" | "waiter" | "turn" | "inbox" | "api" | "resume" | "fork";

export interface SessionView {
  harness: string;
  /** The daemon holds this session through the Agent SDK right now. */
  sdk: boolean;
  /** A `sessionpipe wait` for it is parked on the socket. */
  waiter: boolean;
  /** Between a turn's start and its Stop (the Stop hook will ask). */
  midTurn: boolean;
  /** A live, idle, vetted session whose own permission class is this machine's: its own
   *  local inbox takes the message (§6.3). */
  inbox: boolean;
  /** What holds the session right now, as far as this machine can tell, or null when
   *  nothing does (§6, What counts as held): a live Claude Code window (`open`), another
   *  live process of the harness (`running`), or only a write to its transcript too
   *  recent to account for (`recent`). Held, it is never resumed. */
  held: Holder | null;
  /** The transcript exists on this machine (Codex, Antigravity: the session was placed). */
  known: boolean;
  /** This Claude Code can copy a session (`--fork-session`); no other harness can. */
  canFork: boolean;
  /** The harness's binary was found at all (Claude Code only; absent means yes). A
   *  missing binary reads as no capabilities, which used to be blamed on `--fork-session`. */
  installed?: boolean;
  /** It already has a copy, which is where its messages go: a copy is a leaf and is
   *  never itself copied (§6 `prompt`). */
  copied: boolean;
  /** It is itself a copy this machine made of another session, named here by its own
   *  id: as much a leaf as when it is reached through the original's. */
  isCopy?: boolean;
  /** The harness has an input API (OpenCode, Codex app-server) — none is wired yet. */
  api: boolean;
}

/** What holds a session (SessionView `held`): the same three a copy records as its why. */
export type Holder = CopyWhy;

/** What held it, in words, for the person: why a copy was made (the ack's `detail`, the
 *  copy's record), or why nothing could be done. `what` is the thing that was held: the
 *  session, or the copy its messages go to. Each is only what the machine found: a
 *  session written to seconds ago by a headless run that has since exited was never
 *  "open in a window" (2026-11-10). */
export const HELD: Record<Holder, (what: string) => string> = {
  open: (what) => `${what} was open in Claude Code on this computer (a terminal window or the Claude app)`,
  running: (what) => `another Claude Code process on this computer was running ${what}`,
  recent: (what) =>
    `the transcript of ${what} had been written to in the last 90 seconds by a process this computer could not find`,
};

/** How long a session's own hooks are taken at their word that a turn is running in it,
 *  counted from the last thing they said: a session killed mid-turn never sends its Stop. */
export const HOOKS_WORD_MS = 10 * 60_000;

/** What holds a Claude Code session, from what the machine can see of it (§6, What counts
 *  as held; conformance/control-held.json): the live rows of the harness's own session
 *  registry that name it — a window if any of them is one, else another process's run —
 *  with no row, whether its transcript was written to too recently to account for
 *  (core's `recentWrite`), and with neither, whether its own hooks say a turn is running
 *  in it (`turn`: another process's run the registry does not show). Null: nothing holds
 *  it, and it is resumed in place. */
export function holderOf(rows: readonly { kind: string | null }[], recent: boolean, turn = false): Holder | null {
  if (rows.length) return rows.some((x) => x.kind === "interactive") ? "open" : "running";
  if (recent) return "recent";
  return turn ? "running" : null;
}

/** A start or a prompt on its way to being a turn in hand, as a cancel sees it: when it
 *  was signed, whether anything but its own checks stands between it and being in hand
 *  (a prompt that waits behind another message's turn is not `ready`), and the names its
 *  session goes by on this machine. */
export interface ComingTurn {
  iat: number;
  ready: boolean;
  names: readonly string[];
}

/** Does a cancel wait before it acts (§6 `cancel`; conformance/control-cancel-waits.json)?
 *  Only with nothing in hand for its session, and only for a start or a prompt for that
 *  session that has arrived, is in its own checks, and was signed no later than the
 *  cancel: a Stop is for what was sent before it, and never for what was sent after. */
export function cancelWaits(
  inHand: boolean,
  coming: Iterable<ComingTurn>,
  names: readonly string[],
  iat: number,
): boolean {
  if (inHand) return false;
  for (const c of coming) if (c.ready && c.iat <= iat && c.names.some((n) => names.includes(n))) return true;
  return false;
}

/** A copy's ack `detail` opens with this, then why (`HELD`). */
export const COPY_RAN = "ran in a copy, because";
/** The same for a later message, which resumes the copy made earlier. */
export const COPY_AGAIN = "ran in the copy made earlier, because";
/** …and where the copy's record says nothing this machine would repeat (store.ts `Copy`). */
export const COPY_AGAIN_BARE = "ran in the copy this session's messages go to";

export type Route = { mode: DeliveryMode } | { unsupported: string } | { refused: "no_session" };

/** The harnesses the daemon can run a turn of by itself: resume an idle session, start a
 *  new one (`claude -p`, `codex exec`, `agy -p`, or any ACP agent as its client). */
export const HEADLESS = new Set(["claude-code", "codex", "antigravity", ...acpControl.ACP_HARNESSES]);

/** The ladder in one place, so its order is a fact and not a shape of the code: the
 *  first rung that fits wins (spec/CONTROL.md §6). The in-place rungs come first,
 *  because the session answers in the person's own window or thread, in its own
 *  permission mode, with nothing started and nothing replayed. Among those, the ones
 *  the session itself opened — a parked waiter, a running turn — come before the one
 *  where the daemon writes to it unasked. */
export const DELIVERY_LADDER = ["sdk", "waiter", "turn", "inbox", "api", "resume", "fork"] as const;

/** Does `a` sit above `b` on the ladder? The rungs above `inbox` are all free to test,
 *  so a message that takes one of them never pays for the inbox's own look. */
export const earlier = (a: DeliveryMode, b: DeliveryMode): boolean =>
  DELIVERY_LADDER.indexOf(a) < DELIVERY_LADDER.indexOf(b);

/** Whether each rung fits this session, as the ladder walks it. */
const FITS: Record<DeliveryMode, (s: SessionView) => boolean> = {
  sdk: (s) => s.sdk,
  waiter: (s) => s.waiter,
  turn: (s) => s.midTurn,
  inbox: (s) => s.inbox,
  api: (s) => s.api,
  resume: (s) => HEADLESS.has(s.harness) && s.known && !s.held,
  fork: (s) => HEADLESS.has(s.harness) && s.known && !!s.held && s.canFork && !s.copied && !s.isCopy,
};

/** Where a prompt (or a start) goes. Never two writers on one transcript: a live
 *  session gets an in-place lane or a fork, never a resume. */
/** Said when no `claude` can be found: at daemon start, in a failed ack, and where a
 *  missing binary would otherwise read as a Claude Code without `--fork-session`. */
export const CLAUDE_NOT_FOUND =
  "Claude Code not found on this computer: no `claude` on the daemon's PATH or in the usual folders (nvm, fnm, volta, asdf, Homebrew, ~/.local/bin, the desktop app). Run `sessionpipe connect` again from a shell where `claude` works, or set SESSIONPIPE_CLAUDE to its path in the daemon's service file";

export function routePrompt(s: SessionView): Route {
  for (const mode of DELIVERY_LADDER) if (FITS[mode](s)) return { mode };
  if (!HEADLESS.has(s.harness)) return { unsupported: `no idle delivery for ${s.harness} yet` };
  if (!s.known) return { refused: "no_session" };
  if (s.harness === "claude-code" && s.installed === false) return { unsupported: CLAUDE_NOT_FOUND };
  // Known, headless, and not resumed: something holds it (FITS.resume took every other case).
  const held = s.held as Holder;
  // Only a write that recent passes on its own: the rest is for the person to end.
  const again = held === "recent" ? ": send it again in a couple of minutes" : "";
  return {
    unsupported:
      s.harness === "claude-code"
        ? s.copied
          ? `${HELD[held]("the copy this session's messages go to")}, and a copy is never itself copied${again}`
          : s.isCopy
            ? `${HELD[held]("that copy")}, and a copy is never itself copied${again}`
            : `${HELD[held]("the session")}, and this Claude Code can't copy it (no --fork-session)${again}`
        : `that ${s.harness} session was written to in the last 90 seconds, so ${s.harness} may still have it open, and a ${s.harness} session can't be copied: send it again once it has been idle a couple of minutes`,
  };
}

/** How each kind is delivered, before the session's state is looked at. */
export function kindPath(
  kind: ControlKind,
  harness: string,
): "prompt" | "permission" | "cancel" | "start" | "pool" | { unsupported: string } {
  switch (kind) {
    case "prompt":
      return "prompt";
    case "permission.answer":
      return harness === "gemini-cli"
        ? { unsupported: "Gemini CLI has no permission answer channel" }
        : harness === "devin"
          ? { unsupported: "Devin has no permission answer channel" }
          : "permission";
    case "cancel":
      return "cancel";
    case "start":
      return HEADLESS.has(harness) ? "start" : { unsupported: `can't start a ${harness} session` };
    // No session at all (`sessionpipe:pool`): the machine's pool, whatever harness is asked.
    case "pool":
      return "pool";
    default:
      return { unsupported: `unknown kind ${String(kind)}` };
  }
}

/** What a `cancel` finds when it looks at the session (CONTROL.md §6 `cancel`). */
export interface CancelView {
  harness: string;
  /** The daemon holds the session (the Agent SDK, an ACP agent): its own interrupt. */
  held: boolean;
  /** The daemon is running a headless turn for it as its own child process. */
  own: boolean;
  /** A live interactive Claude Code process holds it: a terminal window, the Claude app. */
  open: boolean;
  /** A live Claude Code process of another kind holds it (a `claude -p` someone else
   *  started): its pid. */
  foreign: number | null;
  /** The session's own hooks say a turn is running. */
  midTurn: boolean;
}

/** A `cancel`'s `detail`, case by case: what was stopped, or why nothing could be, in
 *  words the person who pressed Stop can act on. A receiver shows them as they are. */
export const CANCEL = {
  stopped: "stopped the turn this computer was running for that session",
  finished: "the turn this computer was running for that session finished before it could be stopped",
  /** A start's own final ack (`failed`, code `cancelled`) when the Stop came before its
   *  process began: nothing was started, so nothing is called delivered. */
  unstarted: "stopped before it started, as asked: no session was created",
  open: "that session is open in Claude Code on this computer (a terminal window or the Claude app), and a turn there can only be stopped in its own window: press Esc there",
  foreign: (pid: number) =>
    `a Claude Code process this computer's daemon didn't start is running that session (pid ${pid}), and the daemon only stops turns it runs itself: stop it where it was started`,
  unseen:
    "a turn is running in that session, in a process this computer's daemon didn't start and can't find: stop it where it runs",
  nothing: "nothing is running in that session as far as this computer can tell, so there was nothing to stop",
  other: (harness: string) =>
    `this computer's daemon isn't running that ${harness} session, and it has no way to stop a turn it didn't start: stop it in ${harness} itself`,
} as const;

export type CancelRoute = { stop: "held" | "own" } | { outcome: "unsupported" | "expired"; detail: string };

/** What a `cancel` does (CONTROL.md §6 `cancel`). The daemon stops what is its own to
 *  stop — a session it holds, through that session's interrupt; a headless turn it runs,
 *  by ending the child process it spawned — and nothing else: a turn in a process it did
 *  not start is that process's own, and is never signalled. There the ack says who has
 *  it, which is what the person needs to stop it themselves; and a session nothing is
 *  running in is `expired`: the turn ended before the Stop arrived. Only Claude Code
 *  files a registry this can be read from, so any other harness's session is
 *  `unsupported` whatever its hooks last said. */
export function routeCancel(s: CancelView): CancelRoute {
  if (s.held) return { stop: "held" };
  if (s.own) return { stop: "own" };
  if (s.harness !== "claude-code") return { outcome: "unsupported", detail: CANCEL.other(s.harness) };
  if (s.open) return { outcome: "unsupported", detail: CANCEL.open };
  if (s.foreign !== null) return { outcome: "unsupported", detail: CANCEL.foreign(s.foreign) };
  if (s.midTurn) return { outcome: "unsupported", detail: CANCEL.unseen };
  return { outcome: "expired", detail: CANCEL.nothing };
}

/** What the daemon looks for in the row a session's transcript records for a channel's
 *  message (§8), as core's `messageMark` is for the other in-place lanes: `sessionpipe
 *  channel` names the message's id on its `<channel>` tag, and Claude Code writes the tag
 *  into the row of the turn it causes. Null, as there, for an id that is not a whole
 *  ULID: such a message is not handed to a channel at all. */
export const channelMark = (id: string): string | null => (isUlid(id) ? `message_id="${id}"` : null);

/** A handoff's answer as it lands in `reply_to` (CONTROL.md §6): who answered, in the
 *  short form the receivers label sessions by, and which receiver the person asked through. */
export function frameHandoff(from: { harness: string; id: string }, receiver: string, reply: string): string {
  return handoffFrame(`${from.harness}:${shortId(from.harness, from.id)}`, receiver, reply);
}
