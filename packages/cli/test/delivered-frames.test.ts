// SPDX-License-Identifier: Apache-2.0
// Every sentence the control daemon puts around a message it delivers (control/route.ts,
// control/wait.ts, control/files.ts) against what the transcript readers take off again
// (sessionpipe-core/control `deliveredWords`). The daemon builds its frames with core's
// own builders, so the words cannot differ; what can is the way the daemon puts them
// together for a lane, and a lane the readers don't know is left in a turn's `user`
// text, where a receiver draws it as the person's own words. Each lane below is built
// as control/daemon.ts builds it.
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
  it("are one definition", () => {
    expect(route.IN_PLACE_ANSWER).toBe(core.IN_PLACE_ANSWER);
    expect(RE_ARM).toBe(core.RE_ARM);
    expect(route.hostOf).toBe(core.hostOf);
    expect(route.frame).toBe(core.frame);
    expect(route.frameMarked).toBe(core.frameMarked);
    expect(route.messageMark).toBe(core.messageMark);
    expect(route.frameStart).toBe(core.frameStart);
    expect(route.frameAsk).toBe(core.frameAsk);
    expect(route.copyNote).toBe(core.copyNote);
    // What a copy of a session that is open in a window is told has not changed.
    expect(route.copyNote("open")).toBe(
      "You are a copy of that session, started because the original is open in a window, and you have its conversation, folder and tools. Do what the message asks the way the original would: edits, commands and publishing all take effect for real. Only this conversation stays here, so the person reads your reply and not the original's window: say what you did, then stop.",
    );
    expect(route.messageMark(ID)).toBe("message XJ1V2B6T9M0D");
    // A handoff's answer names who answered by the short id the receivers label sessions by.
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
      "a copy of a session open in a window": [`${route.frame(WORDS, R)}\n\n${route.copyNote("open")}`, WORDS],
      "a copy of a session another process is running": [
        `${route.frame(WORDS, R)}\n\n${route.copyNote("running")}`,
        WORDS,
      ],
      "a copy of a session something wrote to a moment ago": [
        `${route.frame(WORDS, R)}\n\n${route.copyNote("recent")}`,
        WORDS,
      ],
      // The in-place lanes name the message: that is how its answer is found again.
      "a Stop hook's block": [`${route.frameMarked(WORDS, R, ID)}\n\n${route.IN_PLACE_ANSWER}`, WORDS],
      "the inbox": [`${route.frameMarked(WORDS, R, ID)}\n\n${route.IN_PLACE_ANSWER}`, WORDS],
      "a waiter": [`${route.frameMarked(WORDS, R, ID)}\n\n${RE_ARM}`, WORDS],
      "a message with files, at a Stop": [`${route.frameMarked(files, R, ID)}\n\n${route.IN_PLACE_ANSWER}`, files],
    };
    // Another session's ask keeps the paragraph that says who asked, whichever way it
    // arrives: a receiver has nothing else to tell an agent's task from the person's words.
    // Handed over in place it names its message too, and comes back as the plain paragraph.
    const from = "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e";
    const asked = route.frameAsk(WORDS, from);
    const marked = route.frameAsk(WORDS, from, route.messageMark(ID));
    Object.assign(lanes, {
      "an ask: a new session, an idle one resumed": [asked, asked],
      "an ask to a copy of a session open in a window": [`${asked}\n\n${route.copyNote("open")}`, asked],
      "an ask to a copy of a session in use": [`${asked}\n\n${route.copyNote("recent")}`, asked],
      "an ask at a Stop hook's block": [marked, asked],
      "an ask through a waiter": [`${marked}\n\n${RE_ARM}`, asked],
    });
    for (const [lane, [given, words]] of Object.entries(lanes))
      expect(core.deliveredWords(given), lane).toMatchObject({ text: words, delivered: true });
    // What a channel is handed: the daemon's own undoing agrees with core's.
    expect(core.deliveredWords(route.frame(WORDS, R))).toMatchObject({
      text: route.unframe(route.frame(WORDS, R)).text,
      via: route.unframe(route.frame(WORDS, R)).via,
    });
    // A handoff's answer keeps its first line: it is what says whose words follow. It
    // carries no mark of its own, whatever lane it lands by.
    const handoff = route.frameHandoff({ harness: "codex", id: "x" }, R, WORDS);
    for (const given of [handoff, `${handoff}\n\n${route.copyNote("running")}`, `${handoff}\n\n${RE_ARM}`])
      expect(core.deliveredWords(given)).toEqual({ text: handoff, via: null, delivered: true });
  });
});
