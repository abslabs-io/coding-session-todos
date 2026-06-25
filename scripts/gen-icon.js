// Generates media/icon-128.png — the 128x128 Marketplace listing icon.
// Mirrors media/icon.svg (a checklist: first dot filled, the other two hollow,
// third line shorter) in white on a black rounded square. Dependency-free:
// renders the mark at 4x and box-downsamples for anti-aliasing, then encodes a
// PNG with the built-in zlib. Run with: npm run icon
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const N = 128; // output size
const S = 4; // supersample factor
const R = N * S; // render size

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

// Buffer carries the bg rgb everywhere with alpha as coverage, so straight-alpha
// box-averaging never darkens the rounded edges (transparent subpixels still
// hold the bg rgb; only their alpha is zero).
const buf = Buffer.alloc(R * R * 4);
for (let i = 0; i < R * R; i++) {
  buf[i * 4] = BLACK[0];
  buf[i * 4 + 1] = BLACK[1];
  buf[i * 4 + 2] = BLACK[2];
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

// Geometry maps icon.svg's 24x24 space into the 128 canvas (scale 4.5, offset
// 10) so the mark is centered. SVG circles are r=2 with stroke-width 2, so the
// painted radius is 3 units (path + half stroke); the hollow ring's hole is the
// path minus the half stroke (r=1 unit). Lines are stroke-width 2 (half 1 unit)
// with round caps. Row 1's dot is filled; rows 2-3 are hollow, like the SVG.
const SCALE = 4.5;
const OFF = 10;
const u = (v) => v * SCALE + OFF;

const DOT_X = u(5);
const DOT_OUTER = 3 * SCALE; // painted radius (r=2 + half stroke=1)
const DOT_HOLE = 1 * SCALE; // ring inner radius (r=2 - half stroke=1)
const LINE_X = u(10);
const LINE_HW = 1 * SCALE; // line half-width (stroke-width 2 / 2)

const rows = [
  { cy: u(5), lineEnd: u(21), fill: true },
  { cy: u(12), lineEnd: u(21), fill: false },
  { cy: u(19), lineEnd: u(17), fill: false },
];

for (let y = 0; y < R; y++) {
  for (let x = 0; x < R; x++) {
    const ux = (x + 0.5) / S; // back to N-space, pixel center
    const uy = (y + 0.5) / S;
    if (!insideRRect(ux, uy, 0, 0, N, N, 28)) continue;
    set(x, y, BLACK, 255);
    for (const row of rows) {
      const dot = Math.hypot(ux - DOT_X, uy - row.cy);
      const inDot = row.fill ? dot <= DOT_OUTER : dot <= DOT_OUTER && dot >= DOT_HOLE;
      const inLine = segDist(ux, uy, LINE_X, row.cy, row.lineEnd, row.cy) <= LINE_HW;
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
