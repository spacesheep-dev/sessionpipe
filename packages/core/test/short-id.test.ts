// SPDX-License-Identifier: Apache-2.0
// The short id (PROTOCOL.md §3): the spec's vectors, and why it is a hash and not a prefix.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shortId } from "../src/short-id.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("shortId", () => {
  it("matches the spec's vectors", () => {
    expect(shortId("claude-code", "8c132906-8c3f-4814-870a-afc3d05e1d2e")).toBe("58ab6602");
    expect(shortId("codex", "01a10860-a43f-7ce2-b12f-a7911ae8a880")).toBe("ae08c6ab");
  });
  it("two Codex sessions from the same minute share an id prefix but not a short id", () => {
    const a = "01a10860-a43f-7ce2-b12f-a7911ae8a880";
    const b = "01a10860-a5bf-7472-9446-206557b2658e";
    expect(a.slice(0, 8)).toBe(b.slice(0, 8));
    expect(shortId("codex", a)).not.toBe(shortId("codex", b));
    expect(shortId("codex", b)).toBe("aa462bdb");
  });
  it("reaches every vector in conformance/short-id.json", () => {
    const { cases } = JSON.parse(readFileSync(path.join(root, "conformance/short-id.json"), "utf8")) as {
      cases: { name: string; harness: string; id: string; short_id: string }[];
    };
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const c of cases) expect(shortId(c.harness, c.id), c.name).toBe(c.short_id);
  });
  it("the harness is part of the hash", () => {
    expect(shortId("codex", "x")).not.toBe(shortId("claude-code", "x"));
    expect(shortId("codex", "x")).toMatch(/^[0-9a-f]{8}$/);
  });
});
