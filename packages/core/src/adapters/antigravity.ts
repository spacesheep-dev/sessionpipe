// SPDX-License-Identifier: Apache-2.0
// Antigravity (Google) — docs: https://antigravity.google/docs/hooks
// Config: ~/.gemini/config/hooks.json — top-level keys are hook NAMES, ours is
// "sessionpipe". stdin is camelCase with NO event name (it rides in argv). A hook's
// stdout is its answer; non-JSON is a deny. Timeouts in seconds. No session end
// exists. Ported from spacesheep-cli lib/sessions.js (facts, remote url, projects).
//
// No PreToolUse. Its answer must carry a `decision` (allow / deny / ask / force_ask),
// none of which means "carry on": `{}` is read as a deny with no reason, which blocked
// every tool call on every machine 0.1–0.6.0 was installed on (2026-10-04, Antigravity
// 2.19.1), and `allow` would wave calls past the person's own review settings. So the
// tool events come from PostToolUse alone, which carries no tool name (only `stepIdx`
// and `error`): it is a "still working" beat.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { homeDir } from "../paths.js";
import { ends, parseLines } from "../readers/files.js";
import { readAntigravity } from "../readers/transcripts.js";
import { formatJson, readJsonFile } from "./claude-shaped.js";
import type {
  Adapter,
  BackfillRow,
  HookCommand,
  HookInput,
  HookResult,
  InstallOptions,
  InstallReport,
  SessionFacts,
} from "./types.js";

const NAME = "antigravity";
const HOOK_NAME = "sessionpipe";
export const AG_EVENTS = ["PreInvocation", "PostInvocation", "PostToolUse", "Stop"] as const;
/** What a PreToolUse entry an older install left behind gets, until a restarted
 *  conversation reads the rewritten hooks.json: the person's own prompt, with why. The
 *  hook (cli/src/hook.ts) and the launcher (cli/src/launcher.ts) print the same line. */
export const AG_STALE_PRETOOL =
  '{"decision":"ask","reason":"sessionpipe: an outdated PreToolUse hook is still loaded. Restart this conversation (or run sessionpipe install) to drop it."}\n';
/** Antigravity's answer for one event: `{}` is "carry on" for every event we register. */
export const antigravityAnswer = (event: string): string => (event === "PreToolUse" ? AG_STALE_PRETOOL : "{}\n");
const gemini = (env: NodeJS.ProcessEnv) => env.GEMINI_CLI_HOME || path.join(homeDir(), ".gemini");
const hooksFile = (env: NodeJS.ProcessEnv) => path.join(gemini(env), "config", "hooks.json");
const projectsDir = (env: NodeJS.ProcessEnv) => path.join(gemini(env), "config", "projects");
const dataDirs = (env: NodeJS.ProcessEnv) =>
  ["antigravity", "antigravity-cli", "antigravity-ide"].map((d) => path.join(gemini(env), d));
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const validTool = (n: unknown): n is string => typeof n === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(n);

// One tool event already, so a lean install is the same entry.
function entry(cmd: HookCommand) {
  const handler = (e: string) => ({ type: "command", command: cmd([NAME, e]).command, timeout: 5 });
  const out: Record<string, unknown> = { enabled: true };
  for (const e of AG_EVENTS) out[e] = /Tool/.test(e) ? [{ matcher: "*", hooks: [handler(e)] }] : [handler(e)];
  return out;
}

export const antigravity: Adapter = {
  name: NAME,
  events: AG_EVENTS,
  detect: (env = process.env) =>
    existsSync(path.join(gemini(env), "config")) || dataDirs(env).some((d) => existsSync(d)),
  configFiles: (env = process.env) => [hooksFile(env)],
  install(cmd, env = process.env): InstallReport[] {
    const file = hooksFile(env);
    const f = readJsonFile(file);
    if (!f.ok) return [{ file, changed: false, skipped: true, note: `${f.reason}; not touched` }];
    const hooks = f.value;
    const e = entry(cmd);
    if (JSON.stringify(hooks[HOOK_NAME]) === JSON.stringify(e)) return [{ file, changed: false }];
    hooks[HOOK_NAME] = e;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, formatJson(hooks, f));
    return [
      {
        file,
        changed: true,
        created: !f.existed,
        note: "hooks.json is read when a conversation starts; open ones report after a restart",
      },
    ];
  },
  uninstall(env = process.env, opts: InstallOptions = {}): InstallReport[] {
    const file = hooksFile(env);
    if (!existsSync(file)) return [{ file, changed: false }];
    const f = readJsonFile(file);
    if (!f.ok) return [{ file, changed: false, skipped: true, note: `${f.reason}; not touched` }];
    const hooks = f.value;
    if (!(HOOK_NAME in hooks)) return [{ file, changed: false }];
    delete hooks[HOOK_NAME];
    if (opts.created?.includes(file) && !Object.keys(hooks).length) {
      unlinkSync(file);
      return [{ file, changed: true, note: "removed (sessionpipe created it)" }];
    }
    writeFileSync(file, formatJson(hooks, f));
    return [{ file, changed: true }];
  },
  installed(cmd, env = process.env) {
    const file = hooksFile(env);
    const f = readJsonFile(file);
    const have = f.ok ? f.value[HOOK_NAME] : undefined;
    return [
      {
        file,
        state: !have ? "missing" : JSON.stringify(have) === JSON.stringify(entry(cmd)) ? "current" : "stale",
      },
    ];
  },

  fromHook(input: HookInput): HookResult | null {
    const event = input.argv[1] ?? "";
    let s: Record<string, unknown> = {};
    try {
      // A stdin that is JSON but not an object (`null`, a number) is no payload.
      const j: unknown = input.stdin ? JSON.parse(input.stdin) : {};
      if (j && typeof j === "object" && !Array.isArray(j)) s = j as Record<string, unknown>;
    } catch {}
    const id = (s.conversationId ?? s.session_id ?? s.sessionId) as string | undefined;
    const stdout = antigravityAnswer(event);
    if (!id) return { session: { id: "" }, events: [], stdout };
    const workspaces = agWorkspaces(s.workspacePaths);
    const session: HookResult["session"] = { id: String(id), cwd: workspaces[0] ?? input.cwd };
    if (typeof s.modelName === "string" && s.modelName !== "auto") session.model = s.modelName;
    const toolCall = s.toolCall as { name?: unknown; args?: unknown } | undefined;
    const tool = validTool(toolCall?.name) ? toolCall?.name : validTool(s.toolName) ? s.toolName : undefined;
    const ev = (type: string, data: Record<string, unknown>) => ({ type, data: prune(data), harnessEvent: event });
    const events: HookResult["events"] = [];
    switch (event) {
      case "PreInvocation":
        // Fires before every model call of an execution; only the first is the person's ask.
        if (Number(s.invocationNum) === 0 || s.invocationNum === undefined) {
          events.push(ev("session.started", { source: "unknown" }));
          events.push(ev("turn.started", {}));
        } else events.push(ev("session.heartbeat", {}));
        break;
      case "PostInvocation":
        break;
      case "PreToolUse":
        if (tool) events.push(ev("tool.started", { tool, input: toolCall?.args }));
        break;
      case "PostToolUse":
        // Antigravity names no tool here; a beat keeps a long run of tools "working".
        if (!tool) events.push(ev("session.heartbeat", {}));
        else
          events.push(
            ev("tool.ended", {
              tool,
              ok: !s.error,
              error: typeof s.error === "string" ? s.error.slice(0, 2000) : undefined,
              input: toolCall?.args,
            }),
          );
        break;
      case "Stop":
        events.push(ev("turn.ended", { reason: s.error ? "error" : "stop" }));
        break;
      default:
        return { session, events: [], stdout };
    }
    const r: HookResult = { session, events, stdout, hints: { workspaces } };
    if (typeof s.transcriptPath === "string") r.transcript = s.transcriptPath;
    return r;
  },

  readTranscript(file, fromLine) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return { turns: [], line: fromLine };
    }
    return readAntigravity(text.split("\n"), fromLine);
  },

  facts(session, transcript, hints): SessionFacts {
    if (!transcript) return {};
    return antigravityFacts(transcript, {
      conversation: session.id,
      workspaces: (hints.workspaces as string[] | undefined) ?? (session.cwd ? [session.cwd] : []),
      env: process.env,
    });
  },

  backfill(sinceMs, env = process.env): BackfillRow[] {
    const rows: BackfillRow[] = [];
    for (const data of dataDirs(env)) {
      let ids: string[] = [];
      try {
        ids = readdirSync(path.join(data, "brain")).filter((n) => /^[0-9a-f-]{36}$/i.test(n));
      } catch {}
      for (const id of ids) {
        const f = path.join(data, "brain", id, ".system_generated", "logs", "transcript.jsonl");
        try {
          if (statSync(f).mtimeMs < sinceMs) continue;
        } catch {
          continue;
        }
        const facts = antigravityFacts(f, { conversation: id, workspaces: [], env });
        if (!facts.started_at || !facts.last_at) continue;
        const { started_at, last_at, first_ask: _fa, harness_version: _hv, ...rest } = facts;
        rows.push({ session: { id, ...rest }, started_at, last_at });
      }
    }
    return rows;
  },
};

function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** A folder as Antigravity writes it (a file:// URI or a path) → an absolute path, or null. */
export function agPath(p: unknown): string | null {
  if (typeof p !== "string" || !p) return null;
  let s = p;
  if (/^file:/i.test(s)) {
    try {
      s = decodeURIComponent(new URL(s).pathname);
    } catch {
      return null;
    }
    if (process.platform === "win32" && /^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
  if (!path.isAbsolute(s)) return null;
  return path.resolve(s);
}
export const agWorkspaces = (paths: unknown): string[] =>
  (Array.isArray(paths) ? paths : [])
    .map(agPath)
    .filter((p): p is string => !!p)
    .filter((p, i, a) => a.indexOf(p) === i);

function agVariants(p: string): string[] {
  const out = [p];
  try {
    const r = realpathSync.native(p);
    if (r !== p) out.push(r);
  } catch {}
  return out;
}
function agProjects(dir: string): { id: string; folders: string[] }[] {
  const out: { id: string; folders: string[] }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return out;
  }
  for (const n of names) {
    const id = n.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    let j: { projectResources?: { resources?: { folderUri?: unknown; gitFolder?: { folderUri?: unknown } }[] } };
    try {
      j = JSON.parse(readFileSync(path.join(dir, n), "utf8"));
    } catch {
      continue;
    }
    const folders: string[] = [];
    // A resource is one of the kinds in Antigravity's project.proto: a plain folder is
    // `{ folderUri }`, a git checkout `{ gitFolder: { folderUri, defaultBranch, allowWrite } }`
    // (what 2.23.1 writes for a folder under git); google3 and remote resources name no folder.
    for (const r of j?.projectResources?.resources ?? []) {
      const f = agPath(r?.folderUri ?? r?.gitFolder?.folderUri);
      if (f) folders.push(...agVariants(f));
    }
    if (folders.length) out.push({ id, folders });
  }
  return out;
}
/** The project whose folder is the workspace or contains it; the deepest wins. */
export function agMatchProject(projects: { id: string; folders: string[] }[], workspaces: string[]): string | null {
  const ws: string[] = [];
  for (const w of workspaces) {
    const p = agPath(w);
    if (p) ws.push(...agVariants(p));
  }
  let best: string | null = null;
  let bestLen = -1;
  for (const pr of projects)
    for (const f of pr.folders) {
      const within = ws.some((w) => w === f || w.startsWith(f.endsWith(path.sep) ? f : f + path.sep));
      if (within && f.length > bestLen) {
        best = pr.id;
        bestLen = f.length;
      }
    }
  return best;
}

/** Antigravity's web remote: https://antigravity.google.com/r/<installation uuid>-v2, with
 *  ?p=c/<conversation>?section=<project> when the project is known. */
export function antigravityRemoteUrl(
  transcript: string,
  opts: { conversation?: string; workspaces?: string[]; env: NodeJS.ProcessEnv; projectsDir?: string },
): string | null {
  const i = transcript.indexOf(`${path.sep}brain${path.sep}`);
  const dirs = (i > 0 ? [transcript.slice(0, i)] : []).concat(dataDirs(opts.env));
  for (const d of dirs) {
    try {
      const m = /installation_uuid:\s*"([0-9a-f-]{36})"/i.exec(
        readFileSync(path.join(d, "antigravity_state.pbtxt"), "utf8"),
      );
      if (!m) continue;
      const base = `https://antigravity.google.com/r/${m[1]}-v2`;
      const conv = opts.conversation ?? "";
      if (!ID_RE.test(conv) || !opts.workspaces?.length) return base;
      const project = agMatchProject(agProjects(opts.projectsDir ?? projectsDir(opts.env)), opts.workspaces);
      return project ? `${base}?p=${encodeURIComponent(`c/${conv}?section=${project}`)}` : base;
    } catch {}
  }
  return null;
}

export function antigravityFacts(
  file: string,
  opts: { conversation: string; workspaces: string[]; env: NodeJS.ProcessEnv },
): SessionFacts {
  const { head, tail } = ends(file, 128 * 1024, 64 * 1024);
  const H = parseLines(head);
  const T = parseLines(tail);
  const out: SessionFacts = {};
  const url = antigravityRemoteUrl(file, opts);
  if (url) out.url = url;
  for (const j of H) {
    if (j.type !== "USER_INPUT" || typeof j.content !== "string") continue;
    const m = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/.exec(j.content);
    const text = (m ? (m[1] as string) : j.content).trim();
    const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
    if (!line || /^<[a-z_-]+>/i.test(line)) continue;
    out.title = line.length > 80 ? `${line.slice(0, 80).replace(/\s+\S*$/, "")}…` : line;
    out.title_source = "first-ask";
    break;
  }
  const times = H.concat(T)
    .map((j) => Date.parse(String(j.created_at ?? j.timestamp ?? "")))
    .filter((n) => n > 0);
  if (times.length) {
    out.started_at = Math.min(...times);
    out.last_at = Math.max(...times);
  }
  return out;
}
