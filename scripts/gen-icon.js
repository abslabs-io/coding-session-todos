// Generates media/icon-128.png — the 128x128 Marketplace listing icon.
// Dependency-free: renders a coral rounded-square "checklist" mark at 4x and
// box-downsamples for anti-aliasing, then encodes a PNG with the built-in zlib.
// Run with: npm run icon
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const N = 128; // output size
const S = 4; // supersample factor
const R = N * S; // render size

const CORAL = [217, 119, 87];
const WHITE = [255, 255, 255];

// Buffer carries coral rgb everywhere with alpha as coverage, so straight-alpha
// box-averaging never darkens the rounded edges (transparent subpixels still
// hold the coral rgb; only their alpha is zero).
const buf = Buffer.alloc(R * R * 4);
for (let i = 0; i < R * R; i++) {
  buf[i * 4] = CORAL[0];
  buf[i * 4 + 1] = CORAL[1];
  buf[i * 4 + 2] = CORAL[2];
  buf[i * 4 + 3] = 0;
}

function set(x, y, c, a) {
  const i = (y * R + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = a;
}

function insideRRect(px, py, x, y, w, h, rad) {
  const cx = Math.min(Math.max(px, x + rad), x + w - rad);
  const cy = Math.min(Math.max(py, y + rad), y + h - rad);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  const cx = ax + t * vx;
  const cy = ay + t * vy;
  return Math.hypot(px - cx, py - cy);
}

const rows = [
  { cy: 36, lineEnd: 104 },
  { cy: 64, lineEnd: 104 },
  { cy: 92, lineEnd: 84 },
];
const DOT_X = 34;
const DOT_R = 8;
const LINE_X = 50;
const LINE_R = 6;

for (let y = 0; y < R; y++) {
  for (let x = 0; x < R; x++) {
    const ux = (x + 0.5) / S; // back to N-space, pixel center
    const uy = (y + 0.5) / S;
    if (!insideRRect(ux, uy, 0, 0, N, N, 28)) continue;
    set(x, y, CORAL, 255);
    for (const row of rows) {
      const inDot = Math.hypot(ux - DOT_X, uy - row.cy) <= DOT_R;
      const inLine = segDist(ux, uy, LINE_X, row.cy, row.lineEnd, row.cy) <= LINE_R;
      if (inDot || inLine) {
        set(x, y, WHITE, 255);
        break;
      }
    }
  }
}

// Box-downsample R -> N (straight-alpha average).
const out = Buffer.alloc(N * N * 4);
const n = S * S;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < S; sy++) {
      for (let sx = 0; sx < S; sx++) {
        const i = ((y * S + sy) * R + (x * S + sx)) * 4;
        r += buf[i];
        g += buf[i + 1];
        b += buf[i + 2];
        a += buf[i + 3];
      }
    }
    const oi = (y * N + x) * 4;
    out[oi] = Math.round(r / n);
    out[oi + 1] = Math.round(g / n);
    out[oi + 2] = Math.round(b / n);
    out[oi + 3] = Math.round(a / n);
  }
}

// Encode PNG (RGBA, 8-bit, filter type 0 per scanline).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// 10,11,12 = compression/filter/interlace = 0

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0; // filter: none
  out.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, "..", "media", "icon-128.png");
fs.writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes)`);
