#!/usr/bin/env node
/**
 * Install our tiles into OGS Desktop's Custom Games (1.21+): "Multiplayer",
 * plus one per local course the host serves (courses.local.json).
 *
 *   node scripts/install-desktop-launcher.mjs http://68.249.176.21:5173
 *
 * Desktop lists every folder in <userData>/fuse/ that has an index.html and a
 * game.json. Ours just forward the game window to a page on the host, so
 * Desktop runs normally — no OGS_APP_URL, no special launch. The host must be
 * running (npm run dev / npm run host) so we can ask it for its course list.
 * Restart Desktop to see the tiles. Re-run to pick up new courses or a new
 * host; delete the folders to remove them.
 *
 * For a guest, build the folders somewhere else instead and send them over:
 *
 *   node scripts/install-desktop-launcher.mjs http://<public-ip>:5173 \
 *     --out ./guest-tiles --source http://localhost:5173
 *
 * --source is where to read the course list from (your own machine often
 * can't reach itself on its public address); the tiles still point at <host>.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const outDir = option('--out');
const sourceArg = option('--source');
const host = (args[0] || 'http://localhost:5173').replace(/\/+$/, '');
const listFrom = (sourceArg || host).replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(host)) {
  console.error(`Expected a host like http://1.2.3.4:5173, got "${host}"`);
  process.exit(1);
}

const userData =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Application Support/opengolfsim-desktop')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'opengolfsim-desktop')
      : path.join(os.homedir(), '.config/opengolfsim-desktop');
if (!outDir && !fs.existsSync(userData)) {
  console.error(`OGS Desktop's data folder isn't at ${userData} — is Desktop installed and opened once?`);
  process.exit(1);
}

const source = path.join(path.dirname(fileURLToPath(import.meta.url)), '../desktop-launcher');
const template = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
const defaultPoster = fs.readFileSync(path.join(source, 'poster.jpg'));
const gamesDir = outDir ? path.resolve(outDir) : path.join(userData, 'fuse');
const PREFIX = 'fuse-';

// The host's lobby list carries its local courses (slug local_*) with
// host-relative course paths — the same names the lobby uses, so a room
// started from a tile matches one started from the picker.
let catalog;
try {
  const res = await fetch(`${listFrom}/api/courses/home?platform=darwin&fuse=1`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  catalog = (await res.json()).courses ?? [];
} catch (err) {
  console.error(`Couldn't get the course list from ${listFrom} (${err.message}). Is the host running?`);
  process.exit(1);
}

const tiles = [
  { folder: `${PREFIX}multiplayer`, name: 'Multiplayer', page: '/fuse/examples/multiplayer/index.html' },
  ...catalog
    .filter((c) => c.slug?.startsWith('local_') && c.courseUrl)
    .map((c) => ({
      folder: `${PREFIX}${c.slug.replace(/_/g, '-')}`,
      name: c.title,
      page: `/fuse/examples/courses/index.html?courseUrl=${encodeURIComponent(c.courseUrl)}`,
      poster: c.posterUrl?.startsWith('/') ? `${listFrom}${c.posterUrl}` : undefined,
    })),
];

fs.mkdirSync(gamesDir, { recursive: true });
for (const tile of tiles) {
  const dir = path.join(gamesDir, tile.folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), template.replace('__HOST__', host).replace('__PATH__', tile.page));
  fs.writeFileSync(
    path.join(dir, 'game.json'),
    JSON.stringify({ name: tile.name, author: `Host ${new URL(host).host}` }, null, 2) + '\n'
  );
  let poster = defaultPoster;
  if (tile.poster) {
    const res = await fetch(tile.poster).catch(() => undefined);
    if (res?.ok) poster = Buffer.from(await res.arrayBuffer());
  }
  fs.writeFileSync(path.join(dir, 'poster.jpg'), poster);
  console.log(`  ✓ ${tile.name}`);
}

// Drop tiles for courses the host no longer lists.
const keep = new Set(tiles.map((t) => t.folder));
for (const entry of fs.readdirSync(gamesDir)) {
  if (entry.startsWith(PREFIX) && !keep.has(entry)) {
    fs.rmSync(path.join(gamesDir, entry), { recursive: true });
    console.log(`  – removed ${entry}`);
  }
}

console.log(`\nInstalled into ${gamesDir} (host ${host}).`);
if (!outDir) console.log('Restart OGS Desktop to see them under Custom Games.');
