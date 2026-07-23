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
        };
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
          console.warn(
            `    ⚠  multiplayer relay not started (run \`npm install\` in server/): ${err.message}\n`
          );
        }
      },
    },
  ],
});