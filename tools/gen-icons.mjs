#!/usr/bin/env node
/**
 * Generates every launcher-icon bitmap for the Black of Duty APK.
 *
 * WHY THIS EXISTS (and why it is a script instead of committed artwork):
 * the game repo is strict "no image assets — everything generated in code",
 * and this generator follows the same discipline for the app icon: a small
 * signed-distance-field renderer (pure Node + zlib, zero dependencies) draws a
 * tactical crosshair emblem, box-filters it down to each density bucket, and
 * writes legacy launcher PNGs plus adaptive-icon foregrounds. Re-run with
 * `node tools/gen-icons.mjs` to regenerate all ten files.
 *
 * The PNG encoder is deliberately minimal: 8-bit RGBA, no interlace, correct
 * CRC. That is everything aapt2 needs.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'android-overrides', 'icon');

// ------------------------------------------------------------------ PNG I/O

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * stride + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- rendering

/**
 * Signed-distance art on a square master canvas.
 *
 * All radii are fractions of the canvas side, centred on (0.5, 0.5). The
 * `fit` parameter scales the whole motif so callers can place it correctly:
 * legacy launchers want it near full-bleed, adaptive foregrounds must keep it
 * inside the 66dp safe zone of the 108dp canvas (fit <= ~0.61).
 */
function render(size, fit) {
  const px = new Uint8Array(size * size * 4);
  const c = size / 2;
  const motif = 0.455; // outermost art extent, in canvas fractions
  // Art DIAMETER should be `fit` of the canvas, so the scale converts a motif
  // radius of `motif` (fractions of canvas side) into `fit/2` of the side.
  const s = (fit * size) / (2 * motif);
  const AA = Math.max(1, size / 1024);

  // Signed distances, in scaled units. All centred on (c, c).
  const circle = (x, y, r) => Math.hypot(x - c, y - c) - r * s;
  const annulus = (x, y, r0, r1) =>
    Math.abs(circle(x, y, (r0 + r1) / 2)) - ((r1 - r0) / 2) * s;
  // Bounded axis-aligned rounded rectangle at (c+ox, c+oy), half-extents hx,hy.
  const rectAt = (x, y, ox, oy, hx, hy) => {
    const dx = Math.abs(x - (c + ox)) - hx;
    const dy = Math.abs(y - (c + oy)) - hy;
    const ax = Math.max(dx, 0);
    const ay = Math.max(dy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0);
  };
  // Axis-aligned square of half-size a centred at (tx, ty).
  const squareAt = (x, y, tx, ty, a) =>
    Math.max(Math.abs(x - tx), Math.abs(y - ty)) - a;
  const cover = (d) => Math.min(1, Math.max(0, 0.5 - d));

  const BG = [6, 8, 10]; // #06080a — matches the splash and loading screen
  const STEEL = [201, 214, 220]; // #c9d6dc
  const DIM = [90, 106, 114]; // #5a6a72
  const ACCENT = [255, 138, 106]; // #ff8a6a — the diagnostics/HUD accent

  // Post geometry: four reticle posts crossing the outer ring along the axes.
  // Half-length along the axis 0.0575*s at ±0.3975*s from centre, half-width
  // 0.032*s. Bounded in both directions — a bounded rect, not an infinite
  // slab; an unbounded slab is how this shape got broken the first time.
  const POST_H = [[0.3975, 0, 0.0575, 0.032], [-0.3975, 0, 0.0575, 0.032]];
  const POST_V = [[0, 0.3975, 0.032, 0.0575], [0, -0.3975, 0.032, 0.0575]];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let r = BG[0];
      let g = BG[1];
      let b = BG[2];
      // Soft radial depth: a barely-lighter disc that falls back to the flat
      // background at the corners.
      const rd = Math.hypot(x - c, y - c) / (0.5 * size);
      if (rd < 0.75) {
        const lift = 14 * (1 - rd / 0.75) ** 2;
        r += lift;
        g += lift;
        b += lift;
      }

      // Closest surface wins: the smallest signed distance among all elements
      // decides the pixel, and its colour layers over the background. This is
      // how the accent dot stays visible across the posts that cross it.
      let best = Infinity;
      let bcol = STEEL;
      const consider = (d, col) => {
        if (d < best) {
          best = d;
          bcol = col;
        }
      };

      consider(annulus(x, y, 0.32, 0.4), STEEL); // outer ring
      for (const [ox, oy, hx, hy] of POST_H) consider(rectAt(x, y, ox * s, oy * s, hx * s, hy * s), STEEL);
      for (const [ox, oy, hx, hy] of POST_V) consider(rectAt(x, y, ox * s, oy * s, hx * s, hy * s), STEEL);
      consider(annulus(x, y, 0.235, 0.265), DIM); // inner ring
      // Four diagonal stadia ticks between the rings.
      for (let k = 0; k < 4; k++) {
        const ang = Math.PI / 4 + (k * Math.PI) / 2;
        consider(squareAt(x, y, c + Math.cos(ang) * 0.3 * s, c + Math.sin(ang) * 0.3 * s, 0.016 * s), DIM);
      }
      consider(circle(x, y, 0.05), ACCENT); // centre dot

      if (best < AA) {
        const k = cover(best / AA);
        r = Math.round(r + (bcol[0] - r) * k);
        g = Math.round(g + (bcol[1] - g) * k);
        b = Math.round(b + (bcol[2] - b) * k);
      }
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return px;
}

/**
 * Box filter from the master render to a destination size. This is the honest
 * average over the source coverage for every destination pixel — good enough
 * for launcher icons (linear-light filtering would be marginally better and
 * indistinguishable at 48px).
 */
function downscale(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  const xs = sw / dw;
  const ys = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * ys);
    const y1 = Math.min(sh, Math.ceil((y + 1) * ys));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xs);
      const x1 = Math.min(sw, Math.ceil((x + 1) * xs));
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * dw + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ------------------------------------------------------------------- layout

// Density bucket -> (legacy px, foreground px). Foreground is the adaptive-icon
// canvas at 108dp, which is what the icon masks to 66dp of visible area.
const DENSITIES = {
  mdpi: [48, 108],
  hdpi: [72, 162],
  xhdpi: [96, 216],
  xxhdpi: [144, 324],
  xxxhdpi: [192, 432],
};

const MASTER = 1024;
const masterFull = render(MASTER, 0.86); // legacy: near full-bleed
const masterSafe = render(MASTER, 0.58); // adaptive: inside the 66dp safe zone

let written = [];
for (const [density, [legacyPx, fgPx]] of Object.entries(DENSITIES)) {
  const dir = join(OUT, `mipmap-${density}`);
  mkdirSync(dir, { recursive: true });
  for (const name of ['ic_launcher', 'ic_launcher_round']) {
    const px = downscale(masterFull, MASTER, MASTER, legacyPx, legacyPx);
    const file = join(dir, `${name}.png`);
    writeFileSync(file, encodePNG(legacyPx, legacyPx, px));
    written.push(file);
  }
  const fg = downscale(masterSafe, MASTER, MASTER, fgPx, fgPx);
  const file = join(dir, 'ic_launcher_foreground.png');
  writeFileSync(file, encodePNG(fgPx, fgPx, fg));
  written.push(file);
}

// Adaptive-icon XML: references the color we own and the foreground bitmaps we
// just wrote. Monochrome is deliberately omitted so themed icons are not
// claimed by an asset that was not designed for them.
const ADAPTIVE = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
const V26 = join(OUT, 'mipmap-anydpi-v26');
mkdirSync(V26, { recursive: true });
writeFileSync(join(V26, 'ic_launcher.xml'), ADAPTIVE);
writeFileSync(join(V26, 'ic_launcher_round.xml'), ADAPTIVE);
written.push(join(V26, 'ic_launcher.xml'), join(V26, 'ic_launcher_round.xml'));

// The launcher background colour — #06080a, the same near-black the splash and
// the loading screen use, so square-icon launchers do not flash white.
const BG_XML = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#FF06080A</color>
</resources>
`;
const VALS = join(OUT, 'values');
mkdirSync(VALS, { recursive: true });
writeFileSync(join(VALS, 'ic_launcher_background.xml'), BG_XML);
written.push(join(VALS, 'ic_launcher_background.xml'));

for (const f of written) {
  console.log(`  ${f.replace(OUT + '/', '').padEnd(50)} ${statSync(f).size} B`);
}
console.log(`\n${written.length} files under ${OUT}`);

export { render, downscale, encodePNG };