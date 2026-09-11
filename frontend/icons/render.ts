/**
 * Renders the icon sources in this directory into the PNGs the manifest ships.
 *
 *   bun run icons/render.ts
 *
 * Run it after editing an SVG here; the PNGs under public/ are committed so a
 * plain `bun run build` needs neither a browser nor an image library. The
 * renderer is a headless Brave screenshot rather than a raster dependency —
 * puppeteer-core is already here for the browser suite, and one more runtime
 * package to redraw a tick is not a trade worth making.
 *
 * Brave is located here rather than through tests/helpers/browser.ts on
 * purpose: a build tool that breaks when the test suite is refactored is a
 * dependency pointing the wrong way.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const BRAVE = [
  process.env.BRAVE_PATH,
  '/usr/bin/brave-browser',
  '/opt/brave.com/brave/brave',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/brave',
].filter(Boolean) as string[];

/** source, output, and the sizes that output is wanted at. */
const JOBS: Array<{ svg: string; name: string; sizes: number[] }> = [
  // 192 and 512 are what Chrome checks for before it will offer an install.
  { svg: 'icon.svg', name: 'icon', sizes: [192, 512] },
  { svg: 'icon-maskable.svg', name: 'icon-maskable', sizes: [192, 512] },
  // iOS reads one link tag and ignores the manifest, and 180 is what a modern
  // iPhone asks for.
  { svg: 'icon-apple.svg', name: 'apple-touch-icon', sizes: [180] },
];

const executablePath = BRAVE.find((path) => existsSync(path));
if (!executablePath) throw new Error(`Brave was not found. Tried:\n  ${BRAVE.join('\n  ')}`);

await mkdir('public/icons', { recursive: true });

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-brave-update'],
});
const page = await browser.newPage();

for (const job of JOBS) {
  const svg = await Bun.file(`icons/${job.svg}`).text();
  for (const size of job.sizes) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    // the source carries its own width and height at 512; the wrapper overrides
    // both so the vector redraws at the target size instead of being scaled.
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:transparent}` +
        `svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
      { waitUntil: 'load' },
    );
    const out = `public/icons/${job.name}-${size}.png`;
    // omitBackground keeps the transparent corners of the non-maskable icon;
    // the full-bleed ones have nothing to show through.
    await page.screenshot({ path: out, type: 'png', omitBackground: true });
    console.log(`${out}  ${(Bun.file(out).size / 1024).toFixed(1)} kB`);
  }
}

await browser.close();
