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
  });

  // A receiver captions a turn "asked with sessionpipe" by this paragraph and nothing else:
  // with it gone, an agent's task was drawn as the person's own message.
  it("keeps the paragraph that says an agent asked, and takes off only a note after it", () => {
    for (const from of ["claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e", undefined]) {
      const asked = frameAsk(ASK, from);
      expect(asked.startsWith(`${ASK}\n\n(Asked by `)).toBe(true);
      expect(deliveredWords(asked)).toEqual({ text: asked, via: null, delivered: true });
      // To a copy of a session open in a window, and through `sessionpipe wait`.
      expect(deliveredWords(`${asked}\n\n${COPY_NOTE}`)).toEqual({ text: asked, via: null, delivered: true });
      expect(deliveredWords(`${asked}\n\n${RE_ARM}`)).toEqual({ text: asked, via: null, delivered: true });
    }
  });

  // A person can type or paste any of these words. A sentence is sessionpipe's only where
  // the daemon puts it; a paragraph that merely reads like one is the person's.
  const typed = (text: string) => ({ text, via: null, delivered: false });
  const SENT = "(Sent via spacesheep.dev with sessionpipe control, signed on the sender's device.)";
  const HEAD = "Message via spacesheep.dev (sessionpipe control, signed on the sender's device):";
  it("a prompt that is only one of the sentences stays as typed", () => {
    for (const only of [SENT, HEAD, IN_PLACE_ANSWER, COPY_NOTE, RE_ARM, frameAsk("", "codex:01a10860").trim()])
      expect(deliveredWords(only), only.slice(0, 30)).toEqual(typed(only));
    // What the builders give for no words at all, and a frame with only a note after it.
    for (const built of [
      frame("", R),
      frameStart("", R),
      `${HEAD}\n\n${IN_PLACE_ANSWER}`,
      frameHandoff("codex:x", R, ""),
    ])
      expect(deliveredWords(built), built.slice(0, 30)).toEqual(typed(built));
  });

  it("a sentence in a place sessionpipe does not put it is the person's", () => {
    for (const text of [
      // A note with no frame before the words: nothing here came from the daemon.
      `do this\n\n${IN_PLACE_ANSWER}`,
      `do this\n\n${COPY_NOTE}`,
      `do this\n\n${RE_ARM}`,
      // The line that opens a message, not at the start; the one that closes one, not at the end.
      `first, typed here\n\n${frame("second", R)}`,
      `${frameStart("Count the files under docs/.", R)}\n\nand under src/ too`,
      // Combinations the daemon never builds.
      `${frameStart("do this", R)}\n\n${COPY_NOTE}`,
      `${frameAsk("do this", "codex:01a10860")}\n\n${IN_PLACE_ANSWER}`,
      `${frameHandoff("codex:ae08c6ab", R, "It was a race.")}\n\n${IN_PLACE_ANSWER}`,
    ])
      expect(deliveredWords(text), text.slice(0, 40)).toEqual(typed(text));
  });

  it("inside a delivered message, the person's own paragraphs stay, whatever they read like", () => {
    const quoting = `why did it say this?\n\n${IN_PLACE_ANSWER}\n\n${SENT}\n\nand this:\n\n${COPY_NOTE}`;
    // Only the daemon's own line and its one note come off, each from where it put it.
    expect(deliveredWords(`${frame(quoting, R)}\n\n${IN_PLACE_ANSWER}`)).toEqual(plain(quoting));
    expect(deliveredWords(frame(quoting, R))).toEqual(
      plain(`why did it say this?\n\n${IN_PLACE_ANSWER}\n\n${SENT}\n\nand this:`),
    );
    expect(deliveredWords(frameStart(quoting, R))).toEqual(plain(quoting));
  });

  it("keeps what the message says: the attached files, and whose answer a handoff carries", () => {
    const files =
      "Review these.\n\nAttached files (saved in this folder):\n- .sessionpipe/files/s1/a.png (image/png, 179 KB)";
    expect(deliveredWords(frameStart(files, R))).toEqual(plain(files));
    const handoff = frameHandoff("codex:ae08c6ab", R, "It was a race.\n\nFixed in ci.yml.");
    expect(deliveredWords(handoff)).toEqual({ text: handoff, via: null, delivered: true });
    // Handed to a copy of the session, or through a waiter: the note after it goes.
    for (const note of [COPY_NOTE, RE_ARM])
      expect(deliveredWords(`${handoff}\n\n${note}`)).toEqual({ text: handoff, via: null, delivered: true });
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
});
