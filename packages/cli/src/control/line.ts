// SPDX-License-Identifier: Apache-2.0
// One session's messages, one at a time, in the order they were sent (spec/CONTROL.md §6
// `prompt`): by the time each was signed (`iat`), then by arrival. A message takes its
// place in its session's line the moment it arrives, before anything is awaited for it,
// and holds it until its delivery is over or it turns out to have none (refused,
// expired). What happens to it while it waits — a verification that takes longer than
// the next message's, a wait for the session's start, a download — changes nothing about
// who goes next.
//
// The order used to be whoever reached the queue first, and a message reached it only
// after its signature had been verified. Two messages of one poll are verified side by
// side, so the later one sometimes got there first: three sent half a second apart ran
// bravo, delta, charlie (2026-11-10, one batch of sixteen).

/** A message's place in its session's line. */
export interface Turn {
  /** Resolves when it is this message's turn: nothing before it is waiting or running. */
  readonly ready: Promise<void>;
  /** Its turn is over, or it never took one: the next goes. Calling it again does nothing. */
  leave(): void;
}

interface Waiting {
  iat: number;
  go: () => void;
}

interface Line {
  /** The one whose turn it is. */
  current: Waiting | null;
  /** The rest, in the order they arrived. */
  waiting: Waiting[];
  /** The next one is about to be chosen. */
  choosing: boolean;
}

export class Lines {
  private readonly lines = new Map<string, Line>();

  /** Take a place in `session`'s line for a message signed at `iat`. */
  enter(session: string, iat: number): Turn {
    let line = this.lines.get(session);
    if (!line) {
      line = { current: null, waiting: [], choosing: false };
      this.lines.set(session, line);
    }
    const mine = line;
    let go!: () => void;
    const ready = new Promise<void>((res) => {
      go = res;
    });
    const me: Waiting = { iat, go };
    mine.waiting.push(me);
    this.choose(session, mine);
    let left = false;
    return {
      ready,
      leave: () => {
        if (left) return;
        left = true;
        if (mine.current === me) mine.current = null;
        else mine.waiting.splice(mine.waiting.indexOf(me), 1);
        this.choose(session, mine);
      },
    };
  }

  /** Give the turn to the earliest-signed of those waiting; of two signed in the same
   *  millisecond, to the one that arrived first. Chosen a microtask later, not on the
   *  spot: every message of one poll is handed over in the same tick, and all of them
   *  are in line before the first is picked, so a poll that lists them out of order
   *  still runs them in it. One that has its turn keeps it: nothing overtakes a message
   *  that has started. */
  private choose(session: string, line: Line): void {
    if (line.current || line.choosing) return;
    line.choosing = true;
    queueMicrotask(() => {
      line.choosing = false;
      let next: Waiting | null = null;
      for (const w of line.waiting) if (!next || w.iat < next.iat) next = w;
      if (!next) {
        this.lines.delete(session);
        return;
      }
      line.waiting.splice(line.waiting.indexOf(next), 1);
      line.current = next;
      next.go();
    });
  }
}
