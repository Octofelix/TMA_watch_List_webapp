// Builds the phone app icons in public/icons/ from the logo in public/brand/ (a PNG).
// No image libraries needed: decodes the PNG, places it on a white background, scales it, re-encodes.
// Run:  node scripts/make-icons.js
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

const root = new URL('../public/', import.meta.url);
const logoName = readdirSync(new URL('brand/', root)).find((f) => /\.png$/i.test(f));
if (!logoName) throw new Error('Put a PNG logo in public/brand/ first.');

function decodePng(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), depth = buf[24], type = buf[25];
  if (depth !== 8 || (type !== 6 && type !== 2)) throw new Error('Logo must be an 8-bit RGB or RGBA PNG.');
  const bpp = type === 6 ? 4 : 3;
  const idat = [];
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p), t = buf.toString('ascii', p + 4, p + 8);
    if (t === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const r = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let v = r;
      if (f === 1) v = r + a; else if (f === 2) v = r + b; else if (f === 3) v = r + ((a + b) >> 1);
      else if (f === 4) { const p0 = a + b - c, pa = Math.abs(p0 - a), pb = Math.abs(p0 - b), pc = Math.abs(p0 - c); v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[y * stride + x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = px[i * bpp]; rgba[i * 4 + 1] = px[i * bpp + 1]; rgba[i * 4 + 2] = px[i * bpp + 2];
    rgba[i * 4 + 3] = bpp === 4 ? px[i * bpp + 3] : 255;
  }
  return { w, h, rgba };
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Bilinear sample of the logo at (x, y) in logo pixels, premultiplied to avoid dark fringes.
function sample(img, x, y) {
  const x0 = Math.max(0, Math.min(img.w - 1, Math.floor(x))), y0 = Math.max(0, Math.min(img.h - 1, Math.floor(y)));
  const x1 = Math.min(img.w - 1, x0 + 1), y1 = Math.min(img.h - 1, y0 + 1), fx = x - x0, fy = y - y0;
  const out = [0, 0, 0, 0];
  for (const [xx, yy, wt] of [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]]) {
    const i = (yy * img.w + xx) * 4, a = img.rgba[i + 3] / 255;
    out[0] += img.rgba[i] * a * wt; out[1] += img.rgba[i + 1] * a * wt; out[2] += img.rgba[i + 2] * a * wt; out[3] += a * wt;
  }
  return out; // premultiplied rgb, alpha 0..1
}

// size: icon size; scale: how much of the icon the logo fills; bg: background colour or null (transparent)
function render(img, size, scale, bg, mono = false) {
  const out = Buffer.alloc(size * size * 4), logoPx = size * scale, off = (size - logoPx) / 2, k = img.w / logoPx;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const lx = (x - off + 0.5) * k - 0.5, ly = (y - off + 0.5) * k - 0.5;
    const inside = lx >= -0.5 && ly >= -0.5 && lx <= img.w - 0.5 && ly <= img.h - 0.5;
    const [r, g, b, a] = inside ? sample(img, lx, ly) : [0, 0, 0, 0];
    const i = (y * size + x) * 4;
    if (mono) { // white silhouette for Android's small status-bar badge
      const lum = a ? (r + g + b) / (3 * a) : 255;
      const alpha = lum > 235 ? 0 : a; // drop the white parts of the logo
      out[i] = out[i + 1] = out[i + 2] = 255; out[i + 3] = Math.round(alpha * 255);
    } else if (bg) {
      out[i] = Math.round(r + bg[0] * (1 - a)); out[i + 1] = Math.round(g + bg[1] * (1 - a)); out[i + 2] = Math.round(b + bg[2] * (1 - a)); out[i + 3] = 255;
    } else {
      out[i] = a ? Math.round(r / a) : 0; out[i + 1] = a ? Math.round(g / a) : 0; out[i + 2] = a ? Math.round(b / a) : 0; out[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, out);
}

const img = decodePng(readFileSync(new URL(`brand/${logoName}`, root)));
const dir = new URL('icons/', root);
mkdirSync(dir, { recursive: true });
const WHITE = [255, 255, 255];
const icons = {
  'icon-192.png': render(img, 192, 0.86, WHITE),
  'icon-512.png': render(img, 512, 0.86, WHITE),
  'maskable-512.png': render(img, 512, 0.62, WHITE), // Android crops these into circles/squircles
  'apple-touch-icon.png': render(img, 180, 0.82, WHITE),
  'badge-96.png': render(img, 96, 0.92, null, true),
};
for (const [name, png] of Object.entries(icons)) writeFileSync(new URL(name, dir), png);
console.log(`Made ${Object.keys(icons).length} icons from ${logoName} (${img.w}x${img.h}) in public/icons/`);
