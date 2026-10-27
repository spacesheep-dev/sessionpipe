// SPDX-License-Identifier: Apache-2.0
// Claude Code's own local inbox, as the `inbox` delivery mode uses it (spec/CONTROL.md
// §6.3). A live Claude Code publishes a Unix socket in its session registry row and
// takes one JSON line: a `user` frame that becomes a real prompt in that process, which
// then answers in the person's own window or thread, in that session's own permission
// mode.
//
// This file is the daemon's alone. It is not exported from `@sessionpipe/core` and there
// is no CLI verb for it: writing into somebody's live session is something one process
// on this machine does, for a message it verified itself, and nothing else.
//
// Two rules the whole lane rests on:
//
//  1. A message never chooses a permission mode. The sender DECLARES the machine's own
//     permission class in the content, inside the canonical envelope; the receiving
//     session takes a message whose class matches its own and silently parks one that
//     does not (measured: it holds an unmatched message for 300 s, then drops it).
//     Declaring buys delivery, never escalation — a peer can grant nothing, and a
//     prompting session still raised its own permission prompt.
//  2. The lane is chosen BEFORE the first byte. Everything checkable is checked up
//     front; once a byte is written the message is committed and never tried on another
//     lane, or the same words could arrive twice (a parked message can be released
//     later).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { claudeControl } from "@sessionpipe/core";
import { hostOf } from "./route.js";

type LiveRecord = claudeControl.LiveRecord;

/** The only inbox protocol this code speaks. */
export const PEER_PROTOCOL = 1;
/** How long the daemon waits for the session's own turn to begin before it says the
 *  message may be held (measured deliveries were sub-second; 340 ms end to end). */
export const CONFIRM_MS = 8_000;
/** A registry row has to say this before anything is written: a message written into a
 *  running turn joins that turn, which is the `turn` lane's job, not this one's. */
export const IDLE_STATUS = "idle";
/** What a registry row says about a session Claude Code holds open for the person. Every
 *  row that publishes an inbox carries it — terminal windows and claude.ai bridge workers
 *  alike, 47 of 47 measured — and a row that doesn't is not ours to write to, since a
 *  registry row is a file any process of this uid can write. A desktop-app session
 *  publishes no inbox at all (none in three sweeps of 47–53 rows), so it is refused here
 *  like anything else without one. */
export const INTERACTIVE_KIND = "interactive";

const TOKEN_RE = /^[0-9a-f]{32}$/;
const OPEN_TAG = "cross-session-message";
const CLOSE_TAG = `</${OPEN_TAG}>`;

export type PeerClass = "bypass" | "prompting";

/** The envelope's attributes, in the receiver's own order. It parses an envelope by
 *  rebuilding it and comparing, so an attribute out of order is an envelope it does not
 *  recognise — which is a silent five-minute hold, not an error. Only `from-name` and
 *  `from-mode` are ever sent: the rest are the receiver's own vocabulary, and a value
 *  this machine cannot vouch for has no business in a frame the model reads. */
const ATTRS = ["from", "from-session", "hop-chain", "from-name", "from-mode", "from-plugin"] as const;
type Attr = (typeof ATTRS)[number];

/** An envelope as the receiver reads one back. Strict on purpose: the attribute list,
 *  the newline after the open tag and the one before the close tag are all part of it. */
const ENVELOPE_RE = new RegExp(`^<${OPEN_TAG}((?: [a-z-]+="[^"<>]*")*)>\\n([\\s\\S]*)\\n${CLOSE_TAG}$`);
const ATTR_RE = / ([a-z-]+)="([^"<>]*)"/g;

function build(attrs: Partial<Record<Attr, string>>, body: string): string {
  const open = ATTRS.filter((a) => attrs[a] !== undefined)
    .map((a) => ` ${a}="${attrs[a]}"`)
    .join("");
  return `<${OPEN_TAG}${open}>\n${body}\n${CLOSE_TAG}`;
}

/** What an envelope says, or null when the text is not one. */
export function readEnvelope(s: string): { attrs: Record<string, string>; body: string } | null {
  const m = ENVELOPE_RE.exec(s);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const a of (m[1] as string).matchAll(ATTR_RE)) attrs[a[1] as string] = a[2] as string;
  return { attrs, body: m[2] as string };
}

/** The envelope to write, or null when this message cannot be put in one that reads
 *  back as itself — a body that closes the tag early, say. The round trip is the check:
 *  the receiver parses what it is sent by rebuilding it, so anything that does not
 *  come back byte for byte would be parked unread rather than refused out loud. */
export function envelope(o: { fromName?: string; fromMode: PeerClass; body: string }): string | null {
  if (!o.body || o.body.includes(CLOSE_TAG)) return null;
  const attrs: Partial<Record<Attr, string>> = {
    ...(o.fromName ? { "from-name": o.fromName } : {}),
    "from-mode": o.fromMode,
  };
  const text = build(attrs, o.body);
  const back = readEnvelope(text);
  if (!back || back.body !== o.body) return null;
  for (const a of ATTRS) if ((back.attrs[a] ?? undefined) !== attrs[a]) return null;
  return text;
}

/** Who the message is from, for `from-name`: the board the person typed it on, by the
 *  receiver's own host. The session's window shows it, so it is cleaned to what can sit
 *  in an attribute and read as a name — no quotes or angle brackets to break out of the
 *  envelope, no control or formatting characters to hide what it says, and short. */
export function senderName(receiver: string): string {
  return cleanName(`${hostOf(receiver)} board`);
}

export const cleanName = (s: string): string =>
  [
    ...s
      .replace(/["<>]/g, "")
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, 64)
    .join("");

/** Why this live session may not be written to, or null when it may. Everything here is
 *  read before the first byte (rule 2 above), and every refusal means the lane does not
 *  apply — the message takes the next rung, which is not the same as failing. */
export function vetInbox(
  rec: LiveRecord | null,
  o: {
    /** The session's own permission class, from the mode its hooks reported. */
    sessionClass: PeerClass | null;
    /** The class this machine would declare. The two must be equal: a declaration the
     *  receiver cannot match is parked, and one it can is still only a declaration. */
    machineClass: PeerClass | null;
    /** The account the session's transcript was resolved in: the lane never crosses one. */
    configDir?: string;
    uid?: number | undefined;
    platform?: NodeJS.Platform;
    /** The process's real start time, to compare with the registry's. Null when it
     *  can't be read, which is not by itself a refusal. */
    procStart?: string | null;
    alive?: (pid: number) => boolean;
    stat?: (p: string) => { isSocket: boolean; uid: number } | null;
    /** The inbox's auth token, asked for only off macOS, where the inbox cannot vet a
     *  peer by its uid. Read HERE, before the lane is chosen: no key, no lane. */
    token?: (() => string | null) | undefined;
  },
): { code: string; detail: string } | null {
  const platform = o.platform ?? process.platform;
  if (platform === "win32") return { code: "platform", detail: "Claude Code publishes no local inbox on Windows" };
  if (!rec)
    return { code: "no_record", detail: "no single live Claude Code process holds that session on this computer" };
  if (rec.peerProtocol !== PEER_PROTOCOL)
    return {
      code: "protocol",
      detail: `that session's Claude Code speaks inbox protocol ${rec.peerProtocol ?? "none"}, not ${PEER_PROTOCOL}`,
    };
  if (rec.kind !== INTERACTIVE_KIND)
    return {
      code: "not_a_window",
      detail: "the live process holding that session isn't one of this computer's own Claude Code windows",
    };
  if (!rec.socket || !path.isAbsolute(rec.socket))
    return { code: "no_inbox", detail: "that session's Claude Code published no local inbox" };
  if (o.configDir && path.resolve(o.configDir) !== path.resolve(rec.configDir))
    return {
      code: "other_home",
      detail: "the live process is signed in to a different Claude Code account from the one holding that transcript",
    };
  const alive = o.alive ?? aliveNow;
  if (!alive(rec.pid)) return { code: "gone", detail: "the process holding that session has ended" };
  if (rec.procStart && o.procStart && !sameStart(rec.procStart, o.procStart))
    return { code: "recycled_pid", detail: "another process has that pid now" };
  const st = (o.stat ?? statSocket)(rec.socket);
  if (!st?.isSocket) return { code: "no_inbox", detail: "that session's inbox is not a socket any more" };
  const uid = o.uid ?? ourUid();
  if (uid !== undefined && st.uid !== uid)
    return { code: "not_ours", detail: "that session's inbox belongs to another user on this computer" };
  if (rec.status !== IDLE_STATUS)
    return {
      code: "busy",
      detail: `that session is ${rec.status ?? "in an unknown state"}, not idle; a message sent into a running turn joins it instead`,
    };
  if (!o.sessionClass)
    return {
      code: "class_unknown",
      detail: "that session's own permission mode isn't one this lane can declare (plan, auto, or nothing recorded)",
    };
  if (!o.machineClass || o.machineClass !== o.sessionClass)
    return {
      code: "class_mismatch",
      detail: `this computer would reach that session as ${o.machineClass ?? "nothing it can declare"}, and the session is running as ${o.sessionClass}; a message is never declared as anything but what the machine itself is`,
    };
  // Off macOS a line with no auth token is dropped unread, which looks exactly like a
  // message being held. No key, no lane, and the message takes the next rung instead of
  // failing for ever.
  if (platform !== "darwin" && o.token && !o.token())
    return {
      code: "no_key",
      detail: "that session's inbox key can't be read on this computer, and off macOS a message without it is refused",
    };
  return null;
}

function aliveNow(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/** This process's own uid. A runtime without `getuid` is Windows, which `vetInbox`
 *  refuses before it gets here. */
/* v8 ignore next -- see above */
const ourUid = (): number | undefined => process.getuid?.();

function statSocket(p: string): { isSocket: boolean; uid: number } | null {
  try {
    const s = statSync(p);
    return { isSocket: s.isSocket(), uid: s.uid };
  } catch {
    return null;
  }
}

/** The same process, as two start times that may be spelled differently. Claude Code
 *  writes `procStart` in UTC; a `ps` reading it back says the same instant, and this
 *  accepts that instant however it is punctuated. Only a DIFFERENT instant is a
 *  recycled pid. */
export function sameStart(a: string, b: string): boolean {
  if (a === b) return true;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1_000;
}

/** The process's start time in the spelling the registry uses (`procStart`), so a
 *  recycled pid can be told from the process that filed the row. Best effort: a `ps`
 *  this platform spells differently is "don't know", not a refusal. */
export function procStartOf(pid: number, run: (pid: number) => string = psStart): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    return run(pid).trim() || null;
  } catch {
    return null;
  }
}

/** `ps` prints a start time in the time zone and language of whoever runs it, while
 *  Claude Code's registry writes it in UTC and in English: on a Mac in PDT every one of
 *  52 live rows read back seven hours out, and every delivery was refused as a recycled
 *  pid. Ask `ps` for the registry's own spelling. */
const psStart = (pid: number): string =>
  execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
  });

/** The token that lets a line in where the inbox asks for one (`<pid>.<sha>.key`, the
 *  same uid, 0600). macOS vets the peer's uid instead and needs none. */
export function peerToken(rec: LiveRecord): string | null {
  if (!rec.keyFile) return null;
  try {
    const j = JSON.parse(readFileSync(rec.keyFile, "utf8")) as { peerToken?: unknown };
    return typeof j.peerToken === "string" && TOKEN_RE.test(j.peerToken) ? j.peerToken : null;
  } catch {
    return null;
  }
}

export type WriteResult = { written: true; bytes: number } | { code: string; detail: string };

/** The inbox was not there when the socket was opened — the ordinary race, since the
 *  vetting stats it a moment earlier. Node puts the socket's absolute path in its own
 *  error message, and this `detail` travels to the receiver and is shown to the person,
 *  so only the error's code goes with it; the whole error is logged on the machine. */
const gone = (e: unknown): { code: string; detail: string } => {
  const code = (e as { code?: unknown } | null)?.code;
  return {
    code: "no_inbox",
    detail: `that session's inbox was gone by the time the message was written${typeof code === "string" ? ` (${code})` : ""}`,
  };
};

/** Write ONE message into a live session's inbox and nothing else. `priority: "later"`
 *  on purpose: the message becomes a turn of its own rather than joining one in flight.
 *
 *  Vetting happens here too, before the socket is opened; once a byte is written the
 *  result is `written`, whatever the session then does with it — the caller confirms
 *  delivery by the row the session writes for the turn, and never falls through to
 *  another lane. No `session_id` is sent: the measured deliveries carried none, and the
 *  one process that holds the session is already settled by the registry row and its
 *  start time. */
export async function writeInbox(
  rec: LiveRecord | null,
  o: {
    /** The text the person typed, already framed for the session (route.ts). */
    body: string;
    /** Who it is from, as the session's window shows it (`senderName`). */
    fromName?: string;
    sessionClass: PeerClass | null;
    machineClass: PeerClass | null;
    configDir?: string;
    timeoutMs?: number;
    /** Off macOS: the inbox may ask for this first. Read with `peerToken`. */
    token?: string | null;
    platform?: NodeJS.Platform;
    procStart?: string | null;
    /** Test seams. */
    uid?: number | undefined;
    alive?: (pid: number) => boolean;
    stat?: (p: string) => { isSocket: boolean; uid: number } | null;
    connect?: (p: string) => net.Socket;
  },
): Promise<WriteResult> {
  const why = vetInbox(rec, { ...o, token: o.token === undefined ? undefined : () => o.token ?? null });
  if (why) return why;
  const r = rec as LiveRecord;
  const text = envelope({
    ...(o.fromName ? { fromName: o.fromName } : {}),
    fromMode: o.machineClass as PeerClass,
    body: o.body,
  });
  if (!text) return { code: "unsendable", detail: "that message can't be put in an envelope this lane can be sure of" };
  const platform = o.platform ?? process.platform;
  const lines: string[] = [];
  if (platform !== "darwin" && o.token) lines.push(JSON.stringify({ type: "auth", token: o.token }));
  lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text }, priority: "later" }));
  const payload = `${lines.join("\n")}\n`;
  const timeoutMs = o.timeoutMs ?? 5_000;
  return await new Promise<WriteResult>((resolve) => {
    let done = false;
    let wrote = false;
    let connected = false;
    /** The bytes may be with the receiver. Once the socket is open this message is
     *  committed — anything that goes out does so after that, and the inbox may read it
     *  whenever it drains — and the one thing that must never happen is the same words
     *  arriving twice. A ~20 KB line and a receiver that stalls past the timeout is
     *  exactly that case: held, not tried somewhere else. */
    const committed = () => wrote || connected;
    const finish = (res: WriteResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        s.destroy();
      } catch {}
      resolve(res);
    };
    // Nothing happened at all: no connection, no error, nothing out on the socket. Any
    // of those and the message is committed, held rather than tried somewhere else.
    const timer = setTimeout(
      () =>
        finish(
          committed()
            ? { written: true, bytes: payload.length }
            : { code: "no_answer", detail: "that session's inbox didn't take the message" },
        ),
      timeoutMs,
    );
    let s: net.Socket;
    try {
      s = (o.connect ?? ((p: string) => net.connect(p)))(r.socket as string);
    } catch (e) {
      clearTimeout(timer);
      return resolve(gone(e));
    }
    // An error after the socket opened is not a reason to send the words again; one
    // before it (the inbox was gone) leaves the message for the next rung.
    s.on("error", (e) => finish(committed() ? { written: true, bytes: payload.length } : gone(e)));
    s.on("connect", () => {
      connected = true;
      s.write(payload, () => {
        wrote = true;
        finish({ written: true, bytes: payload.length });
      });
    });
  });
}
