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

/** Clicks the first element whose text matches, within a selector. */
export async function clickByText(page: Page, selector: string, text: string): Promise<void> {
  const handle = await page.evaluateHandle(
    (sel: string, needle: string) =>
      [...document.querySelectorAll(sel)].find((el) =>
        (el as HTMLElement).innerText.trim().toLowerCase().includes(needle.toLowerCase())) ?? null,
    selector, text,
  );
  const element = handle.asElement() as ElementHandle<Element> | null;
  if (!element) throw new Error(`No ${selector} reading "${text}".`);
  await element.click();
}
