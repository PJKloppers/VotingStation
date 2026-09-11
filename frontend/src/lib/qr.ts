/**
 * A QR code, worked out in the page.
 *
 * The whole point of the code is a hall: the organizer puts the voting link on
 * the projector and the room scans it rather than typing a uuid off a slide.
 * That has to hold up on the venue's wifi at the one moment it matters, so no
 * image service -- and a hosted encoder would also have been handed every
 * ballot id we ever drew.
 *
 * Byte mode, error correction level M, versions 1 to 10. That is 213 bytes,
 * far past any link this app builds. A longer string returns null rather than
 * a code nothing can read, and the caller shows the link on its own.
 *
 * Every array index below is in range by construction -- the tables are fixed
 * and the buffers are sized from them -- so the reads are asserted and the
 * arithmetic stays legible.
 */

export interface QrCode {
  /** modules per side, not counting the quiet zone */
  size: number;
  /** one entry per module, row major: 1 is dark */
  modules: Uint8Array;
}

/** the quiet zone a scanner expects around the code, in modules */
export const QUIET = 4;

/** per version: data codewords, check codewords per block, blocks. level M. */
const VERSIONS: ReadonlyArray<readonly [number, number, number]> = [
  [16, 10, 1], [28, 16, 1], [44, 26, 1], [64, 18, 2], [86, 24, 2],
  [108, 16, 4], [124, 18, 4], [154, 22, 4], [182, 22, 5], [216, 26, 5],
];

/** alignment pattern centres, per version */
const ALIGN: ReadonlyArray<readonly number[]> = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/** the filler that runs out the last codewords, alternating */
const PAD = [0xec, 0x11] as const;

/* ------------------------------------------------------------ GF(256) */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;

const mul = (a: number, b: number) => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

/**
 * The check codewords for one block: the remainder of the data divided by the
 * Reed-Solomon generator polynomial of that degree.
 */
function check(data: Uint8Array, degree: number): Uint8Array {
  let gen = Uint8Array.of(1);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(gen.length + 1);
    for (let j = 0; j < gen.length; j++) {
      next[j] = next[j]! ^ gen[j]!;
      next[j + 1] = next[j + 1]! ^ mul(gen[j]!, EXP[i]!);
    }
    gen = next;
  }

  const out = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ out[0]!;
    out.copyWithin(0, 1);
    out[degree - 1] = 0;
    for (let i = 0; i < degree; i++) out[i] = out[i]! ^ mul(gen[i + 1]!, factor);
  }
  return out;
}

/* ------------------------------------------------------------ the bits */

/** byte mode spends 8 bits on the length up to version 9, 16 from version 10 */
const countBits = (version: number) => (version < 10 ? 8 : 16);

function pickVersion(length: number): number | null {
  for (let v = 1; v <= VERSIONS.length; v++) {
    if (4 + countBits(v) + length * 8 <= VERSIONS[v - 1]![0] * 8) return v;
  }
  return null;
}

/** the string, padded out, split into blocks, checked, and interleaved */
function codewords(bytes: Uint8Array, version: number): Uint8Array {
  const [dataCw, checkCw, blocks] = VERSIONS[version - 1]!;

  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, dataCw * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  for (let i = 0; bits.length < dataCw * 8; i++) push(PAD[i % 2]!, 8);

  const flat = new Uint8Array(dataCw);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) flat[i >>> 3] = flat[i >>> 3]! | (0x80 >>> (i & 7));
  }

  // the short blocks come first and the ones carrying a codeword more come
  // last; a reader reassembles them by that rule, so the order is not ours
  const short = Math.floor(dataCw / blocks);
  const longs = dataCw % blocks;
  const data: Uint8Array[] = [];
  const checks: Uint8Array[] = [];
  for (let b = 0, from = 0; b < blocks; b++) {
    const length = short + (b >= blocks - longs ? 1 : 0);
    const block = flat.subarray(from, from + length);
    from += length;
    data.push(block);
    checks.push(check(block, checkCw));
  }

  const out = new Uint8Array(dataCw + blocks * checkCw);
  let n = 0;
  for (let i = 0; i <= short; i++) {
    for (const block of data) if (i < block.length) out[n++] = block[i]!;
  }
  for (let i = 0; i < checkCw; i++) {
    for (const block of checks) out[n++] = block[i]!;
  }
  return out;
}

/* ---------------------------------------------------------- the matrix */

const DARK = 1;
/** a function pattern: never carries data, never masked */
const FIXED = 2;

interface Grid { size: number; cells: Uint8Array; }

const at = (g: Grid, row: number, col: number) => g.cells[row * g.size + col] ?? 0;

/** writes one module, ignoring anything the patterns overhang the edge with */
function put(g: Grid, row: number, col: number, value: number): void {
  if (row >= 0 && row < g.size && col >= 0 && col < g.size) g.cells[row * g.size + col] = value;
}

const fixed = (dark: boolean) => (dark ? DARK | FIXED : FIXED);

/** the finders, timing, alignment and version blocks: everything not data */
function patterns(version: number): Grid {
  const size = version * 4 + 17;
  const g: Grid = { size, cells: new Uint8Array(size * size) };

  for (let i = 0; i < size; i++) {
    put(g, 6, i, fixed(i % 2 === 0));
    put(g, i, 6, fixed(i % 2 === 0));
  }

  // drawn last over the timing rows on purpose: the separator ring is light
  // where the timing run would have been dark
  for (const [row, col] of [[3, 3], [3, size - 4], [size - 4, 3]] as const) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const ring = Math.max(Math.abs(dr), Math.abs(dc));
        put(g, row + dr, col + dc, fixed(ring !== 2 && ring !== 4));
      }
    }
  }

  const centres = ALIGN[version - 1]!;
  for (const row of centres) {
    for (const col of centres) {
      const onFinder = (row === 6 && col === 6)
        || (row === 6 && col === size - 7) || (row === size - 7 && col === 6);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          put(g, row + dr, col + dc, fixed(Math.max(Math.abs(dr), Math.abs(dc)) !== 1));
        }
      }
    }
  }

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const value = fixed(((bits >>> i) & 1) === 1);
      const far = size - 11 + (i % 3);
      const near = Math.floor(i / 3);
      put(g, near, far, value);
      put(g, far, near, value);
    }
  }
  return g;
}

/**
 * The format block, twice over.
 *
 * It has to be reserved before the data is laid out and written again once the
 * mask is chosen, so this runs twice: first with a stand-in, then for real.
 */
function formatBits(g: Grid, mask: number): void {
  const size = g.size;
  // level M is 0; the five bits are the level and the mask, then ten of BCH
  const data = mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => fixed(((bits >>> i) & 1) === 1);

  for (let i = 0; i <= 5; i++) put(g, i, 8, bit(i));
  put(g, 7, 8, bit(6));
  put(g, 8, 8, bit(7));
  put(g, 8, 7, bit(8));
  for (let i = 9; i < 15; i++) put(g, 8, 14 - i, bit(i));
  for (let i = 0; i < 8; i++) put(g, 8, size - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) put(g, size - 15 + i, 8, bit(i));
  put(g, size - 8, 8, DARK | FIXED);
}

/** the codewords, snaked up and down two columns at a time from bottom right */
function placeData(g: Grid, data: Uint8Array): void {
  const size = g.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    // column 6 is the vertical timing run, and the snake steps around it
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const row = ((right + 1) & 2) === 0 ? size - 1 - step : step;
        if ((at(g, row, col) & FIXED) !== 0 || i >= data.length * 8) continue;
        put(g, row, col, (data[i >>> 3]! >>> (7 - (i & 7))) & 1);
        i++;
      }
    }
  }
}

const MASKS: ReadonlyArray<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** flips the data modules the mask names -- and flips them back if run again */
function applyMask(g: Grid, mask: number): void {
  const rule = MASKS[mask]!;
  for (let row = 0; row < g.size; row++) {
    for (let col = 0; col < g.size; col++) {
      const cell = at(g, row, col);
      if ((cell & FIXED) === 0 && rule(row, col)) put(g, row, col, cell ^ DARK);
    }
  }
}

/**
 * What the standard docks a masked code for: even blocks of one colour, long
 * runs, anything wearing the finder's 1:1:3:1:1 signature, and an unbalanced
 * proportion of dark. The lowest score wins, which is the whole selection rule.
 */
function penalty(g: Grid): number {
  const size = g.size;
  const dark = (row: number, col: number) => (at(g, row, col) & DARK) !== 0;
  let score = 0;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let same = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (row + dr < 0 || row + dr >= size || col + dc < 0 || col + dc >= size) continue;
          if (dark(row + dr, col + dc) === dark(row, col)) same++;
        }
      }
      if (same > 5) score += 3 + same - 5;
    }
  }

  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const corners = Number(dark(row, col)) + Number(dark(row, col + 1))
        + Number(dark(row + 1, col)) + Number(dark(row + 1, col + 1));
      if (corners === 0 || corners === 4) score += 3;
    }
  }

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size - 6; col++) {
      if (dark(row, col) && !dark(row, col + 1) && dark(row, col + 2) && dark(row, col + 3)
        && dark(row, col + 4) && !dark(row, col + 5) && dark(row, col + 6)) score += 40;
    }
  }
  for (let col = 0; col < size; col++) {
    for (let row = 0; row < size - 6; row++) {
      if (dark(row, col) && !dark(row + 1, col) && dark(row + 2, col) && dark(row + 3, col)
        && dark(row + 4, col) && !dark(row + 5, col) && dark(row + 6, col)) score += 40;
    }
  }

  let count = 0;
  for (let i = 0; i < g.cells.length; i++) if ((g.cells[i]! & DARK) !== 0) count++;
  score += Math.floor(Math.abs((100 * count) / (size * size) - 50) / 5) * 10;
  return score;
}

/** The code for a string, or null if it is longer than version 10 holds. */
export function encodeQr(text: string): QrCode | null {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  if (version === null) return null;

  const g = patterns(version);
  formatBits(g, 0);
  placeData(g, codewords(bytes, version));

  let best = 0;
  let lowest = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(g, mask);
    formatBits(g, mask);
    const score = penalty(g);
    if (score < lowest) { lowest = score; best = mask; }
    applyMask(g, mask);
  }
  applyMask(g, best);
  formatBits(g, best);

  const modules = new Uint8Array(g.size * g.size);
  for (let i = 0; i < modules.length; i++) modules[i] = g.cells[i]! & DARK;
  return { size: g.size, modules };
}

/** Every dark module as one SVG path, offset by the quiet zone. */
export function qrPath(code: QrCode): string {
  const parts: string[] = [];
  for (let row = 0; row < code.size; row++) {
    for (let col = 0; col < code.size; col++) {
      if (code.modules[row * code.size + col]) parts.push(`M${col + QUIET} ${row + QUIET}h1v1h-1z`);
    }
  }
  return parts.join('');
}
