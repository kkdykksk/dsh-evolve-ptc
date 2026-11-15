#!/usr/bin/env node
/**
 * 生成 assets/icon.png（256×256，RGBA）。没有图像依赖：自己画 4×超采样 + 手写 PNG 编码。
 * 图案 = 深色圆角底 + 三段向上收窄的琥珀-青渐变箭头 + 顶部一点，表意「逐层进化」。
 *
 * 用法：`node scripts/icon.mjs [out]`
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? resolve(here, '..', 'assets', 'icon.png'));
const SIZE = 256;
const SCALE = 4;
const N = SIZE * SCALE;

const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value);
const mix = (a, b, t) => a + (b - a) * t;

/** 圆角矩形有向距离（<0 在内部）。 */
function roundRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** 线段有向距离。 */
function segment(x, y, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = x - ax;
  const wy = y - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(wx - vx * t, wy - vy * t);
}

/** 一道「^」：两条线段，返回覆盖度（带 1.2px 羽化）。 */
function chevron(x, y, cx, cy, halfW, rise, thickness) {
  const d = Math.min(segment(x, y, cx - halfW, cy, cx, cy - rise), segment(x, y, cx, cy - rise, cx + halfW, cy));
  return clamp01((thickness - d) / (1.2 * SCALE));
}

function sample(x, y) {
  const px = x / SCALE;
  const py = y / SCALE;

  // 底：圆角方形 + 竖向渐变
  const body = clamp01(-roundRect(px, py, SIZE / 2, SIZE / 2, SIZE / 2 - 4, SIZE / 2 - 4, 58) / (1.2 * SCALE));
  if (body <= 0) return [0, 0, 0, 0];
  const t = clamp01(py / SIZE);
  let r = mix(9, 19, t);
  let g = mix(16, 28, t);
  let b = mix(30, 54, t);

  // 三段箭头：下宽上窄，颜色由琥珀→青
  const layers = [
    { cy: 178, halfW: 66, rise: 52, thickness: 13, from: [245, 178, 82], to: [232, 122, 74] },
    { cy: 148, halfW: 54, rise: 46, thickness: 12, from: [122, 208, 236], to: [110, 160, 244] },
    { cy: 122, halfW: 42, rise: 40, thickness: 11, from: [150, 128, 252], to: [196, 120, 246] },
  ];
  layers.forEach((layer, index) => {
    const cover = chevron(px, py, SIZE / 2, layer.cy, layer.halfW, layer.rise, layer.thickness / 2);
    if (cover <= 0) return;
    const gradient = clamp01((py - (layer.cy - layer.rise)) / layer.rise);
    const cr = mix(layer.from[0], layer.to[0], gradient);
    const cg = mix(layer.from[1], layer.to[1], gradient);
    const cb = mix(layer.from[2], layer.to[2], gradient);
    const alpha = cover * (0.92 - index * 0.06);
    r = mix(r, cr, alpha);
    g = mix(g, cg, alpha);
    b = mix(b, cb, alpha);
  });

  // 顶部一点
  const dot = clamp01((8 - Math.hypot(px - SIZE / 2, py - 74)) / (1.2 * SCALE));
  if (dot > 0) {
    r = mix(r, 235, dot);
    g = mix(g, 246, dot);
    b = mix(b, 255, dot);
  }

  return [r, g, b, body * 255];
}

// 超采样渲染
const big = new Uint8ClampedArray(N * N * 4);
for (let y = 0; y < N; y += 1) {
  for (let x = 0; x < N; x += 1) {
    const [r, g, b, a] = sample(x + 0.5, y + 0.5);
    const offset = (y * N + x) * 4;
    big[offset] = r;
    big[offset + 1] = g;
    big[offset + 2] = b;
    big[offset + 3] = a;
  }
}

// 盒式降采样
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SCALE; sy += 1) {
      for (let sx = 0; sx < SCALE; sx += 1) {
        const offset = ((y * SCALE + sy) * N + (x * SCALE + sx)) * 4;
        const alpha = big[offset + 3] / 255;
        r += big[offset] * alpha;
        g += big[offset + 1] * alpha;
        b += big[offset + 2] * alpha;
        a += big[offset + 3];
      }
    }
    const count = SCALE * SCALE;
    const alpha = a / count;
    const weight = a / 255 || 1;
    const target = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[target] = Math.round(r / weight);
    raw[target + 1] = Math.round(g / weight);
    raw[target + 2] = Math.round(b / weight);
    raw[target + 3] = Math.round(alpha);
  }
}

// PNG 编码
const table = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c;
}
const crc = buffer => {
  let c = 0xffffffff;
  for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, check]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`icon -> ${out} (${png.length} bytes)`);
