// SPDX-License-Identifier: Apache-2.0
// The one source for the protocol's shapes. schemas/v1/*.json are GENERATED from
// this file (`npm run schemas`); core's runtime types are inferred from it with
// type-only imports, so zod never enters the zero-dependency bundle. Prose lives in
// spec/PROTOCOL.md; a rule that is not encoded here is a MUST in words only.
import { z } from "zod";

export const PROTOCOL = 1;

/** Dotted, lowercase. Unknown types MUST be accepted and stored. */
export const EventType = z
  .string()
  .regex(/^(?:native|[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+)$/, "dotted lowercase type, or native");

export const KNOWN_TYPES = [
  "session.started",
  "session.heartbeat",
  "session.ended",
  "session.backfill",
  "session.forgotten",
  "turn.started",
  "turn.ended",
  "turn.transcript",
  "turn.progress",
  "tool.started",
  "tool.ended",
  "files.changed",
  "attention.needed",
  "attention.cleared",
  "subagent.started",
  "subagent.ended",
  "context.compacted",
  "limits.observed",
  "native",
] as const;

/** The lowest tier that carries each known type. */
export const TYPE_TIER: Record<(typeof KNOWN_TYPES)[number], 0 | 1 | 2 | 3> = {
  "session.started": 0,
  "session.heartbeat": 0,
  "session.ended": 0,
  "session.backfill": 0,
  "session.forgotten": 0,
  "turn.started": 0,
  "turn.ended": 0,
  "turn.transcript": 2,
  "turn.progress": 2,
  "tool.started": 1,
  "tool.ended": 1,
  "files.changed": 1,
  "attention.needed": 0,
  "attention.cleared": 0,
  "subagent.started": 1,
  "subagent.ended": 1,
  "context.compacted": 1,
  "limits.observed": 1,
  native: 3,
};

export const HARNESS_NAMES = [
  "claude-code",
  "codex",
  "gemini-cli",
  "antigravity",
  "devin",
  "cursor",
  "copilot-cli",
  "droid",
  "kiro",
  "opencode",
] as const;

export const Tier = z.int().min(0).max(3);
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "ULID");
export const Rfc3339 = z.iso.datetime({ offset: false, precision: 3 });
export const SessionId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const ToolName = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);

export const Harness = z.object({
  /** From the registry in ADAPTERS.md; a name outside it is allowed ([a-z0-9-]). */
  name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  version: z.string().max(64).optional(),
  /** The harness's own event name (`PostToolUse`, `agentStop`). */
  event: z.string().max(64).optional(),
});

export const Session = z.object({
  id: SessionId,
  /** Monotonic per session per sender; the dedup key with harness.name and id. */
  seq: z.int().min(0),
  machine: z.string().max(80).optional(),
  /** Home is written `~`. */
  cwd: z.string().max(1024).optional(),
  /** A remote URL with credentials stripped. */
  repo: z.string().max(512).optional(),
  branch: z.string().max(256).optional(),
  model: z.string().max(128).optional(),
  title: z.string().max(200).optional(),
  title_source: z.enum(["custom", "harness", "first-ask"]).optional(),
  url: z.url().max(1024).optional(),
  /** An id, never an email. */
  account_id: z.string().max(128).optional(),
  /** Whether a person attends the session, in the harness's own word. Absent = unknown, never false. */
  attended: z.boolean().optional(),
  parent_id: SessionId.nullable().optional(),
  /** `<harness>:<id>` of the session that started this one on purpose (a script running
   *  `claude -p` for it), from the launcher's environment. Absent for a subagent, whose
   *  launcher is its parent, and when nothing says. */
  launched_by: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$/)
    .optional(),
});

export const Privacy = z.object({
  /** The redaction rulesets that ran; `secrets@1` always above tier 0. */
  rulesets: z.array(z.string().regex(/^[a-z][a-z0-9-]*@\d+$/)),
  pii: z.boolean(),
});

export const Event = z.object({
  protocol: z.literal(PROTOCOL),
  id: Ulid,
  type: EventType,
  time: Rfc3339,
  tier: Tier,
  harness: Harness,
  session: Session,
  privacy: Privacy,
  /** Per type (see EventData); extra keys allowed and kept. */
  data: z.record(z.string(), z.unknown()),
});

// --- data per type --------------------------------------------------------------

const Loose = z.object({}).loose();
export const AttentionKind = z.enum(["permission", "question", "elicitation", "idle", "error"]);

/** One usage window of an account: `id` is the harness's own name for it (`five_hour`,
 *  `seven_day`, `primary` …); `used_percent` passes 100 once a spend limit is exceeded. */
export const LimitWindow = Loose.extend({
  id: z.string().regex(/^[a-z0-9_]{1,64}$/),
  used_percent: z.number().min(0),
  resets_at: Rfc3339.optional(),
  window_minutes: z.int().min(1).optional(),
});

export const EventData = z.object({
  "session.started": Loose.extend({ source: z.enum(["startup", "resume", "clear", "compact", "fork", "unknown"]) }),
  "session.heartbeat": Loose,
  "session.ended": Loose.extend({ reason: z.enum(["clear", "logout", "exit", "other"]) }),
  "session.backfill": Loose.extend({ started_at: Rfc3339, last_at: Rfc3339, turns: z.int().min(0).optional() }),
  "session.forgotten": Loose,
  "turn.started": Loose.extend({
    turn_id: z.string().max(128).optional(),
    prompt_chars: z.int().min(0).optional(),
    /** The harness's OWN word for who submitted the prompt, forwarded verbatim; not an enum
     *  of this spec (Claude Code: user, sdk, system, loop_wakeup, schedule_wakeup,
     *  poll_event), and a different vocabulary from session.started.source. A bare word:
     *  tier 0 is not redacted, so the shape is the only guard. */
    submitted_by: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/, "a bare word, at most 40 characters")
      .optional(),
    /** True when the prompt text is a block the harness wrote rather than words a person
     *  typed; never a claim that no person caused the turn. */
    injected: z.boolean().optional(),
  }),
  "turn.ended": Loose.extend({
    turn_id: z.string().max(128).optional(),
    reason: z.enum(["stop", "interrupt", "error"]),
    /** The harness's error class when reason is error (rate_limit, overloaded, authentication_failed, server_error …). */
    error: z.string().max(200).optional(),
    ms: z.int().min(0).optional(),
    /** Background work the harness reports still in flight as the turn ends, each of which wakes the session when it finishes (Claude Code: shell commands, monitors, subagents, workflows). Absent when the harness doesn't say. */
    background: z.int().min(0).optional(),
  }),
  "turn.transcript": Loose.extend({
    turn: z.int().min(0),
    user: z.string().max(20_000),
    assistant: z.string().max(20_000),
    at: Rfc3339,
  }),
  /** The turn still running: its prompt and what the assistant has said so far. A
   *  later turn.progress for the same turn replaces it; the turn.transcript with the
   *  same number supersedes it. Over 20 000 chars, the assistant side keeps its END. */
  "turn.progress": Loose.extend({
    turn: z.int().min(0),
    user: z.string().max(20_000),
    assistant: z.string().max(20_000),
    at: Rfc3339,
  }),
  "tool.started": Loose.extend({
    tool: ToolName,
    call_id: z.string().max(128).optional(),
    turn_id: z.string().max(128).optional(),
    /** Set when a subagent made the call. */
    agent_id: z.string().max(128).optional(),
    input: z.unknown().optional(),
  }),
  "tool.ended": Loose.extend({
    tool: ToolName,
    call_id: z.string().max(128).optional(),
    turn_id: z.string().max(128).optional(),
    agent_id: z.string().max(128).optional(),
    ms: z.int().min(0).optional(),
    ok: z.boolean(),
    error: z.string().max(2000).optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
  }),
  "files.changed": Loose.extend({ paths: z.array(z.string().max(1024)).max(500) }),
  "attention.needed": Loose.extend({
    attention_id: z.string().max(128),
    kind: AttentionKind,
    tool: ToolName.optional(),
    message: z.string().max(200).optional(),
  }),
  "attention.cleared": Loose.extend({
    attention_id: z.string().max(128),
    how: z.enum(["answered", "cancelled", "timeout", "unknown"]),
  }),
  "subagent.started": Loose.extend({ agent_id: z.string().max(128), agent_type: z.string().max(128).optional() }),
  "subagent.ended": Loose.extend({ agent_id: z.string().max(128), agent_type: z.string().max(128).optional() }),
  "context.compacted": Loose.extend({ trigger: z.enum(["manual", "auto"]) }),
  /** The account's usage limits as the harness last reported them: one per window. */
  "limits.observed": Loose.extend({
    windows: z.array(LimitWindow).min(1).max(8),
    plan: z.string().max(64).optional(),
  }),
  native: Loose,
});

// --- wire -----------------------------------------------------------------------

export const Batch = z.object({ events: z.array(Event).min(1).max(50) });

export const BatchResponse = z.object({
  accepted: z.int().min(0),
  duplicates: z.int().min(0),
  rejected: z.array(z.object({ id: Ulid, reason: z.string().max(200) })),
  max_tier: Tier,
});

export const ErrorResponse = z.object({
  reason: z.string().max(200),
  supported: z.array(z.int()).optional(),
  max_tier: Tier.optional(),
});

export const Capability = z.enum(["events", "backfill", "forget", "control", "native"]);

// --- control (CONTROL.md) ---------------------------------------------------------

const B64Url = z.string().regex(/^[A-Za-z0-9_-]*$/, "base64url, no padding");
export const MachineId = z.string().regex(/^m_[A-Za-z0-9_-]{16,40}$/, "m_ + 16–40 base64url");
/** `<harness>:<id>`; the id follows its adapter's rule (Claude Code: a UUID). */
export const SessionRef = z.string().regex(/^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$/, "<harness>:<session id>");
export const ControlKind = z.enum(["prompt", "permission.answer", "cancel", "start", "key.add"]);
/** The kinds of key a machine or a receiver handles (CONTROL.md §2). Absent: passkeys only. */
export const KeyTypes = z
  .array(z.enum(["passkey", "device"]))
  .min(1)
  .max(2);
export const DeliveryMode = z.enum(["sdk", "waiter", "turn", "api", "resume", "fork"]);
/** How much a started session may do without anyone approving it (CONTROL.md §3.1),
 *  narrowest first. Closed: nothing is wider than `auto`. */
export const StartPermission = z.enum(["read", "safe", "edits", "auto"]);
/** What a start ran with, or gets by default: a level, or `inherit` (no permission flag,
 *  the harness's own default) on a machine the person put in inherit mode. Never a
 *  command's `permission`. */
export const RunLevel = z.enum(["read", "safe", "edits", "auto", "inherit"]);
/** A model id as the harness names it, passed as one argument: never a leading dash. */
export const ModelId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/, "a model id");
const HarnessName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

/** A file attached to a `start` (CONTROL.md §3.1). The bytes wait on the receiver
 *  (`GET {control}/files/{sha256}`); the signed hash is what the machine checks.
 *  Beyond this shape the verifier also checks: the name's length after NFC, names
 *  unique case-insensitively, and the sizes adding up to at most 50 MiB. */
export const ControlFile = z.object({
  /** Written as is (NFC) into the session's folder: no slash, backslash or control
   *  character, not starting with a dot. */
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects
      /^[^./\\\x00-\x1f\x7f][^/\\\x00-\x1f\x7f]*$/,
      "a file name: no slash, backslash, control character or leading dot",
    ),
  /** Media type, `type/subtype` (case-insensitive). */
  type: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/, "type/subtype"),
  /** Bytes: 1 to 25 MiB. */
  size: z.int().min(1).max(26_214_400),
  /** SHA-256 of the bytes, base64url without padding. */
  sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "43 base64url characters"),
});

/** The signed command, as the device writes it. The machine verifies the EXACT string
 *  it received (control.json `cmd`) and never re-serializes it. */
export const ControlCommand = z.object({
  v: z.literal(1),
  t: z.literal("sessionpipe.control"),
  machine: MachineId,
  kind: ControlKind,
  session: SessionRef,
  /** prompt, start: the message for the model. */
  text: z.string().min(1).max(20_000).optional(),
  /** permission.answer: the attention_id being answered. */
  for: z.string().min(1).max(128).optional(),
  decision: z.enum(["allow", "deny"]).optional(),
  /** Shown to the model beside a decision. */
  note: z.string().max(2000).optional(),
  /** start: the folder the new session runs in: absolute, or `~` / `~/…` under the
   *  home of the user the machine's daemon runs as, as events write it. */
  cwd: z.string().max(1024).optional(),
  /** key.add (session `sessionpipe:keys`): the new device's key (a passkey or a device
   *  key, control-key.json), which the machine trusts once a key it already trusts
   *  signed this command. */
  key: z.lazy(() => ControlKey).optional(),
  /** key.add: what the person calls the device. */
  name: z.string().min(1).max(80).optional(),
  /** start, prompt: 1–10 files, together at most 50 MiB, downloaded and checked by hash
   *  before the session starts or the message is delivered. On a prompt, only to a
   *  machine whose hello says `prompt_files`. */
  files: z.array(ControlFile).min(1).max(10).optional(),
  /** start only: the level the new session runs at, at most the machine's mode. Send
   *  it only to a machine whose hello advertises it for the harness (`start`). */
  permission: StartPermission.optional(),
  /** start only: the model the harness runs. As `permission`: only when advertised. */
  model: ModelId.optional(),
  /** At least 16 random bytes, base64url. */
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
  /** Epoch ms, the signing device's clock. */
  iat: z.int().min(1),
});

/** A day grant's signed string: a passkey vouches for a device key for ≤ 24 h. */
export const ControlGrant = z.object({
  v: z.literal(1),
  t: z.literal("sessionpipe.grant"),
  /** The day key: P-256 SPKI, base64url. */
  pub: B64Url.min(1),
  iat: z.int().min(1),
  exp: z.int().min(1),
  /** The receiver's WebAuthn rp id (well-known control.signing.rp_id). */
  rp: z.string().min(1).max(253),
});

/** A WebAuthn assertion: credential id, authenticatorData, clientDataJSON, signature. */
export const ControlAssertion = z.object({
  cred: B64Url.min(1),
  ad: B64Url.min(1),
  cd: B64Url.min(1),
  sig: B64Url.min(1),
});

/** A device key's signature (CONTROL.md §3.2): its id and 64 bytes r‖s over
 *  `sessionpipe.device.v1⏎<purpose>⏎<rp id>⏎<challenge>`. Nothing else. The shape
 *  only, like an assertion's: the machine reads the key from its own record and checks
 *  the rest (a 43-character id, exactly 64 bytes), so a carrier never decides a kind. */
export const ControlDeviceSignature = z.strictObject({
  cred: B64Url.min(1),
  /** 64 bytes r‖s, base64url without padding. */
  sig: B64Url.min(1),
});

/** A key enrolled on a machine, closed: a passkey (credential id, COSE alg, SPKI), or a
 *  device key an app holds in hardware (CONTROL.md §2 "Device keys"), which names
 *  itself by its SPKI's SHA-256 and says how it is held. A machine refuses any other
 *  field or value, so a kind added later is refused by every machine that predates it. */
export const ControlKey = z.xor([
  z.strictObject({
    id: B64Url.min(16).max(1400),
    alg: z.union([z.literal(-7), z.literal(-257)]),
    spki: B64Url.min(1),
  }),
  z.strictObject({
    /** SHA-256 of the SPKI bytes, base64url without padding. */
    id: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "SHA-256 of the spki, base64url"),
    alg: z.literal(-7),
    spki: B64Url.min(1),
    type: z.literal("device"),
    /** The private key was made in a hardware key store and never leaves it. */
    store: z.literal("hardware"),
    /** The store will not sign without verifying the person, every time. */
    uv: z.literal("each-use"),
  }),
]);

/** One message as a receiver carries it: its own envelope around the signed bytes. */
export const ControlMessage = z.object({
  /** The receiver's id for this message; the ack key. Not signed: the nonce inside cmd is. */
  id: Ulid,
  /** The command string, exactly as signed (≤ 48 000 characters). */
  cmd: z.string().min(1).max(48_000),
  /** The day key's ECDSA P-256 / SHA-256 signature over cmd: raw r‖s, base64url. */
  csig: B64Url.nullable().optional(),
  /** The grant vouching for the day key: its string plus the passkey's assertion over
   *  sha256(str), or a device key's signature over it (CONTROL.md §3.2). */
  grant: z
    .xor([
      ControlAssertion.extend({ str: z.string().min(1).max(2000) }),
      ControlDeviceSignature.extend({ str: z.string().min(1).max(2000) }),
    ])
    .nullable()
    .optional(),
  /** Instead of csig + grant: one passkey assertion (or device signature) over sha256(cmd). */
  confirm: z.xor([ControlAssertion, ControlDeviceSignature]).nullable().optional(),
  /** The receiver's clock. */
  at: Rfc3339,
  /** After this the machine MUST NOT act and acks `expired`; at most 24 h after `at`. */
  expires_at: Rfc3339,
});

export const ControlPoll = z.object({ messages: z.array(ControlMessage) });

/** `taken` is the one non-final outcome: the machine verified the message and is
 *  delivering it (a headless resume can take minutes); a final ack follows. */
/** `progress` (not final): the answer so far, whole, in `reply`, with a rising `seq`.
 *  `taken` (not final): verified and being delivered. Every other outcome is final. */
export const ControlOutcome = z.enum(["progress", "taken", "delivered", "expired", "unsupported", "failed", "refused"]);

export const ControlAck = z.object({
  acks: z
    .array(
      z.object({
        id: Ulid,
        outcome: ControlOutcome,
        at: Rfc3339,
        /** delivered: how it reached the session. */
        mode: DeliveryMode.optional(),
        /** The session that took it, when not the one named (a fork's copy, a started session). */
        session: SessionRef.optional(),
        /** refused: the verifier's code, or the machine's own (`folder`, `no_attention`, `busy`);
         *  failed: `file` when a start's attachment couldn't be fetched, checked or written,
         *  `model` when the harness wouldn't run the start's model. */
        code: z
          .string()
          .regex(/^[a-z_]{1,40}$/)
          .optional(),
        detail: z.string().max(500).optional(),
        /** resume / fork / start: the agent's reply, redacted by the secrets ruleset. */
        reply: z.string().max(20_000).optional(),
        /** progress only: rises with every progress ack for this id; a receiver keeps the highest. */
        seq: z.int().min(0).optional(),
        /** taken, delivered of a start: the options it ran with (`model` only when one was
         *  asked for). A receiver shows this, never what was asked. */
        applied: z.strictObject({ permission: RunLevel.optional(), model: ModelId.optional() }).optional(),
      }),
    )
    .min(1),
});

/** A harness account signed in on the machine: the id `session.account_id` carries,
 *  and the email it signs in with, so a receiver the person paired with can name the
 *  account rather than show an id. Only pair and hello carry it, never an event. */
export const HarnessAccount = z.object({
  harness: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  id: z.string().min(1).max(128),
  email: z.string().max(254).optional(),
  /** What to call an account that has no email: a Claude Code home that runs on
   *  another API is named by its endpoint's host (`api.z.ai`). */
  name: z.string().min(1).max(200).optional(),
});

/** `POST {control}/pair`, sent with the person's sink token from their own terminal —
 *  or, where the receiver declares `control.open_pairing`, with no token and a
 *  `poll_key` (CONTROL.md §2). */
export const ControlPairStart = z.object({
  /** Open pairing: a random secret only this terminal knows. Status polls present it
   *  as their bearer; the receiver keeps only a hash. */
  poll_key: z
    .string()
    .regex(/^[A-Za-z0-9_-]{22,128}$/)
    .optional(),
  /** Set when adding a key to a machine already paired. */
  machine: MachineId.optional(),
  name: z.string().min(1).max(80),
  harnesses: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(20),
  modes: z.array(DeliveryMode),
  version: z.string().max(40),
  /** The folders the machine lets sessions run in, for the receiver's "new session"
   *  picker. Informational: the machine checks its own list again. */
  folders: z.array(z.string().max(1024)).max(50).optional(),
  /** safe: nothing that needs approval runs unattended; auto: the harness's auto mode;
   *  inherit: no permission flag, each harness's own default there. Chosen at the machine. */
  mode: z.enum(["safe", "auto", "inherit"]).optional(),
  /** The harness accounts signed in here, so the receiver's board can name each
   *  `session.account_id` (CONTROL.md §2). */
  accounts: z.array(HarnessAccount).max(20).optional(),
  /** The machine takes `files` on a start (downloads, checks and writes them). A
   *  machine that doesn't say so may ignore them: a receiver SHOULD NOT send it files. */
  files: z.boolean().optional(),
  /** The kinds of key this machine takes (unique; absent means `["passkey"]`). A
   *  client offers a device key only to a machine that lists `device`. */
  key_types: KeyTypes.optional(),
});

/** The receiver's answer: where the person confirms, and the digits both screens show. */
export const ControlPairStarted = z.object({
  machine: MachineId,
  code: z.string().regex(/^[A-Za-z0-9_-]{6,32}$/),
  url: z.url(),
  /** Six digits the terminal and the receiver's page both show. */
  check: z.string().regex(/^\d{6}$/),
  expires_at: Rfc3339,
});

/** `GET {control}/pair?code=…` once the person confirmed. The machine verifies `proof`
 *  over sha256("sessionpipe.pair:<machine>:<code>") before it trusts `key`. */
export const ControlPaired = z.object({
  status: z.enum(["pending", "paired", "expired"]),
  /** The key approved, whole: a device key keeps its type, store and uv. */
  key: ControlKey.optional(),
  /** The key's proof: a passkey assertion, or a device signature for purpose `pair`. */
  proof: z.xor([ControlAssertion, ControlDeviceSignature]).optional(),
  /** The machine's own bearer for polls, acks and hello: opens nothing else. Minted
   *  once, at the first pairing of a machine. */
  token: z.string().min(16).max(256).optional(),
  /** Optional: a key for the events lane (`sink add`), so the receiver's session board
   *  shows this machine without a second step. Handed over once. */
  sink_token: z.string().min(16).max(256).optional(),
  /** Optional: who approved, in the receiver's words (a @handle), so the terminal can
   *  say whose passkey it now trusts. */
  account: z.string().max(200).optional(),
});

/** `POST {control}/hello`: what the machine can do right now. */
export const ControlHello = z.object({
  name: z.string().min(1).max(80),
  harnesses: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)).max(20),
  modes: z.array(DeliveryMode),
  /** Credential ids of the keys enrolled on the machine. */
  keys: z.array(B64Url.min(16).max(1400)).max(50),
  version: z.string().max(40),
  /** Live sessions with a waiter parked on the daemon's socket. */
  waiting: z.array(SessionRef).max(500).optional(),
  /** As in control-pair.json: informational, re-checked on the machine. */
  folders: z.array(z.string().max(1024)).max(50).optional(),
  mode: z.enum(["safe", "auto", "inherit"]).optional(),
  /** As in control-pair.json: read again for every hello, so a new sign-in is named. */
  accounts: z.array(HarnessAccount).max(20).optional(),
  /** As in control-pair.json. */
  files: z.boolean().optional(),
  /** The machine takes `files` on a prompt too (CONTROL.md §6 `prompt`). One that
   *  doesn't say so refuses them: a receiver SHOULD NOT send it a prompt with files. */
  prompt_files: z.boolean().optional(),
  /** Per harness in `harnesses`: the options a start may carry (CONTROL.md §2). No
   *  entry: neither `permission` nor `model`. */
  start: z
    .record(
      HarnessName,
      z.object({
        /** The levels it starts at here, already capped by `mode`. */
        permissions: z.array(StartPermission).min(1).max(4).meta({ uniqueItems: true }),
        /** What a start that names none gets: one of `permissions`, or `inherit` on an
         *  inherit machine. */
        permission: RunLevel,
        /** Model ids the harness offers here: a suggestion, not a promise. */
        models: z.array(ModelId).max(50).optional(),
        /** Any well-formed model is passed to the harness (which may still reject it). */
        any_model: z.boolean().optional(),
      }),
    )
    .refine((o) => Object.keys(o).length <= 50, "at most 50 harnesses")
    .meta({ maxProperties: 50 })
    .optional(),
  /** As in control-pair.json. */
  key_types: KeyTypes.optional(),
});

export const WellKnown = z.object({
  protocol: z.array(z.int().min(1)).min(1),
  max_tier: Tier,
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)),
  auth: z.array(z.enum(["bearer"])).default(["bearer"]),
  endpoints: z.object({
    events: z.string(),
    control: z.string().optional(),
    native: z.string().optional(),
  }),
  batch: z.object({ max_events: z.int().min(1).max(50), max_bytes: z.int().min(1024).max(262_144) }),
  control: z
    .object({
      wait_max_s: z.int().min(1).max(60),
      /** Pairing may start with no token: the person approves the link signed in. */
      open_pairing: z.boolean().optional(),
      /** MCP servers (`mcp__<server>`) a session answering this receiver's message may
       *  use without asking. MCP servers only: a daemon ignores anything else. */
      session_tools: z
        .array(z.string().regex(/^mcp__[A-Za-z0-9_-]{1,64}$/))
        .max(8)
        .optional(),
      /** How commands are signed: the WebAuthn rp id keys are enrolled for, and the algorithms. */
      signing: z.object({
        rp_id: z.string().min(1).max(253),
        algs: z.array(z.union([z.literal(-7), z.literal(-257)])).min(1),
        /** The kinds of key the receiver stores and carries whole (CONTROL.md §2).
         *  Absent means `["passkey"]`. */
        key_types: KeyTypes.optional(),
      }),
      /** Informational: the receiver accepts `files` on a start and serves
       *  `GET {control}/files/{sha256}`. */
      files: z.boolean().optional(),
      /** The receiver shows a machine in `inherit` mode as that, never as safe or auto.
       *  A daemon pairs in, or switches to, `inherit` only with receivers that say so. */
      inherit: z.boolean().optional(),
    })
    .optional(),
});

/** What `npm run schemas` writes to schemas/v1/<name>.json. */
export const SCHEMAS = {
  event: Event,
  "event-data": EventData,
  batch: Batch,
  "batch-response": BatchResponse,
  error: ErrorResponse,
  "well-known": WellKnown,
  control: ControlMessage,
  "control-command": ControlCommand,
  "control-grant": ControlGrant,
  "control-key": ControlKey,
  "control-poll": ControlPoll,
  "control-ack": ControlAck,
  "control-pair": ControlPairStart,
  "control-pair-started": ControlPairStarted,
  "control-paired": ControlPaired,
  "control-hello": ControlHello,
} as const;
