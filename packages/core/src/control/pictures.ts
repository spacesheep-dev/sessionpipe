// SPDX-License-Identifier: Apache-2.0
// Pictures among a command's files (spec/CONTROL.md §6, *Pictures*). A machine lists
// every file in the text it hands a session; a harness that has its own way to take a
// picture (an image argument, an image content block) is given the pictures that way
// too. Which file is a picture is read from its bytes, never from its name: its signed
// `type` is one of four, and the file is that format, with a width and a height its
// header states. What each harness takes, and how much, is the harness's adapter's word
// (spec/ADAPTERS.md); this file only reads headers and applies those limits.
//
// No node: imports, like the rest of core/control: a receiver may run the same reading.

/** The picture types any harness here takes natively. */
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type PictureType = (typeof PICTURE_TYPES)[number];

/** What a picture's header says. */
export interface PictureFacts {
  type: PictureType;
  width: number;
  height: number;
  /** More than one frame: a GIF with two images or more, a WebP with its animation bit. */
  animated: boolean;
}

/** A picture the machine saved, as a harness is offered it. */
export interface Picture extends PictureFacts {
  /** Where it was written, absolute. */
  path: string;
  /** Its length in bytes. */
  size: number;
}

/** What one harness takes natively (spec/ADAPTERS.md, each harness's Control row). */
export interface PictureLimits {
  types: readonly PictureType[];
  /** Bytes per picture. */
  maxBytes?: number;
  /** Pixels on either side. */
  maxSide?: number;
  /** 32 × 32 pixel patches per picture (OpenAI's measure of a picture's size). */
  maxPatches?: number;
  /** Only still pictures. */
  still?: boolean;
  /** For a harness sent the bytes in the message: the pictures are taken in order while
   *  their base64 together stays within this many characters, and the rest are not. */
  maxBase64?: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const ascii = (b: Uint8Array, i: number, s: string) => {
  for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false;
  return true;
};

type Size = { width: number; height: number; animated: boolean } | null;

/** PNG: the signature, then IHDR first, which holds the size. */
function png(b: Uint8Array): Size {
  if (b.length < 24 || !ascii(b, 0, "\x89PNG\r\n\x1a\n") || !ascii(b, 12, "IHDR")) return null;
  return { width: u32be(b, 16), height: u32be(b, 20), animated: false };
}

/** JPEG: SOI, then markers up to the first start of frame, which holds the size. */
function jpeg(b: Uint8Array): Size {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    // Fill bytes before a marker.
    if (m === 0xff) {
      i++;
      continue;
    }
    // Markers that stand alone: TEM, RST0–7.
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    // SOF0–15, less DHT (c4), JPG (c8) and DAC (cc).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { width: u16be(b, i + 7), height: u16be(b, i + 5), animated: false };
    }
    // The image data or its end before any frame: no size to read.
    if (m === 0xda || m === 0xd9) return null;
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

/** GIF: the logical screen holds the size; the blocks after it say how many frames. */
function gif(b: Uint8Array): Size {
  if (b.length < 13 || !(ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) return null;
  const table = (flags: number) => (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  /** Past a run of data sub-blocks, or -1 where the file ends first. */
  const blocks = (i: number) => {
    while (i < b.length) {
      const n = b[i]!;
      if (n === 0) return i + 1;
      i += n + 1;
    }
    return -1;
  };
  let i = 13 + table(b[10]!);
  let frames = 0;
  while (i < b.length && b[i] !== 0x3b && frames < 2) {
    if (b[i] === 0x21) i = blocks(i + 2);
    else if (b[i] === 0x2c && i + 10 <= b.length) {
      frames++;
      i = blocks(i + 10 + table(b[i + 9]!) + 1);
    } else return null;
    if (i < 0) break;
  }
  if (!frames) return null;
  return { width: u16le(b, 6), height: u16le(b, 8), animated: frames > 1 };
}

/** WebP: RIFF, then its first chunk: lossy (VP8), lossless (VP8L) or extended (VP8X). */
function webp(b: Uint8Array): Size {
  if (b.length < 30 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8 ")) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, animated: false };
  }
  if (ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false };
  }
  if (ascii(b, 12, "VP8X"))
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, animated: (b[20]! & 0x02) !== 0 };
  return null;
}

// A Map, not an object: a type such as `__proto__` or `constructor` reads nothing here.
const READERS = new Map<string, (b: Uint8Array) => Size>([
  ["image/png", png],
  ["image/jpeg", jpeg],
  ["image/gif", gif],
  ["image/webp", webp],
]);

/** A file's picture facts: its signed `type` is one of PICTURE_TYPES (in any case), its
 *  bytes are that format, and its header states a width and a height. Null for anything
 *  else — another type, bytes of another format, a header cut short — which stays a file
 *  the text lists and nothing more. */
export function pictureFacts(type: string, bytes: Uint8Array): PictureFacts | null {
  const t = type.toLowerCase() as PictureType;
  const read = READERS.get(t);
  if (!read) return null;
  const s = read(bytes);
  if (!s || s.width < 1 || s.height < 1) return null;
  return { type: t, ...s };
}

/** 32 × 32 pixel patches that cover a picture. */
export const patches = (p: { width: number; height: number }): number =>
  Math.ceil(p.width / 32) * Math.ceil(p.height / 32);

/** Does one harness take this picture natively? */
export function takes(p: Picture, l: PictureLimits): boolean {
  if (!l.types.includes(p.type)) return false;
  if (l.maxBytes !== undefined && p.size > l.maxBytes) return false;
  if (l.maxSide !== undefined && (p.width > l.maxSide || p.height > l.maxSide)) return false;
  if (l.maxPatches !== undefined && patches(p) > l.maxPatches) return false;
  if (l.still && p.animated) return false;
  return true;
}

/** The pictures one harness is given natively: those it takes, in the command's order,
 *  and where it is sent their bytes, while their base64 together stays within its
 *  `maxBase64` (the first that would pass it, and every one after, stay in the text). A
 *  command carries at most FILES_MAX files, fewer than any harness here takes at once. */
export function picturesFor(pictures: readonly Picture[], l: PictureLimits): Picture[] {
  const out = pictures.filter((p) => takes(p, l));
  if (l.maxBase64 === undefined) return out;
  let total = 0;
  const kept: Picture[] = [];
  for (const p of out) {
    total += base64Length(p.size);
    if (total > l.maxBase64) break;
    kept.push(p);
  }
  return kept;
}

/** How many characters `n` bytes take in base64, padding included. */
export const base64Length = (n: number): number => 4 * Math.ceil(n / 3);
