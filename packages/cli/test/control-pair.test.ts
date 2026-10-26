// SPDX-License-Identifier: Apache-2.0
// `sessionpipe control pair` against a scripted receiver (CONTROL.md §2): discovery,
// every answer a pairing poll can get, renewal, a second key for a paired receiver,
// `control off` and `control keys remove`; then the service files for each platform,
// written for real and started through a stand-in launchctl / systemctl.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Passkey } from "../../core/test/helpers/authenticator.js";
import {
  discover,
  ensureLinger,
  installService,
  off,
  type PairOptions,
  pair,
  removeKey,
  serviceFiles,
  uninstallService,
  withoutInherit,
} from "../src/control/pair.js";
import { readControl, writeControl } from "../src/control/store.js";

// The build bakes the version in; here it is what the receiver must be told.
vi.hoisted(() => {
  (globalThis as { __SESSIONPIPE_VERSION__?: string }).__SESSIONPIPE_VERSION__ = "9.9.9";
});
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));
const core = vi.hoisted(() => ({ accounts: vi.fn((): { harness: string; id: string; email?: string }[] => []) }));
vi.mock("@sessionpipe/core", async (original) => ({
  ...(await original<typeof import("@sessionpipe/core")>()),
  claudeAccounts: core.accounts,
  drivableHarnesses: () => ["claude-code"],
}));

const RP = "rx.test";
const URL_ = `https://${RP}`;
const CONTROL = `${URL_}/api/sessionpipe/v1/control`;
const MACHINE = "m_scripted000000000001";

type Answer = { status: number; body?: unknown; raw?: string } | Error;

/** A receiver as a list of answers: the well-known, then POST /pair and GET /pair in turn. */
class Scripted {
  wellKnown: Answer = {
    status: 200,
    body: {
      capabilities: ["events", "control"],
      endpoints: { events: "/api/sessionpipe/v1/events", control: "/api/sessionpipe/v1/control" },
      control: { signing: { rp_id: RP }, open_pairing: false },
    },
  };
  posts: Answer[] = [];
  gets: Answer[] = [];
  readonly seen: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    this.seen.push({
      method,
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const next = url.endsWith("/.well-known/sessionpipe")
      ? this.wellKnown
      : (method === "POST" ? this.posts : this.gets).shift();
    if (!next) throw new Error(`unscripted ${method} ${url}`);
    if (next instanceof Error) throw next;
    if (next.raw !== undefined) return new Response(next.raw, { status: next.status });
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  };
}

/** A well-known file whose receiver shows inherit mode as that (CONTROL.md §2). */
const knowsInherit: Answer = {
  status: 200,
  body: {
    capabilities: ["events", "control"],
    endpoints: { events: "/api/sessionpipe/v1/events", control: "/api/sessionpipe/v1/control" },
    control: { signing: { rp_id: RP }, open_pairing: false, inherit: true },
  },
};

let tmp: string;
let env: NodeJS.ProcessEnv;
let rx: Scripted;
let passkey: Passkey;
let out: string[];
const said = () => out.join("\n");

const started = (over: Record<string, unknown> = {}): Answer => ({
  status: 201,
  body: {
    machine: MACHINE,
    code: "CODE-1",
    url: `${URL_}/pair/CODE-1`,
    check: "123456",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    ...over,
  },
});
async function paired(over: Record<string, unknown> = {}, pk = passkey, code = "CODE-1"): Promise<Answer> {
  return {
    status: 200,
    body: { status: "paired", key: pk.key, proof: await pk.enroll(MACHINE, code), token: "machine-token", ...over },
  };
}
function opts(over: Partial<PairOptions> = {}): PairOptions {
  return {
    url: URL_,
    token: "sink-token",
    folders: [tmp],
    mode: "safe",
    name: "box",
    out: (s) => out.push(s),
    fetch: rx.fetch,
    sleep: async () => {},
    env,
    harnesses: ["claude-code"],
    accounts: [],
    ...over,
  };
}

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-pair-")));
  env = { SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"), SESSIONPIPE_STATE: path.join(tmp, "state") };
  rx = new Scripted();
  passkey = await Passkey.create({ rpId: RP, origin: URL_ });
  out = [];
  core.accounts.mockReset().mockReturnValue([]);
  vi.mocked(execFileSync).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});

describe("discovery", () => {
  it("needs a well-known file that lists control and its signing rp id", async () => {
    rx.wellKnown = { status: 404 };
    await expect(discover(URL_, rx.fetch)).rejects.toThrow(`${URL_} has no sessionpipe well-known file (HTTP 404)`);
    rx.wellKnown = { status: 200, body: { capabilities: ["events"], endpoints: { control: "/c" } } };
    await expect(discover(URL_, rx.fetch)).rejects.toThrow("doesn't serve control yet");
    rx.wellKnown = {
      status: 200,
      body: {
        capabilities: ["control"],
        endpoints: { control: "https://api.rx.test/control" },
        control: { signing: { rp_id: RP } },
      },
    };
    expect(await discover(`${URL_}/`, rx.fetch)).toEqual({
      control: "https://api.rx.test/control",
      rpId: RP,
      open: false,
      inherit: false,
      events: null,
    });
  });
});

describe("pairing (CONTROL.md §2)", () => {
  it("tells the receiver who this machine is, prints the link and digits, and trusts the key its proof vouches for", async () => {
    rx.posts = [started({ check: "ABC-DEF", expires_at: "soon" })];
    rx.gets = [{ status: 200, body: { status: "pending" } }, await paired()];
    const cfg = await pair(opts({ accounts: [{ harness: "claude-code", id: "acct", email: "a@x.io" }] }));
    expect(rx.seen[1]).toMatchObject({
      method: "POST",
      url: `${CONTROL}/pair`,
      auth: "Bearer sink-token",
      body: {
        name: "box",
        harnesses: ["claude-code"],
        modes: ["waiter", "turn", "resume", "fork"],
        version: "9.9.9",
        folders: [tmp],
        mode: "safe",
        accounts: [{ harness: "claude-code", id: "acct", email: "a@x.io" }],
      },
    });
    expect(rx.seen[1]?.body).not.toHaveProperty("poll_key");
    expect(rx.seen[2]).toMatchObject({ url: `${CONTROL}/pair?code=CODE-1`, auth: "Bearer sink-token" });
    // Digits that aren't six digits are shown as they came; no expiry given means ten minutes.
    expect(said()).toContain("The page shows these digits too: ABC-DEF");
    expect(said()).toContain("good for 10 minutes");
    expect(said()).toContain("names your Claude Code account: a@x.io");
    expect(said()).not.toContain("Approved by");
    expect(cfg.receivers[0]).toMatchObject({
      url: URL_,
      control: CONTROL,
      rpId: RP,
      machine: MACHINE,
      token: "machine-token",
    });
    expect(readControl(env)?.receivers[0]?.keys.map((k) => k.id)).toEqual([passkey.key.id]);
  });

  it("lists at most 20 harnesses, and `api` among the modes when an ACP agent is one of them", async () => {
    const many = ["claude-code", "codex", ...Array.from({ length: 25 }, (_, i) => `agent-${i}`)];
    rx.posts = [started()];
    rx.gets = [await paired()];
    await pair(opts({ harnesses: ["claude-code", "goose"] }));
    expect(rx.seen[1]?.body).toMatchObject({
      harnesses: ["claude-code", "goose"],
      modes: expect.arrayContaining(["api"]),
    });
    rx.seen.length = 0;
    rx.posts = [started()];
    rx.gets = [await paired()];
    await pair(opts({ harnesses: many }));
    expect(rx.seen[1]?.body).toMatchObject({
      harnesses: many.slice(0, 20),
      modes: ["waiter", "turn", "resume", "fork"],
    });
  });

  it("pairs in inherit mode only with a receiver that says it knows inherit (CONTROL.md §2)", async () => {
    await expect(pair(opts({ mode: "inherit" }))).rejects.toThrow(
      `${URL_} doesn't know inherit mode yet; it would show this machine as safe while the sessions you message run with no permission flag. Pair with --mode safe or --mode auto`,
    );
    // Nothing was sent: no pairing request reached it.
    expect(rx.seen.map((s) => s.method)).toEqual(["GET"]);
    rx.wellKnown = knowsInherit;
    rx.seen.length = 0;
    rx.posts = [started()];
    rx.gets = [await paired()];
    await pair(opts({ mode: "inherit" }));
    expect(rx.seen[1]?.body).toMatchObject({ mode: "inherit" });
    expect(readControl(env)?.mode).toBe("inherit");
  });

  it("withoutInherit names each receiver that doesn't know inherit, or can't be read", async () => {
    expect(await withoutInherit([URL_], rx.fetch)).toEqual([
      `${URL_} doesn't know inherit mode yet; it would show this machine as safe while the sessions you message run with no permission flag`,
    ]);
    rx.wellKnown = knowsInherit;
    expect(await withoutInherit([URL_], rx.fetch)).toEqual([]);
    const down = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    expect(await withoutInherit(["https://gone.test"], down)).toEqual([
      "couldn't check that https://gone.test knows inherit mode (fetch failed)",
    ]);
  });

  it("a receiver that answers 200 to the start is fine; one that refuses says why, or doesn't", async () => {
    rx.posts = [{ status: 403, body: { reason: "quota" } }];
    await expect(pair(opts())).rejects.toThrow("the receiver refused to start pairing (HTTP 403: quota)");
    rx.posts = [{ status: 500, raw: "<html>" }];
    await expect(pair(opts())).rejects.toThrow("the receiver refused to start pairing (HTTP 500)");
    rx.posts = [{ ...started(), status: 200 }];
    rx.gets = [await paired()];
    expect((await pair(opts())).receivers).toHaveLength(1);
  });

  it("keeps polling through a network blip, an unreadable answer and a pending one; 404 means the pairing is lost", async () => {
    rx.posts = [started()];
    rx.gets = [
      new Error("offline"),
      { status: 200, raw: "{" },
      { status: 200, body: { status: "pending" } },
      await paired(),
    ];
    expect((await pair(opts())).receivers).toHaveLength(1);
    expect(rx.seen.filter((s) => s.url.includes("?code=")).length).toBe(4);
    rx.posts = [started()];
    rx.gets = [{ status: 404 }];
    await expect(pair(opts({ env: { ...env, SESSIONPIPE_CONFIG: path.join(tmp, "two", "c.json") } }))).rejects.toThrow(
      "the receiver lost the pairing",
    );
  });

  it("a code past its time by this clock is renewed before any poll: keyed, under the same machine row", async () => {
    rx.posts = [
      started({ expires_at: new Date(Date.now() - 1000).toISOString() }),
      started({ code: "CODE-2", expires_at: new Date(Date.now() + 60_000).toISOString() }),
    ];
    rx.gets = [await paired({}, passkey, "CODE-2")];
    await pair(opts());
    expect(rx.seen.filter((s) => s.method === "POST")[1]?.body).toMatchObject({ machine: MACHINE });
    expect(said()).toContain("Nobody approved that code before it expired");
    expect(said()).toContain("good for 1 minute;");
  });

  it("open pairing: no token, a poll key the terminal keeps; a renewal starts clean", async () => {
    (rx.wellKnown as { body: { control: { open_pairing: boolean } } }).body.control.open_pairing = true;
    rx.posts = [started({ expires_at: new Date(Date.now() - 1000).toISOString() }), started({ code: "CODE-2" })];
    rx.gets = [await paired({ account: "@me", sink_token: "events-key" }, passkey, "CODE-2")];
    const sinks: string[] = [];
    await pair(opts({ token: null, addSink: (t) => sinks.push(t) }));
    const posts = rx.seen.filter((s) => s.method === "POST");
    expect(posts[0]?.auth).toBeNull();
    const pollKey = (posts[0]!.body as { poll_key: string }).poll_key;
    expect(pollKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(posts[1]?.body).not.toHaveProperty("machine");
    expect(rx.seen.find((s) => s.url.includes("?code="))?.auth).toBe(`Bearer ${pollKey}`);
    expect(said()).toContain("open https://rx.test/pair/CODE-1 and enter:  123 456");
    expect(said()).toContain("Approved by @me. If that isn't you, run `sessionpipe control off` now.");
    expect(sinks).toEqual(["events-key"]);
  });

  it("no token in the paired answer and none from before: nothing is trusted", async () => {
    rx.posts = [started()];
    rx.gets = [await paired({ token: undefined })];
    await expect(pair(opts())).rejects.toThrow("didn't hand this machine its token");
    expect(readControl(env)).toBeNull();
  });

  it("pairing again adds a key to the receiver's row, keeps its token and name, and never doubles a key", async () => {
    rx.posts = [started()];
    rx.gets = [await paired()];
    await pair(
      opts({
        accounts: [
          { harness: "claude-code", id: "a", email: "a@x.io" },
          { harness: "claude-code", id: "b", email: "b@x.io" },
        ],
      }),
    );
    expect(said()).toContain("names your Claude Code accounts: a@x.io, b@x.io");
    // The receiver hands over no token the second time; the first one stays.
    const phone = await Passkey.create({ rpId: RP, origin: URL_ });
    out = [];
    rx.posts = [started()];
    rx.gets = [await paired({ token: undefined }, phone)];
    const c = await pair(opts({ name: "", accounts: [{ harness: "claude-code", id: "a" }] }));
    expect(rx.seen.filter((s) => s.method === "POST")[1]?.body).toMatchObject({ machine: MACHINE, name: "box" });
    expect(c.receivers).toHaveLength(1);
    expect(c.receivers[0]?.token).toBe("machine-token");
    expect(c.receivers[0]?.keys.map((k) => k.id)).toEqual([passkey.key.id, phone.key.id]);
    expect(said()).toContain("2 key(s) trusted");
    expect(said()).not.toContain("accounts: ");
    rx.posts = [started()];
    rx.gets = [await paired({}, phone)];
    expect((await pair(opts())).receivers[0]?.keys).toHaveLength(2);
  });

  it("with no env of its own it reads the shell's, and a .claude.json it can't read names nobody", async () => {
    vi.stubEnv("SESSIONPIPE_CONFIG", env.SESSIONPIPE_CONFIG as string);
    vi.stubEnv("SESSIONPIPE_STATE", env.SESSIONPIPE_STATE as string);
    core.accounts.mockImplementation(() => {
      throw new Error("EACCES");
    });
    rx.posts = [started()];
    rx.gets = [await paired()];
    const o = opts();
    delete o.env;
    delete o.accounts;
    delete o.harnesses;
    const c = await pair(o);
    expect(rx.seen[1]?.body).toMatchObject({ harnesses: ["claude-code"] });
    expect(rx.seen[1]?.body).not.toHaveProperty("accounts");
    expect(c.receivers).toHaveLength(1);
    expect(readControl()?.receivers[0]?.machine).toBe(MACHINE);
    expect(said()).not.toContain("names your Claude Code account");
  });

  it("without a sleep of its own it waits two seconds between polls", async () => {
    vi.useFakeTimers();
    try {
      rx.posts = [started()];
      rx.gets = [await paired()];
      const o = opts();
      delete o.sleep;
      const done = pair(o);
      await vi.advanceTimersByTimeAsync(1999);
      expect(rx.seen.some((s) => s.url.includes("?code="))).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await done).receivers).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("control off and keys remove", () => {
  const two = () =>
    writeControl(
      {
        name: "box",
        folders: [tmp],
        mode: "safe",
        receivers: [
          { url: URL_, control: CONTROL, rpId: RP, machine: MACHINE, token: "t1", keys: [], paired_at: "x" },
          {
            url: "https://two.test",
            control: "https://two.test/control",
            rpId: "two.test",
            machine: "m_two0000000000000002",
            token: "t2",
            keys: [
              { id: "abcdef0123456789", alg: -7, spki: "k", added_at: "x" },
              { id: "zzzz", alg: -257, spki: "k", added_at: "x" },
            ],
            paired_at: "x",
          },
        ],
      },
      env,
    );

  it("off: tells each receiver (even one that can't be reached) and forgets it; by url, or all of them", async () => {
    await off({ out: (s) => out.push(s), env, fetch: rx.fetch });
    expect(said()).toContain("control isn't set up on this machine");
    expect(rx.seen).toEqual([]);
    two();
    const calls: string[] = [];
    const f: typeof fetch = async (u, init) => {
      calls.push(`${new Headers(init?.headers).get("authorization")} ${u}`);
      throw new Error("offline");
    };
    const c = await off({ out: (s) => out.push(s), env, fetch: f, url: `${URL_}/` });
    expect(calls).toEqual([`Bearer t1 ${CONTROL}/off`]);
    expect(c?.receivers.map((r) => r.url)).toEqual(["https://two.test"]);
    expect(said()).toContain(`removed ${URL_} (${MACHINE}, 0 key(s))`);
    // With no fetch of its own it uses the global one.
    vi.stubGlobal("fetch", f);
    const rest = await off({ out: (s) => out.push(s), env });
    expect(rest?.receivers).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(readControl(env)?.receivers).toEqual([]);
  });

  it("keys remove: by id or a prefix of it, across receivers; nothing when control isn't set up", () => {
    expect(removeKey("abc", env)).toBe(0);
    two();
    expect(removeKey("abcdef01", env)).toBe(1);
    expect(readControl(env)?.receivers[1]?.keys.map((k) => k.id)).toEqual(["zzzz"]);
    expect(removeKey("nope", env)).toBe(0);
  });
});

describe("the service that keeps the daemon running", () => {
  const platform = process.platform;
  const getuid = process.getuid;
  let home: string;
  let exec: ReturnType<typeof vi.fn<(cmd: string, args: string[]) => string>>;
  beforeEach(() => {
    home = path.join(tmp, "home");
    mkdirSync(home, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(home);
    exec = vi.fn<(cmd: string, args: string[]) => string>(() => "");
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    Object.defineProperty(process, "getuid", { value: getuid, configurable: true, writable: true });
  });
  const on = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p, configurable: true });

  it("writes a launchd plist and a systemd unit that restart the daemon and log to the state dir, escaped", () => {
    const f = serviceFiles({ node: "/opt/a&b/node", cli: '/x/"cli".js', logDir: "/log", home: "/h" });
    expect(f.plist.path).toBe(path.join("/h", "Library", "LaunchAgents", "org.sessionpipe.control.plist"));
    expect(f.plist.text).toContain('<string>/opt/a&amp;b/node</string><string>/x/"cli".js</string>');
    expect(f.plist.text).toContain(`<key>StandardOutPath</key><string>${path.join("/log", "daemon.log")}</string>`);
    expect(f.unit.path).toBe(path.join("/h", ".config", "systemd", "user", "sessionpipe-control.service"));
    expect(f.unit.text).toContain('ExecStart="/opt/a&b/node" "/x/\\"cli\\".js" "control" "run"');
    expect(serviceFiles({ node: "n", cli: "c", logDir: "l" }).plist.path.startsWith(home)).toBe(true);
  });

  it("darwin: bootstraps into the gui domain, or the user domain when nobody is at the screen", () => {
    const r = installService({ node: "/n", cli: "/c.js", env, exec, platform: "darwin" });
    const plist = path.join(home, "Library", "LaunchAgents", "org.sessionpipe.control.plist");
    expect(r).toBe(`launchd agent org.sessionpipe.control (log: ${path.join(tmp, "state", "control", "daemon.log")})`);
    expect(readFileSync(plist, "utf8")).toContain("<string>/c.js</string>");
    const uid = String(process.getuid?.() ?? "");
    expect(exec.mock.calls).toEqual([
      ["launchctl", ["bootout", `gui/${uid}/org.sessionpipe.control`]],
      ["launchctl", ["bootout", `user/${uid}/org.sessionpipe.control`]],
      ["launchctl", ["bootstrap", `gui/${uid}`, plist]],
    ]);
    exec.mockImplementation((_c, args) => {
      if (args[0] === "bootstrap" && args[1]?.startsWith("gui/"))
        throw new Error("Bootstrap failed: 5: Input/output error");
      return "";
    });
    process.getuid = undefined as never;
    expect(installService({ node: "/n", cli: "/c.js", env, exec, platform: "darwin" })).toContain(
      "in the background domain, since nobody is logged in at this Mac's screen",
    );
    expect(exec).toHaveBeenLastCalledWith("launchctl", ["bootstrap", "user/", plist]);
  });

  it("linux: enables the unit now, and lingers so it outlives the login; says so when systemd isn't reachable", () => {
    const unit = path.join(home, ".config", "systemd", "user", "sessionpipe-control.service");
    exec.mockImplementation((_c, args) => (args[0] === "show-user" ? "Linger=no\n" : ""));
    let r = installService({ node: "/n", cli: "/c.js", env, exec, platform: "linux" });
    expect(readFileSync(unit, "utf8")).toContain('ExecStart="/n" "/c.js" "control" "run"');
    expect(r).toContain(
      "systemd user unit sessionpipe-control.service; it stops when you log out: run `sudo loginctl enable-linger",
    );
    exec.mockImplementation((_c, args) => {
      if (args.includes("daemon-reload")) throw new Error("Failed to connect to bus");
      return "";
    });
    r = installService({ node: "/n", cli: "/c.js", env, exec, platform: "linux" });
    expect(r).toBe(
      `wrote ${unit}, but systemd --user isn't reachable here; run \`sessionpipe control run\` yourself (tmux, screen)`,
    );
    expect(installService({ node: "/n", cli: "/c.js", env, exec, platform: "freebsd" })).toContain(
      "no service manager for this platform yet",
    );
  });

  it("linger: already on, turned on now, or needs root (and a loginctl that isn't there)", () => {
    const script = (answers: string[]) => {
      const e = vi.fn<(cmd: string, args: string[]) => string>((_c, args) => {
        if (args[0] === "show-user") return answers.shift() ?? "";
        return "";
      });
      return e;
    };
    expect(ensureLinger("me", script(["Linger=yes\n"]))).toEqual({
      on: true,
      note: expect.stringContaining("already on"),
    });
    expect(ensureLinger("me", script(["Linger=no\n", "Linger=yes\n"]))).toEqual({
      on: true,
      note: expect.stringContaining("turned linger on"),
    });
    expect(ensureLinger("me", script(["Linger=no\n", "Linger=no\n"]))).toEqual({
      on: false,
      note: "it stops when you log out: run `sudo loginctl enable-linger me` once to keep it running",
    });
    expect(
      ensureLinger("me", () => {
        throw new Error("ENOENT");
      }).on,
    ).toBe(false);
    // The real runner is `execFileSync`, quiet.
    vi.mocked(execFileSync).mockReturnValue("Linger=yes\n" as never);
    expect(ensureLinger("me").on).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith("loginctl", ["show-user", "me", "--property=Linger"], expect.anything());
  });

  it("uninstall: unloads and removes the file this platform has, and nothing where there is none", () => {
    const f = serviceFiles({ node: "", cli: "", logDir: "", home });
    for (const p of ["darwin", "linux"] as const) {
      on(p);
      uninstallService(env);
      expect(execFileSync).not.toHaveBeenCalled();
    }
    on("darwin");
    mkdirSync(path.dirname(f.plist.path), { recursive: true });
    writeFileSync(f.plist.path, "plist");
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("not loaded");
    });
    uninstallService(env);
    expect(existsSync(f.plist.path)).toBe(false);
    expect(vi.mocked(execFileSync).mock.calls.map((c) => c[1])).toEqual([
      ["bootout", `gui/${process.getuid?.() ?? ""}/org.sessionpipe.control`],
      ["bootout", `user/${process.getuid?.() ?? ""}/org.sessionpipe.control`],
    ]);
    vi.mocked(execFileSync).mockClear();
    process.getuid = undefined as never;
    writeFileSync(f.plist.path, "plist");
    uninstallService(env);
    expect(vi.mocked(execFileSync).mock.calls[0]?.[1]).toEqual(["bootout", "gui//org.sessionpipe.control"]);
    vi.mocked(execFileSync).mockClear();
    on("linux");
    mkdirSync(path.dirname(f.unit.path), { recursive: true });
    writeFileSync(f.unit.path, "unit");
    uninstallService(env);
    expect(existsSync(f.unit.path)).toBe(false);
    expect(vi.mocked(execFileSync).mock.calls.map((c) => c[1])).toEqual([
      ["--user", "disable", "--now", "sessionpipe-control.service"],
      ["--user", "daemon-reload"],
    ]);
    on("win32");
    vi.mocked(execFileSync).mockClear();
    uninstallService(env);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
