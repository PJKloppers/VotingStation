/** Serves dist/ for local testing, the way a static host would. */
const dir = 'dist';
const port = Number(process.env.PORT ?? 4173);

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);
    const candidates = [`${dir}${path}`, `${dir}${path}/index.html`, `${dir}/index.html`];
    for (const candidate of candidates) {
      const file = Bun.file(candidate);
      if (await file.exists()) return new Response(file);
    }
    return new Response('Not found', { status: 404 });
  },
});

console.log(`serving ${dir} on http://localhost:${port}`);
