import { deflateSync } from 'node:zlib';

/**
 * Dependency-free QR code (byte mode, error-correction level M, versions 1-15) and a
 * minimal PNG writer, so the binding link can be shown as a scannable image. Ported from
 * weixin-bridge lib/qr.mjs.
 */

// Per version (index 1..15), level M: EC codewords per block, and number of blocks.
const EC_LEN = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10];
const MAX_VERSION = 15;

function rawModules(version: number): number {
  let count = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    count -= (25 * align - 10) * align - 55;
    if (version >= 7) count -= 36;
  }
  return count;
}

const totalCodewords = (version: number) => Math.floor(rawModules(version) / 8);
const dataCodewords = (version: number) => totalCodewords(version) - EC_LEN[version]! * BLOCKS[version]!;

// --- Reed-Solomon over GF(256), polynomial 0x11D ---
function gfMul(a: number, b: number): number {
  let result = 0;
  for (let i = 7; i >= 0; i -= 1) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((b >>> i) & 1) * a;
  }
  return result;
}

function rsDivisor(degree: number): number[] {
  const poly = new Array<number>(degree).fill(0);
  poly[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      poly[j] = gfMul(poly[j]!, root);
      if (j + 1 < degree) poly[j] = poly[j]! ^ poly[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  return poly;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const rem = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift()!;
    rem.push(0);
    divisor.forEach((coef, i) => {
      rem[i] = rem[i]! ^ gfMul(coef, factor);
    });
  }
  return rem;
}

// --- data codewords: mode + length + bytes + padding, then EC and interleaving ---
function encodeData(bytes: Buffer, version: number): number[] {
  const capacity = dataCodewords(version) * 8;
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(Number.parseInt(bits.slice(i, i + 8).join(''), 2));
  return data;
}

function addErrorCorrection(data: number[], version: number): number[] {
  const blocks = BLOCKS[version]!;
  const ecLen = EC_LEN[version]!;
  const total = totalCodewords(version);
  const shortBlocks = blocks - (total % blocks);
  const shortLen = Math.floor(total / blocks) - ecLen;
  const divisor = rsDivisor(ecLen);
  const parts: Array<{ data: number[]; ec: number[] }> = [];
  for (let i = 0, offset = 0; i < blocks; i += 1) {
    const chunk = data.slice(offset, offset + shortLen + (i < shortBlocks ? 0 : 1));
    offset += chunk.length;
    parts.push({ data: chunk, ec: rsRemainder(chunk, divisor) });
  }
  const out: number[] = [];
  for (let i = 0; i <= shortLen; i += 1) for (const part of parts) if (i < part.data.length) out.push(part.data[i]!);
  for (let i = 0; i < ecLen; i += 1) for (const part of parts) out.push(part.ec[i]!);
  return out;
}

// --- matrix ---
function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = size - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

type Matrix = boolean[][];

function penalty(modules: Matrix): number {
  const size = modules.length;
  const lines: string[] = [];
  for (let i = 0; i < size; i += 1) {
    lines.push(modules[i]!.map(Number).join(''));
    lines.push(modules.map((row) => Number(row[i])).join(''));
  }
  let score = 0;
  let dark = 0;
  for (const line of lines) {
    for (const run of line.match(/0{5,}|1{5,}/g) ?? []) score += run.length - 2;
    for (let i = line.indexOf('1011101'); i !== -1; i = line.indexOf('1011101', i + 1)) {
      if (line.slice(Math.max(0, i - 4), i) === '0000' || line.slice(i + 7, i + 11) === '0000') score += 40;
    }
  }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y]![x]) dark += 1;
      if (x + 1 < size && y + 1 < size) {
        const c = modules[y]![x];
        if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) score += 3;
      }
    }
  }
  return score + Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
}

function buildMatrix(codewords: number[], version: number, mask: number): Matrix {
  const size = version * 4 + 17;
  const modules: Matrix = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed: Matrix = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: number | boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y]![x] = Boolean(dark);
    fixed[y]![x] = true;
  };
  // timing patterns
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // finder patterns with their light separators
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as Array<[number, number]>) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, ring !== 2 && ring !== 4);
      }
    }
  }
  // alignment patterns (skipping the three finder corners)
  const align = alignmentPositions(version, size);
  align.forEach((cx, i) =>
    align.forEach((cy, j) => {
      const last = align.length - 1;
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }),
  );
  // format information: level M (bits 00) + mask, BCH(15,5), in two copies
  const formatData = mask;
  let rem = formatData;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const format = ((formatData << 10) | rem) ^ 0x5412;
  const fbit = (i: number) => (format >>> i) & 1;
  for (let i = 0; i <= 5; i += 1) set(8, i, fbit(i));
  set(8, 7, fbit(6));
  set(8, 8, fbit(7));
  set(7, 8, fbit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, fbit(i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, fbit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, fbit(i));
  set(8, size - 8, true);
  // version information (versions 7+), BCH(18,6), in two copies
  if (version >= 7) {
    let vrem = version;
    for (let i = 0; i < 12; i += 1) vrem = (vrem << 1) ^ ((vrem >>> 11) * 0x1f25);
    const info = (version << 12) | vrem;
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, (info >>> i) & 1);
      set(b, a, (info >>> i) & 1);
    }
  }
  // data: zigzag in column pairs from the right, masked as it is placed
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fixed[y]![x]) continue;
        const bit = index < codewords.length * 8 ? (codewords[index >>> 3]! >>> (7 - (index & 7))) & 1 : 0;
        modules[y]![x] = Boolean(bit) !== MASKS[mask]!(x, y);
        index += 1;
      }
    }
  }
  return modules;
}

/** A square matrix of booleans (true = dark module). */
export function qrMatrix(text: string): Matrix {
  const bytes = Buffer.from(text, 'utf8');
  let version = 1;
  while (version <= MAX_VERSION && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8) version += 1;
  if (version > MAX_VERSION) throw new Error(`text too long for the built-in QR encoder (${bytes.length} bytes)`);
  const codewords = addErrorCorrection(encodeData(bytes, version), version);
  let best: { modules: Matrix; score: number } | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = buildMatrix(codewords, version, mask);
    const score = penalty(modules);
    if (!best || score < best.score) best = { modules, score };
  }
  return best!.modules;
}

// CRC-32 (PNG chunks); zlib.crc32 only exists from Node 20.15
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** 8-bit greyscale PNG: `scale` pixels per module, `margin` light modules around the code. */
export function qrPng(text: string, { scale = 10, margin = 4 } = {}): Buffer {
  const modules = qrMatrix(text);
  const side = (modules.length + margin * 2) * scale;
  const raw = Buffer.alloc((side + 1) * side, 0xff);
  for (let py = 0; py < side; py += 1) {
    raw[py * (side + 1)] = 0; // filter type: none
    const row = modules[Math.floor(py / scale) - margin];
    if (!row) continue;
    for (let px = 0; px < side; px += 1) {
      if (row[Math.floor(px / scale) - margin]) raw[py * (side + 1) + 1 + px] = 0x00;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 0, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
