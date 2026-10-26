// SPDX-License-Identifier: Apache-2.0
// Any agent that speaks the Agent Client Protocol (agentclientprotocol.com) — control
// delivery (spec/CONTROL.md §6, ADAPTERS.md "Agents driven through ACP"). One client
// for all of them: the daemon runs the agent's own CLI as a child, speaks JSON-RPC 2.0
// over its stdin and stdout (`initialize`, `session/new` or `session/load`,
// `session/prompt`, `session/cancel`), reads the reply from its `agent_message_chunk`
// updates, and answers its `session/request_permission` from the machine's mode. The
// agent names its own session, so the daemon keeps the start's id as its name
// (CONTROL.md §6 `start`), and keeps the process for the next message (`api` mode).
// Which agents, and how each is launched, is the ACP registry's word
// (github.com/agentclientprotocol/registry, 2026-10-22); only one already installed
// here is ever run. Shapes measured against codex-acp 2.2.2 on 2026-10-22.
import { type ChildProcess, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { deniedNote, findBinary, JOB_TIMEOUT_MS, jobEnv, type Mode } from "./headless.js";

export interface AcpAgent {
  /** sessionpipe's harness name (ADAPTERS.md): the registry's id unless a hook adapter already named it. */
  harness: string;
  /** The registry's id. */
  registry: string;
  label: string;
  /** The CLI's name on PATH. */
  bin: string;
  args: string[];
}

/** The agents the daemon can drive, with the launch line the registry publishes. */
export const ACP_AGENTS: readonly AcpAgent[] = [
  { harness: "gemini-cli", registry: "gemini", label: "Gemini CLI", bin: "gemini", args: ["--acp"] },
  { harness: "devin", registry: "devin", label: "Devin", bin: "devin", args: ["acp"] },
  { harness: "opencode", registry: "opencode", label: "OpenCode", bin: "opencode", args: ["acp"] },
  { harness: "cursor", registry: "cursor", label: "Cursor", bin: "cursor-agent", args: ["acp"] },
  { harness: "copilot-cli", registry: "github-copilot-cli", label: "Copilot CLI", bin: "copilot", args: ["--acp"] },
  {
    harness: "droid",
    registry: "factory-droid",
    label: "Droid",
    bin: "droid",
    args: ["exec", "--output-format", "acp-daemon"],
  },
  { harness: "goose", registry: "goose", label: "goose", bin: "goose", args: ["acp"] },
  { harness: "kilo", registry: "kilo", label: "Kilo", bin: "kilo", args: ["acp"] },
  {
    harness: "qwen-code",
    registry: "qwen-code",
    label: "Qwen Code",
    bin: "qwen",
    args: ["--acp", "--experimental-skills"],
  },
  { harness: "cline", registry: "cline", label: "Cline", bin: "cline", args: ["--acp"] },
  { harness: "auggie", registry: "auggie", label: "Auggie", bin: "auggie", args: ["--acp"] },
  { harness: "kimi", registry: "kimi", label: "Kimi CLI", bin: "kimi", args: ["acp"] },
  { harness: "amp", registry: "amp-acp", label: "Amp", bin: "amp-acp", args: [] },
  { harness: "mistral-vibe", registry: "mistral-vibe", label: "Mistral Vibe", bin: "vibe-acp", args: [] },
  { harness: "bob", registry: "bob", label: "Bob", bin: "bob", args: ["acp"] },
  { harness: "grok-build", registry: "grok-build", label: "Grok Build", bin: "grok", args: ["agent", "stdio"] },
  { harness: "qoder", registry: "qoder", label: "Qoder CLI", bin: "qodercli", args: ["--acp"] },
  { harness: "minimax-code", registry: "minimax-code", label: "MiniMax Code", bin: "mcode", args: ["acp"] },
  { harness: "codebuddy-code", registry: "codebuddy-code", label: "Codebuddy Code", bin: "codebuddy", args: ["--acp"] },
  { harness: "nova", registry: "nova", label: "Nova", bin: "nova", args: ["acp"] },
  { harness: "dimcode", registry: "dimcode", label: "DimCode", bin: "dim", args: ["acp"] },
  { harness: "dirac", registry: "dirac", label: "Dirac", bin: "dirac", args: ["--acp"] },
  { harness: "harn", registry: "harn", label: "Harn", bin: "harn", args: ["serve", "acp"] },
  { harness: "vtcode", registry: "vtcode", label: "VT Code", bin: "vtcode", args: ["acp"] },
  { harness: "stakpak", registry: "stakpak", label: "Stakpak", bin: "stakpak", args: ["acp"] },
  { harness: "crow-cli", registry: "crow-cli", label: "crow-cli", bin: "crow-cli", args: ["acp"] },
  { harness: "corust-agent", registry: "corust-agent", label: "Corust Agent", bin: "corust-agent-acp", args: [] },
  { harness: "cortex-code", registry: "cortex-code", label: "Cortex Code", bin: "cortex", args: ["acp", "serve"] },
  { harness: "kimchi", registry: "kimchi", label: "Kimchi", bin: "kimchi", args: ["--mode", "acp"] },
];

export const ACP_HARNESSES: readonly string[] = ACP_AGENTS.map((a) => a.harness);

export const acpAgent = (harness: string): AcpAgent | undefined => ACP_AGENTS.find((a) => a.harness === harness);

/** The env var that names an agent's CLI by hand: `SESSIONPIPE_ACP_GEMINI_CLI`. */
export const acpOverride = (harness: string): string => `SESSIONPIPE_ACP_${harness.toUpperCase().replace(/-/g, "_")}`;

/** An agent's CLI on this machine: the override, else on PATH, else beside the node
 *  running this (an `npm install -g` there) or where the installers put it. */
export function findAcpAgent(
  harness: string,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  nodeDir = path.dirname(process.execPath),
): { bin: string; args: string[] } | null {
  const a = acpAgent(harness);
  if (!a) return null;
  const bin = findBinary({
    override: env[acpOverride(harness)],
    names: process.platform === "win32" ? [`${a.bin}.exe`, `${a.bin}.cmd`] : [a.bin],
    env,
    dirs: [
      nodeDir,
      path.join(home, ".local", "bin"),
      path.join(home, ".cargo", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
  });
  return bin ? { bin, args: a.args } : null;
}

/** The ACP agents installed here, by harness name, for the daemon's hello. */
export function acpHarnesses(env: NodeJS.ProcessEnv = process.env): string[] {
  return ACP_HARNESSES.filter((h) => findAcpAgent(h, env));
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

interface Option {
  optionId: string;
  kind: string;
}

/** Which permission option the machine's mode picks, or null for `cancelled`: safe
 *  refuses (once, else always), auto allows (once, else always). Never the other way. */
export function permissionChoice(options: unknown, mode: Mode): Option | null {
  const list = (Array.isArray(options) ? options : [])
    .map(obj)
    .filter((o): o is Json => !!o && !!str(o.optionId))
    .map((o) => ({ optionId: str(o.optionId), kind: str(o.kind) }));
  const want = mode === "auto" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const k of want) {
    const hit = list.find((o) => o.kind === k);
    if (hit) return hit;
  }
  return null;
}

/** A JSON-RPC error in words: its message, and its `data` where that says more (goose
 *  1.55 answers session/new with "Internal error" and the reason in `data`). */
export function errorWords(err: Json): string {
  const message = str(err.message);
  const data = str(err.data) || str(obj(err.data)?.message);
  return data && data !== message ? (message ? `${message}: ${data}` : data) : message;
}

/** What a request to run something was called, for the reply's list of refusals. */
function toolName(call: Json | null, titles: Map<string, string>): string | null {
  if (!call) return null;
  const t = str(call.title) || titles.get(str(call.toolCallId)) || str(call.name) || str(call.toolCallId);
  return t ? t.slice(0, 80) : null;
}

/** A session the daemon holds (the shape of daemon.ts's SdkSession, plus the agent's own id). */
export interface AcpHeld {
  /** Deliver one message; resolves with the agent's reply when the turn ends. */
  send(text: string): Promise<{ reply: string; error?: string }>;
  interrupt(): Promise<void>;
  close(): void;
  readonly busy: boolean;
  readonly lastUsed: number;
  readonly mode: "api";
  /** The id the agent gave the session. */
  readonly session: string;
  /** The process is gone or was closed: nothing more can be sent. */
  readonly closed: boolean;
}

export interface AcpOptions {
  bin: string;
  args: string[];
  cwd: string;
  mode: Mode;
  label: string;
  env?: NodeJS.ProcessEnv;
  /** Reopen this session of the agent's (`session/load`) instead of starting a new one. */
  load?: string;
  /** The reply so far, each time it grows. */
  onText?: (text: string) => void;
  log?: (line: string) => void;
  now?: () => number;
  /** A turn still running after this is cancelled, then stopped. */
  timeoutMs?: number;
  /** How long the agent may take to answer `initialize` and open the session. */
  openTimeoutMs?: number;
  /** On close, how long the agent gets to leave by itself before SIGTERM (then SIGKILL). */
  closeGraceMs?: number;
}

export type AcpStart = { held: AcpHeld } | { failed: string } | { unsupported: string };

const CLIENT_INFO = { name: "sessionpipe", title: "sessionpipe control", version: "1" };

/** Run an ACP agent and open a session in it. Resolves once the agent has answered
 *  `session/new` (or `session/load`); every later turn goes through `held.send`. */
export function startAcp(o: AcpOptions): Promise<AcpStart> {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const label = o.label;
  let child: ChildProcess;
  try {
    child = spawn(o.bin, o.args, {
      cwd: o.cwd,
      env: jobEnv(o.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (e) {
    return Promise.resolve({ failed: `couldn't start ${label}: ${(e as Error).message}` });
  }
  const kill = (sig: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {}
  };

  let gone: string | null = null; // why the process is no longer there
  let errTail = "";
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  const write = (m: Json) => {
    if (gone) return;
    try {
      child.stdin?.write(`${JSON.stringify(m)}\n`);
    } catch {}
  };
  const request = (method: string, params: Json, timeoutMs: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (gone) return reject(new Error(gone));
      const id = nextId++;
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${label} didn't answer ${method} in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      t.unref();
      pending.set(id, {
        resolve: (r) => {
          clearTimeout(t);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      write({ jsonrpc: "2.0", id, method, params });
    });
  const notify = (method: string, params: Json) => write({ jsonrpc: "2.0", method, params });

  // The turn in flight: its reply as it grows, and what it was refused.
  // `message`: the id of the chunk before, null for one that had none, undefined before any.
  let turn: { text: string; message?: string | null; denied: string[]; count: number } | null = null;
  const titles = new Map<string, string>();
  const onUpdate = (u: Json | null) => {
    if (!u) return;
    const kind = str(u.sessionUpdate);
    if (kind === "tool_call" && str(u.toolCallId) && str(u.title)) {
      if (titles.size >= 200) titles.clear();
      titles.set(str(u.toolCallId), str(u.title));
      return;
    }
    if (kind !== "agent_message_chunk" || !turn) return;
    const c = obj(u.content);
    if (c?.type !== "text" || !str(c.text)) return;
    // A new message after a tool step starts a new paragraph.
    const mid = str(u.messageId) || null;
    if (turn.message !== undefined && mid !== turn.message && turn.text.trim())
      turn.text = `${turn.text.trimEnd()}\n\n`;
    turn.message = mid;
    turn.text += str(c.text);
    o.onText?.(turn.text);
  };
  const onRequest = (id: unknown, method: string, params: Json | null) => {
    if (method !== "session/request_permission") {
      write({ jsonrpc: "2.0", id: id as string, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    const pick = permissionChoice(params?.options, o.mode);
    if (!pick?.kind.startsWith("allow")) {
      const name = toolName(obj(params?.toolCall), titles);
      if (turn) {
        turn.count++;
        if (name && !turn.denied.includes(name) && turn.denied.length < 20) turn.denied.push(name);
      }
    }
    write({
      jsonrpc: "2.0",
      id: id as string,
      result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } },
    });
  };
  const onLine = (line: string) => {
    let m: Json | null;
    try {
      m = obj(JSON.parse(line));
    } catch {
      return;
    }
    if (!m) return;
    const method = str(m.method);
    if (method) {
      if (m.id !== undefined) onRequest(m.id, method, obj(m.params));
      else if (method === "session/update") onUpdate(obj(obj(m.params)?.update));
      return;
    }
    const p = typeof m.id === "number" ? pending.get(m.id) : undefined;
    if (!p) return;
    pending.delete(m.id as number);
    const err = obj(m.error);
    if (err) p.reject(new Error(errorWords(err) || `${label} returned error ${String(err.code ?? "?")}`));
    else p.resolve(m.result);
  };
  let partial = "";
  child.stdout?.on("data", (b: Buffer) => {
    const lines = (partial + b.toString("utf8")).split("\n");
    partial = lines.pop() as string;
    for (const l of lines) if (l.trim()) onLine(l);
    if (partial.length > 4 * 1024 * 1024) partial = "";
  });
  child.stderr?.on("data", (b: Buffer) => {
    errTail = (errTail + b.toString("utf8")).slice(-4000);
  });
  const left = (why: string) => {
    if (gone) return;
    gone = why;
    for (const p of pending.values()) p.reject(new Error(why));
    pending.clear();
  };
  child.on("error", (e) => left(`couldn't start ${label}: ${e.message}`));
  const exited = (code: number | null, signal: NodeJS.Signals | null) => {
    const tail = errTail.trim().split("\n").slice(-3).join(" ").trim();
    left(`${label} exited (${signal || `code ${code}`})${tail ? `: ${tail}` : ""}`);
  };
  child.on("exit", exited);
  // A tool the agent left running can hold its stdout open after it exited; `close`
  // is also the end for a process that never started.
  child.on("close", exited);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      child.stdin?.end();
    } catch {}
    const grace = o.closeGraceMs ?? 2000;
    const t = setTimeout(() => kill("SIGTERM"), grace);
    t.unref();
    const k = setTimeout(() => kill("SIGKILL"), grace * 6);
    k.unref();
    child.once("exit", () => {
      clearTimeout(t);
      clearTimeout(k);
    });
  };

  const open = o.openTimeoutMs ?? 60_000;

  function held(session: string): AcpHeld {
    let busy = false;
    let lastUsed = now();
    return {
      session,
      mode: "api",
      get busy() {
        return busy;
      },
      get lastUsed() {
        return lastUsed;
      },
      get closed() {
        return closed || !!gone;
      },
      async send(text) {
        if (closed) return { reply: "", error: `${label} was closed` };
        busy = true;
        lastUsed = now();
        const t = { text: "", denied: [], count: 0 };
        turn = t;
        const limit = o.timeoutMs ?? JOB_TIMEOUT_MS;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          notify("session/cancel", { sessionId: session });
          setTimeout(close, 5000).unref();
        }, limit);
        timer.unref();
        try {
          const res = obj(
            await request("session/prompt", { sessionId: session, prompt: [{ type: "text", text }] }, limit + 10_000),
          );
          const stop = str(res?.stopReason);
          const words = t.text.trim() || `(${label} finished without a written reply.)`;
          const refused = deniedNote(t.denied, t.count);
          if (stop === "end_turn" || stop === "max_tokens") return { reply: words + refused };
          if (stop === "refusal") return { reply: `${words}\n\n(${label} refused the request.)${refused}` };
          if (stop === "cancelled")
            return timedOut
              ? {
                  reply: "",
                  error: `${label} was still working after ${Math.round(limit / 60_000)} minutes, so it was stopped`,
                }
              : { reply: `${words}\n\n(The turn was cancelled.)${refused}` };
          return { reply: "", error: `${label} ended the turn with ${stop || "no stop reason"}` };
        } catch (e) {
          return { reply: "", error: (e as Error).message };
        } finally {
          clearTimeout(timer);
          turn = null;
          busy = false;
          lastUsed = now();
        }
      },
      async interrupt() {
        notify("session/cancel", { sessionId: session });
      },
      close,
    };
  }

  return (async (): Promise<AcpStart> => {
    let signIn = "";
    try {
      const init = obj(
        await request(
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: CLIENT_INFO,
          },
          open,
        ),
      );
      const caps = obj(init?.agentCapabilities);
      const info = obj(init?.agentInfo);
      log(
        `${label}: ${str(info?.name) || "agent"} ${str(info?.version)} (ACP ${String(init?.protocolVersion ?? "?")})`,
      );
      // An agent that lists ways to sign in may refuse a session until someone did, at
      // the machine's terminal: the daemon never signs in for anyone. The agent's own
      // words for the first way, when it gives any (goose: "Run `goose configure` …").
      const methods = Array.isArray(init?.authMethods) ? init.authMethods.map(obj) : [];
      if (methods.length) {
        const how = str(methods[0]?.description) || str(methods[0]?.name);
        signIn = ` (if ${label} wants a sign-in, do it at the machine's terminal${how ? `: ${how}` : ""})`;
      }
      if (o.load) {
        if (!caps?.loadSession) {
          close();
          return { unsupported: `${label} can't reopen a session once it has been closed (no session/load)` };
        }
        await request("session/load", { sessionId: o.load, cwd: o.cwd, mcpServers: [] }, open);
        return { held: held(o.load) };
      }
      const res = obj(await request("session/new", { cwd: o.cwd, mcpServers: [] }, open));
      const session = str(res?.sessionId);
      if (!session) throw new Error(`${label} opened a session without naming it`);
      return { held: held(session) };
    } catch (e) {
      close();
      return { failed: `${(e as Error).message}${signIn}` };
    }
  })();
}
