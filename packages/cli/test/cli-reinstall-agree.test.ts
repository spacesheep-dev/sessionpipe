// SPDX-License-Identifier: Apache-2.0
// `sessionpipe doctor` and `sessionpipe reinstall` agree about a computer with nothing to
// repair: where doctor says all is well of the copies on it, a reinstall plans nothing and
// says "Nothing to repair"; and what doctor finds, reinstall says in the same words.
// Both commands run whole, through `main`, against the SAME inventory: the look
// (reinstall/find.ts) is stood in for and answers a computer made up from a seed
// (helpers/reinstall-worlds.ts: the look's own rules, written a second time), so no disk
// decides what is found. Everything else either command reads is this test's own sandbox,
// which is the same for both and has nothing wrong with it: no agent hooked, no service
// file, no daemon answering, npm there, and the registry naming the worlds' newest release.
//
// Nothing here installs, removes or starts anything: npm, the run, the removal and every
// program are stood in for, and the ones that would change something fail the test when
// they are called.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ServiceState } from "@sessionpipe/core/service";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serviceLook, serviceSeen } from "../src/control/health.js";
import { type Copy, type Inventory, look, type Use } from "../src/reinstall/find.js";
import { remove } from "../src/reinstall/ours.js";
import { type Facts, idle, type Plan, plan, typing } from "../src/reinstall/plan.js";
import { carryOut } from "../src/reinstall/run.js";
import { VERSION } from "../src/run.js";
import { execCapture, installInto, latestVersion, npmDo } from "../src/update.js";
import { healthy, NEWEST, rng, world } from "./helpers/reinstall-worlds.js";

type Cli = typeof import("../src/cli.js");

/** The inventory both commands are answered with; null: the real look, at real folders. */
const given = vi.hoisted(() => ({ inv: null as unknown }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock("../src/reinstall/find.js", async (original) => {
  const real = await original<typeof import("../src/reinstall/find.js")>();
  return {
    ...real,
    look: vi.fn((o: Parameters<typeof real.look>[0]) => (given.inv as Inventory | null) ?? real.look(o)),
  };
});
// The plan is the real one, watched: what it was handed, and what it answered.
vi.mock("../src/reinstall/plan.js", async (original) => {
  const real = await original<typeof import("../src/reinstall/plan.js")>();
  return { ...real, plan: vi.fn(real.plan) };
});
vi.mock("../src/reinstall/run.js", async (original) => ({
  ...(await original<typeof import("../src/reinstall/run.js")>()),
  carryOut: vi.fn(),
}));
vi.mock("../src/reinstall/ours.js", async (original) => ({
  ...(await original<typeof import("../src/reinstall/ours.js")>()),
  remove: vi.fn(),
}));
vi.mock("../src/update.js", async (original) => ({
  ...(await original<typeof import("../src/update.js")>()),
  execCapture: vi.fn(),
  npmDo: vi.fn(),
  installInto: vi.fn(),
  latestVersion: vi.fn(),
  installEverywhere: vi.fn(),
  rearmHooks: vi.fn(),
}));
// No service manager is asked anything: this sandbox has no service.
vi.mock("../src/control/health.js", async (original) => ({
  ...(await original<typeof import("../src/control/health.js")>()),
  serviceSeen: vi.fn(() => null),
  serviceLook: vi.fn(() => null),
}));

let cli: Cli;
let tmp: string;
let home: string;

beforeAll(async () => {
  cli = await import("../src/cli.js");
});
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-agree-")));
  home = path.join(tmp, "home");
  mkdirSync(home);
  for (const [k, v] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    PATH: path.join(home, ".local", "bin"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    GEMINI_CLI_HOME: path.join(home, ".gemini"),
    GROK_HOME: path.join(home, ".grok"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_DATA: path.join(tmp, "data"),
    SESSIONPIPE_SOCKET: path.join(tmp, "ctl.sock"),
    SESSIONPIPE_SECRETS: "file",
    SESSIONPIPE_CLAUDE: path.join(tmp, "no-claude"),
    SESSIONPIPE_NO_UPDATE_CHECK: undefined,
    SESSIONPIPE_SERVICE_LABEL: undefined,
    SSH_CONNECTION: undefined,
    FORCE_COLOR: undefined,
    NO_COLOR: undefined,
    TERM: "xterm-256color",
    npm_config_registry: undefined,
    NPM_CONFIG_REGISTRY: undefined,
    // Where this runner keeps its own Node says nothing of the home that is looked in.
    npm_config_cache: undefined,
    npm_config_prefix: undefined,
    N_PREFIX: undefined,
    NVM_DIR: undefined,
    FNM_DIR: undefined,
    ASDF_DATA_DIR: undefined,
    VOLTA_HOME: undefined,
    // Nor does who started these tests: `npm test` and `npx vitest` say `npm_command` to
    // all they start, and the look passes a `node_modules/.bin` over where that is said.
    npm_command: undefined,
  }))
    vi.stubEnv(k, v as string);
  vi.resetAllMocks();
  given.inv = null;
  vi.spyOn(os, "hostname").mockReturnValue("test-box.local");
  // npm is there and says where it installs; its newest release is the worlds' newest;
  // the hook doctor times answers at once, and no other program answers at all.
  vi.mocked(execCapture).mockResolvedValue({ code: 0, stdout: `${path.join(home, ".local")}\n`, stderr: "" });
  vi.mocked(latestVersion).mockResolvedValue(NEWEST);
  vi.mocked(spawnSync).mockImplementation(((_cmd: string, argv: string[]) => ({
    status: argv.some((a) => a.endsWith("hook.js")) ? 0 : 1,
    stdout: "",
    stderr: "",
  })) as never);
  let tick = 0n;
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => (tick += 1_000_000n));
  // What would change this computer: never, in a file of looks and dry runs.
  for (const changes of [carryOut, remove, npmDo, installInto] as ReturnType<typeof vi.fn>[])
    vi.mocked(changes).mockImplementation(() => {
      throw new Error("a look, or a dry run, changed something");
    });
});
afterEach(() => {
  const changed = [carryOut, remove, npmDo, installInto].map(
    (f) => vi.mocked(f as ReturnType<typeof vi.fn>).mock.calls,
  );
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
  expect(changed).toEqual([[], [], [], []]);
});

/** One run of the CLI: what it printed, what it said of an error, and how it ended. */
async function run(...argv: string[]) {
  const lines: string[] = [];
  const io = { out: (s = "") => void lines.push(s), err: vi.fn(), exit: vi.fn() };
  await cli.main(argv, io);
  const code = process.exitCode;
  process.exitCode = undefined;
  return { lines, text: lines.join("\n"), errors: io.err.mock.calls.map((c) => String(c[0])), code };
}

/** The warnings a program reads from doctor that are about copies, or about what typing
 *  `sessionpipe` starts. */
const about = (warnings: string[]): string[] =>
  warnings.filter((w) => /cop(y|ies) of sessionpipe|Typing `sessionpipe`|on your PATH|sessionpipe reinstall/.test(w));
/** What `status` says of this computer, in its one line. */
const computer = (lines: string[]): string => lines.find((l) => /^ {2}\S This computer /.test(l)) ?? "";
/** The copies doctor counts: what the proof accepts, but an npx cache entry nothing uses. */
const installsOf = (inv: Inventory): Copy[] => inv.copies.filter((c) => c.slot && !idle(c));

interface Said {
  /** doctor: its verdict (the first line of `status`, which is doctor's own), whether its
   *  `copies` row is there (as `status` says the same row), the warnings a program gets
   *  about copies, and the copies it lists. */
  verdict: string;
  row: boolean;
  warnings: string[];
  listed: { dir: string; version: string | null; whole: boolean; uses: string[] }[];
  /** reinstall --dry-run: all it printed, what it refused with, its exit code, and the plan
   *  it made from the facts it read. */
  out: string;
  refused: string[];
  code: typeof process.exitCode;
  plan: Plan;
  facts: Facts;
}

/** What both commands say of one inventory; of the real folders of this home, for none. */
async function both(inv: Inventory | null): Promise<Said> {
  given.inv = inv;
  const j = JSON.parse((await run("doctor", "--json")).text) as { warnings: string[]; copies: Said["listed"] };
  const brief = await run("status");
  vi.mocked(plan).mockClear();
  const dry = await run("reinstall", "--dry-run");
  const made = vi.mocked(plan).mock;
  return {
    verdict: brief.lines[0] as string,
    row: computer(brief.lines).includes("copies: "),
    warnings: about(j.warnings),
    listed: j.copies,
    out: dry.text,
    refused: dry.errors,
    code: dry.code,
    plan: made.results[0]?.value as Plan,
    facts: made.calls[0]?.[1] as Facts,
  };
}

/** The facts of this sandbox, as `reinstall` reads them: nothing wrong, for every seed.
 *  (Beside them: where the hooks' own file would be, and that this sandbox keeps its files
 *  apart, which matters only to a look that may reach nothing.) */
const FINE = {
  latest: { version: NEWEST },
  npm: true,
  harnesses: [],
  hooks: { version: null, wrong: [] },
  wanted: false,
  service: null,
  staleSocket: false,
  daemon: null,
};
const fine = (f: Facts): boolean => {
  const { hookFiles: _files, apart: _apart, ...rest } = f;
  return JSON.stringify(rest) === JSON.stringify(FINE);
};
const NOTHING = `Nothing to repair: one sessionpipe, ${NEWEST}, the newest release.`;
const SEEDS = 500;

describe.skipIf(process.platform === "win32")("doctor and reinstall, of the same computer", () => {
  it(`property (a), through main: a computer whose one installed copy is whole, the newest and what is typed: doctor has nothing to say of its copies and reinstall plans nothing (${SEEDS} made-up computers)`, async () => {
    const wrong: string[] = [];
    // The page itself is read for some of them: the same row `status` sums up.
    const paged = rng(1);
    for (let seed = 0; seed < SEEDS; seed++) {
      const { inv } = healthy(seed);
      const installs = installsOf(inv);
      const one = installs[0] as Copy;
      const said = await both(inv);
      const no = (what: string, got: unknown) => wrong.push(`seed ${seed}: ${what}: ${JSON.stringify(got)}`);
      // The world is what it is said to be, whatever else is in it.
      if (
        installs.length !== 1 ||
        one.slot !== "global" ||
        one.version !== NEWEST ||
        one.wrong ||
        inv.typed !== one.dir
      )
        no("not a computer with one whole, newest, typed copy", installs);
      if (!fine(said.facts)) no("the sandbox's facts are not fine", said.facts);
      // doctor: all good, no row, no warning, and the one copy listed as whole.
      if (said.verdict !== "✓ All good") no("doctor's verdict", said.verdict);
      if (said.row) no("doctor has a copies row", said.warnings);
      if (said.warnings.length) no("doctor warns", said.warnings);
      if (
        JSON.stringify(said.listed) !== JSON.stringify([{ dir: one.dir, version: NEWEST, whole: true, uses: one.uses }])
      )
        no("doctor lists", said.listed);
      if (paged() < 0.15 && /^ {2}\S copies /m.test((await run("doctor")).text))
        no("doctor's page has a copies row", "");
      // reinstall: nothing to repair, said in those words, with no step, no refusal, exit 0.
      if (!said.plan.nothing?.startsWith("Nothing to repair") || said.plan.steps.length || said.plan.refuse)
        no("reinstall's plan", { nothing: said.plan.nothing, steps: said.plan.steps, refuse: said.plan.refuse });
      if (!said.out.includes(NOTHING) || said.out.includes("This will") || said.out.includes("Dry run"))
        no("reinstall printed", said.out);
      if (said.refused.length || said.code !== undefined) no("reinstall ended", [said.refused, said.code]);
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  it(`property (a), both ways: of a computer whose one installed copy is the newest, doctor says all good exactly where reinstall says "Nothing to repair"; and through what typing starts: unsure is nothing to doctor, what is known is a finding for both, in the same words (${SEEDS} computers of any kind)`, async () => {
    const wrong: string[] = [];
    const seen = { met: 0, good: 0, found: 0, unsure: 0, unsureGood: 0, noInstall: 0, inSlot: 0, offPath: 0, none: 0 };
    for (let seed = 0; seed < SEEDS; seed++) {
      const { inv } = world(seed);
      const installs = installsOf(inv);
      const said = await both(inv);
      const no = (what: string, got: unknown) => wrong.push(`seed ${seed}: ${what}: ${JSON.stringify(got)}`);
      const nothing = !!said.plan.nothing?.startsWith("Nothing to repair");
      // The row and the warnings are one finding, said twice; and with nothing else wrong
      // in this sandbox, the verdict is that finding too.
      if (said.row !== said.warnings.length > 0)
        no("doctor's row and its warnings disagree", [said.row, said.warnings]);
      if ((said.verdict === "✓ All good") === said.row) no("doctor's verdict and its row disagree", said.verdict);
      if (JSON.stringify(said.listed.map((c) => c.dir)) !== JSON.stringify(installs.map((c) => c.dir)))
        no("doctor lists other copies than it counts", said.listed);

      // --- what typing `sessionpipe` starts, in every world ---------------------------------
      const typed = inv.copies.find((c) => c.dir === inv.typed);
      const known = typing(inv);
      // What can't be told is nothing to doctor: no word of the file, whatever else it says.
      if (inv.unsure !== null) {
        seen.unsure++;
        if (known !== null) no("unsure, and typing() answers", known);
        if (said.warnings.some((w) => w.includes("can't be told") || w.startsWith("Typing")))
          no("unsure, and doctor says so", said.warnings);
        // And where reinstall has no step to take, its sentence is decided by the rest.
        if (said.plan.steps.length) no("unsure, and reinstall has steps", said.plan.steps.length);
        if (said.plan.nothing !== null && !said.plan.notes.some((n) => n.includes("can't be told from here")))
          no("unsure, and reinstall says nothing of it", said.plan.notes);
      }
      // What is known to be astray is doctor's finding, in the plan's own sentence, and
      // never "Nothing to repair".
      if (inv.typed !== null && typed?.slot !== "global") {
        seen.noInstall++;
        if (!known || !said.warnings.includes(known))
          no("what is typed is no installed copy, and doctor", said.warnings);
        if (said.verdict === "✓ All good") no("what is typed is no installed copy, and doctor says all good", "");
        if (nothing) no("what is typed is no installed copy, and reinstall says", said.plan.nothing);
        if (said.plan.steps.length) no("what is typed is no installed copy, and reinstall has steps", "");
        if (said.plan.nothing !== null && !said.plan.notes.includes(known as string))
          no("what is typed is no installed copy, and reinstall's notes are", said.plan.notes);
        // No line installs over what is left alone. Where it sits in a looked-in prefix's
        // own slot (what an install that was cut off left, a build) the line moves that
        // folder aside; anywhere else it shows what PATH finds.
        // (Never of what someone else's tool keeps: Volta's copy is Volta's to remove.)
        const inSlot =
          !inv.copies.find((c) => c.dir === inv.typed)?.keeper &&
          inv.prefixes.some((x) => path.join(x, "lib", "node_modules", "sessionpipe") === inv.typed);
        for (const r of said.refused) {
          if (/npm install/.test(r)) no("what is typed is left alone, and the line installs", said.refused);
          if (r.startsWith("sessionpipe: Typing `sessionpipe` starts")) {
            const line = inSlot ? `Next: mv -n ${inv.typed} ${inv.typed}.old\n` : "Next: which -a sessionpipe\n";
            if (!r.endsWith(line)) no("what is typed is left alone, and the line is", r);
            if (inSlot) seen.inSlot++;
          }
        }
      }
      // Nothing is typed. With a copy installed and no installed copy's command folder
      // one a shell looks in, `sessionpipe` is not found: a finding for both, which names
      // that copy's own folder, wherever a fresh copy would go. With no copy installed
      // there is nothing to say of PATH: doctor is silent, and what reinstall does about a
      // fresh copy is its own (a plan, or a refusal).
      const installed = inv.unsure ? [] : inv.copies.filter((c) => c.slot === "global" && !c.aside);
      const lost =
        inv.typed === null && inv.unsure === null && installed.length > 0 && !installed.some((c) => c.onPath);
      if (lost) {
        seen.offPath++;
        const off = `${path.join(installed[0]?.prefix as string, "bin")} is not on your PATH`;
        if (!known?.startsWith(off.replace("/w/home/u", "~")) && !known?.startsWith(off))
          no("an installed copy no shell looks for, and typing() says", known);
        if (!known || !said.warnings.includes(known))
          no("an installed copy no shell looks for, and doctor", said.warnings);
        if (said.verdict === "✓ All good") no("an installed copy no shell looks for, and doctor says all good", "");
        if (nothing) no("an installed copy no shell looks for, and reinstall says", said.plan.nothing);
        if (said.plan.nothing !== null && !said.plan.notes.includes(known as string))
          no("an installed copy no shell looks for, and reinstall's notes are", said.plan.notes);
        // A run that acts puts it right, and does not say it again beside its rows.
        if (said.plan.steps.length && said.plan.notes.includes(known as string))
          no("an installed copy no shell looks for, and the plan repeats it beside its steps", said.plan.notes);
      } else if (inv.typed === null && known !== null)
        no("nothing typed, a finding, and no installed copy off PATH", known);
      if (inv.typed === null && inv.unsure === null && installed.length === 0) {
        seen.none++;
        if (said.warnings.some((w) => w.includes("on your PATH")))
          no("no copy installed, and doctor speaks of PATH", said.warnings);
        if (nothing) no("no copy installed, and reinstall says", said.plan.nothing);
        // With nothing else found (no other copy, no dangling link), doctor says all good.
        if (!installsOf(inv).length && !inv.dangling.length && said.verdict !== "✓ All good")
          no("no copy at all, and doctor's verdict", said.verdict);
      }
      // Whatever doctor says of what typing starts is `typing`'s sentence, and no other.
      const told = said.warnings.filter((w) => w.startsWith("Typing") || w.includes("is not on your PATH"));
      if (JSON.stringify(told) !== JSON.stringify(known ? [known] : []))
        no("doctor's word on what typing starts", told);

      // --- the one installed copy is the newest: all good exactly where nothing to repair ----
      const one = installs.length === 1 ? (installs[0] as Copy) : null;
      if (one?.slot !== "global" || one.version !== NEWEST) {
        // Outside that, "Nothing to repair" is said of no computer at all.
        if (nothing) no("not one installed newest copy, and reinstall says", said.plan.nothing);
        continue;
      }
      seen.met++;
      if (!said.row !== nothing)
        no(`doctor ${said.row ? "has a finding" : "says all good"}, and reinstall`, {
          nothing: said.plan.nothing,
          steps: said.plan.steps.map((s) => s.do),
          refuse: said.plan.refuse,
          doctor: said.warnings,
        });
      if (nothing) {
        seen.good++;
        if (inv.unsure !== null) seen.unsureGood++;
        if (said.plan.steps.length || said.plan.refuse) no("nothing to repair, with steps or a refusal", said.plan);
        if (!said.out.includes(NOTHING) || said.out.includes("This will") || said.out.includes("Dry run"))
          no("nothing to repair, and reinstall printed", said.out);
        if (said.refused.length || said.code !== undefined)
          no("nothing to repair, and it ended", [said.refused, said.code]);
        // Never of a copy that is not what is typed, but where that can't be told (the gap
        // these tests reported: nothing typed, the copy off PATH, the home another folder).
        if (inv.typed !== one.dir && inv.unsure === null) no("nothing to repair, of a copy nobody types", inv.typed);
      } else {
        seen.found++;
        // What doctor found is what reinstall says, or what its plan puts right.
        if (said.plan.nothing !== null && JSON.stringify(said.plan.notes) !== JSON.stringify(told))
          no("one copy and a finding, and the two say", [said.plan.notes, told]);
      }
    }
    expect(wrong).toEqual([]);
    // Not a handful: the claim was put to a good part of them, on both sides, and through
    // each kind of what typing starts.
    expect(seen.met).toBeGreaterThan(SEEDS / 20);
    expect(seen.good).toBeGreaterThan(SEEDS / 50);
    expect(seen.found).toBeGreaterThan(SEEDS / 50);
    expect(seen.unsure).toBeGreaterThan(SEEDS / 25);
    expect(seen.unsureGood).toBeGreaterThan(0);
    expect(seen.noInstall).toBeGreaterThan(SEEDS / 50);
    expect(seen.inSlot).toBeGreaterThan(0);
    expect(seen.offPath).toBeGreaterThan(SEEDS / 100);
    expect(seen.none).toBeGreaterThan(SEEDS / 50);
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("doctor and reinstall, of the same service and daemon", () => {
  /** Who the manager names for the service (the daemon that answers is pid 4242), what
   *  that daemon says of who started it (`via`: null for someone by hand; no word at all:
   *  one from before 0.15), and whether that is two daemons (plan.ts `twins`). */
  const TABLE: [number | null, { via: string | null } | null, boolean][] = [
    [4242, { via: "launchd" }, false],
    [4242, null, false],
    [4242, { via: null }, false],
    [100, { via: null }, true],
    [100, { via: "supervisor" }, false],
    [100, null, true],
    [null, { via: null }, true],
    [null, { via: "systemd" }, false],
    [null, null, false],
  ];
  const EACH = 12;

  it(`two daemons, through main: of a computer whose one copy is whole, the newest, typed and served, doctor names \`sessionpipe reinstall\` exactly where reinstall plans to stop a daemon, and says all good exactly where reinstall says "Nothing to repair" (${TABLE.length} rows of who started the daemon, ${EACH} made-up computers each)`, async () => {
    // This computer is paired, so it needs the service: both commands look at it.
    mkdirSync(path.join(tmp, "config"), { recursive: true });
    writeFileSync(
      path.join(tmp, "config", "control.json"),
      JSON.stringify({
        name: "lab",
        folders: [],
        mode: "safe",
        receivers: [{ url: "https://r.example", machine: "m_1", token: "t", keys: [] }],
      }),
    );
    // Both are this release: the daemon that answers, and npm's newest.
    vi.mocked(latestVersion).mockResolvedValue(VERSION);
    const replies: Record<string, unknown> = {
      status: { op: "status", status: { version: VERSION, pid: 4242, name: "lab", receivers: [], busy: null } },
    };
    const server = net.createServer((socket) => {
      socket.once("data", (d) => {
        const r = replies[(JSON.parse(d.toString()) as { op: string }).op];
        if (r === undefined) socket.end();
        else socket.end(`${JSON.stringify(r)}\n`);
      });
    });
    await new Promise<void>((ok) => server.listen(process.env.SESSIONPIPE_SOCKET, () => ok()));
    const wrong: string[] = [];
    const seen = { two: 0, one: 0 };
    try {
      let made = 0;
      for (let seed = 0; made < TABLE.length * EACH; seed++) {
        // A made-up computer with nothing to repair, its one copy this release and the
        // one the service file names. One whose copy lives where no copy is to live
        // (Homebrew's versioned folder: no home) is passed over: there reinstall can plan
        // nothing at all, which is another matter (reported, and pinned below).
        const base = healthy(seed).inv;
        if (!base.home) continue;
        const [pid, word, two] = TABLE[made++ % TABLE.length] as (typeof TABLE)[number];
        const inv: Inventory = {
          ...base,
          copies: base.copies.map((c) =>
            c.dir === base.typed ? { ...c, version: VERSION, uses: [...new Set<Use>([...c.uses, "service"])] } : c,
          ),
        };
        const cli = path.join(base.typed as string, "dist", "cli.js");
        const state: ServiceState = {
          manager: "launchd",
          file: path.join(home, "Library", "LaunchAgents", "org.sessionpipe.control.plist"),
          installed: true,
          loaded: true,
          argv: [process.execPath, cli, "control", "run"],
          pid,
        };
        vi.mocked(serviceLook).mockReturnValue(state);
        vi.mocked(serviceSeen).mockReturnValue(state);
        if (word) replies.health = { op: "health", health: { accounts: [], copy: { cli, ...word } } };
        else delete replies.health;
        const said = await both(inv);
        const no = (what: string, got: unknown) =>
          wrong.push(
            `seed ${seed} (launchd names ${pid}, the daemon says ${JSON.stringify(word)}): ${what}: ${JSON.stringify(got)}`,
          );
        const byHand = said.warnings.filter((w) => w.includes("by hand"));
        const stops = said.plan.steps.some((s) => s.do === "stop");
        const nothing = !!said.plan.nothing?.startsWith("Nothing to repair");
        // What reinstall read is what the table says of this row.
        if (said.facts.daemon?.byHand !== (word ? word.via === null : null) || said.facts.service?.pid !== pid)
          no("the facts", [said.facts.service, said.facts.daemon]);
        if (two) {
          seen.two++;
          if (said.verdict !== "! 1 thing needs attention") no("doctor's verdict", said.verdict);
          if (byHand.length !== 1 || !byHand[0]?.includes("`sessionpipe reinstall` stops it"))
            no("doctor warns", said.warnings);
          if (!stops || nothing)
            no("reinstall's plan", { nothing: said.plan.nothing, steps: said.plan.steps.map((s) => s.do) });
          if (!said.out.includes("a daemon someone started by hand (pid 4242) holds the socket the service needs"))
            no("reinstall found", said.out);
          if (!said.out.includes("~ stop     the daemon started by hand (pid 4242), once it holds nothing"))
            no("reinstall's row", said.out);
        } else {
          seen.one++;
          if (said.verdict !== "✓ All good") no("doctor's verdict", said.verdict);
          if (said.warnings.length) no("doctor warns", said.warnings);
          if (stops || !nothing || said.plan.refuse)
            no("reinstall's plan", { nothing: said.plan.nothing, steps: said.plan.steps.map((s) => s.do) });
          if (!said.out.includes(`Nothing to repair: one sessionpipe, ${VERSION}, the newest release.`))
            no("reinstall printed", said.out);
          if (said.out.includes("started by hand")) no("reinstall found a daemon by hand", said.out);
        }
        if (said.refused.length || said.code !== undefined) no("reinstall ended", [said.refused, said.code]);
      }
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
    expect(wrong).toEqual([]);
    expect(seen).toEqual({ two: 3 * EACH, one: 6 * EACH });
  }, 60_000);

  it("no folder can hold the one copy: reinstall names `which -a sessionpipe`, not `doctor`, which names `reinstall` for the same computer", async () => {
    // Two strays where no shell looks, nothing typed, and no place for the one copy (the
    // look names none: this account's own folder holds what is not ours, say). The plan
    // refused with `sessionpipe doctor` as the next command, and doctor, for the same
    // computer, names `sessionpipe reinstall`: each named the other.
    const at = (prefix: string, o: Partial<Copy>): Copy => ({
      dir: path.join(prefix, "lib", "node_modules", "sessionpipe"),
      where: prefix.replace(home, "~"),
      prefix,
      slot: "global",
      not: null,
      aside: false,
      version: NEWEST,
      wrong: null,
      bins: [path.join(prefix, "bin", "sessionpipe")],
      uses: [],
      onPath: false,
      writable: true,
      keeper: null,
      ...o,
    });
    const a = at(path.join(home, "opt", "a"), {});
    const b = at(path.join(home, "opt", "b"), { version: "1.9.0" });
    const said = await both({
      reach: true,
      copies: [a, b],
      dangling: [],
      strangers: [],
      onPath: [],
      typed: null,
      unsure: null,
      home: null,
      taken: null,
      prefixes: [a.prefix as string, b.prefix as string],
      npx: path.join(home, ".npm", "_npx"),
    });
    expect(said.verdict).toBe("! 2 things need attention");
    expect(said.warnings).toEqual([
      "~/opt/a/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.",
      `2 copies of sessionpipe are on this computer (${NEWEST} in ${a.dir}; 1.9.0 in ${b.dir}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    expect(said.plan).toMatchObject({ nothing: null, steps: [] });
    expect(said.refused).toEqual([
      "sessionpipe: no folder on this computer can hold the one copy of sessionpipe. Nothing was changed. Next: which -a sessionpipe\n",
    ]);
  });
});

describe.skipIf(process.platform === "win32")("doctor and reinstall, at real folders", () => {
  function put(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  }
  /** A published sessionpipe as npm installs one for every folder, with its bin link. */
  const install = (prefix: string, version: string): string => {
    const dir = path.join(prefix, "lib", "node_modules", "sessionpipe");
    put(path.join(dir, "package.json"), { name: "sessionpipe", version });
    put(path.join(dir, "dist", "cli.js"), "");
    mkdirSync(path.join(prefix, "bin"), { recursive: true });
    symlinkSync(
      path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"),
      path.join(prefix, "bin", "sessionpipe"),
    );
    return dir;
  };
  /** The copy that typing starts answers its own release when `reinstall` asks it. */
  const answers = (version: string) =>
    vi
      .mocked(spawnSync)
      .mockImplementation(((_cmd: string, argv: string[]) =>
        argv[1] === "--version"
          ? { status: 0, stdout: `${version}\n`, stderr: "" }
          : { status: argv.some((a) => a.endsWith("hook.js")) ? 0 : 1, stdout: "", stderr: "" }) as never);
  const seenBy = (): Inventory => vi.mocked(look).mock.results.at(-1)?.value as Inventory;

  it("M3: the usual sudo install: one healthy copy, the newest, in a prefix this user may not write: doctor says all is well and reinstall that there is nothing to repair", async () => {
    const prefix = path.join(home, "usr-local");
    const copy = install(prefix, NEWEST);
    vi.stubEnv("PATH", [path.join(prefix, "bin"), path.join(home, ".local", "bin")].join(path.delimiter));
    vi.mocked(execCapture).mockResolvedValue({ code: 0, stdout: `${prefix}\n`, stderr: "" });
    answers(NEWEST);
    const locked = [path.join(prefix, "lib", "node_modules"), path.join(prefix, "bin"), prefix];
    for (const dir of locked) chmodSync(dir, 0o555);
    try {
      const said = await both(null);
      const inv = seenBy();
      expect(inv.typed).toBe(copy);
      expect(inv.home?.prefix).toBe(prefix);
      // Whoever runs the tests: the plan is the same where they may write it (root) and where not.
      expect(said.row).toBe(false);
      expect(said.warnings).toEqual([]);
      expect(said.listed).toEqual([{ dir: copy, version: NEWEST, whole: true, uses: ["typed"] }]);
      expect((await run("doctor")).lines[0]).toBe("✓ All good");
      expect(said.plan).toMatchObject({ nothing: NOTHING, steps: [], refuse: null });
      expect(said.out).toContain(NOTHING);
      expect(said.out).not.toContain("This will");
      expect(said.out).not.toContain("sudo");
      expect([said.refused, said.code]).toEqual([[], undefined]);
    } finally {
      for (const dir of locked.reverse()) chmodSync(dir, 0o755);
    }
  });

  it("M3: what typing starts, at real folders, each way: a shim nobody can see through is nothing to doctor and nothing to repair; a checkout that is typed, and a copy's folder off PATH, are a finding for both in the same words", async () => {
    const copy = install(path.join(home, ".local"), NEWEST);
    answers(NEWEST);
    const local = path.join(home, ".local", "bin");
    // A version manager's shim first on PATH, these commands not started through it.
    const shim = path.join(home, ".asdf", "shims", "sessionpipe");
    put(shim, '#!/bin/sh\nexec asdf exec sessionpipe "$@"\n');
    chmodSync(shim, 0o755);
    vi.stubEnv("PATH", [path.dirname(shim), local].join(path.delimiter));
    const unsure = await both(null);
    expect(seenBy()).toMatchObject({ typed: null, unsure: shim, home: null });
    expect([unsure.verdict, unsure.row, unsure.warnings]).toEqual(["✓ All good", false, []]);
    expect(unsure.listed).toEqual([{ dir: copy, version: NEWEST, whole: true, uses: [] }]);
    expect(unsure.plan).toMatchObject({
      nothing: NOTHING,
      steps: [],
      refuse: null,
      notes: [
        "Typing `sessionpipe` starts ~/.asdf/shims/sessionpipe, which is no link of npm's: which copy it starts can't be told from here.",
      ],
    });
    expect(unsure.out).toContain(NOTHING);
    expect([unsure.refused, unsure.code]).toEqual([[], undefined]);
    // A checkout someone linked first on PATH: that is known, and it is no installed copy.
    const source = path.join(home, "src", "sessionpipe");
    put(path.join(source, "package.json"), { name: "sessionpipe", version: "2.1.0-dev.1" });
    put(path.join(source, "dist", "cli.js"), "");
    put(path.join(source, "src", "cli.ts"), "");
    mkdirSync(path.join(home, "bin"));
    symlinkSync(path.join(source, "dist", "cli.js"), path.join(home, "bin", "sessionpipe"));
    vi.stubEnv("PATH", [path.join(home, "bin"), local].join(path.delimiter));
    const checkout = await both(null);
    const TYPED = "Typing `sessionpipe` starts ~/src/sessionpipe, which is no installed copy of it.";
    expect(seenBy()).toMatchObject({ typed: source, unsure: null, home: null });
    expect([checkout.verdict, checkout.row, checkout.warnings]).toEqual(["! 1 thing needs attention", true, [TYPED]]);
    expect(checkout.plan).toMatchObject({
      nothing: `One sessionpipe on this computer: ${NEWEST}, the newest release.`,
      steps: [],
      refuse: null,
      notes: [TYPED],
    });
    expect(checkout.out).not.toContain("Nothing to repair");
    expect([checkout.refused, checkout.code]).toEqual([[], undefined]);
    // Nothing on PATH leads to the copy, and its own folder is not on PATH either.
    vi.stubEnv("PATH", path.join(home, "elsewhere"));
    const off = await both(null);
    const OFF = "~/.local/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.";
    expect(seenBy()).toMatchObject({
      typed: null,
      unsure: null,
      home: { prefix: path.join(home, ".local"), onPath: false },
      taken: null,
    });
    expect([off.verdict, off.row, off.warnings]).toEqual(["! 1 thing needs attention", true, [OFF]]);
    expect(off.plan).toMatchObject({
      nothing: `One sessionpipe on this computer: ${NEWEST}, the newest release.`,
      steps: [],
      notes: [OFF],
    });
    expect(off.out).not.toContain("Nothing to repair");
    // On PATH, by npm's own link: all good, and nothing to repair with nothing beside it.
    vi.stubEnv("PATH", local);
    const well = await both(null);
    expect([well.verdict, well.row, well.warnings]).toEqual(["✓ All good", false, []]);
    expect(well.plan).toMatchObject({ nothing: NOTHING, notes: [], steps: [] });
  });

  it("M3: one whole copy of the newest release that no folder on PATH leads to, beside an empty folder of one's own that is on PATH: typing `sessionpipe` finds nothing, and both say so (it was 'All good' and 'Nothing to repair')", async () => {
    const prefix = path.join(home, ".npm-global");
    const copy = install(prefix, NEWEST);
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    vi.stubEnv("PATH", path.join(home, ".local", "bin"));
    vi.mocked(execCapture).mockResolvedValue({ code: 0, stdout: `${prefix}\n`, stderr: "" });
    const OFF = "~/.npm-global/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.";
    const said = await both(null);
    const inv = seenBy();
    // Nothing on PATH is a `sessionpipe`: nothing is typed, and nobody is unsure of it.
    expect(inv.onPath).toEqual([]);
    expect([inv.typed, inv.unsure]).toEqual([null, null]);
    // The place for a fresh copy is the folder that is on PATH, not the one the copy is
    // in; the copy itself says no shell looks in its folder.
    expect(inv.home).toMatchObject({ prefix: path.join(home, ".local"), onPath: true });
    expect(inv.copies.map((c) => [c.dir, c.wrong, c.uses, c.onPath])).toEqual([[copy, null, [], false]]);
    expect([said.verdict, said.row]).toEqual(["! 1 thing needs attention", true]);
    expect(said.warnings).toEqual([OFF]);
    expect(said.plan).toMatchObject({
      nothing: `One sessionpipe on this computer: ${NEWEST}, the newest release.`,
      notes: [OFF],
      steps: [],
      refuse: null,
    });
    expect(said.out).not.toContain("Nothing to repair");
    expect([said.refused, said.code]).toEqual([[], undefined]);
    // With the empty folder off PATH as well, the same of both.
    vi.stubEnv("PATH", path.join(home, "elsewhere"));
    const off = await both(null);
    expect(off.row).toBe(true);
    expect(off.warnings).toEqual([OFF]);
    expect(off.plan.nothing).toBe(`One sessionpipe on this computer: ${NEWEST}, the newest release.`);
    expect(off.plan.notes).toEqual(off.warnings);
    // An older copy there: reinstall acts (the one copy goes where a shell finds it, the
    // one nobody could type goes), and does not repeat the finding beside its rows.
    vi.stubEnv("PATH", path.join(home, ".local", "bin"));
    put(path.join(copy, "package.json"), { name: "sessionpipe", version: "1.9.0" });
    const older = await both(null);
    expect(older.warnings).toContain(
      "~/.npm-global/bin is not on your PATH: add it, or `sessionpipe` is not found when you type it.",
    );
    expect(older.plan.steps.map((s) => s.do)).toEqual(["fetch", "install", "use", "remove", "prove"]);
    expect(older.plan.notes).toEqual([]);
    expect(older.plan.home?.prefix).toBe(path.join(home, ".local"));
  });

  it("no copy installed, npm's own folder on PATH and `~/.local/bin` not: doctor says nothing of PATH (it named `~/.local/bin`, a folder reinstall would never install into), and reinstall installs where npm does", async () => {
    // Doctor takes the look without npm's prefix (it runs nothing), so with nothing typed
    // the one place it knew a fresh copy could go was `~/.local`: "~/.local/bin is not on
    // your PATH", counted as a thing to fix, for anyone who ran it through npx before
    // installing. With no copy installed there is nothing to say of a computer.
    const prefix = path.join(home, "node");
    mkdirSync(path.join(prefix, "bin"), { recursive: true });
    vi.stubEnv("PATH", path.join(prefix, "bin"));
    vi.mocked(execCapture).mockResolvedValue({ code: 0, stdout: `${prefix}\n`, stderr: "" });
    const said = await both(null);
    expect(said.listed).toEqual([]);
    expect([said.verdict, said.row, said.warnings]).toEqual(["✓ All good", false, []]);
    // The same computer, for reinstall: the fresh copy goes where npm installs, a shell
    // finds it there, and nothing is said of PATH.
    expect(seenBy().home).toMatchObject({ prefix, onPath: true, why: "npm's global folder" });
    expect(said.plan.notes).toEqual([]);
    expect(said.plan.steps.map((s) => s.do)).toEqual(["fetch", "install", "use", "prove"]);
    expect(said.out).toContain(`  + install  ${NEWEST}, the newest release, fresh in ~/node (npm's global folder)`);
    expect(said.out).not.toContain("is not on your PATH");
    expect([said.refused, said.code]).toEqual([[], undefined]);
    // Where no folder a fresh copy could go to is on PATH, doctor is still silent (there
    // is no copy to speak of), and reinstall refuses before any step with the line that adds it.
    vi.stubEnv("PATH", path.join(home, "elsewhere"));
    const nowhere = await both(null);
    expect([nowhere.verdict, nowhere.row, nowhere.warnings]).toEqual(["✓ All good", false, []]);
    expect(nowhere.plan.steps).toEqual([]);
    expect(nowhere.refused).toEqual([
      `sessionpipe: ~/node/bin is not on your PATH, so \`sessionpipe\` would not be found when you type it. Nothing was changed. Add it, then run this again. Next: export PATH=${path.join(prefix, "bin")}:"$PATH"\n`,
    ]);
  });

  it("the copy that is typed lives in Homebrew's versioned folder, and there is something to repair: doctor names `sessionpipe reinstall`, and reinstall repairs it there (it refused, and named `sessionpipe doctor`)", async () => {
    const cellar = path.join(home, "homebrew", "Cellar", "node", "22.1.0");
    const typed = install(cellar, "1.9.0");
    const stray = install(path.join(home, ".npm-global"), "1.9.0");
    vi.stubEnv("PATH", path.join(cellar, "bin"));
    answers("1.9.0");
    const said = await both(null);
    expect(seenBy()).toMatchObject({ typed, home: { prefix: cellar, why: "where the one you type is", onPath: true } });
    expect(said.verdict).toBe("! 1 thing needs attention");
    expect(said.warnings).toEqual([
      `2 copies of sessionpipe are on this computer (1.9.0 in ${typed}; 1.9.0 in ${stray}); \`sessionpipe reinstall\` leaves one clean copy`,
    ]);
    expect(said.plan.steps.map((s) => s.do)).toEqual(["fetch", "install", "use", "remove", "prove"]);
    expect(said.plan.home?.prefix).toBe(cellar);
    expect(said.out).toContain(
      `  + install  ${NEWEST}, the newest release, fresh in ~/homebrew/Cellar/node/22.1.0 (replaces 1.9.0)`,
    );
    expect([said.refused, said.code]).toEqual([[], undefined]);
  });

  it("M4: what doctor can't see without running it: a typed copy whose cli.js is there and does not answer its release is nothing to doctor, and reinstall's to repair", async () => {
    const copy = install(path.join(home, ".local"), NEWEST);
    const hook = (argv: string[]) => (argv.some((a) => a.endsWith("hook.js")) ? 0 : 1);
    // It answers nothing at all; it prints what is no release; it says it is another one.
    for (const [answer, wrong] of [
      [{ status: 1 }, "it doesn't run: `--version` printed nothing"],
      [{ status: 0, stdout: "Usage: something else\n" }, "it doesn't run: `--version` printed nothing"],
      [{ status: 0, stdout: "1.9.0\n" }, `it says it is 1.9.0, and its package.json says ${NEWEST}`],
    ] as const) {
      vi.mocked(spawnSync).mockImplementation(((_cmd: string, argv: string[]) =>
        argv[1] === "--version" ? answer : { status: hook(argv), stdout: "", stderr: "" }) as never);
      const said = await both(null);
      // doctor read it: whole, typed, nothing to say.
      expect(said.row).toBe(false);
      expect(said.warnings).toEqual([]);
      expect(said.listed).toEqual([{ dir: copy, version: NEWEST, whole: true, uses: ["typed"] }]);
      // reinstall asked it, and puts a fresh copy in its place.
      expect(seenBy().copies.map((c) => [c.dir, c.wrong])).toEqual([[copy, wrong]]);
      expect(said.plan.nothing).toBeNull();
      expect(said.plan.steps.map((s) => s.do)).toEqual(["fetch", "install", "use", "prove"]);
      expect(said.out).toContain(wrong);
      expect(said.out).toContain("This will");
      expect([said.refused, said.code]).toEqual([[], undefined]);
    }
  });

  it("no program is started by either command but the hook doctor times: no manager, no npm, no copy", async () => {
    install(path.join(home, ".local"), NEWEST);
    answers(NEWEST);
    await both(null);
    const started = [...vi.mocked(spawnSync).mock.calls, ...vi.mocked(execFileSync).mock.calls].map((c) =>
      [c[0], ...((Array.isArray(c[1]) ? c[1] : []) as string[])].join(" "),
    );
    // `reinstall` asks the one copy that typing starts for its version, once; doctor and
    // `status` ask none. And nothing else of this home, npm or a service manager is started.
    const cli = path.join(home, ".local", "lib", "node_modules", "sessionpipe", "dist", "cli.js");
    expect(started.filter((s) => s.includes("--version"))).toEqual([`${process.execPath} ${cli} --version`]);
    expect(started.filter((s) => s.includes(home) && !s.includes("--version"))).toEqual([]);
    expect(started.filter((s) => /\b(npm|npx|launchctl|systemctl|loginctl)\b/.test(s))).toEqual([]);
    expect(started.some((s) => s.includes("hook.js"))).toBe(true);
  });
});
