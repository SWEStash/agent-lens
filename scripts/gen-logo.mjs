#!/usr/bin/env node
// Generate the web UI's logo + favicon set from the brand source PNG.
//
// The source (assets/brand/logo-source.png) is a mint "code-lens" mark on a flat
// grey-green background with a soft neon glow. The mark's strokes are the brightest
// thing in the image, so we key on luminance: bright stroke pixels become opaque, the
// dim background/glow becomes transparent, with a linear ramp between for soft edges
// (a faint halo around the strokes is intentional). Then we trim to the mark and emit
// sized assets.
//
// Re-run after changing the source: `node scripts/gen-logo.mjs`. Outputs are committed.
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(root, "assets/brand/logo-source.png");
const PUBLIC = resolve(root, "packages/web/public"); // favicons: referenced from index.html
const ASSETS = resolve(root, "packages/web/src/assets"); // navbar logo: imported by App.tsx (Vite-hashed)

// Luminance thresholds (0..255). At/below NEAR → transparent; at/above FAR → opaque;
// linear ramp between. Tuned so the bright strokes survive and the grey bg + outer glow drop.
const NEAR = 150;
const FAR = 205;
const ALPHA_KEEP = 40; // pixels at/above this alpha define the trim bounding box

const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;

let minX = width, minY = height, maxX = 0, maxY = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels;
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    let a = lum <= NEAR ? 0 : lum >= FAR ? 255 : Math.round(((lum - NEAR) / (FAR - NEAR)) * 255);
    // Respect any pre-existing transparency in the source.
    a = Math.min(a, data[i + 3]);
    data[i + 3] = a;
    if (a >= ALPHA_KEEP) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}

// Pad the bounding box slightly so the glow isn't clipped, then keep it square + centred.
const pad = Math.round(Math.max(width, height) * 0.02);
minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
const bw = maxX - minX + 1, bh = maxY - minY + 1;
const side = Math.max(bw, bh);
const left = Math.max(0, minX - Math.floor((side - bw) / 2));
const top = Math.max(0, minY - Math.floor((side - bh) / 2));
const sq = Math.min(side, width - left, height - top);

const keyed = sharp(data, { raw: { width, height, channels } })
  .extract({ left, top, width: sq, height: sq });
const master = await keyed.png().toBuffer();

const resize = (size) =>
  sharp(master).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png();

// Favicons live in public/ and are referenced by index.html via %BASE_URL%.
const favicons = [["favicon-16.png", 16], ["favicon-32.png", 32], ["apple-touch-icon.png", 180]];
for (const [name, size] of favicons) await resize(size).toFile(resolve(PUBLIC, name));
// The navbar logo is imported by App.tsx so Vite hashes it and applies the base URL.
await mkdir(ASSETS, { recursive: true });
await resize(128).toFile(resolve(ASSETS, "logo.png"));
// A larger transparent master kept alongside the source for reference / future use (not shipped).
await resize(512).toFile(resolve(root, "assets/brand/logo-transparent.png"));
console.log(`box ${bw}×${bh} → square ${sq} · wrote ${favicons.length} favicons + navbar logo`);
