// 生成应用图标：build/icon.png（托盘/窗口用）与 build/icon.ico（Windows 打包用）
// 纯 Node 实现，无外部依赖：画一个圆角方形 + 白色桥形图案
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;

function roundedRect(px, x, y, w, h, r, color) {
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      const cx = Math.min(Math.max(i, x + r), x + w - r);
      const cy = Math.min(Math.max(j, y + r), y + h - r);
      if ((i - cx) ** 2 + (j - cy) ** 2 <= r * r) setPx(px, i, j, color);
    }
  }
}
function circle(px, cx, cy, r, color) {
  for (let j = Math.floor(cy - r); j <= cy + r; j++) {
    for (let i = Math.floor(cx - r); i <= cx + r; i++) {
      if ((i - cx) ** 2 + (j - cy) ** 2 <= r * r) setPx(px, i, j, color);
    }
  }
}
function hbar(px, y, h, color) {
  for (let j = y; j < y + h; j++) for (let i = 0; i < SIZE; i++) setPx(px, i, j, color);
}
function setPx(px, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const o = (y * SIZE + x) * 4;
  px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
}

function draw() {
  const px = Buffer.alloc(SIZE * SIZE * 4, 0);
  // 背景：深蓝圆角方块
  roundedRect(px, 8, 8, SIZE - 16, SIZE - 16, 48, [31, 111, 235, 255]);
  // 白色桥面横条
  hbar(px, 150, 18, [255, 255, 255, 255]);
  // 桥拱：两个白色半圆桥洞（用背景色挖洞）
  circle(px, 86, 168, 34, [31, 111, 235, 255]);
  circle(px, 170, 168, 34, [31, 111, 235, 255]);
  // 顶部白色圆点（节点）
  circle(px, SIZE / 2, 74, 26, [255, 255, 255, 255]);
  return px;
}

function crc32(buf) {
  let table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function toPng(px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// ICO：Vista+ 支持内嵌 PNG 的单张 256x256 条目
function toIco(png) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0; // 256x256 用 0 表示
  entry[2] = 0; entry[3] = 0;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12);
  return Buffer.concat([head, entry, png]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = toPng(draw());
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), toIco(png));
console.log('图标已生成：build/icon.png, build/icon.ico');
