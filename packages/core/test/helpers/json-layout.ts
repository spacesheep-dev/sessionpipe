// SPDX-License-Identifier: Apache-2.0
// Config files laid out every which way, for the writer's tests (#205): a seeded random
// source, and a layout that puts each object or array on one line or over several, with
// the colon written three ways and the file's own indent and line end.

export type Rand = () => number;

/** mulberry32: the same files on every run for a seed. */
export function rng(seed: number): Rand {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** `v` as JSON text, each object or array on one line or over several from `pad`. */
export function layout(r: Rand, v: unknown, unit: string, eol: string, pad = ""): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const entries = Array.isArray(v) ? v.map((x) => [null, x] as const) : Object.entries(v);
  if (!entries.length) return Array.isArray(v) ? "[]" : "{}";
  const colon = pick(r, [": ", ":", " : "]);
  const inner = pad + unit;
  const items = entries.map(([k, x]) => (k === null ? "" : JSON.stringify(k) + colon) + layout(r, x, unit, eol, inner));
  const [o, c] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
  if (r() < 0.5) {
    const sp = pick(r, ["", " "]);
    return o + sp + items.join(pick(r, [", ", ","])) + sp + c;
  }
  return o + eol + inner + items.join(`,${eol}${inner}`) + eol + pad + c;
}

/** A file's shape at random: its indent, line end, final newline and byte-order mark. */
export function randomShape(r: Rand) {
  const eol = pick(r, ["\n", "\r\n"]);
  return { indent: pick(r, ["  ", "    ", "\t", " "]), eol, finalNewline: r() < 0.5, bom: r() < 0.2 };
}
