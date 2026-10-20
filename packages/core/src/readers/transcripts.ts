// SPDX-License-Identifier: Apache-2.0
// Transcript readers: complete turns (a person's message + everything the assistant
// said before the next one), each with the line it ends on, and the line the
// cursor may advance to once every turn is delivered. Ported from spacesheep-cli
// lib/memory.js. One reader per harness file format; nothing else is vendor code.
import { codexReplayBoundary } from "../adapters/codex-rollout.js";
import type { TranscriptRead } from "../adapters/types.js";

interface Msg {
  role: "user" | "assistant";
  text: string;
  at: number;
  line: number;
}

export function pairTurns(msgs: Msg[], endLine: number): TranscriptRead {
  const turns: { user: string; assistant: string; at: number; startLine: number; endLine: number }[] = [];
  let cur: (typeof turns)[number] | null = null;
  for (const m of msgs) {
    if (m.role === "user") {
      // Never overwrite a prompt that has no reply yet: in an agentic turn the reply
      // comes after tool calls, and a second user record is not a new question.
      if (cur && !cur.assistant) {
        cur.user += `\n\n${m.text}`;
        continue;
      }
      if (cur) turns.push(cur);
      cur = { user: m.text, assistant: "", at: m.at, startLine: m.line, endLine: m.line };
    } else {
      if (!cur) cur = { user: "", assistant: "", at: m.at, startLine: m.line, endLine: m.line };
      cur.assistant += (cur.assistant ? "\n\n" : "") + m.text;
      cur.endLine = m.line;
    }
  }
  if (cur?.assistant) turns.push(cur);
  // A user message with no reply yet stays unsent: the cursor stops before it.
  const line = cur && !cur.assistant ? cur.startLine : endLine;
  const out: TranscriptRead = {
    turns: turns.map((t) => ({ user: t.user, assistant: t.assistant, at: t.at, endLine: t.endLine })),
    line,
  };
  if (cur && !cur.assistant && cur.user) out.open = { user: cur.user, at: cur.at };
  return out;
}

/** Injected context the person never typed: <tag>…</tag> wrappers, HTML comments, slash-command expansions. */
export const isInjected = (text: string): boolean =>
  (/^<[a-z_-]+>/i.test(text) && /<\/[a-z_-]+>\s*$/i.test(text)) || /^<!--\s/.test(text) || /^<command-/.test(text);

const parse = (raw: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
};
/** The line after the last whole one. A trailing line that does not parse has no
 *  newline yet (a write in progress): the cursor stops before it, or the prompt in
 *  it would never be read. */
const endOf = (lines: string[]) => {
  const last = lines[lines.length - 1];
  if (last === undefined) return 0;
  return last === "" || parse(last) === null ? lines.length - 1 : lines.length;
};
const textParts = (c: unknown, kinds: string[]): string => {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter(
      (b) =>
        b &&
        typeof b === "object" &&
        kinds.includes((b as { type?: string }).type ?? "") &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => (b as { text: string }).text)
    .join("\n");
};

/** Claude Code / Droid: {type:"user"|"assistant", message:{content}, timestamp, isMeta, isSidechain, origin}. */
export function readClaude(lines: string[], from: number): TranscriptRead {
  const msgs: Msg[] = [];
  for (let i = from; i < lines.length; i++) {
    const j = lines[i] ? parse(lines[i] as string) : null;
    if (!j || j.isSidechain) continue;
    const origin = j.origin as { kind?: string } | undefined;
    if (
      j.type === "user" &&
      (j.isMeta || j.isCompactSummary || j.repeatsCompactSummary || (origin?.kind && origin.kind !== "human"))
    )
      continue;
    const at = Date.parse(String(j.timestamp ?? "")) || Date.now();
    const c = (j.message as { content?: unknown } | undefined)?.content;
    if (j.type === "user") {
      const text = textParts(c, ["text"]).trim();
      if (!text || isInjected(text)) continue;
      msgs.push({ role: "user", text, at, line: i });
    } else if (j.type === "assistant" && Array.isArray(c)) {
      const text = textParts(c, ["text"]).trim();
      if (text) msgs.push({ role: "assistant", text, at, line: i });
    }
  }
  return pairTurns(msgs, endOf(lines));
}

/** What Codex writes into a session as a "user" message that the person never typed:
 *  `<environment_context>` and the like, and the AGENTS.md it read (`# AGENTS.md
 *  instructions for <folder>` followed by `<INSTRUCTIONS>`). */
export function codexInjected(text: string): boolean {
  return /^<[a-z_-]+>/i.test(text) || /^# AGENTS\.md instructions\b/i.test(text);
}

/** Codex rollout: {type:"response_item", payload:{type:"message", role, content:[{type:"input_text"|"output_text", text}]}}. */
export function readCodex(lines: string[], from: number): TranscriptRead {
  const msgs: Msg[] = [];
  const boundary = codexReplayBoundary(parse(lines.find((line) => line.trim()) ?? ""));
  // Find the boundary from the header even when resuming inside the replay.
  // Keep absolute line numbers: the delivery cursor refers to the original file.
  const start = boundary ? lines.findIndex((line) => boundary(parse(line))) : 0;
  if (start < 0) return pairTurns(msgs, endOf(lines));
  for (let i = Math.max(from, start); i < lines.length; i++) {
    const j = lines[i] ? parse(lines[i] as string) : null;
    if (!j || j.type !== "response_item") continue;
    const p = j.payload as { type?: string; role?: string; content?: unknown } | undefined;
    if (!p || p.type !== "message") continue;
    const at = Date.parse(String(j.timestamp ?? "")) || Date.now();
    const text = textParts(p.content, ["input_text", "output_text"]).trim();
    if (!text) continue;
    if (p.role === "user") {
      if (codexInjected(text)) continue; // Codex's own injections, not the person's words
      msgs.push({ role: "user", text, at, line: i });
    } else if (p.role === "assistant") msgs.push({ role: "assistant", text, at, line: i });
  }
  return pairTurns(msgs, endOf(lines));
}

/** Gemini CLI chat log: {type:"user"|"gemini", content|message|text, timestamp}. */
export function readGemini(lines: string[], from: number): TranscriptRead {
  const msgs: Msg[] = [];
  for (let i = from; i < lines.length; i++) {
    const j = lines[i] ? parse(lines[i] as string) : null;
    if (!j) continue;
    const role = j.type === "user" ? "user" : j.type === "gemini" || j.type === "model" ? "assistant" : null;
    if (!role) continue;
    const raw = j.content ?? j.message ?? j.text;
    const text = (typeof raw === "string" ? raw : textParts(raw, ["text"])).trim();
    if (!text) continue;
    const at = Date.parse(String(j.timestamp ?? "")) || Date.now();
    msgs.push({ role, text, at, line: i });
  }
  return pairTurns(msgs, endOf(lines));
}

/** Antigravity: one step per line, type USER_INPUT | PLANNER_RESPONSE, content with <USER_REQUEST> wrapping. */
export function readAntigravity(lines: string[], from: number): TranscriptRead {
  const msgs: Msg[] = [];
  for (let i = from; i < lines.length; i++) {
    const j = lines[i] ? parse(lines[i] as string) : null;
    if (!j || typeof j.content !== "string") continue;
    const at = Date.parse(String(j.created_at ?? j.timestamp ?? "")) || Date.now();
    if (j.type === "USER_INPUT") {
      const m = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/.exec(j.content);
      const text = (m ? (m[1] ?? "") : j.content).trim();
      if (text) msgs.push({ role: "user", text, at, line: i });
    } else if (j.type === "PLANNER_RESPONSE") {
      const text = j.content.trim();
      if (text) msgs.push({ role: "assistant", text, at, line: i });
    }
  }
  return pairTurns(msgs, endOf(lines));
}
