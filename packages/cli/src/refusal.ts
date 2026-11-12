// SPDX-License-Identifier: Apache-2.0
/** A command that stops with what is wrong and the one command to run next. The `try`
 *  line a failure prints comes from here, from the code that raised it, and never from
 *  the words of a message: those may be a receiver's, a file's or npm's. */
export class Refusal extends Error {
  constructor(
    message: string,
    readonly next: string,
  ) {
    super(message);
  }
}
