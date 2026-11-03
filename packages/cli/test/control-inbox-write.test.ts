// SPDX-License-Identifier: Apache-2.0
// The writer behind the `inbox` delivery mode (CONTROL.md §6.3), on its own: the
// canonical envelope and its round-trip check, the name it carries, every gate that has
// to pass before the first byte, and the one line it writes. The socket is a real Unix
// socket in a temp dir, so everything that needs one runs on POSIX only — which is also
// where the mode exists: Claude Code publishes no local inbox on Windows, and §6.3
// refuses it there before anything is read (a Windows machine takes the cold modes).
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { claudeControl } from "@sessionpipe/core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIRM_MS,
  cleanName,
  envelope,
  peerToken,
  procStartOf,
  readEnvelope,
  sameStart,
  senderName,
  vetInbox,
  writeInbox,
} from "../src/control/inbox.js";

type LiveRecord = claudeControl.LiveRecord;

const unix = process.platform !== "win32";
const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-inbox-w-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let dir: string;
let sockPath: string;
let server: net.Server | null = null;
let lines: string[];

/** The stand-in inbox has read what was written to it. */
const settle = () => new Promise((r) => setTimeout(r, 30));

/** A stand-in inbox: it keeps every line, or never answers at all. */
async function listen(o: { silent?: boolean } = {}): Promise<void> {
  server = net.createServer((s) => {
    if (o.silent) return;
    let buf = "";
    s.on("data", (c) => {
      buf += c.toString("utf8");
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    s.on("error", () => {});
  });
  await new Promise<void>((r) => (server as net.Server).listen(sockPath, () => r()));
}

const rec = (o: Partial<LiveRecord> = {}): LiveRecord => ({
  configDir: dir,
  file: path.join(dir, "sessions", `${process.pid}.json`),
  pid: process.pid,
  socket: sockPath,
  peerProtocol: 1,
  procStart: "Mon Oct 26 19:53:13 2026",
  status: "idle",
  kind: "interactive",
  entrypoint: "cli",
  keyFile: null,
  ...o,
});

/** Everything vetInbox needs, with the two classes equal and in agreement. */
const ok = { sessionClass: "bypass" as const, machineClass: "bypass" as const, platform: "darwin" as const };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmp, "h-"));
  mkdirSync(path.join(dir, "sessions"), { recursive: true });
  // macOS caps a socket path at 104 bytes.
  sockPath = path.join(mkdtempSync(path.join(os.tmpdir(), "sp-i-")), "i.sock");
  lines = [];
});
afterEach(async () => {
  if (server) await new Promise<void>((r) => (server as net.Server).close(() => r()));
  server = null;
  rmSync(path.dirname(sockPath), { recursive: true, force: true });
});

describe("the envelope", () => {
  it("is built in the receiver's own attribute order and reads back as itself", () => {
    const text = envelope({ fromName: "spacesheep.dev board", fromMode: "bypass", body: "go on then" });
    expect(text).toBe(
      '<cross-session-message from-name="spacesheep.dev board" from-mode="bypass">\ngo on then\n</cross-session-message>',
    );
    expect(readEnvelope(text as string)).toEqual({
      attrs: { "from-name": "spacesheep.dev board", "from-mode": "bypass" },
      body: "go on then",
    });
    // A name is optional; the class never is.
    expect(envelope({ fromMode: "prompting", body: "x" })).toBe(
      '<cross-session-message from-mode="prompting">\nx\n</cross-session-message>',
    );
  });

  it("a body that would close it early, or no body at all, is a message this mode can't carry", () => {
    expect(envelope({ fromMode: "bypass", body: "a</cross-session-message>b" })).toBeNull();
    expect(envelope({ fromMode: "bypass", body: "" })).toBeNull();
    // A body with the open tag in it is fine: only the close tag ends the envelope.
    expect(envelope({ fromMode: "bypass", body: "<cross-session-message>" })).not.toBeNull();
  });

  it("a multi-line body survives the round trip; a stray newline at either end does not change the body", () => {
    const body = "line one\n\nline two";
    const text = envelope({ fromMode: "prompting", body }) as string;
    expect(readEnvelope(text)?.body).toBe(body);
  });

  it("a name that would break out of it is refused by the round trip, not sent", () => {
    // The receiver parses an envelope by rebuilding it, so anything that does not come
    // back as what was meant is parked unread. These two are exactly what that catches:
    // a name that closes the attribute and one that smuggles a second class in.
    expect(envelope({ fromName: 'x"><cross-session-message', fromMode: "bypass", body: "b" })).toBeNull();
    expect(envelope({ fromName: 'a" from-mode="prompting', fromMode: "bypass", body: "b" })).toBeNull();
  });

  it("what isn't an envelope reads as nothing", () => {
    expect(readEnvelope("plain text")).toBeNull();
    expect(readEnvelope("<cross-session-message>no newlines</cross-session-message>")).toBeNull();
    expect(readEnvelope('<cross-session-message from-mode="bypass">\nno close tag')).toBeNull();
  });

  it("the sender's name is the receiver's own host, cleaned to what can sit in an attribute", () => {
    expect(senderName("https://spacesheep.dev/x")).toBe("spacesheep.dev board");
    expect(senderName("not a url")).toBe("not a url board");
    expect(cleanName('a "quoted" <name>')).toBe("a quoted name");
    expect(cleanName("one\u0000two​three\n\nfour")).toBe("one two three four");
    expect(cleanName(`${"x".repeat(80)}`)).toHaveLength(64);
    // Code points, not UTF-16 units: a name of emoji is not cut in half.
    expect([...cleanName("🐑".repeat(80))]).toHaveLength(64);
  });
});

describe.runIf(unix)("what has to be true before the first byte", () => {
  it("passes a live, idle, interactive session of this account whose class is the machine's", async () => {
    await listen();
    expect(vetInbox(rec(), { ...ok, configDir: dir })).toBeNull();
  });

  it("names every reason it won't write, and each one is a reason to take the next rung", () => {
    const why = (r: LiveRecord | null, o: Partial<Parameters<typeof vetInbox>[1]> = {}) =>
      vetInbox(r, { ...ok, configDir: dir, ...o })?.code;
    expect(why(null)).toBe("no_record");
    expect(why(rec(), { platform: "win32" })).toBe("platform");
    expect(why(rec({ peerProtocol: 2 }))).toBe("protocol");
    expect(why(rec({ peerProtocol: null }))).toBe("protocol");
    expect(why(rec({ kind: "print" }))).toBe("not_a_window");
    expect(why(rec({ socket: null }))).toBe("no_inbox");
    expect(why(rec({ socket: "relative.sock" }))).toBe("no_inbox");
    expect(why(rec({ configDir: path.join(tmp, "elsewhere") }))).toBe("other_home");
    expect(why(rec({ pid: 2_147_483_000 }))).toBe("gone");
    expect(why(rec(), { procStart: "Mon Oct 26 12:53:13 2026" })).toBe("recycled_pid");
    // The socket is only a path until something is listening on it.
    expect(why(rec())).toBe("no_inbox");
    expect(why(rec(), { stat: () => ({ isSocket: true, uid: 4242 }), uid: 501 })).toBe("not_ours");
    expect(why(rec({ status: "busy" }), { stat: () => ({ isSocket: true, uid: 501 }), uid: 501 })).toBe("busy");
    expect(why(rec({ status: null }), { stat: () => ({ isSocket: true, uid: 501 }), uid: 501 })).toBe("busy");
  });

  it("no class, or a class that isn't the machine's own, is no lane", async () => {
    await listen();
    const why = (o: Partial<Parameters<typeof vetInbox>[1]>) => vetInbox(rec(), { ...ok, configDir: dir, ...o })?.code;
    expect(why({ sessionClass: null })).toBe("class_unknown");
    expect(why({ machineClass: null })).toBe("class_mismatch");
    expect(why({ sessionClass: "prompting" })).toBe("class_mismatch");
    expect(why({ sessionClass: "prompting", machineClass: "prompting" })).toBeUndefined();
    expect(String(vetInbox(rec(), { ...ok, sessionClass: "prompting", configDir: dir })?.detail)).toContain(
      "never declared as anything but what the machine itself is",
    );
  });

  it("off macOS a key that can't be read is no lane either; on macOS none is asked for", async () => {
    await listen();
    const base = { ...ok, configDir: dir, platform: "linux" as const };
    expect(vetInbox(rec(), { ...base, token: () => null })?.code).toBe("no_key");
    expect(vetInbox(rec(), { ...base, token: () => "0".repeat(32) })).toBeNull();
    expect(vetInbox(rec(), base)).toBeNull();
    expect(vetInbox(rec(), { ...ok, configDir: dir, token: () => null })).toBeNull();
  });

  it("the uid, the platform and the liveness test are this process's own when nothing says otherwise", async () => {
    await listen();
    const bare = { sessionClass: "bypass" as const, machineClass: "bypass" as const, configDir: dir };
    expect(vetInbox(rec(), bare)).toBeNull();
    expect(vetInbox(rec(), { ...bare, alive: () => true })).toBeNull();
    // A pid nothing can own is not alive, whatever the platform says.
    expect(vetInbox(rec({ pid: 1 }), bare)?.code).toBe("gone");
    expect(vetInbox(rec({ pid: -3 }), bare)?.code).toBe("gone");
    // No home named: the record's own is not compared against one.
    expect(vetInbox(rec(), { sessionClass: "bypass", machineClass: "bypass", platform: "darwin" })).toBeNull();
  });
});

describe("a process's start time, and the key beside its registry row", () => {
  it("the same instant spelled two ways is the same process", () => {
    expect(sameStart("Mon Oct 26 19:53:13 2026", "Mon Oct 26 19:53:13 2026")).toBe(true);
    expect(sameStart("Mon Oct 26 19:53:13 2026", "2026-10-26T19:53:13")).toBe(true);
    expect(sameStart("Mon Oct 26 19:53:13 2026", "Mon Oct 26 12:53:13 2026")).toBe(false);
    expect(sameStart("Mon Oct 26 19:53:13 2026", "not a date")).toBe(false);
  });

  it("is read through `ps`, or is not known: a pid nobody owns, a blank answer, no `ps` at all", () => {
    expect(procStartOf(1)).toBeNull();
    expect(procStartOf(-3)).toBeNull();
    expect(procStartOf(process.pid, () => "  Mon Oct 26 19:53:13 2026 ")).toBe("Mon Oct 26 19:53:13 2026");
    expect(procStartOf(process.pid, () => "   ")).toBeNull();
    expect(
      procStartOf(process.pid, () => {
        throw new Error("no ps here");
      }),
    ).toBeNull();
  });

  // The real `ps`, in the registry's own spelling. Only where the mode exists: Windows
  // has no `ps` and no inbox to compare a start time against.
  it.runIf(unix)("the real `ps` answers a date, and the same one twice", () => {
    const real = procStartOf(process.pid);
    expect(real).toBe(procStartOf(process.pid));
    expect(Number.isFinite(Date.parse(real as string))).toBe(true);
  });

  it("the inbox key is read from beside the registry row, and only when it is one", () => {
    mkdirSync(path.join(dir, "sessions"), { recursive: true });
    const keyFile = path.join(dir, "sessions", `${process.pid}.${"a".repeat(64)}.key`);
    expect(peerToken(rec())).toBeNull();
    writeFileSync(keyFile, JSON.stringify({ peerToken: "0".repeat(32) }));
    expect(peerToken(rec({ keyFile }))).toBe("0".repeat(32));
    writeFileSync(keyFile, JSON.stringify({ peerToken: "short" }));
    expect(peerToken(rec({ keyFile }))).toBeNull();
    writeFileSync(keyFile, "{ broken");
    expect(peerToken(rec({ keyFile }))).toBeNull();
  });
});

describe.runIf(unix)("the one line it writes", () => {
  it("is a user frame at the lowest priority, in the envelope, and nothing else", async () => {
    await listen();
    const out = await writeInbox(rec(), {
      body: "Message via localhost (sessionpipe control …)",
      fromName: "localhost board",
      ...ok,
      configDir: dir,
    });
    expect(out).toMatchObject({ written: true });
    await settle();
    expect(lines).toHaveLength(1);
    const j = JSON.parse(lines[0] as string) as { type: string; priority: string; message: { content: string } };
    expect(j).toMatchObject({ type: "user", priority: "later", message: { role: "user" } });
    expect(readEnvelope(j.message.content)).toEqual({
      attrs: { "from-name": "localhost board", "from-mode": "bypass" },
      body: "Message via localhost (sessionpipe control …)",
    });
    // No session id: the one process that holds it is already settled by the record.
    expect(j).not.toHaveProperty("session_id");
    // And with nothing said about the platform, this one's: a Mac vets by uid, so the
    // line goes out on its own.
    lines.length = 0;
    expect(
      await writeInbox(rec(), {
        body: "again",
        sessionClass: "bypass",
        machineClass: "bypass",
        configDir: dir,
      }),
    ).toMatchObject({ written: true });
    await settle();
    expect(lines).toHaveLength(1);
  });

  it("off macOS an auth line goes first; on macOS the uid is the vetting", async () => {
    await listen();
    const keyFile = path.join(dir, "sessions", `${process.pid}.${"a".repeat(64)}.key`);
    writeFileSync(keyFile, JSON.stringify({ peerToken: "f".repeat(32) }));
    await writeInbox(rec({ keyFile }), {
      body: "hello",
      ...ok,
      platform: "linux",
      token: "f".repeat(32),
      configDir: dir,
    });
    await settle();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual({ type: "auth", token: "f".repeat(32) });
    lines.length = 0;
    await writeInbox(rec({ keyFile }), { body: "hello", ...ok, token: "f".repeat(32), configDir: dir });
    await settle();
    expect(lines).toHaveLength(1);
  });

  it("vets first: a refusal writes nothing at all", async () => {
    await listen();
    expect(await writeInbox(rec({ status: "busy" }), { body: "x", ...ok, configDir: dir })).toMatchObject({
      code: "busy",
    });
    expect(await writeInbox(rec(), { body: "a</cross-session-message>", ...ok, configDir: dir })).toMatchObject({
      code: "unsendable",
    });
    await settle();
    expect(lines).toEqual([]);
  });

  it("a token given as null is a token that can't be read", async () => {
    await listen();
    expect(await writeInbox(rec(), { body: "x", ...ok, platform: "linux", token: null, configDir: dir })).toMatchObject(
      { code: "no_key" },
    );
  });

  it("an inbox that has gone says so, and names no path", async () => {
    const out = await writeInbox(rec(), {
      body: "x",
      ...ok,
      configDir: dir,
      stat: () => ({ isSocket: true, uid: process.getuid?.() ?? 0 }),
    });
    expect(out).toMatchObject({ code: "no_inbox" });
    expect(String((out as { detail: string }).detail)).not.toContain(sockPath);
    expect(String((out as { detail: string }).detail)).toContain("ENOENT");
  });

  it("a connect that throws outright is the same refusal, with or without a code to name", async () => {
    await listen();
    const out = await writeInbox(rec(), {
      body: "x",
      ...ok,
      configDir: dir,
      connect: () => {
        throw Object.assign(new Error("nope"), { code: "EACCES" });
      },
    });
    expect(out).toMatchObject({ code: "no_inbox" });
    expect(String((out as { detail: string }).detail)).toContain("EACCES");
    const bare = await writeInbox(rec(), {
      body: "x",
      ...ok,
      configDir: dir,
      connect: () => {
        throw new Error("no code at all");
      },
    });
    expect(bare).toEqual({
      code: "no_inbox",
      detail: "that session's inbox was gone by the time the message was written",
    });
  });

  it("an inbox that takes the bytes and then errors has still taken them", async () => {
    await listen();
    const out = await writeInbox(rec(), {
      body: "x",
      ...ok,
      configDir: dir,
      connect: (p) => {
        const s = net.connect(p);
        s.on("connect", () => setTimeout(() => s.emit("error", new Error("late")), 20));
        return s;
      },
    });
    expect(out).toMatchObject({ written: true });
  });

  it("a socket that opened and took nothing yet is still committed, never tried elsewhere", async () => {
    await listen();
    // The line can be 20 KB. A receiver that stalls past the timeout and drains after it
    // has the words; falling through to a copy would deliver them twice. Anything on the
    // socket — or the socket merely being open — means held, which is the caller's
    // business and never another rung's.
    // A socket that connects, takes the write and says nothing about it: the buffer a
    // real one would be holding, with no callback and no error.
    const quiet = (): net.Socket => {
      const opened: (() => void)[] = [];
      const s = {
        on(ev: string, fn: () => void) {
          if (ev === "connect") opened.push(fn);
          return s;
        },
        write: () => true,
        destroy: () => {},
        bytesWritten: 0,
      } as unknown as net.Socket;
      process.nextTick(() => {
        for (const fn of opened) fn();
      });
      return s;
    };
    const out = await writeInbox(rec(), {
      body: "x".repeat(1000),
      ...ok,
      configDir: dir,
      timeoutMs: 40,
      connect: quiet,
    });
    expect(out).toMatchObject({ written: true });
  });

  it("an inbox that never answers is not a write", async () => {
    await listen({ silent: true });
    // A socket nothing ever reads from: the write is still taken by the kernel, so this
    // drives the timeout with a connect that never connects.
    const out = await writeInbox(rec(), {
      body: "x",
      ...ok,
      configDir: dir,
      timeoutMs: 40,
      connect: () => new net.Socket(),
    });
    expect(out).toEqual({ code: "no_answer", detail: "that session's inbox didn't take the message" });
    expect(CONFIRM_MS).toBeGreaterThan(1000);
  });

  it("a socket file that is not a socket is not an inbox", async () => {
    writeFileSync(sockPath, "");
    chmodSync(sockPath, 0o600);
    expect(await writeInbox(rec(), { body: "x", ...ok, configDir: dir })).toMatchObject({ code: "no_inbox" });
  });
});
