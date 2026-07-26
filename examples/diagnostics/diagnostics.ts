import { app, NetClient, PROTOCOL_VERSION } from '@opengolfsim/fuse';

/**
 * A read-only probe for the real-hardware path, built to be run *inside* OGS
 * Desktop where a console isn't necessarily reachable — every answer is on
 * screen, and mirrored through `app.log()` so it also lands in Desktop's
 * main.log.
 *
 * It answers the three things the empirical spike needs to know:
 *   1. Did our build load, and how is the host app embedding it (`appType`)?
 *   2. Can this page open a WebSocket to the relay, or is it blocked?
 *   3. Do launch monitor shots actually arrive as `app.on('shot')`?
 *
 * It never simulates a shot or touches CourseGame — nothing here can affect a
 * real round.
 */

type Status = 'pass' | 'fail' | 'warn' | 'pending';

const report: string[] = [];

function row(container: HTMLElement, key: string, value: string, status?: Status) {
  const el = document.createElement('div');
  el.className = 'row';
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = key;
  const v = document.createElement('span');
  v.className = 'v';
  v.textContent = value;
  el.append(k, v);
  if (status) {
    const chip = document.createElement('span');
    chip.className = `chip ${status}`;
    chip.textContent = status === 'pending' ? '…' : status;
    el.append(chip);
  }
  container.append(el);
  report.push(`${key}: ${value}${status ? ` [${status}]` : ''}`);
  app.log(`[diag] ${key}: ${value}`);
  return { row: el, value: v, chip: el.querySelector('.chip') as HTMLElement | null };
}

function setRow(
  handle: { value: HTMLElement, chip: HTMLElement | null },
  value: string,
  status: Status
) {
  handle.value.textContent = value;
  if (handle.chip) {
    handle.chip.className = `chip ${status}`;
    handle.chip.textContent = status === 'pending' ? '…' : status;
  }
  report.push(`  -> ${value} [${status}]`);
  app.log(`[diag] -> ${value} [${status}]`);
}

const el = (id: string) => document.getElementById(id)!;

// ---------------------------------------------------------------- environment

const env = el('env');
const embedded = window.self !== window.top;

row(env, 'app.appType', app.appType, app.appType === 'web' ? 'warn' : 'pass');
row(env, 'Embedding', embedded ? 'iframe (postMessage)' : 'top-level window');
row(env, 'window.ogsElectron', typeof (window as any).ogsElectron !== 'undefined' ? 'present' : 'absent');
row(env, 'Page URL', window.location.href);
// What actually decides ws:// vs wss:// is the page's *scheme*, not the secure
// context — localhost is a trustworthy origin (isSecureContext true) and still
// allows ws:// happily. Only an https page has its ws:// blocked as mixed content.
const httpsPage = window.location.protocol === 'https:';
row(env, 'Page protocol', window.location.protocol, httpsPage ? 'warn' : 'pass');
row(env, 'Secure context', String(window.isSecureContext));
row(env, 'User agent', navigator.userAgent);

// FUSE no longer loads Rapier, so `initialize()` resolves immediately and this
// row should turn green the moment the page runs. It stays because a stuck
// callback is still the symptom that a bundle failed to evaluate at all.
const initRow = row(env, 'app.initialize() callback', 'waiting…', 'pending');
const initStarted = performance.now();
let initFired = false;
app.initialize(() => {
  initFired = true;
  setRow(initRow, `fired after ${((performance.now() - initStarted) / 1000).toFixed(1)}s`, 'pass');
});
// Keep counting rather than declaring failure at a fixed moment — the question
// is whether this is slow or genuinely stuck, and a static row can't say.
const initTick = setInterval(() => {
  if (initFired) return clearInterval(initTick);
  const seconds = (performance.now() - initStarted) / 1000;
  initRow.value.textContent = `still waiting… ${seconds.toFixed(0)}s`;
  if (seconds > 30) {
    setRow(initRow, `never fired after ${seconds.toFixed(0)}s — the FUSE bundle never evaluated`, 'fail');
    clearInterval(initTick);
  }
}, 1000);

// `web` means no host app is talking to us — expected in a plain browser tab,
// but under Desktop it would mean shots have no route in.
if (app.appType === 'web') {
  row(env, 'Note', 'appType "web" — no host app detected. In a plain browser tab this is normal.');
}
// A CSP from the host app is the prime suspect when the socket fails here —
// this reports the exact directive and the policy behind it, which is the
// difference between "the relay is unreachable" and "we were forbidden".
const cspRow = row(env, 'CSP violations', 'none so far');
let policyShown = false;
document.addEventListener('securitypolicyviolation', (event) => {
  setRow(cspRow, `${event.effectiveDirective || event.violatedDirective} blocked ${event.blockedURI}`, 'fail');
  if (!policyShown && event.originalPolicy) {
    policyShown = true;
    row(env, 'Active policy', event.originalPolicy);
  }
});

// There is no console inside Desktop, so anything thrown during startup would
// otherwise be invisible — surface it on the page.
const errorRow = row(env, 'Uncaught errors', 'none so far');
window.addEventListener('error', (event) =>
  setRow(errorRow, `${event.message} (${event.filename}:${event.lineno})`, 'fail'));
window.addEventListener('unhandledrejection', (event) =>
  setRow(errorRow, `unhandled rejection: ${event.reason}`, 'fail'));

// An https page has its ws:// blocked as mixed content — the relay would need TLS.
if (httpsPage) {
  row(env, 'Note', 'This page is https, so the browser will block ws:// as mixed content. If the relay test fails, that is why — the relay needs TLS (wss://), or Desktop needs to load us over http.');
}

// -------------------------------------------------------------------- relay

const relay = el('relay');
const hostInput = el('relay-host') as HTMLInputElement;
hostInput.value = `${window.location.hostname || 'localhost'}:8080`;

row(relay, 'Protocol version', String(PROTOCOL_VERSION));
const reachRow = row(relay, 'Relay port over http', 'not tested yet', 'pending');
const socketRow = row(relay, 'WebSocket opens', 'not tested yet', 'pending');
const joinRow = row(relay, 'Relay join (full protocol)', 'not tested yet', 'pending');

let client: NetClient | undefined;

/**
 * Plain HTTP to the relay port before the WebSocket. The ws server answers a
 * bare GET with 400, so *any* response proves the port is reachable and that
 * connect-src allows the origin — which separates "nothing is listening" from
 * "the socket upgrade specifically was refused".
 */
async function testReachability(host: string) {
  setRow(reachRow, `GET http://${host} …`, 'pending');
  try {
    const res = await fetch(`http://${host}/`, { mode: 'no-cors' });
    setRow(reachRow, `answered (status ${res.status || 'opaque'}) — port reachable`, 'pass');
  } catch (err) {
    setRow(reachRow, `fetch failed: ${err} — port unreachable, or connect-src blocks it`, 'fail');
  }
}

function testRelay() {
  const host = hostInput.value.trim();
  const url = `ws://${host}`;
  void testReachability(host);
  setRow(socketRow, `connecting to ${url}…`, 'pending');
  setRow(joinRow, 'waiting on the socket…', 'pending');

  // Step 1: can a socket open at all? This is the question that decides Path A —
  // a CSP or mixed-content block fails here, before any protocol is involved.
  const started = performance.now();
  let raw: WebSocket;
  try {
    raw = new WebSocket(url);
  } catch (err) {
    setRow(socketRow, `threw immediately: ${err}`, 'fail');
    setRow(joinRow, 'skipped — no socket', 'fail');
    return;
  }

  const timeout = setTimeout(() => {
    if (raw.readyState !== WebSocket.OPEN) {
      raw.close();
      setRow(socketRow, 'timed out after 5s — no relay listening, or blocked', 'fail');
      setRow(joinRow, 'skipped — no socket', 'fail');
    }
  }, 5000);

  raw.addEventListener('open', () => {
    clearTimeout(timeout);
    setRow(socketRow, `open in ${(performance.now() - started).toFixed(0)}ms`, 'pass');
    raw.close();
    joinRelay(host);
  });

  raw.addEventListener('error', () => {
    clearTimeout(timeout);
    // Deliberately not guessing at the cause here — the CSP row above and the
    // http reachability row together say which of these it actually is.
    setRow(
      socketRow,
      httpsPage
        ? 'failed — this is an https page, so ws:// is blocked as mixed content'
        : 'failed — blocked by policy, or nothing listening (see the CSP and reachability rows)',
      'fail'
    );
    setRow(joinRow, 'skipped — no socket', 'fail');
  });
}

/** Step 2: the real client, real protocol — proves the whole chain works. */
function joinRelay(host: string) {
  setRow(joinRow, 'joining room "diagnostics"…', 'pending');
  client?.close();
  client = new NetClient(`ws://${host}`, {
    roomCode: 'diagnostics',
    courseUrl: 'diagnostics',
    players: [{ name: 'Diagnostics', id: 'diagnostics', clubs: [] }],
  });
  client.on('joined', (msg) => {
    setRow(joinRow, `joined as ${msg.clientId} — the relay is reachable and speaking v${PROTOCOL_VERSION}`, 'pass');
    client?.leave();
  });
  client.on('error', (message) => setRow(joinRow, `relay refused the join: ${message}`, 'fail'));
  client.connect();
}

el('relay-test').addEventListener('click', testRelay);
testRelay();

// -------------------------------------------------------------------- setup

const setup = el('setup');

/**
 * Does the host app re-send `setup` after a reload, or is it a one-shot push at
 * navigation? This decides how multiplayer can start under Desktop: if setup
 * comes back, the lobby can reload the page to rebuild the game from the server
 * roster; if it doesn't, the game has to be rebuilt in place instead.
 *
 * A plain load counter isn't enough — relaunching the game from the library
 * navigates the same renderer and would look identical. So mark the reload
 * explicitly, and consume the mark on the way back in.
 */
const RELOAD_KEY = 'ogs.diag.reloaded-at';
const reloadedAt = sessionStorage.getItem(RELOAD_KEY);
sessionStorage.removeItem(RELOAD_KEY);
if (reloadedAt) {
  const secondsAgo = ((Date.now() - Number(reloadedAt)) / 1000).toFixed(1);
  row(setup, 'This page load', `came from the Reload button ${secondsAgo}s ago — so the setup row below is the answer`);
} else {
  row(setup, 'This page load', 'launched by the host app (not a reload)');
}
el('reload').addEventListener('click', () => {
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  window.location.reload();
});

const pageLoadedAt = performance.now();
const setupRow = row(setup, 'setup event', 'waiting for the host app…', 'pending');

/**
 * AppBridge sends `{type:'ready'}` from setReady(), now straight from its
 * constructor. If the host app never arms the launch monitor, the question is
 * whether it heard that signal at all — this button re-sends it by hand to test
 * that link on its own.
 */
const readyRow = row(setup, 'ready signal to host', 'sent automatically on load — click to send again');
el('send-ready').addEventListener('click', () => {
  app.sendMessage({ type: 'ready' });
  setRow(readyRow, `sent by hand at ${new Date().toLocaleTimeString()} — does the launch monitor arm now?`, 'pass');
});

app.on('setup', (payload: any) => {
  setRow(setupRow, `received ${((performance.now() - pageLoadedAt) / 1000).toFixed(1)}s into this page load`, 'pass');
  const players = payload?.setupData?.players ?? [];
  row(setup, 'Players', players.length
    ? players.map((p: any) => `${p.name} (${p.clubs?.length ?? 0} clubs)`).join(', ')
    : 'none in payload');
  row(setup, 'Course URL', payload?.gameData?.courseUrl ?? 'none');
  row(setup, 'Units', payload?.setupData?.units ?? 'unknown');
  row(setup, 'Putting enabled', String(payload?.setupData?.puttingEnabled));
  row(setup, 'Raw setupData', JSON.stringify(payload?.setupData ?? {}));
});

// --------------------------------------------------------------------- shots

const shotLog = el('shot-log');
const shotCount = el('shot-count');
let shots = 0;

app.on('shot', (shot: any) => {
  shots++;
  shotCount.textContent = String(shots);
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  // the documented Shot shape (globals.d.ts); the raw payload is logged below
  // it too, so a field the Square names differently still shows up
  const summary = [
    `ball ${shot?.ballSpeed ?? '?'} mph`,
    `VLA ${shot?.verticalLaunchAngle ?? '?'}`,
    `HLA ${shot?.horizontalLaunchAngle ?? '?'}`,
    `spin ${shot?.spinSpeed ?? '?'} / axis ${shot?.spinAxis ?? '?'}`,
  ].join('  ');
  line.innerHTML = `<b>${time}</b>  ${summary}`;
  const raw = document.createElement('div');
  raw.textContent = `   ${JSON.stringify(shot)}`;
  if (shots === 1) shotLog.textContent = '';
  shotLog.prepend(line, raw);
  report.push(`shot ${shots}: ${JSON.stringify(shot)}`);
  app.log(`[diag] shot ${shots}: ${JSON.stringify(shot)}`);
});

// -------------------------------------------------------------------- report

el('copy').addEventListener('click', async () => {
  const text = [`FUSE diagnostics — ${new Date().toISOString()}`, ...report].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    (el('copy') as HTMLButtonElement).textContent = 'Copied';
  } catch {
    // clipboard is unavailable in some embeds — fall back to the console
    console.log(text);
    (el('copy') as HTMLButtonElement).textContent = 'Logged to console';
  }
});

console.log('[diag] FUSE diagnostics ready', { appType: app.appType, embedded });
