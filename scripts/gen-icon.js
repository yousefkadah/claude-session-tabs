// Dependency-free PNG icon generator (no SVG toolchain needed).
// Composites the Claude "spark" mark (rasterized from its SVG path via a
// nonzero-winding scanline fill) over a dark card with colored session dots.
// Renders at 4x and box-downsamples for smooth edges. Output: resources/icon.png (256x256).
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = 256;
const S = 4; // supersampling factor
const W = OUT * S;
const H = OUT * S;
const buf = new Uint8ClampedArray(W * H * 4); // RGBA, starts transparent

// Claude spark — exact path from the Claude Code extension's claude-logo.svg (viewBox 0 0 24 24).
const CLAUDE_PATH =
  'M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z';

function px(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const sa = a / 255;
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;
  buf[i] = (r * sa + buf[i] * da * (1 - sa)) / oa;
  buf[i + 1] = (g * sa + buf[i + 1] * da * (1 - sa)) / oa;
  buf[i + 2] = (b * sa + buf[i + 2] * da * (1 - sa)) / oa;
  buf[i + 3] = oa * 255;
}

function roundRect(x0, y0, w, h, rad, color) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let dx = 0;
      let dy = 0;
      if (x < x0 + rad) dx = x0 + rad - x;
      else if (x > x1 - rad - 1) dx = x - (x1 - rad - 1);
      if (y < y0 + rad) dy = y0 + rad - y;
      else if (y > y1 - rad - 1) dy = y - (y1 - rad - 1);
      if (dx > 0 && dy > 0 && dx * dx + dy * dy > rad * rad) continue;
      px(x, y, color);
    }
  }
}

function disc(cx, cy, r, color) {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) px(x, y, color);
    }
  }
}

// --- minimal SVG path -> polygons ---
function parsePath(d) {
  let i = 0;
  const n = d.length;
  const isWS = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',';
  const skip = () => { while (i < n && isWS(d[i])) i++; };
  function readNum() {
    skip();
    const start = i;
    if (d[i] === '+' || d[i] === '-') i++;
    while (i < n && d[i] >= '0' && d[i] <= '9') i++;
    if (d[i] === '.') { i++; while (i < n && d[i] >= '0' && d[i] <= '9') i++; }
    if (d[i] === 'e' || d[i] === 'E') { i++; if (d[i] === '+' || d[i] === '-') i++; while (i < n && d[i] >= '0' && d[i] <= '9') i++; }
    return parseFloat(d.slice(start, i));
  }
  function readFlag() { skip(); const c = d[i]; i++; return c === '1' ? 1 : 0; }

  const subpaths = [];
  let cur = null;
  let cmd = '';
  let cx = 0, cy = 0, sx = 0, sy = 0;

  function cubic(x1, y1, x2, y2, x, y) {
    const steps = 18;
    for (let t = 1; t <= steps; t++) {
      const u = t / steps;
      const mu = 1 - u;
      const bx = mu * mu * mu * cx + 3 * mu * mu * u * x1 + 3 * mu * u * u * x2 + u * u * u * x;
      const by = mu * mu * mu * cy + 3 * mu * mu * u * y1 + 3 * mu * u * u * y2 + u * u * u * y;
      cur.push({ x: bx, y: by });
    }
  }

  skip();
  while (i < n) {
    skip();
    if (i >= n) break;
    const c = d[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) { cmd = c; i++; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === 'M') {
      let x = readNum(), y = readNum();
      if (rel) { x += cx; y += cy; }
      cx = x; cy = y; sx = x; sy = y;
      cur = [{ x, y }];
      subpaths.push(cur);
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L') {
      let x = readNum(), y = readNum();
      if (rel) { x += cx; y += cy; }
      cx = x; cy = y; cur.push({ x, y });
    } else if (C === 'H') {
      let x = readNum();
      if (rel) x += cx;
      cx = x; cur.push({ x: cx, y: cy });
    } else if (C === 'V') {
      let y = readNum();
      if (rel) y += cy;
      cy = y; cur.push({ x: cx, y: cy });
    } else if (C === 'C') {
      let x1 = readNum(), y1 = readNum(), x2 = readNum(), y2 = readNum(), x = readNum(), y = readNum();
      if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
      cubic(x1, y1, x2, y2, x, y);
      cx = x; cy = y;
    } else if (C === 'A') {
      readNum(); readNum(); readNum(); readFlag(); readFlag(); // rx ry xrot large sweep (approx as line)
      let x = readNum(), y = readNum();
      if (rel) { x += cx; y += cy; }
      cur.push({ x, y }); cx = x; cy = y;
    } else if (C === 'Z') {
      if (cur) cur.push({ x: sx, y: sy });
      cx = sx; cy = sy;
    } else {
      i++; // unknown; avoid stalling
    }
  }
  return subpaths;
}

function fillPath(d, ox, oy, scale, color) {
  const subs = parsePath(d).map((pts) =>
    pts.map((p) => ({ x: ox + p.x * scale, y: oy + p.y * scale })),
  );
  const edges = [];
  let minY = Infinity, maxY = -Infinity;
  for (const pts of subs) {
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      const b = pts[(k + 1) % pts.length];
      if (a.y !== b.y) edges.push({ a, b });
      minY = Math.min(minY, a.y);
      maxY = Math.max(maxY, a.y);
    }
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(H - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (const e of edges) {
      const { a, b } = e;
      if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) {
        const x = a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x);
        xs.push({ x, dir: a.y < b.y ? 1 : -1 });
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p.x - q.x);
    let w = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      w += xs[k].dir;
      if (w !== 0) {
        const xa = Math.round(xs[k].x);
        const xb = Math.round(xs[k + 1].x);
        for (let x = xa; x < xb; x++) px(x, y, color);
      }
    }
  }
}

const s = (nn) => Math.round(nn * S);
const CLAY = [217, 119, 87, 255];

// Background: dark rounded square
roundRect(0, 0, W, H, s(52), [34, 37, 43, 255]);

// Claude spark, centered/upper
const boxSize = 132; // in 256-space
const ox = ((256 - boxSize) / 2) * S;
const oy = 30 * S;
fillPath(CLAUDE_PATH, ox, oy, (boxSize / 24) * S, CLAY);

// Session status dots (the "tabs" signature)
disc(s(96), s(214), s(11), [74, 222, 128, 255]);
disc(s(128), s(214), s(11), [245, 158, 11, 255]);
disc(s(160), s(214), s(11), [96, 165, 250, 255]);

// Downsample S x S -> 1
const out = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) {
      for (let sx = 0; sx < S; sx++) {
        const idx = ((y * S + sy) * W + (x * S + sx)) * 4;
        r += buf[idx]; g += buf[idx + 1]; b += buf[idx + 2]; a += buf[idx + 3];
      }
    }
    const nn = S * S;
    const o = (y * OUT + x) * 4;
    out[o] = r / nn; out[o + 1] = g / nn; out[o + 2] = b / nn; out[o + 3] = a / nn;
  }
}

// --- PNG encode ---
function crc32(b) {
  let c = ~0;
  for (let k = 0; k < b.length; k++) {
    c ^= b[k];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const raw = Buffer.alloc(OUT * (OUT * 4 + 1));
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0;
  out.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const dest = path.join(__dirname, '..', 'resources', 'icon.png');
fs.writeFileSync(dest, png);
console.log('wrote', dest, png.length, 'bytes');
