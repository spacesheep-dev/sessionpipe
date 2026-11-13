// SPDX-License-Identifier: Apache-2.0
// What `sessionpipe reinstall` will do, decided from what was found and from nothing
// else: no file is read here and nothing is run, so every state a computer can be in is
// a test with no computer. `--dry-run` prints this plan; a real run carries out the same
// one (run.ts). Each step names what it touches and why.
import path from "node:path";
import { isNewer } from "@sessionpipe/core/version";
import { shq } from "../shell.js";
import type { Copy, Inventory } from "./find.js";

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
  /** The daemon that answers on the socket. */
  daemon: { pid: number; version: string } | null;
  /** This sessionpipe keeps its files somewhere other than this computer's usual place:
   *  the sentence that says so, and how to run this without that. */
  apart: { said: string; line: string } | null;
}

export type Step = { touches: string[]; why: string } & (
  | { do: "fetch"; version: string }
  | { do: "install"; version: string; prefix: string; dir: string; replaces: boolean }
  | { do: "stop"; pid: number }
  | { do: "unserve"; file: string }
  /** `serve`: there is a service file or a running daemon to move onto the fresh copy.
   *  Without either there is nothing this command can start: the hooks alone are written. */
  | { do: "use"; serve: boolean }
  | { do: "remove"; path: string; what: string }
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
  /** Nothing to repair: the sentence that says so. */
  nothing: string | null;
  /** It won't act: what stands in the way, and the one command to run. */
  refuse: { error: string; next: string } | null;
  /** The release that is installed, and where. */
  target: string | null;
  home: Inventory["homes"][number] | null;
  steps: Step[];
  left: Left[];
  /** Said beside the plan: what is not this command's to repair. */
  notes: string[];
  /** The file a shell still finds first once this is done, where that is not the fresh
   *  copy (a checkout's link, a script of someone's): typing `sessionpipe` starts that
   *  one. The note that says so is built from it. Null: the fresh copy, or nothing. */
  first: string | null;
}

const is = (a: string | null | undefined, b: string): boolean => !!a && path.resolve(a) === path.resolve(b);
/** The package folder a prefix holds sessionpipe in. */
export const slotIn = (prefix: string, platform: NodeJS.Platform): string =>
  platform === "win32"
    ? path.join(prefix, "node_modules", "sessionpipe")
    : path.join(prefix, "lib", "node_modules", "sessionpipe");

/** An npx cache entry that nothing uses but, at most, this very command: a cache, not a
 *  copy to repair (`npx -y sessionpipe@latest reinstall` runs from one). */
export const idle = (c: Copy): boolean => c.slot === "npx" && !c.uses.some((u) => u !== "this");

const what = (c: Copy): string =>
  c.aside
    ? `a folder ${c.wrong}`
    : `sessionpipe ${c.version ?? "(a broken copy)"}${c.wrong ? `, which is broken: ${c.wrong}` : ""}`;

/** `show`: how a path is said in a sentence for a person (the caller's `~/…`). It is
 *  used in prose only: what a step touches, and a command to paste, keep the whole path. */
export function plan(inv: Inventory, f: Facts, show: (p: string) => string = (p) => p): Plan {
  const none: Plan = {
    nothing: null,
    refuse: null,
    target: null,
    home: null,
    steps: [],
    left: [],
    notes: [],
    first: null,
  };
  if (f.apart && inv.reach === null)
    return {
      ...none,
      refuse: {
        error: `${f.apart.said}, so it leaves this computer's copies alone. Nothing was changed`,
        next: f.apart.line,
      },
    };
  const home = inv.homes[0] ?? null;
  const at = home ? slotIn(home.prefix, inv.platform) : null;
  const ours = inv.copies.filter((c) => c.slot);
  const left: Left[] = inv.copies
    .filter((c) => !c.slot)
    .map((c) => ({
      where: c.where,
      path: c.dir,
      version: c.version,
      why: c.not as string,
      line: c.keeper,
      ours: false,
    }));
  left.push(
    ...inv.strangers.map((s) => ({
      where: show(s.file),
      path: s.file,
      version: null,
      why: s.why,
      line: null,
      ours: false,
    })),
  );
  const notes: string[] = [];
  if (home && home.pathAt === null)
    notes.push(`${show(home.bin)} is not on your PATH: add it, or \`sessionpipe\` is not found when you type it.`);
  // What a shell finds first, once every copy this command removes is gone and the fresh
  // one has its link: the first on PATH of what stays and of the home's own bin folder.
  // Where that is not the fresh copy, typing `sessionpipe` still starts something else.
  // (What stays IN the home's own bin folder is found there in place of the fresh copy.)
  const goes = (dir: string | null) => !!dir && !inv.copies.some((c) => is(c.dir, dir) && (!c.slot || !c.writable));
  const inFront = home
    ? inv.onPath.find((e) => !is(e.dir, at as string) && !goes(e.dir) && (home.pathAt === null || e.at <= home.pathAt))
    : undefined;
  const first = inFront ? inFront.file : null;
  if (first)
    notes.push(
      `What a shell finds first is ${show(first)}, which is not this copy: typing \`sessionpipe\` starts that one.`,
    );
  if (f.wanted && !f.service && !f.daemon)
    notes.push(
      "The background service isn't running, and nothing here starts it by itself: `sessionpipe control run` does.",
    );

  const stop = (error: string, next: string): Plan => ({ ...none, left, notes, first, refuse: { error, next } });
  // --- what is not ours sits where the fresh copy's link goes: nothing is done at all ------
  // npm refuses to put its link over a file it didn't make (EEXIST: it installs nothing),
  // and what is not provably ours is never moved by this command. Another home is no
  // answer: the copy would land where nobody types it.
  if (home?.blocked)
    return stop(
      `${show(home.blocked)} is a file sessionpipe did not put there, and it sits where the link to the fresh copy goes: npm will not put its link over it. Nothing was changed. Move it out of the way, then run this again`,
      `${inv.platform === "win32" ? "move" : "mv"} ${shq(home.blocked, inv.platform)} ${shq(`${home.blocked}.old`, inv.platform)}`,
    );

  // --- one clean copy, in use everywhere: nothing to repair -------------------------------
  // An npx cache entry nothing uses is not a second copy: it is what npx ran this from.
  const live = ours.filter((c) => !idle(c));
  const one = live.length === 1 ? (live[0] as Copy) : null;
  const known = "version" in f.latest ? f.latest.version : null;
  const target = known ?? one?.version ?? null;
  const hooksFine = !f.harnesses.length || (f.hooks.version === target && !f.hooks.wrong.length);
  const serviceFine = f.service
    ? f.wanted &&
      f.service.loaded &&
      f.service.nodeOk &&
      !!one?.uses.includes("service") &&
      f.daemon?.version === target &&
      (f.service.pid === null || f.service.pid === f.daemon.pid)
    : !f.daemon || f.daemon.version === target;
  // Nothing wrong with it: it runs, and its link is there to start it.
  if (
    one &&
    is(at, one.dir) &&
    !one.wrong &&
    one.version === target &&
    !inv.dangling.length &&
    hooksFine &&
    serviceFine
  )
    return {
      ...none,
      target,
      home,
      left,
      notes,
      first,
      nothing: `This computer has one sessionpipe: ${one.version}, in ${one.where}${
        known
          ? ", the newest release"
          : ` (npm couldn't be asked whether that is the newest: ${(f.latest as { error: string }).error})`
      }. ${
        // Not "nothing to repair" while what a person types is something else: it is not
        // this command's to move, and saying so is all there is to do.
        first
          ? `But what you type is ${show(first)}, which is not it, and not sessionpipe's to move.`
          : "Nothing to repair."
      }${
        // What else was found beside it stays, and is said: "Found 2 copies" above this
        // sentence is then no contradiction of it.
        ours.some(idle) ? " The copy in the npx cache is npm's own cache: it is left." : ""
      }${left.length ? " What is no install of it is left alone." : ""}`,
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
  if (!home || !at)
    return stop(
      "no folder on this computer that you may write can hold a fresh copy. Nothing was changed",
      "sessionpipe doctor",
    );

  // --- the steps, in the order they are taken ------------------------------------------------
  const steps: Step[] = [];
  const there = ours.find((c) => is(at, c.dir));
  steps.push({
    do: "fetch",
    version: known,
    touches: [],
    why: `sessionpipe ${known}, the newest release, is fetched from npm. Until that has worked, nothing here is touched.`,
  });
  steps.push({
    do: "install",
    version: known,
    prefix: home.prefix,
    dir: at,
    replaces: !!there,
    touches: [
      at,
      inv.platform === "win32"
        ? path.join(home.prefix, "sessionpipe.cmd")
        : path.join(home.prefix, "bin", "sessionpipe"),
    ],
    why: `It is installed fresh in ${home.shown} (${home.why})${
      there ? `; ${what(there)}, which is there now, is taken out first and put back if the install fails` : ""
    }.`,
  });
  // Two daemons: the one that answers is not the process the service manager runs. A
  // manager that names no process (pid null) while a daemon answers is that state too,
  // not a manager that can't tell: the service's own process exits 0 when it finds
  // another daemon on the socket, so its service is loaded and runs nothing. (For
  // "nothing to repair", above, no process named is read the other way: no reason to act.)
  if (f.service && f.daemon && f.service.pid !== f.daemon.pid)
    steps.push({
      do: "stop",
      pid: f.daemon.pid,
      touches: [],
      why: `A daemon someone started by hand (pid ${f.daemon.pid}) holds the socket the background service needs: it is stopped once it holds nothing, and the service takes over.`,
    });
  const unserve = !!f.service && !f.wanted && !f.daemon;
  if (f.service && unserve)
    steps.push({
      do: "unserve",
      file: f.service.file,
      touches: [f.service.file],
      why: "Nothing on this computer needs the background service (it is paired with nobody, the pool is off, asking is off): its service file is removed.",
    });
  const serve = !!f.service && !unserve;
  steps.push({
    do: "use",
    serve: serve || !!f.daemon,
    touches: [
      ...(f.harnesses.length ? f.hookFiles : []),
      ...(serve ? [(f.service as NonNullable<Facts["service"]>).file] : []),
    ],
    why: `${f.harnesses.length ? "The hooks are written again from it" : "No agent is hooked here, so there are no hooks to write"}${
      serve
        ? ", and the background service is made to run it (its environment kept), restarted once it holds nothing"
        : f.daemon
          ? ", and the daemon that runs here is asked to restart onto it"
          : ""
    }.`,
  });
  // The home's own link is written again by the install; any other that leads nowhere goes.
  for (const file of inv.dangling.filter((f) => !is(path.dirname(f), home.bin)))
    steps.push({
      do: "remove",
      path: file,
      what: "a link to a sessionpipe that is gone",
      touches: [file],
      why: `${show(file)} leads to a sessionpipe that is gone: the link is removed.`,
    });
  // What is in nobody's use goes first; the copy this command runs from goes last.
  const rank = (c: Copy) => (c.uses.includes("this") ? 3 : c.uses.length ? 2 : c.aside ? 0 : 1);
  for (const c of ours.filter((c) => !is(at, c.dir)).sort((a, b) => rank(a) - rank(b))) {
    if (!c.writable) {
      left.push({
        where: c.where,
        path: c.dir,
        version: c.version,
        why: "you may not write where it is",
        line:
          c.slot === "global" && !c.aside && inv.platform !== "win32"
            ? `sudo npm uninstall -g --prefix ${shq(c.prefix as string, inv.platform)} sessionpipe`
            : null,
        ours: true,
      });
      continue;
    }
    steps.push({
      do: "remove",
      path: c.dir,
      what: what(c),
      touches: [c.dir, ...c.bins],
      why: `${c.where} holds ${what(c)}: it is removed${c.bins.length ? ", with its link" : ""}.`,
    });
  }
  steps.push({
    do: "prove",
    touches: [],
    why: `Then it is checked: the fresh copy runs, a shell finds it${f.harnesses.length ? ", the hooks run it" : ""}${
      serve || f.daemon ? ", the background service runs it" : ""
    }, and nothing here names a copy that was removed.`,
  });
  return { ...none, target: known, home, steps, left, notes, first };
}
