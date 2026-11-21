import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findBrowser, brandOf } from './card.js';
import { DEFAULT_CONFIG } from './score.js';

/**
 * Watermark «AI NEWS STUDIO» on pictures of the public channel (owner's decision of 30.10):
 * a yellow corner tag (on photos — bottom right, on cards — top right, so it does not cover the card's bottom brand line) + (for photos) a faint diagonal text pattern. Rendering — headless Chrome/Edge,
 * as in card.js; the result is a JPEG q≥0.92 (canvas → --dump-dom), proportions kept, long side ≤ 2048.
 */
export const MAX_SIDE = 2048;
export const JPEG_QUALITY = 0.92;
export const DIAGONAL_ALPHA = 0.09;

export class WatermarkError extends Error {
  constructor(code, message) { super(message); this.name = 'WatermarkError'; this.code = code; }
}

/** 'on' | 'off': an explicit config value, otherwise on (public channel). The personal feed and «Моя лента» (My feed) do not invoke the mark. */
export const watermarkModeOf = (config = DEFAULT_CONFIG) => (config?.watermark === 'off' ? 'off' : 'on');

/** Image size from the header: PNG, JPEG, WebP → { width, height } | null. */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return null;
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
    if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** Result size: same proportions, long side no more than MAX_SIDE. */
export function fitSize({ width, height }, max = MAX_SIDE) {
  const k = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

const MIME = (buf) => (buf[0] === 0xff ? 'image/jpeg' : buf[0] === 0x89 ? 'image/png' : 'image/webp');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * HTML page: the picture (data:) is drawn on a canvas together with the mark; the JPEG is put into <pre id="out">.
 * corner — the corner tag (always); diagonal — the pattern across the whole picture (photos only).
 */
export function watermarkHtml({ dataUri, width, height, brand, diagonal = true }) {
  const cfg = JSON.stringify({ width, height, brand, diagonal, top: !diagonal, alpha: DIAGONAL_ALPHA, q: JPEG_QUALITY });
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><pre id="out"></pre><script>
const C=${cfg};
const img=new Image();
img.onload=()=>{
  const cv=document.createElement('canvas');cv.width=C.width;cv.height=C.height;
  const g=cv.getContext('2d');
  g.drawImage(img,0,0,C.width,C.height);
  const u=Math.max(C.width,C.height)/1000;
  if(C.diagonal){
    g.save();g.translate(C.width/2,C.height/2);g.rotate(-Math.PI/6);
    g.font='bold '+Math.round(34*u)+'px "Segoe UI",Arial,sans-serif';g.textAlign='center';g.textBaseline='middle';
    const label=C.brand+'      ',w=g.measureText(label).width,step=Math.round(110*u),R=Math.hypot(C.width,C.height);
    let row=0;
    for(let y=-R;y<=R;y+=step,row++){
      for(let x=-R-(row%2?w/2:0);x<=R;x+=w){
        g.fillStyle='rgba(0,0,0,'+C.alpha*0.8+')';g.fillText(C.brand,x+Math.round(1.5*u),y+Math.round(1.5*u));
        g.fillStyle='rgba(255,255,255,'+C.alpha+')';g.fillText(C.brand,x,y);
      }
    }
    g.restore();
  }
  const fs=Math.round(26*u),padX=Math.round(16*u),padY=Math.round(9*u),m=Math.round(22*u);
  g.font='bold '+fs+'px "Segoe UI",Arial,sans-serif';g.textBaseline='middle';g.textAlign='left';
  const tw=g.measureText(C.brand).width,bw=tw+2*padX,bh=fs+2*padY;
  g.fillStyle='rgba(255,214,0,0.82)';
  const by=C.top?Math.round(44*u):C.height-m-bh;
  g.beginPath();g.roundRect(C.width-m-bw,by,bw,bh,Math.round(6*u));g.fill();
  g.fillStyle='rgba(20,20,20,0.92)';g.fillText(C.brand,C.width-m-bw+padX,by+bh/2+Math.round(1*u));
  document.getElementById('out').textContent=cv.toDataURL('image/jpeg',C.q);
};
img.onerror=()=>{document.getElementById('out').textContent='ERROR';};
img.src=${JSON.stringify(dataUri)};
</script><!--${esc(brand)}--></body></html>`;
}

const runDump = (cmd, args, timeout) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 200 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/** Extracts the JPEG from the DOM dump. null — no data. */
export function extractJpeg(dom) {
  const m = /<pre id="out">data:image\/jpeg;base64,([A-Za-z0-9+/=]+)<\/pre>/.exec(String(dom ?? ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  return buf.length > 100 && buf[0] === 0xff && buf[1] === 0xd8 ? buf : null;
}

/**
 * Apply the mark to a picture file. opts: { outFile, kind: 'photo'|'card', config, browser, exec }.
 * kind 'card' — the corner mark only. Returns { file, sha256, width, height }.
 * No browser / rendering failed — WatermarkError ('no-browser' | 'format' | 'render').
 */
export async function watermark(file, { outFile, kind = 'photo', config = DEFAULT_CONFIG, browser, exec = runDump, timeoutMs = 40000 } = {}) {
  const exe = browser === undefined ? findBrowser() : browser;
  if (!exe) throw new WatermarkError('no-browser', 'watermark: Chrome/Edge not found — install a browser or set CARD_BROWSER');
  if (!outFile) throw new WatermarkError('render', 'watermark: no output file set');
  let src;
  try { src = await readFile(file); } catch (e) { throw new WatermarkError('format', `watermark: cannot read file: ${e.message}`); }
  const size = imageSize(src);
  if (!size || !size.width || !size.height) throw new WatermarkError('format', 'watermark: cannot determine image size (jpg/png/webp required)');
  const out = fitSize(size);
  const tmp = await mkdtemp(join(tmpdir(), 'wm-'));
  try {
    const html = join(tmp, 'wm.html');
    await writeFile(html, watermarkHtml({ dataUri: `data:${MIME(src)};base64,${src.toString('base64')}`, ...out, brand: brandOf(config), diagonal: kind !== 'card' }), 'utf8');
    let jpeg = null;
    for (const mode of ['--headless', '--headless=new']) {
      try {
        const dom = await exec(exe, [mode, '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', `--user-data-dir=${join(tmp, 'profile')}`, `--window-size=${out.width},${out.height}`, '--virtual-time-budget=8000', '--dump-dom', pathToFileURL(html).href], timeoutMs);
        jpeg = extractJpeg(dom);
      } catch { jpeg = null; }
      const s = jpeg && imageSize(jpeg);
      if (s && s.width === out.width && s.height === out.height) break;
      jpeg = null;
    }
    if (!jpeg) throw new WatermarkError('render', 'watermark: browser did not return an image of the expected size');
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, jpeg);
    return { file: outFile, sha256: createHash('sha256').update(jpeg).digest('hex'), ...out };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * For publishing: file → file with the mark in <dir>/wm/<source sha + kind + brand>.jpg; it is not rendered again.
 * source 'card' — the corner mark only. The error is propagated (the caller does not send the original).
 */
export async function watermarkCached(file, { source = 'feed', dir = join(dirname(file), 'wm'), config = DEFAULT_CONFIG, ...rest } = {}) {
  const kind = source === 'card' ? 'card' : 'photo';
  let src;
  try { src = await readFile(file); } catch (e) { throw new WatermarkError('format', `watermark: cannot read file: ${e.message}`); }
  const sha = createHash('sha256').update(src).update(`|${kind}|${brandOf(config)}|v1`).digest('hex').slice(0, 32);
  const outFile = join(dir, `${sha}.jpg`);
  if (existsSync(outFile)) return { file: outFile, cached: true };
  return { ...(await watermark(file, { ...rest, outFile, kind, config })), cached: false };
}
