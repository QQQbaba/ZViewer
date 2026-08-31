// 纯 Node 生成 App 图标（渐变圆角方块 + 白色播放三角），无外部依赖
const zlib = require('zlib');
const fs = require('fs');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size, px) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const corner = 0.20; // 圆角比例
  const A = { x: 0.35, y: 0.30 }, B = { x: 0.67, y: 0.50 }, C = { x: 0.35, y: 0.70 };
  const sign = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size, ny = (y + 0.5) / size;
      // 圆角矩形判定
      const cx = Math.min(nx, 1 - nx), cy = Math.min(ny, 1 - ny);
      let inShape = true;
      if (cx < corner && cy < corner) {
        const dx = corner - cx, dy = corner - cy;
        if (dx * dx + dy * dy > corner * corner) inShape = false;
      }
      // 三角形判定
      const d1 = sign({ x: nx, y: ny }, A, B), d2 = sign({ x: nx, y: ny }, B, C), d3 = sign({ x: nx, y: ny }, C, A);
      const tri = !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
      const idx = (y * size + x) * 4;
      if (tri && inShape) {
        px[idx] = 255; px[idx + 1] = 255; px[idx + 2] = 255; px[idx + 3] = 255;
      } else if (inShape) {
        // 渐变：顶 #4f46e5 → 底 #9333ea
        px[idx] = Math.round(0x4f + (0x93 - 0x4f) * ny);
        px[idx + 1] = Math.round(0x46 + (0x33 - 0x46) * ny);
        px[idx + 2] = Math.round(0xe5 + (0xea - 0xe5) * ny);
        px[idx + 3] = 255;
      } else {
        px[idx] = 0; px[idx + 1] = 0; px[idx + 2] = 0; px[idx + 3] = 0;
      }
    }
  }
  return px;
}

const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [dpi, size] of Object.entries(sizes)) {
  const dir = 'res/mipmap-' + dpi;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/ic_launcher.png', encodePNG(size, draw(size)));
  console.log('icon ok:', dir, size + 'x' + size);
}
console.log('ALL_ICONS_DONE');
