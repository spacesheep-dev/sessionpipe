// SPDX-License-Identifier: Apache-2.0
/** A command that stops with what is wrong and the one command to run next. The `try`
 *  line a failure prints comes from here, from the code that raised it, and never from
 *  the words of a message: those may be a receiver's, a file's or npm's. */
/** `next` is empty where no command leads out: then none is named, in a terminal or a pipe. */
export class Refusal extends Error {
  /** `inLine`: the message doesn't name the command itself. Where a failure is the one
   *  line a pipe gets, the command is then said at the end of it, so a script, an ssh
   *  session or an agent reads what to run next as a person at a terminal does.
   *  `mild`: the command did what it could and this is what is left for the person: at
   *  a terminal it is said under `!`, not `error`. The exit code and the one line a pipe
   *  gets are those of any refusal. */
  constructor(
    message: string,
    readonly next: string,
    readonly inLine = false,
    readonly mild = false,
  ) {
    super(message);
  }
}
