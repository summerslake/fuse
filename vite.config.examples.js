import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: 'examples',
  base: './',
  publicDir: path.resolve(import.meta.dirname, 'public'),
  resolve: {
    alias: {
      '@opengolfsim/fuse': path.resolve(import.meta.dirname, 'src/index.ts'),
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    proxy: {
      /**
       * OGS Desktop derives its entire API base from `app_url`
       * (`api_url = ${app_url}/api`), so pointing OGS_APP_URL at this dev server
       * also repoints sign-in, the course library, the store and analytics —
       * which we don't serve, leaving Desktop offline with an empty library.
       * Pass all of that through to the real server; only `/fuse/**` is ours.
       */
      '^/api/': {
        target: 'https://app.opengolfsim.com',
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: true,
    outDir: path.resolve(import.meta.dirname, 'dist/examples'),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'examples/index.html'),
        range: path.resolve(import.meta.dirname, 'examples/range/index.html'),
        courses: path.resolve(import.meta.dirname, 'examples/courses/index.html'),
        cornhole: path.resolve(import.meta.dirname, 'examples/cornhole/index.html'),
        diagnostics: path.resolve(import.meta.dirname, 'examples/diagnostics/index.html'),
      },
    },
  },
  plugins: [
    {
      name: 'custom-cli-message',
      configureServer(server) {
        const _print = server.printUrls;
        server.printUrls = () => {
          console.log('\n    FUSE Examples running\n');
          _print();
          // NB: use `open --env`, not a direct binary launch — running the
          // executable from a terminal loses the bundle's TCC grants, and the
          // Square plugin then can't reach Bluetooth ("Noble powered on" timeout).
          console.log(
            `    OGS Desktop:  open --env OGS_APP_URL=http://localhost:${server.config.server.port ?? 5173} -a "/Applications/OpenGolfSim.app"` +
              (process.env.OGS_DIAG === '1'
                ? '\n    OGS_DIAG=1 — every game Desktop launches will serve the diagnostics page\n'
                : '\n    (set OGS_DIAG=1 to serve the diagnostics page instead of the game)\n')
          );
        };
      },
    },
    {
      /**
       * Let OGS Desktop load this dev server. Desktop launches games from
       * `${app_url}/fuse/examples/<game>/index.html`, but our root is `examples/`,
       * so those requests 404 without a rewrite. With OGS_DIAG=1 every game it
       * launches serves the diagnostics page instead — that's the spike: point
       * Desktop here, launch anything, read the screen.
       */
      name: 'ogs-desktop-compat',
      configureServer(server) {
        const diagnostics = process.env.OGS_DIAG === '1';
        server.middlewares.use((req, res, next) => {
          if (!req.url) return next();
          if (req.url.startsWith('/fuse/examples/')) {
            req.url = req.url.slice('/fuse/examples'.length);
          } else if (req.url.startsWith('/fuse/')) {
            req.url = req.url.slice('/fuse'.length);
          }
          // Only the game entry pages, never assets or the diagnostics page
          // itself. Redirect rather than rewrite so the browser's base URL moves
          // too — the page's relative script/asset paths depend on it.
          if (
            diagnostics &&
            !req.url.startsWith('/diagnostics/') &&
            /^\/[^/]+\/index\.html(\?|$)/.test(req.url)
          ) {
            res.writeHead(302, { Location: '/diagnostics/index.html' });
            return res.end();
          }
          next();
        });
      },
    },
    {
      // Host the multiplayer relay in-process, so `npm run dev` both serves the
      // game and hosts the room. Fails soft if server/ deps aren't installed.
      name: 'ogs-mp-relay',
      async configureServer(server) {
        const port = Number(process.env.OGS_MP_PORT || 8080);
        const secret = process.env.OGS_MP_SECRET || '';
        try {
          const { createRelay } = await import('./server/relay.js');
          const relay = createRelay({ port, secret });
          await relay.ready;
          server.httpServer?.once('close', () => relay.close());
          console.log(
            `    Multiplayer relay: ws://localhost:${port}` +
              (secret ? '' : '  (no OGS_MP_SECRET — LAN/dev only)') +
              '\n'
          );
        } catch (err) {
          // Be specific: a config edit restarts vite while the old process still
          // holds the port, and the relay then silently isn't there — which looks
          // exactly like a blocked WebSocket from the client side.
          const hint =
            err.code === 'EADDRINUSE'
              ? `port ${port} is already in use — another dev server or relay is still running.\n` +
                `       Multiplayer will NOT work until that is freed:  lsof -nP -iTCP:${port} -sTCP:LISTEN`
              : `${err.message} (if this is a missing module, run \`npm install\` in server/)`;
          console.warn(`\n    ⚠  MULTIPLAYER RELAY NOT STARTED — ${hint}\n`);
        }
      },
    },
  ],
});