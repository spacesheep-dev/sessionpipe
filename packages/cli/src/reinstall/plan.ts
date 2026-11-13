// SPDX-License-Identifier: Apache-2.0
// What `sessionpipe reinstall` will do, decided from what was found and from nothing
// else: no file is read here and nothing is run, so every state a computer can be in is
// a test with no computer. `--dry-run` prints this plan; a real run carries out the same
// one (run.ts). Each step names what it touches, and what the plan's row says of it.
//
// Two things hold for every plan. The one copy lives where the copy lives that typing
// `sessionpipe` starts: it is never answered with a second copy somewhere else. And a run
// either ends with typing `sessionpipe` starting a whole copy of the release it names, or
// it changes nothing: where that can't be promised, the plan is a refusal before any step.
import path from "node:path";
import { isNewer } from "@sessionpipe/core/version";
import { shq } from "../shell.js";
import type { Copy, Home, Inventory } from "./find.js";

/** What was found beside the copies. */
export interface Facts {
  /** npm's newest release, or why it couldn't be asked. */
  latest: { version: string } | { error: string };
  /** npm can be run from here. */
  npm: boolean;
  /** The harnesses set up on this computer. */
  harnesses: string[];
  /** The hooks' own files: the release that wrote them, and what is wrong with them or
   *  with the settings that call them. */
  hooks: { version: string | null; wrong: string[] };
  /** What writing the hooks again touches: their own files, and each harness's settings. */
  hookFiles: string[];
  /** Something on this computer needs the background service. */
  wanted: boolean;
  /** The service file, and what the service manager says of it. */
  service: {
    file: string;
    loaded: boolean;
    pid: number | null;
    node: string | null;
    /** The node and the copy the file names are there. */
    nodeOk: boolean;
    cliOk: boolean;
  } | null;
  /** A socket file with no daemon behind it. */
  staleSocket: boolean;
  /** The daemon that answers on the socket. `byHand`: its own word on who started it
   *  (someone, and no service manager); null where it doesn't say (one from before 0.15). */
  daemon: { pid: number; version: string; byHand: boolean | null } | null;
  /** This sessionpipe keeps its files somewhere other than this computer's usual place:
   *  the sentence that says so, and how to run this without that. */
  apart: { said: string; line: string } | null;
}

/** What is done, in order. `say`: what a step's row on the plan says after its verb
 *  (page.ts): what is installed, switched, stopped or removed. The download has no row
 *  (the safety line says it), nor has the check at the end (the run says it as it is
 *  made). */
export type Step = { touches: string[] } & (
  | { do: "fetch"; version: string }
  | { do: "install"; version: string; prefix: string; dir: string; replaces: boolean; say: string }
  | { do: "stop"; pid: number; say: string }
  /** `serve`: there is a service file or a running daemon to move onto the copy. Without
   *  either there is nothing this command can start: the hooks alone are written. `say`
   *  is null where there is nothing to switch: no agent hooked, nothing running. */
  | { do: "use"; serve: boolean; say: string | null }
  | { do: "remove"; path: string; say: string }
  | { do: "prove" }
);

/** A copy that stays, and why; `line` is the command that removes it where there is one. */
export interface Left {
  /** What stays, as a person reads it; and by its whole path, which no step touches. */
  where: string;
  path: string;
  version: string | null;
  why: string;
  line: string | null;
  /** A published copy this command would have removed: the job isn't done while it is there. */
  ours: boolean;
}

export interface Plan {
  /** Nothing to do: the sentence that says what is here. It says "nothing to repair"
   *  only where there is no note beside it. */
  nothing: string | null;
  /** It won't act: what stands in the way, and the one command to run. */
  refuse: { error: string; next: string } | null;
  /** The release the one copy is, and where it lives. */
  target: string | null;
  home: Home | null;
  /** The home's copy is not installed again: it is whole and the newest, where this user
   *  may not write. The words of its row. Null: it is installed fresh. */
  stays: string | null;
  steps: Step[];
  /** What keeps a run safe, under the rows: a line each. */
  safety: string[];
  /** The file first on PATH that npm did not make, where what typing starts was taken
   *  from how this command was started and not read (find.ts `inferred`); and how many
   *  installed copies stay for that reason. A run then says nothing of what typing starts. */
  inferred: string | null;
  kept: number;
  left: Left[];
  /** Said beside the plan, and again when it is done: what is not this command's to repair. */
  notes: string[];
}

/** The package folder a prefix holds sessionpipe in. */
export const slotIn = (prefix: string): string => path.join(prefix, "lib", "node_modules", "sessionpipe");

/** Two daemons: a service manager has the service, and the daemon that answers is one
 *  someone started by hand, which holds the socket the service needs. Never where the
 *  manager names the answering process as its own. Otherwise the daemon's own word
 *  decides; one that doesn't say (from before 0.15) is told by its process being another
 *  than the one the manager names, and where the manager names none, nothing is told.
 *  `reinstall` and `doctor` both go by this, so they agree on it. */
export const twins = (
  service: { pid: number | null } | null,
  daemon: { pid: number; byHand: boolean | null } | null,
): boolean => !!service && !!daemon && service.pid !== daemon.pid && (daemon.byHand ?? service.pid !== null);

/** An npx cache entry that nothing uses but, at most, this very command: a cache, not a
 *  copy to repair (`npx -y sessionpipe@latest reinstall` runs from one). */
export const idle = (c: Copy): boolean => c.slot === "npx" && !c.uses.some((u) => u !== "this");

/** A copy in a row: its release and its folder. A copy that is ours names its release
 *  (the proof asks for it); what names none is a folder left behind: npm's or this
 *  command's own, or what is left of a copy that was emptied. What is wrong with a copy
 *  is in the table. */
const named = (c: Copy): string => (c.aside ? `a leftover folder in ${c.where}` : `${c.version} in ${c.where}`);

/** What typing `sessionpipe` starts, where that is known not to be an installed copy a
 *  shell finds: the sentence that says so; null where it is one, or can't be told. It is
 *  no fault of a copy, and not this command's to mend: `reinstall` and `doctor` both say
 *  it, and neither calls such a computer all good. */
export function typing(inv: Inventory, show: (p: string) => string = (p) => p): string | null {
  if (inv.typed) return null;
  // Nothing is typed. With a copy installed, that is a finding where no installed copy's
  // command folder is one a shell looks in. (With none installed there is nothing to say
  // of a computer: where a fresh one would go is `reinstall`'s to decide when it acts.)
  const installed = inv.unsure ? [] : inv.copies.filter((c) => c.slot === "global" && !c.aside);
  const off = installed.find((c) => !c.onPath);
  return off && !installed.some((c) => c.onPath)
    ? `${show(path.join(off.prefix as string, "bin"))} is not on your PATH: add it, or \`sessionpipe\` is not found when you type it.`
    : null;
}

/** What typing `sessionpipe` starts, where that is something other than a copy npm
 *  installed: a contributor's checkout, a linked folder, the copy Volta keeps. Nothing is
 *  wrong with that, and it is not this command's to change: it is said as what is so. */
export function typedAs(inv: Inventory, show: (p: string) => string = (p) => p): string | null {
  const typed = inv.copies.find((c) => c.dir === inv.typed);
  if (!inv.typed || typed?.slot === "global") return null;
  const where = typed?.where ?? show(inv.typed);
  return typed?.keeper
    ? `Typing \`sessionpipe\` starts the copy Volta keeps, in ${where}.`
    : `Typing \`sessionpipe\` starts ${where}, which npm did not install (a checkout, a linked folder).`;
}

/** The way in when the command itself may no longer be typed. */
const NPX = "npx -y sessionpipe@latest reinstall";

/** `show`: how a path is said in a sentence for a person (the caller's `~/…`). It is
 *  used in prose only: what a step touches, and a command to paste, keep the whole path. */
export function plan(inv: Inventory, f: Facts, show: (p: string) => string = (p) => p): Plan {
  const none: Plan = {
    nothing: null,
    refuse: null,
    target: null,
    home: null,
    stays: null,
    steps: [],
    safety: [],
    inferred: null,
    kept: 0,
    left: [],
    notes: [],
  };
  const stop = (error: string, next: string): Plan => ({ ...none, refuse: { error, next } });
  if (f.apart && inv.reach === null)
    return stop(`${f.apart.said}, so it leaves this computer's copies alone. Nothing was changed`, f.apart.line);
  const home = inv.home;
  const ours = inv.copies.filter((c) => c.slot);
  const left: Left[] = [
    ...inv.copies
      .filter((c) => !c.slot)
      .map((c) => ({
        where: c.where,
        path: c.dir,
        version: c.version,
        why: c.not as string,
        line: c.keeper,
        ours: false,
      })),
    ...inv.strangers.map((s) => ({
      where: show(s.file),
      path: s.file,
      version: null,
      why: s.why,
      line: null,
      ours: false,
    })),
  ];
  const astray = typing(inv, show);
  // A service file, and nothing that needs the service nor any daemon answering. It is
  // not this command's to remove: what says that nothing needs it is a file of settings,
  // and those may be another sessionpipe's.
  const idleService = !!f.service && !f.wanted && !f.daemon;
  const notes = [
    ...(astray ? [astray] : []),
    ...(f.wanted && !f.service && !f.daemon
      ? ["The background service isn't running, and nothing here starts it by itself: `sessionpipe control run` does."]
      : []),
  ];
  // What can't be known, said beside a computer that is otherwise fine. It is no finding:
  // a file first on PATH that npm did not make may well be the shim that starts this copy.
  const own = typedAs(inv, show);
  const typed = inv.copies.find((c) => c.dir === inv.typed);
  // What is typed is a folder where npm keeps the package. Not what someone else's tool
  // keeps (Volta's copy): that is theirs to remove, not to move.
  const inSlot = !typed?.keeper && inv.prefixes.some((p) => slotIn(p) === inv.typed);
  const unknown = [
    ...(own ? [own] : []),
    ...(inv.unsure
      ? [
          `Typing \`sessionpipe\` starts ${show(inv.unsure)}, which is no link of npm's: which copy it starts can't be told from here.`,
        ]
      : []),
  ];

  // --- one whole copy of the newest release, in use everywhere: nothing to repair -----------
  // Wherever it lives, and whoever may write there. An npx cache entry nothing uses is not
  // a second copy: it is what npx ran this from.
  const live = ours.filter((c) => !idle(c));
  const one = live.length === 1 ? (live[0] as Copy) : null;
  const known = "version" in f.latest ? f.latest.version : null;
  const target = known ?? one?.version ?? null;
  const hooksFine = !f.harnesses.length || (f.hooks.version === target && !f.hooks.wrong.length);
  const serviceFine =
    idleService ||
    (f.service
      ? f.wanted &&
        f.service.loaded &&
        f.service.nodeOk &&
        !!one?.uses.includes("service") &&
        f.daemon?.version === target &&
        !twins(f.service, f.daemon)
      : !f.daemon || f.daemon.version === target);
  if (
    one?.slot === "global" &&
    !one.wrong &&
    one.version === target &&
    !inv.dangling.length &&
    hooksFine &&
    serviceFine
  ) {
    if (!known)
      unknown.push(
        `npm couldn't be asked whether ${one.version} is the newest release: ${(f.latest as { error: string }).error}.`,
      );
    return {
      ...none,
      target,
      home,
      // What stays beside it is listed: an npx cache entry nothing uses is npm's own cache.
      left: [
        ...left,
        ...ours.filter(idle).map((c) => ({
          where: c.where,
          path: c.dir,
          version: c.version,
          why: "npm's cache of what npx ran",
          line: null,
          ours: false,
        })),
      ],
      notes: [...notes, ...unknown],
      // "Nothing to repair" wherever nothing was found that is not as it should be: the
      // same computers `doctor` calls all good. What can't be known is said beside it.
      nothing: notes.length
        ? `One sessionpipe on this computer: ${one.version}${known ? ", the newest release" : ""}.`
        : `Nothing to repair: one sessionpipe, ${one.version}${known ? ", the newest release" : ""}.`,
    };
  }

  // What is typed is not a copy npm installed (a checkout, Volta's copy), and no copy npm
  // installed is here: nothing is this command's to repair, and `doctor` says the same.
  // (Not where what is typed sits where npm keeps the package: that is what an install
  // that was cut off left, and it is in the way. Nor with two daemons to sort out.)
  if (own && !inSlot && !live.length && !inv.dangling.length && !twins(f.service, f.daemon))
    return {
      ...none,
      target,
      home,
      left,
      notes: [...notes, ...unknown],
      nothing: "Nothing to repair: no copy that npm installed is on this computer.",
    };

  // --- something to repair: what must hold before anything is touched ----------------------
  if (!known)
    return stop(
      `npm couldn't be asked for the newest release (${(f.latest as { error: string }).error}), and a fresh copy comes from npm. Nothing was changed`,
      "sessionpipe reinstall",
    );
  if (!f.npm)
    return stop(
      "npm is not beside this Node nor on PATH, and a fresh copy comes from npm. Nothing was changed. Install npm, then run this again",
      "sessionpipe reinstall",
    );
  // What npx fetched to run this is not what this computer runs: a newer runner
  // (`npx sessionpipe@next reinstall`) moves nothing back, and goes with the rest.
  const ahead = [...live.map((c) => c.version), f.hooks.version, f.daemon?.version ?? null].find(
    (v) => v && isNewer(v, known, true),
  );
  if (ahead)
    return stop(
      `sessionpipe ${ahead} is on this computer, newer than npm's newest release (${known}): a reinstall would move it back. Nothing was changed`,
      "sessionpipe doctor",
    );
  // What typing starts must end up the one clean copy, or nothing is changed. A file first
  // on PATH that is no link of npm's (a version manager's shim, a wrapper) starts a copy
  // this command can't name unless it was started through it.
  if (inv.unsure)
    return stop(
      `${show(inv.unsure)} is the first \`sessionpipe\` on your PATH and no link of npm's: this command can't tell which copy that file starts, so it can't tell where the one clean copy goes. Nothing was changed. If the file is yours, point it at one copy or take it off your PATH (\`which -a sessionpipe\` shows what your PATH finds), then run this again`,
      // No command leads out by itself (installing another copy leads back here): none is named.
      "",
    );
  /** The line that moves something out of the way, and writes over nothing. Once it has
   *  run, `sessionpipe` may be nowhere to type: the repair goes on through npx, in the
   *  same line. */
  const aside = (file: string): string => `mv -n ${shq(file, "linux")} ${shq(`${file}.old`, "linux")} && ${NPX}`;
  const ASIDE = "The line moves it aside and runs the repair again, through npx";
  if (inv.typed && typed?.slot !== "global")
    return stop(
      `${(own as string).slice(0, -1)}${
        typed?.not && !typed.keeper ? `: ${typed.not}` : ""
      }. This command leaves it alone, so it can't put one clean copy in its place. Nothing was changed${
        inSlot ? `. ${ASIDE}` : ""
      }`,
      // A folder where npm keeps the package (what an install that was cut off left, a
      // build) is in the way of the one copy, and the person's to move: the line moves it,
      // and deletes nothing. For anything else there is nothing of sessionpipe's to run:
      // what the person's own PATH finds, in its order.
      inSlot ? aside(inv.typed) : "which -a sessionpipe",
    );
  if (!home && inv.taken)
    return stop(
      `${show(inv.taken.dir)} is not provably sessionpipe's (${inv.taken.why}), and it is where the one copy goes. Nothing was changed. ${ASIDE}`,
      aside(inv.taken.dir),
    );
  if (!home)
    return stop(
      "no folder on this computer can hold the one copy of sessionpipe. Nothing was changed",
      // Not `doctor`, which would name this command: what the PATH finds, in its order.
      "which -a sessionpipe",
    );
  const at = slotIn(home.prefix);
  // npm refuses to put its link over a file it didn't make (EEXIST: it installs nothing),
  // and what is not provably ours is never moved by this command.
  if (home.blocked)
    return stop(
      `${show(home.blocked)} is not sessionpipe's, and it is where the fresh copy's link goes: npm won't write over it. Nothing was changed. ${ASIDE}`,
      aside(home.blocked),
    );
  if (!inv.typed && !home.onPath)
    return stop(
      `${show(home.bin)} is not on your PATH, so \`sessionpipe\` would not be found when you type it. Nothing was changed. Add it, then run this again`,
      `export PATH=${shq(home.bin, "linux")}:"$PATH"`,
    );
  // A home this user may not write is never answered with a second copy somewhere else.
  // Its copy stays where it is whole and the newest; where it is not, the one line that
  // updates it in place comes first, and this command finishes the job after it.
  // The copy that is there now; a folder left behind in its place is no copy.
  const there = ours.find((c) => c.dir === at && !c.aside);
  const sound = !!there && !there.wrong && there.version === known;
  if (!home.writable && !sound)
    return stop(
      `${home.shown} ${
        there
          ? `holds ${inv.typed ? "the copy you type" : "the copy that is to stay"} (${there.version})`
          : `is where \`sessionpipe\` goes (${home.why})`
      }, and you may not write there. Nothing was changed. ${there ? "Update" : "Install"} it there, then run this again`,
      `sudo npm install -g --prefix ${shq(home.prefix, "linux")} sessionpipe@${known}`,
    );
  const stays = home.writable ? null : `${known} in ${home.shown} as it is: whole, the newest, and not yours to write`;

  // --- the steps, in the order they are taken ------------------------------------------------
  const steps: Step[] = [];
  if (!stays)
    steps.push(
      { do: "fetch", version: known, touches: [] },
      {
        do: "install",
        version: known,
        prefix: home.prefix,
        dir: at,
        replaces: !!there,
        touches: [at, path.join(home.bin, "sessionpipe")],
        // Why this folder: the table's row for it says what uses the copy that is there;
        // where none is, the reason is said here.
        say: `${known}, the newest release, fresh in ${home.shown} (${there ? `replaces ${there.version}` : home.why})`,
      },
    );
  // Two daemons: the one someone started by hand is stopped, and the service takes over.
  if (f.daemon && twins(f.service, f.daemon))
    steps.push({
      do: "stop",
      pid: f.daemon.pid,
      touches: [],
      say: `the daemon started by hand (pid ${f.daemon.pid}), once it holds nothing`,
    });
  const serve = !!f.service && !idleService;
  const moved = [
    ...(f.harnesses.length ? ["the hooks"] : []),
    ...(serve ? ["the background service"] : f.daemon ? ["the daemon that runs here"] : []),
  ];
  steps.push({
    do: "use",
    serve: serve || !!f.daemon,
    touches: [
      ...(f.harnesses.length ? f.hookFiles : []),
      ...(serve ? [(f.service as NonNullable<Facts["service"]>).file] : []),
    ],
    // What moves onto the copy: the hooks where an agent is hooked, and what runs in the
    // background where something does.
    say: moved.length ? `${moved.join(" and ")} to it` : null,
  });
  // The home's own link is written again by the install; any other that leads nowhere goes.
  for (const file of inv.dangling.filter((f) => path.dirname(f) !== home.bin))
    steps.push({
      do: "remove",
      path: file,
      touches: [file],
      say: `${show(file)} (a link to a copy that is gone)`,
    });
  // What is in nobody's use goes first; the copy this command runs from goes last.
  let kept = 0;
  const rank = (c: Copy) => (c.uses.includes("this") ? 3 : c.uses.length ? 2 : c.aside ? 0 : 1);
  for (const c of ours.filter((c) => c.dir !== at).sort((a, b) => rank(a) - rank(b))) {
    // What typing starts was not read, only taken from how this command was started: the
    // file first on PATH may start any installed copy. None is removed.
    if (inv.inferred && c.slot === "global" && !c.aside) {
      left.push({
        where: c.where,
        path: c.dir,
        version: c.version,
        why: `${show(inv.inferred)} may be what starts it`,
        line: null,
        ours: false,
      });
      kept++;
      continue;
    }
    if (!c.writable) {
      left.push({
        where: c.where,
        path: c.dir,
        version: c.version,
        why: "you may not write where it is",
        // What this command would have removed, and nothing else: the folder and its own
        // link. Not `npm uninstall`, which takes whatever is at the prefix's command path.
        line: `sudo rm -r ${[c.dir, ...c.bins].map((x) => shq(x, "linux")).join(" ")}`,
        ours: true,
      });
      continue;
    }
    steps.push({ do: "remove", path: c.dir, touches: [c.dir, ...c.bins], say: named(c) });
  }
  steps.push({ do: "prove", touches: [] });
  return {
    ...none,
    target: known,
    home,
    stays,
    steps,
    // npm installs beside the copy that is there and the fresh one is seen to run before
    // the two change places: a download or an install that fails has touched nothing.
    safety: [
      ...(stays ? [] : [`Nothing is touched until ${known} has been downloaded and seen to run.`]),
      ...(serve
        ? ["The service keeps its environment and restarts once it holds nothing."]
        : f.daemon
          ? ["The daemon restarts once it holds nothing."]
          : []),
    ],
    left,
    inferred: inv.inferred,
    kept,
    // What typing starts was either a refusal above or is what this run puts right: of
    // the notes, only what it does not mend is said beside a plan. And what is not known
    // is said as that.
    notes: [
      ...notes.filter((n) => n !== astray),
      ...(inv.inferred
        ? [
            `Typing \`sessionpipe\` starts ${show(inv.inferred)}, which is no link of npm's: which copy it starts is not known${
              kept ? ", so no other installed copy is removed" : ""
            }.`,
          ]
        : []),
    ],
  };
}
