import { defineConfig } from 'vite';
import path from 'path';

/**
 * Everything OGS Desktop needs from whatever server we point `app_url` at.
 * Shared by `vite dev` and `vite preview`, because the built bundle is the
 * interesting case: Desktop's Electron renderer runs the hosted (built) fuse
 * fine, so `preview` is how we test a production bundle under Desktop.
 */
const desktopProxy = {
  /**
   * Desktop derives its entire API base from `app_url`
   * (`api_url = ${app_url}/api`), so pointing OGS_APP_URL here also repoints
   * sign-in, the course library, the store and analytics — which we don't serve,
   * leaving Desktop offline with an empty library. Pass those through; only
   * `/fuse/**` is ours.
   */
  '^/api/': {
    target: 'https://app.opengolfsim.com',
    changeOrigin: true,
  },
};

/**
 * Desktop launches games from `${app_url}/fuse/examples/<game>/index.html`, but
 * our root is `examples/`, so strip that prefix. With OGS_DIAG=1 every game it
 * launches redirects to the diagnostics page instead — that's the spike.
 */
/**
 * OGS Desktop builds its library from `${app_url}/api/courses/home`, which we
 * proxy — so we can hand it one extra tile. "Multiplayer" launches our lobby
 * entry page with no course attached; the lobby picks the course itself, which
 * is why this entry deliberately has no `courseUrl`.
 *
 * This is the only way in: Desktop is closed source, so the library can't be
 * extended from inside. It costs nothing when OGS_APP_URL isn't pointed here.
 */
const MULTIPLAYER_TILE = {
  title: 'Multiplayer',
  description: 'Play a round with a friend — pick the course in the lobby',
  url: '/fuse/examples/multiplayer/index.html',
  gameMode: 2,
  engine: 2,
  posterUrl: 'https://coursedata.opengolfsim.com/webgl/courses/mountain-vista/v1/mountain-vista-poster.jpg',
  slug: 'fuse_multiplayer',
  gameEngine: 'webgl',
};

async function serveLibraryWithMultiplayer(req, res) {
  const upstream = new URL(req.url, 'https://app.opengolfsim.com');
  const response = await fetch(upstream, { headers: { accept: 'application/json' } });
  const body = await response.json();
  body.courses = [MULTIPLAYER_TILE, ...(body.courses ?? [])];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function desktopCompat(server) {
  const diagnostics = process.env.OGS_DIAG === '1';
  server.middlewares.use((req, res, next) => {
    if (!req.url) return next();

    // Add our tile to the library on its way through. Everything else under
    // /api is proxied untouched.
    if (req.url.startsWith('/api/courses/home')) {
      return serveLibraryWithMultiplayer(req, res).catch(() => next());
    }
    if (req.url.startsWith('/fuse/examples/')) {
      req.url = req.url.slice('/fuse/examples'.length);
    } else if (req.url.startsWith('/fuse/')) {
      req.url = req.url.slice('/fuse'.length);
    }
    // Only the game entry pages, never assets or the diagnostics page itself.
    // Redirect rather than rewrite so the browser's base URL moves too — the
    // page's relative script/asset paths depend on it.
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
}

/** Host the multiplayer relay in-process, so one command serves game + room. */
async function startRelay() {
  const port = Number(process.env.OGS_MP_PORT || 8080);
  const secret = process.env.OGS_MP_SECRET || '';
  try {
    const { createRelay } = await import('./server/relay.js');
    const relay = createRelay({ port, secret });
    await relay.ready;
    console.log(
      `    Multiplayer relay: ws://localhost:${port}` +
        (secret ? '' : '  (no OGS_MP_SECRET — LAN/dev only)') +
        '\n'
    );
    return relay;
  } catch (err) {
    // Be specific: a config edit restarts vite while the old process still holds
    // the port, and the relay then silently isn't there — which looks exactly
    // like a blocked WebSocket from the client side.
    const hint =
      err.code === 'EADDRINUSE'
        ? `port ${port} is already in use — another dev server or relay is still running.\n` +
          `       Multiplayer will NOT work until that is freed:  lsof -nP -iTCP:${port} -sTCP:LISTEN`
        : `${err.message} (if this is a missing module, run \`npm install\` in server/)`;
    console.warn(`\n    ⚠  MULTIPLAYER RELAY NOT STARTED — ${hint}\n`);
    return undefined;
  }
}

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
  server: { proxy: desktopProxy },
  preview: { port: 5173, proxy: desktopProxy },
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
        multiplayer: path.resolve(import.meta.dirname, 'examples/multiplayer/index.html'),
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
      configureServer: desktopCompat,
      configurePreviewServer: desktopCompat,
    },
    {
      // Host the multiplayer relay in-process, so `npm run dev` both serves the
      // game and hosts the room. Fails soft if server/ deps aren't installed.
      name: 'ogs-mp-relay',
      async configureServer(server) {
        const relay = await startRelay();
        if (relay) server.httpServer?.once('close', () => relay.close());
      },
      async configurePreviewServer(server) {
        const relay = await startRelay();
        if (relay) server.httpServer?.once('close', () => relay.close());
      },
    },
  ],
});