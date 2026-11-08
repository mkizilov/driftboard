// Draws the app icons into ../public as PNG files: `pnpm --filter @driftboard/web icons`.
// No dependencies: shapes are sampled four times per pixel in each direction and encoded with
// Node's zlib, so the output is the same on every machine.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const INK = [0x26, 0x24, 0x1f];
const NOTE = [0xfc, 0xd3, 0x4d];
const FOLD = [0xe0, 0xa8, 0x2e];
const LINE = [0x9a, 0x6b, 0x12];

/** Signed distance to a rounded rectangle given by its centre, half sizes and corner radius. */
function roundedRect(x, y, cx, cy, hx, hy, radius) {
  const dx = Math.abs(x - cx) - (hx - radius);
  const dy = Math.abs(y - cy) - (hy - radius);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * The colour at a point of the unit square, or `null` where the icon is transparent. A maskable
 * icon fills the whole square (the platform cuts the shape) and keeps the note in the safe zone.
 */
function pixel(u, v, maskable) {
  if (!maskable && roundedRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return null;
  const scale = maskable ? 0.82 : 1;
  const x = 0.5 + (u - 0.5) / scale;
  const y = 0.5 + (v - 0.5) / scale;
  let colour = INK;
  if (roundedRect(x, y, 0.5, 0.5, 0.3, 0.3, 0.05) <= 0) {
    colour = NOTE;
    const fold = 0.17;
    const along = x - (0.8 - fold) + (y - (0.8 - fold));
    if (x > 0.8 - fold && y > 0.8 - fold) colour = along > fold ? INK : FOLD;
    for (const [row, right] of [[0.36, 0.7], [0.46, 0.7], [0.56, 0.54]]) {
      if (x >= 0.3 && x <= right && Math.abs(y - row) <= 0.016) colour = LINE;
    }
  }
  return colour;
}

const SAMPLES = 4;

function render(size, maskable) {
  const data = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const colour = pixel(
            (px + (sx + 0.5) / SAMPLES) / size,
            (py + (sy + 0.5) / SAMPLES) / size,
            maskable,
          );
          if (colour === null) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          covered += 1;
        }
      }
      const offset = (py * size + px) * 4;
      if (covered > 0) {
        data[offset] = Math.round(r / covered);
        data[offset + 1] = Math.round(g / covered);
        data[offset + 2] = Math.round(b / covered);
        data[offset + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255);
      }
    }
  }
  return data;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

function png(size, maskable) {
  const rgba = render(size, maskable);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0; // filter type "none"
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits per channel, RGBA, no interlacing
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#26241f"/>
  <path d="M25 20h50a5 5 0 0 1 5 5v38l-17 17H25a5 5 0 0 1-5-5V25a5 5 0 0 1 5-5z" fill="#fcd34d"/>
  <path d="M80 63v12a5 5 0 0 1-5 5H63z" fill="#e0a82e"/>
  <path d="M30 36h40M30 46h40M30 56h24" stroke="#9a6b12" stroke-width="3.2"/>
</svg>
`;

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'icon-192.png'), png(192, false));
writeFileSync(join(out, 'icon-512.png'), png(512, false));
writeFileSync(join(out, 'icon-maskable-512.png'), png(512, true));
writeFileSync(join(out, 'apple-touch-icon.png'), png(180, true));
writeFileSync(join(out, 'favicon.svg'), favicon);
