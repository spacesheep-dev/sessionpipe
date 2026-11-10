// SPDX-License-Identifier: Apache-2.0
// Every sentence the control daemon puts around a message it delivers (control/route.ts,
// control/wait.ts, control/files.ts) against the copy in core that the transcript readers
// take off again (sessionpipe-core/control `deliveredWords`). The daemon still builds its
// frames from its own definitions; until it builds them from core's, this is what says a
// sentence changed on one side only: the readers would leave the new one in a turn's
// `user` text, where a receiver draws it as the person's own words.
import { shortId } from "@sessionpipe/core";
import * as core from "@sessionpipe/core/control";
import { describe, expect, it } from "vitest";
import { withFiles } from "../src/control/files.js";
import * as route from "../src/control/route.js";
import { RE_ARM } from "../src/control/wait.js";

const R = "https://spacesheep.dev/api/control";
const ID = "01K8ZC3W5Q7RN4XJ1V2B6T9M0D";
const WORDS = "Rebase the branch.\n\nThen run the tests.";

describe("the daemon's frames and core's", () => {
  it("are the same words", () => {
    expect(route.IN_PLACE_ANSWER).toBe(core.IN_PLACE_ANSWER);
    expect(route.COPY_NOTE).toBe(core.COPY_NOTE);
    expect(RE_ARM).toBe(core.RE_ARM);
    expect(route.hostOf(R)).toBe(core.hostOf(R));
    expect(route.frame(WORDS, R)).toBe(core.frame(WORDS, R));
    expect(route.inboxMark(ID)).toBe(core.inboxMark(ID));
    expect(route.frameInbox(WORDS, R, ID)).toBe(core.frameInbox(WORDS, R, ID));
    expect(route.frameStart(WORDS, R)).toBe(core.frameStart(WORDS, R));
    for (const from of ["codex:01a10860-a43f-7ce2-b12f-a7911ae8a880", undefined])
      expect(route.frameAsk(WORDS, from)).toBe(core.frameAsk(WORDS, from));
    const from = { harness: "codex", id: "01a10860-a43f-7ce2-b12f-a7911ae8a880" };
    expect(route.frameHandoff(from, R, WORDS)).toBe(
      core.frameHandoff(`codex:${shortId(from.harness, from.id)}`, R, WORDS),
    );
  });

  // Each text below is built as control/daemon.ts builds it for a lane.
  it("come off every text the daemon hands a session, leaving the person's words", () => {
    const files = withFiles(
      WORDS,
      [{ file: { type: "image/png", size: 183_402 } }] as Parameters<typeof withFiles>[1],
      [".sessionpipe/files/s1/shot.png"],
    );
    const lanes: Record<string, [string, string]> = {
      "a new session's first message": [route.frameStart(WORDS, R), WORDS],
      "a new session's first message, with files": [route.frameStart(files, R), files],
      "a headless resume": [route.frame(WORDS, R), WORDS],
      "a copy of a session open in a window": [`${route.frame(WORDS, R)}\n\n${route.COPY_NOTE}`, WORDS],
      "a Stop hook's block": [`${route.frame(WORDS, R)}\n\n${route.IN_PLACE_ANSWER}`, WORDS],
      "the inbox": [`${route.frameInbox(WORDS, R, ID)}\n\n${route.IN_PLACE_ANSWER}`, WORDS],
      "a waiter": [`${route.frame(WORDS, R)}\n\n${RE_ARM}`, WORDS],
    };
    // Another session's ask keeps the paragraph that says who asked, whichever way it
    // arrives: a receiver has nothing else to tell an agent's task from the person's words.
    const asked = route.frameAsk(WORDS, "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e");
    Object.assign(lanes, {
      "an ask: a new session, an idle one resumed, a Stop hook's block": [asked, asked],
      "an ask to a copy of a session open in a window": [`${asked}\n\n${route.COPY_NOTE}`, asked],
      "an ask through a waiter": [`${asked}\n\n${RE_ARM}`, asked],
    });
    for (const [lane, [given, words]] of Object.entries(lanes))
      expect(core.deliveredWords(given), lane).toMatchObject({ text: words, delivered: true });
    // What a channel is handed: the daemon's own undoing agrees with core's.
    expect(core.deliveredWords(route.frame(WORDS, R))).toMatchObject({
      text: route.unframe(route.frame(WORDS, R)).text,
      via: route.unframe(route.frame(WORDS, R)).via,
    });
    // A handoff's answer keeps its first line: it is what says whose words follow.
    const handoff = route.frameHandoff({ harness: "codex", id: "x" }, R, WORDS);
    expect(core.deliveredWords(handoff)).toEqual({ text: handoff, via: null, delivered: true });
  });
});
