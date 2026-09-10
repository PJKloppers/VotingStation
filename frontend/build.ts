/**
 * The compiler.
 *
 * `bun build` takes the HTML entry point, follows it into the TSX and the CSS,
 * and writes a directory of hashed static files. `publicPath: './'` keeps every
 * reference relative, so the same build works at the domain root and under the
 * /VotingStation/ prefix GitHub Pages serves it from.
 */
import { rm } from 'node:fs/promises';

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

const result = await Bun.build({
  entrypoints: ['src/index.html'],
  outdir: 'dist',
  target: 'browser',
  minify: !dev,
  sourcemap: dev ? 'inline' : 'none',
  publicPath: './',
  define,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// GitHub Pages serves 404.html for unknown paths. Ours is the app itself, so a
// deep link that skips the hash still lands somewhere useful.
await Bun.write('dist/404.html', await Bun.file('dist/index.html').text());
// Pages runs Jekyll otherwise, which drops files beginning with an underscore.
await Bun.write('dist/.nojekyll', '');

const total = result.outputs.reduce((n, o) => n + o.size, 0);
console.log(
  `built ${result.outputs.length} files, ${(total / 1024).toFixed(0)} kB` +
    (dev ? ' (dev)' : ''),
);
