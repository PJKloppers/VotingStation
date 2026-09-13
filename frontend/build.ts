/**
 * The compiler.
 *
 * `bun build` takes the HTML entry point, follows it into the TSX and the CSS,
 * and writes a directory of hashed static files. `publicPath: './'` keeps every
 * reference relative, so the same build works at the domain root and under the
 * /VotingStation/ prefix GitHub Pages serves it from.
 *
 * `public/` is copied over the top of that, unhashed and unrenamed, for the
 * files whose names other things already know: the web app manifest and its
 * icons.
 */
import { cp, rm } from 'node:fs/promises';

const DEFAULTS = {
  SUPABASE_URL: 'https://ukkgodlkxoyilyagtttj.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_Tv9rORiv-iZfpcRDLaSdjg_Dk6FiRcO',
};

const dev = process.argv.includes('--dev');

const define: Record<string, string> = Object.fromEntries(
  Object.entries(DEFAULTS).map(([key, fallback]) => [
    `process.env.${key}`,
    // an unset repository variable arrives as an empty string, not as undefined
    JSON.stringify(process.env[key] || fallback),
  ]),
);
// React ships both builds behind this check; without it the bundle carries the
// development one, warnings, dev tooling and all.
define['process.env.NODE_ENV'] = JSON.stringify(dev ? 'development' : 'production');

await rm('dist', { recursive: true, force: true });

/**
 * Keeps the PWA tags out of the bundler's hands.
 *
 * Bun's HTML loader does follow `<link rel="manifest">` and
 * `<link rel="apple-touch-icon">` -- it fails the build outright when it cannot
 * resolve them -- and would otherwise emit them under hashed names. That is
 * wrong for both: the manifest's own `icons[].src` entries are JSON the
 * bundler never reads, so a hashed icon leaves the manifest pointing at
 * nothing, and iOS wants one predictable apple-touch-icon. Marked external,
 * the hrefs pass through verbatim and `public/` supplies the files.
 */
const passThrough: import('bun').BunPlugin = {
  name: 'pwa-assets',
  setup(build) {
    build.onResolve({ filter: /^\.\/(manifest\.webmanifest|icons\/)/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

const result = await Bun.build({
  entrypoints: ['src/index.html'],
  outdir: 'dist',
  target: 'browser',
  minify: !dev,
  // Without this a dynamic import is inlined and the lazy chunk is a lie: the
  // scanner and its decoder would ship to every voter who types a link.
  splitting: true,
  sourcemap: dev ? 'inline' : 'none',
  publicPath: './',
  define,
  plugins: [passThrough],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Everything in public/ ships byte for byte under the name it already has:
// the manifest, and the icons the manifest and the iOS tag name. Their paths
// are relative throughout -- `start_url` and `scope` are "./", resolved
// against the manifest's own URL -- so the same files install from the domain
// root and from under /VotingStation/. `id` is deliberately absent, because it
// resolves against the origin rather than the manifest and any value we could
// write would pin the app to one of those two.
await cp('public', 'dist', { recursive: true });

// A manifest whose icons 404 is not an invalid manifest; the browser simply
// declines to offer an install and says nothing. Cheaper to find here.
const manifest = await Bun.file('dist/manifest.webmanifest').json();
for (const icon of manifest.icons as Array<{ src: string }>) {
  const file = `dist/${icon.src.replace(/^\.\//, '')}`;
  if (!(await Bun.file(file).exists())) {
    console.error(`manifest names ${icon.src}, which is not in dist/`);
    process.exit(1);
  }
}

// GitHub Pages serves 404.html for unknown paths. Ours is the app itself, so a
// deep link that skips the hash still lands somewhere useful -- and it is what
// makes /privacy-and-terms-of-service a real path rather than a fragment, which
// is what a Google OAuth reviewer has to be given. The router reads the route
// back off location.pathname; see lib/router.ts. Written without a trailing
// slash on purpose: publicPath is './', so the route must stay one segment deep
// off the deploy root or the asset paths resolve a directory too far down.
await Bun.write('dist/404.html', await Bun.file('dist/index.html').text());
// Pages runs Jekyll otherwise, which drops files beginning with an underscore.
await Bun.write('dist/.nojekyll', '');

const total = result.outputs.reduce((n, o) => n + o.size, 0);
console.log(
  `built ${result.outputs.length} files, ${(total / 1024).toFixed(0)} kB` +
    (dev ? ' (dev)' : ''),
);
