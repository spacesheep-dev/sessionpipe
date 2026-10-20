// SPDX-License-Identifier: Apache-2.0
// An Antigravity row's link names its conversation and the project that holds the
// session's workspace: ?p=c/<conversation>?section=<project>. The project comes from
// ~/.gemini/config/projects/<id>.json, where a git checkout's folder sits under `gitFolder`
// and a plain folder's at the top of the resource.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { antigravity, antigravityRemoteUrl } from "../src/adapters/antigravity.js";
import type { FactsState } from "../src/adapters/types.js";

const INSTALL = "63814c3d-3d2c-4c7c-b2c8-1f483142ca28";
const CONV = "97fecab7-f315-422a-9507-9ffbab6764e6";
const PROJECT = "c02f9ed5-e5df-4b7a-9fc8-21b8756963ce";
const BASE = `https://antigravity.google.com/r/${INSTALL}-v2`;
const LINK = `${BASE}?p=c%2F${CONV}%3Fsection%3D${PROJECT}`;

let home: string;
let env: NodeJS.ProcessEnv;
let transcript: string;
const uri = (p: string) => pathToFileURL(p).href;
const project = (id: string, resources: unknown[]) =>
  writeFileSync(
    path.join(home, "config", "projects", `${id}.json`),
    JSON.stringify({ id, name: id, projectResources: { resources } }),
  );
const url = (workspaces: string[]) => antigravityRemoteUrl(transcript, { conversation: CONV, workspaces, env });

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-ag-projects-"));
  env = { GEMINI_CLI_HOME: home };
  mkdirSync(path.join(home, "config", "projects"), { recursive: true });
  const logs = path.join(home, "antigravity", "brain", CONV, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(path.join(home, "antigravity", "antigravity_state.pbtxt"), `installation_uuid:  "${INSTALL}"\n`);
  transcript = path.join(logs, "transcript.jsonl");
  writeFileSync(transcript, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("antigravity link: the project", () => {
  it("is found for a git checkout, whose folder Antigravity keeps under gitFolder", () => {
    const ws = path.join(home, "git", "repo");
    project(PROJECT, [{ gitFolder: { folderUri: uri(ws), defaultBranch: "main" } }]);
    expect(url([ws])).toBe(LINK);
    expect(url([path.join(ws, "app", "src")])).toBe(LINK);
  });
  it("is still found for a plain folder", () => {
    const ws = path.join(home, "notes");
    project(PROJECT, [{ folderUri: uri(ws) }]);
    expect(url([ws])).toBe(LINK);
  });
  it("is the deepest folder either kind names", () => {
    const outer = "e59ff482-652a-40f7-a390-4694eb445cbb";
    const ws = path.join(home, "git", "repo");
    project(outer, [{ folderUri: uri(path.join(home, "git")) }]);
    project(PROJECT, [{ gitFolder: { folderUri: uri(ws), allowWrite: true } }]);
    expect(url([path.join(ws, "app")])).toBe(LINK);
    expect(url([path.join(home, "git", "other")])).toBe(`${BASE}?p=c%2F${CONV}%3Fsection%3D${outer}`);
  });
  it("is none for google3 and remote resources, which name no folder", () => {
    const ws = path.join(home, "git", "repo");
    project(PROJECT, [
      { google3: { forkType: "FORK_TYPE_PIPER" } },
      { remoteResource: { type: "github", url: "https://github.com/example/repo" } },
      { gitFolder: "not a message" },
      { gitFolder: null },
      null,
    ]);
    expect(url([ws])).toBe(BASE);
  });
  it("reaches the session's facts from a hook's workspacePaths", () => {
    vi.stubEnv("GEMINI_CLI_HOME", home);
    const ws = path.join(home, "git", "repo");
    project(PROJECT, [{ gitFolder: { folderUri: uri(ws), defaultBranch: "main" } }]);
    const hook = antigravity.fromHook({
      argv: ["antigravity", "Stop"],
      stdin: JSON.stringify({ conversationId: CONV, workspacePaths: [uri(ws)], transcriptPath: transcript }),
      env: {},
      cwd: "/",
    });
    expect(hook?.transcript).toBe(transcript);
    const state: FactsState = { get: () => ({}), save: () => {} };
    const facts = antigravity.facts(hook?.session ?? { id: "" }, transcript, hook?.hints ?? {}, state);
    expect(facts.url).toBe(LINK);
  });
});
