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
    configure: (proxy) => {
      // One readable line instead of a TLS stack trace per failed request —
      // when the connection is down this fires several times a second.
      proxy.on('error', (err, _req, res) => {
        console.warn(`    ⚠  OpenGolfSim API unreachable: ${err.code || err.message}`);
        if (typeof res?.writeHead !== 'function' || res.headersSent) return;
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end('{"error":"OpenGolfSim API unreachable from the host"}');
      });
    },
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
  let body = { courses: [] };
  try {
    const response = await fetch(upstream, { headers: { accept: 'application/json' } });
    body = await response.json();
  } catch (err) {
    // No internet, or something intercepting TLS (a dropped connection often
    // surfaces as "certificate has expired"). Still serve our own tile: the
    // relay and the game build are local, so multiplayer shouldn't vanish just
    // because OpenGolfSim's servers are unreachable.
    console.warn(
      `    ⚠  OpenGolfSim API unreachable (${err.cause?.code || err.message}) — serving the Multiplayer tile only.\n` +
        '       Sign-in, the full library and first-time course downloads need internet.\n'
    );
  }
  body.courses = [MULTIPLAYER_TILE, ...(body.courses ?? [])];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function desktopCompat(server) {
  const diagnostics = process.env.OGS_DIAG === '1';
  server.middlewares.use((req, res, next) => {
    if (!req.url) return next();

    // Log what the host app actually asks for. Different OpenGolfSim versions
    // call different endpoints, and "the Multiplayer tile didn't appear" is
    // otherwise indistinguishable between "it never reached us", "it asked a
    // library endpoint we don't inject into", and "it ignored our entry".
    if (req.url.startsWith('/api/')) {
      console.log(`    [api] ${req.method} ${req.url.split('?')[0]}`);
    }

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

/**
 * Startup banner. Prints the command to launch your own Desktop against this
 * server, and — since a remote guest needs an address you can't see from the
 * Local/Network lines — looks up the public IP and prints the exact command to
 * send them.
 */
function printBanner(server) {
  const port = server.config.preview?.port ?? server.config.server?.port ?? 5173;
  const _print = server.printUrls.bind(server);
  server.printUrls = () => {
    console.log('\n    FUSE Examples running\n');
    _print();
    // NB: use `open --env`, not a direct binary launch — running the executable
    // from a terminal loses the bundle's TCC grants, and the Square plugin then
    // can't reach Bluetooth ("Noble powered on" timeout).
    console.log(
      `    You:    open --env OGS_APP_URL=http://localhost:${port} -a "/Applications/OpenGolfSim.app"` +
        (process.env.OGS_DIAG === '1'
          ? '\n    OGS_DIAG=1 — every game Desktop launches will serve the diagnostics page'
          : '')
    );
    printGuestCommand(port);
  };
}

/** Look up the public IP so you can tell a remote guest where to point. */
async function printGuestCommand(port) {
  try {
    const response = await fetch('https://ifconfig.me/ip', { signal: AbortSignal.timeout(4000) });
    const ip = (await response.text()).trim();
    if (!/^[0-9a-fA-F.:]+$/.test(ip)) throw new Error(`unexpected response`);
    console.log(
      `    Guest:  open --env OGS_APP_URL=http://${ip}:${port} -a "/Applications/OpenGolfSim.app"\n` +
        `            (needs TCP ${port} and 8080 forwarded to this machine)\n`
    );
  } catch (err) {
    console.log(
      `    Guest:  public IP lookup failed (${err.message}) — LAN play is unaffected;\n` +
        '            use the Network address above.\n'
    );
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
      configureServer: printBanner,
      // `npm run host` runs preview, which never got the banner at all
      configurePreviewServer: printBanner,
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