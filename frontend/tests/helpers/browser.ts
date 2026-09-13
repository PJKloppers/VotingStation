import { existsSync } from 'node:fs';
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer-core';

/** Where Brave lives, in the order worth trying. */
const CANDIDATES = [
  process.env.BRAVE_PATH,
  '/usr/bin/brave-browser',
  '/opt/brave.com/brave/brave',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/brave',
].filter(Boolean) as string[];

export function braveExecutable(): string {
  const found = CANDIDATES.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `Brave was not found. Tried:\n  ${CANDIDATES.join('\n  ')}\nSet BRAVE_PATH to its location.`,
    );
  }
  return found;
}

export async function launchBrave(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: braveExecutable(),
    headless: process.env.HEADED !== '1',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Brave's own services have nothing to do with the test and only slow it down.
      '--disable-brave-update',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
}

/** Serves a directory the way a static host would, on a free port. */
export function serveStatic(dir: string) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      for (const candidate of [`${dir}${path}`, `${dir}${path}/index.html`, `${dir}/index.html`]) {
        const file = Bun.file(candidate);
        if (await file.exists()) return new Response(file);
      }
      return new Response('Not found', { status: 404 });
    },
  });
  return { server, origin: `http://localhost:${server.port}` };
}

/**
 * Clicks a control inside the one container that mentions something.
 *
 * A page listing several questions has several Edit buttons, and "the first
 * one" is a test that passes for the wrong reason the moment the order
 * changes. This says which card is meant.
 */
export async function clickWithin(
  page: Page, container: string, containing: string, control: string, text: string,
  timeout = 15000,
): Promise<void> {
  const handle = await page.waitForFunction(
    (sel: string, needle: string, ctrl: string, label: string) => {
      const box = [...document.querySelectorAll(sel)].find((el) =>
        (el as HTMLElement).innerText.toLowerCase().includes(needle.toLowerCase()));
      if (!box) return false;
      return [...box.querySelectorAll(ctrl)].find((el) =>
        (el as HTMLElement).innerText.trim().toLowerCase().includes(label.toLowerCase())) ?? false;
    },
    { timeout, polling: 200 },
    container, containing, control, text,
  );
  const element = handle.asElement() as ElementHandle<Element> | null;
  if (!element) {
    throw new Error(`No ${control} reading "${text}" inside a ${container} about "${containing}".`);
  }
  await element.click();
}

/**
 * Waits for text to appear anywhere on the page, ignoring case.
 *
 * Case matters here: `innerText` reports what is rendered, and the pills are
 * uppercased in CSS -- so a page reading "Carried" answers with "CARRIED".
 */
export async function waitForText(page: Page, text: string, timeout = 15000): Promise<void> {
  await page.waitForFunction(
    (needle: string) =>
      (document.body?.innerText ?? '').toLowerCase().includes(needle.toLowerCase()),
    { timeout, polling: 200 },
    text,
  );
}

/**
 * Types a PIN into the voter's box.
 *
 * The ballot is fetched after React mounts, so the box does not exist when the
 * document finishes loading -- and on a hash-only navigation there is no
 * document load to wait for at all.
 */
export async function enterPin(page: Page, pin: string): Promise<void> {
  await page.waitForSelector('.pin-entry', { timeout: 15000 });
  await page.type('.pin-entry', pin);
}

/**
 * Clicks the first element whose text matches, within a selector, waiting for
 * it to appear.
 *
 * Waiting is the point. Nearly every control here shows up only after a fetch
 * resolves, and a click that fails the instant the page is not ready yet tells
 * you nothing about why.
 */
export async function clickByText(
  page: Page, selector: string, text: string, timeout = 15000,
): Promise<void> {
  const handle = await page.waitForFunction(
    (sel: string, needle: string) =>
      [...document.querySelectorAll(sel)].find((el) =>
        (el as HTMLElement).innerText.trim().toLowerCase().includes(needle.toLowerCase()))
      ?? false,
    { timeout, polling: 200 },
    selector, text,
  );
  const element = handle.asElement() as ElementHandle<Element> | null;
  if (!element) throw new Error(`No ${selector} reading "${text}".`);
  await element.click();
}

/**
 * Reads a Code 128 barcode out of a PNG.
 *
 * ZXing rather than our own encoder run backwards: a table copied wrongly into
 * `lib/barcode.ts` would otherwise agree with itself and the test would pass on
 * a barcode no scanner in the world could read.
 *
 * Given a Uint8ClampedArray, ZXing's RGBLuminanceSource takes the values as
 * luminance already computed -- one byte a pixel, not four.
 */
export async function decodeBarcode(png: { data: Buffer; width: number; height: number }):
  Promise<string | null> {
  const {
    MultiFormatOneDReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource,
    DecodeHintType, BarcodeFormat,
  } = await import('@zxing/library');

  const luminances = new Uint8ClampedArray(png.width * png.height);
  for (let i = 0; i < luminances.length; i++) {
    luminances[i] = (png.data[i * 4]! * 306 + png.data[i * 4 + 1]! * 601
                     + png.data[i * 4 + 2]! * 117) >> 10;
  }

  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]);
  hints.set(DecodeHintType.TRY_HARDER, true);

  /*
   * Upright and on its side. RGBLuminanceSource reports no rotation support,
   * so ZXing will not try the other way round by itself -- and the barcode on a
   * slip is printed standing up. A real scanner does not care which way the
   * paper is held, so neither does this.
   */
  const turned = new Uint8ClampedArray(luminances.length);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      // (x, y) -> (height - 1 - y, x) in an image that is height wide
      turned[x * png.height + (png.height - 1 - y)] = luminances[y * png.width + x]!;
    }
  }

  const tries: Array<[Uint8ClampedArray, number, number]> = [
    [luminances, png.width, png.height],
    [turned, png.height, png.width],
  ];
  for (const [pixels, w, h] of tries) {
    try {
      const bitmap = new BinaryBitmap(new HybridBinarizer(
        new RGBLuminanceSource(pixels, w, h)));
      return new MultiFormatOneDReader(hints).decode(bitmap, hints).getText();
    } catch {
      // not this way up
    }
  }
  return null;
}
