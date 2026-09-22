#!/usr/bin/env node
/*
 * render.mjs – rendert die Ads aus index.html als MP4 (H.264, yuv420p, 30 fps).
 *
 *   node render.mjs                 alle Ads → out/<id>.mp4
 *   node render.mjs intro           nur eine Ad
 *   node render.mjs --stills        alle 0,5 s ein PNG → out/stills/<id>/ (zur schnellen Sichtkontrolle)
 *
 * Optionen: --fps 30  --crf 17  --every 0.5  --out <ordner>  --scale 2 (2160x3840)
 * ffmpeg: $FFMPEG_PATH, sonst ffmpeg-static (npm), sonst "ffmpeg" im PATH.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const HELP = `Nutzung: node render.mjs [ad-id ...] [--stills] [--fps 30] [--crf 17] [--every 0.5] [--out ordner] [--scale 1]`;
const opt = { ids: [], fps: 0, crf: 17, stills: false, every: 0.5, out: path.join(here, 'out'), scale: 1 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--fps') opt.fps = +argv[++i];
  else if (a === '--crf') opt.crf = +argv[++i];
  else if (a === '--stills') opt.stills = true;
  else if (a === '--every') opt.every = +argv[++i];
  else if (a === '--out') opt.out = path.resolve(argv[++i]);
  else if (a === '--scale') opt.scale = +argv[++i];
  else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
  else if (a.startsWith('--')) { console.error('Unbekannte Option ' + a + '\n' + HELP); process.exit(1); }
  else opt.ids.push(a);
}

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { return require('ffmpeg-static'); } catch { /* nicht installiert */ }
  return 'ffmpeg';
}

async function renderVideo(page, id, total, fps, size) {
  fs.mkdirSync(opt.out, { recursive: true });
  const file = path.join(opt.out, `${id}.mp4`);
  const frames = Math.round(total * fps);
  const ff = spawn(ffmpegPath(), [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(opt.crf),
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.2',
    '-movflags', '+faststart', '-r', String(fps),
    file,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  let failed = null;
  ff.stdin.on('error', e => { failed = e; });
  const done = new Promise((res, rej) => {
    ff.on('error', rej);
    ff.on('close', code => (code === 0 ? res() : rej(new Error(`ffmpeg beendet mit Code ${code}`))));
  });
  const t0 = Date.now();
  for (let i = 0; i < frames && !failed; i++) {
    await page.evaluate(t => window.__seek(t), i / fps);
    const png = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % fps === 0) process.stdout.write(`\r${id}: ${Math.round(i / fps)} s / ${total.toFixed(1)} s`);
  }
  ff.stdin.end();
  await done;
  const mb = (fs.statSync(file).size / 1e6).toFixed(1);
  console.log(`\r${id}: ${frames} Frames, ${size.w * opt.scale}x${size.h * opt.scale}, ${total.toFixed(1)} s → ${path.relative(process.cwd(), file)} (${mb} MB, ${Math.round((Date.now() - t0) / 1000)} s)`);
}

async function renderStills(page, id, total) {
  const dir = path.join(opt.out, 'stills', id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (let t = 0; t <= total + 1e-6; t += opt.every, n++) {
    await page.evaluate(t => window.__seek(t), Math.min(t, total));
    await page.screenshot({ path: path.join(dir, `${String(n).padStart(3, '0')}_${t.toFixed(1)}s.png`), type: 'png' });
  }
  console.log(`${id}: ${n} Stills → ${path.relative(process.cwd(), dir)}`);
}

async function main() {
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: opt.scale });
  page.on('pageerror', e => { console.error('Seitenfehler:', e.message); process.exitCode = 1; });
  const base = pathToFileURL(path.join(here, 'index.html')).href;
  await page.goto(base + '?render=1');
  const all = await page.evaluate(() => Object.keys(ADS));
  const ids = opt.ids.length ? opt.ids : all;
  try {
    for (const id of ids) {
      if (!all.includes(id)) {
        console.error(`Unbekannte Ad "${id}". Verfügbar: ${all.join(', ')}`);
        process.exitCode = 1;
        continue;
      }
      await page.goto(`${base}?ad=${encodeURIComponent(id)}&render=1`);
      await page.evaluate(() => window.__ready);
      const { total, fps, size } = await page.evaluate(() => ({ total: window.__total, fps: window.__fps, size: window.__size }));
      await page.setViewportSize({ width: size.w, height: size.h });
      if (opt.stills) await renderStills(page, id, total);
      else await renderVideo(page, id, total, opt.fps || fps, size);
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
