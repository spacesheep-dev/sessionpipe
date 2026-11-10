// SPDX-License-Identifier: Apache-2.0
// The words sessionpipe puts around a message it delivers, and taking them off again.
// A receiver draws a turn's `user` text as the person's own message, so none of these
// may be left in it: a board showed "Reply with only the word IDLE1. You are a copy of
// that session, started because the original is open in a window, …" as what the person
// had written (2026-11-10).
import { describe, expect, it } from "vitest";
import {
  COPY_NOTE,
  deliveredWords,
  frame,
  frameAsk,
  frameHandoff,
  frameInbox,
  frameStart,
  hostOf,
  IN_PLACE_ANSWER,
  inboxMark,
  RE_ARM,
} from "../src/control/frames.js";

const R = "https://spacesheep.dev/api/control";
const ID = "01K8ZC3W5Q7RN4XJ1V2B6T9M0D";
const ASK = "Fix the flaky test in ci.yml.\n\nThen tell me what it was.";

describe("the frames", () => {
  it("say where a message came from, by the receiver's host", () => {
    expect(hostOf(R)).toBe("spacesheep.dev");
    expect(hostOf("http://localhost:8791/x")).toBe("localhost:8791");
    expect(hostOf("not a url")).toBe("not a url");
    expect(frame("hi", R)).toBe(
      "Message via spacesheep.dev (sessionpipe control, signed on the sender's device):\n\nhi",
    );
    expect(inboxMark(ID)).toBe("message XJ1V2B6T9M0D");
    expect(frameInbox("hi", R, ID)).toBe(
      "Message via spacesheep.dev (sessionpipe control, signed on the sender's device; message XJ1V2B6T9M0D):\n\nhi",
    );
    expect(frameStart("hi", R)).toBe(
      "hi\n\n(Sent via spacesheep.dev with sessionpipe control, signed on the sender's device.)",
    );
    expect(frameAsk("hi", "codex:01a10860")).toMatch(
      /^hi\n\n\(Asked by codex:01a10860 on this machine with sessionpipe ask\. /,
    );
    expect(frameAsk("hi", undefined)).toContain("(Asked by another session on this machine");
    expect(frameHandoff("codex:ae08c6ab", R, "It was a race.")).toBe(
      "Answer from codex:ae08c6ab (sessionpipe handoff, asked via spacesheep.dev):\n\nIt was a race.",
    );
  });
});

describe("deliveredWords", () => {
  const plain = (text: string, via: string | null = "spacesheep.dev") => ({ text, via, delivered: true });

  it("takes off the line that says where a message came from, before the words or after", () => {
    expect(deliveredWords(frame(ASK, R))).toEqual(plain(ASK));
    expect(deliveredWords(frameInbox(ASK, R, ID))).toEqual(plain(ASK));
    expect(deliveredWords(frameStart(ASK, R))).toEqual(plain(ASK));
    expect(deliveredWords(frameStart(ASK, "http://100.68.187.81:7373"))).toEqual(plain(ASK, "100.68.187.81:7373"));
  });

  it("takes off the notes to the model that travel with one", () => {
    // A Stop hook's block and the inbox: how the answer travels.
    expect(deliveredWords(`${frame(ASK, R)}\n\n${IN_PLACE_ANSWER}`)).toEqual(plain(ASK));
    expect(deliveredWords(`${frameInbox(ASK, R, ID)}\n\n${IN_PLACE_ANSWER}`)).toEqual(plain(ASK));
    // A copy of a session that is open in a window.
    expect(deliveredWords(`${frame(ASK, R)}\n\n${COPY_NOTE}`)).toEqual(plain(ASK));
    // `sessionpipe wait`.
    expect(deliveredWords(`${frame(ASK, R)}\n\n${RE_ARM}`)).toEqual(plain(ASK));
    // Another session's ask: the task stays, who asked and how the answer travels goes.
    expect(deliveredWords(frameAsk(ASK, "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e"))).toEqual(plain(ASK, null));
    expect(deliveredWords(frameAsk(ASK, undefined))).toEqual(plain(ASK, null));
  });

  it("wherever the line sits: another message joined after it leaves it in the middle", () => {
    const joined = `${frameStart("Count the files under docs/.", R)}\n\nand under src/ too`;
    expect(deliveredWords(joined)).toEqual(plain("Count the files under docs/.\n\nand under src/ too"));
    const two = `first, typed here\n\n${frame("second, from the board", R)}\n\n${IN_PLACE_ANSWER}`;
    expect(deliveredWords(two)).toEqual(plain("first, typed here\n\nsecond, from the board"));
  });

  it("keeps what the message says: the attached files, and whose answer a handoff carries", () => {
    const files =
      "Review these.\n\nAttached files (saved in this folder):\n- .sessionpipe/files/s1/a.png (image/png, 179 KB)";
    expect(deliveredWords(frameStart(files, R))).toEqual(plain(files));
    const handoff = frameHandoff("codex:ae08c6ab", R, "It was a race.\n\nFixed in ci.yml.");
    expect(deliveredWords(handoff)).toEqual({ text: handoff, via: null, delivered: true });
  });

  it("leaves text sessionpipe did not write exactly as it was", () => {
    for (const text of [
      "plain words",
      "  spaces kept, and\n\n\nblank lines  ",
      "",
      // The person quoting a frame inside a sentence, or half of one, is still the person.
      "what does (Sent via spacesheep.dev with sessionpipe control, signed on the sender's device.) mean?",
      "Message via spacesheep.dev (sessionpipe control, signed on the sender's device)",
      "Message via two words (sessionpipe control, signed on the sender's device):\n\nhi",
    ])
      expect(deliveredWords(text)).toEqual({ text, via: null, delivered: false });
  });

  it("a message that was nothing but frame is no words at all", () => {
    expect(deliveredWords(frame("", R))).toEqual(plain(""));
    expect(deliveredWords(`${frameStart("  ", R)}`)).toEqual(plain(""));
  });
});
