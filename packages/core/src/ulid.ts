// SPDX-License-Identifier: Apache-2.0
// ULID: 48-bit ms timestamp + 80 random bits, Crockford base32. Monotonic within a
// process so two events in the same millisecond still sort in emit order.
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let lastRand: number[] = [];

function encodeTime(t: number): string {
  let out = "";
  let n = t;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    // increment the random part
    for (let i = lastRand.length - 1; i >= 0; i--) {
      const v = (lastRand[i] as number) + 1;
      if (v < 32) {
        lastRand[i] = v;
        break;
      }
      lastRand[i] = 0;
    }
  } else {
    lastTime = now;
    lastRand = Array.from(randomBytes(16), (b) => b % 32);
  }
  return encodeTime(now) + lastRand.map((v) => ALPHABET[v]).join("");
}

export const isUlid = (s: string): boolean => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
