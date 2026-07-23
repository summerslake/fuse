import { createRelay } from './relay.js';

// Standalone entry: `npm run server` (or `node index.js [port] [secret]`).
// The in-process vite plugin uses createRelay directly instead.
const port = Number(process.env.OGS_MP_PORT || process.argv[2] || 8080);
const secret = process.env.OGS_MP_SECRET || process.argv[3] || '';

const relay = createRelay({ port, secret });

relay.ready
  .then(() => {
    console.log(`OGS multiplayer relay listening on ws://0.0.0.0:${port}`);
    if (!secret) {
      console.log('  ⚠  no room secret set (OGS_MP_SECRET) — fine for LAN/dev, set one before exposing to the internet');
    }
  })
  .catch((err) => {
    console.error(`Failed to start relay on port ${port}: ${err.message}`);
    process.exit(1);
  });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await relay.close();
    process.exit(0);
  });
}
