# Draft issue for `OpenGolfSim/ogs-plugin-square`

**Posted 2026-11-02:** https://github.com/OpenGolfSim/ogs-plugin-square/issues/3

---

**Title:** Unhandled Bluetooth write rejection crashes the plugin on disconnect — "Restart launch monitor service" hangs

## Summary

The plugin sends Bluetooth writes (heartbeat, commands, club changes) without
handling failure. When the Square disconnects while a write is pending,
including the plugin's own disconnect during a restart, that write's
rejection goes unhandled and kills the plugin worker before it reports that
it stopped. "Restart launch monitor service" then hangs until the whole app
is restarted. Fix: catch the write's rejection and guard the exit handler
(diff below).

## What happens

Restarting the launch monitor service from inside OpenGolfSim sometimes never
completes. After that, every further restart attempt also hangs, and the only
way to get the Square working again is to restart the whole app — which ends
the round in progress.

## Environment

- OpenGolfSim Desktop 1.20.2 when found, still present on 1.21.1; macOS (Apple silicon)
- `ogs-plugin-square` 0.0.2 when found; the bug is unchanged in 0.0.3 (current `main`)
- Square firmware 1.10.28

## What the log shows

On a restart, the plugin errors the moment it starts exiting, and every later
attempt stops at "Requesting plugin stop...":

```
18:22:24.459 [info]  (OGS_LAUNCH) Restarting launch monitor service...
18:22:24.460 [debug] (PLUGIN)     Requesting plugin stop...
18:22:24.461 [info]  (PLUGIN)     [ogs-plugin-square-main] 'Exiting ogs-plugin-square...'
18:22:24.464 [error] (PLUGIN)     PluginError Error: Disconnected unknown
18:22:47.528 [info]  (OGS_LAUNCH) Restarting launch monitor service...
18:22:47.530 [debug] (PLUGIN)     Requesting plugin stop...
... (six more, same)
```

On quit, the same error, with a stack that points at the library rather than
the plugin's own code:

```
18:42:13.050 [error] (PLUGIN) PluginError Error: Disconnected unknown
    at Noble.disconnectListener (.../@stoprocent/noble/lib/noble.js:784:51)
    at Object.onceWrapper (node:events:631:26)
    at Noble.emit (node:events:509:28)
    at Noble._onDisconnect (.../@stoprocent/noble/lib/noble.js:435:12)
    at NobleMac.emit (node:events:509:28)
```

A stop that works logs `plugin is safe to shutdown` about 200 ms after
`Exiting ogs-plugin-square...`.

## Cause

`writeCommandBuffer` starts a write and drops the promise:

```js
function writeCommandBuffer(buffer) {
  ...
  scope.discoveredCharacteristics.command.write(buffer);
}
```

Every command goes through it, including the heartbeat on a 5-second interval
and, since 0.0.3, the club change sent whenever the player switches clubs.
noble wraps each operation in `_withDisconnectHandler`, which rejects anything
still pending when the peripheral disconnects:

```js
const disconnectListener = reason => reject(new Error(`Disconnected ${reason}`));
this.once(`disconnect:${peripheralId}`, disconnectListener);
```

So if a write is pending at the moment of a disconnect — including the
deliberate `peripheral.disconnect()` in the exit handler — it rejects with
"Disconnected unknown", nothing handles the rejection, and the plugin worker
dies with a `PluginError` before it reports a clean stop. The host keeps
waiting on that stop, and later restart requests queue up behind it.

I first tried guarding only the exit handler's `await peripheral.disconnect()`.
That did not help: the rejection belongs to the earlier write, not to the
disconnect call.

## Suggested fix

1. Handle the write's rejection in `writeCommandBuffer`, keeping it
   fire-and-forget (awaiting it would change `initializeDevice`'s timing).
2. Make the exit handler unable to throw or stall, as `ogs-plugin-square-omni`
   already does.
3. Unrelated but adjacent: the `event` data handler's `catch (err)` logs `e`,
   which is undefined there, so a notification parse error throws from inside
   its own handler.

Against 0.0.3:

```diff
@@ -410,7 +410,8 @@
           if (!data.buffer) return;
           handleNotification(Buffer.from(data.buffer));
         } catch (err) {
-          logging.error('Event error', e);
+          // was `e`, which is not defined here — the handler threw while reporting
+          logging.error('Event error', err);
         }
       });
       subPromises.push(scope.discoveredCharacteristics.event.subscribe());
@@ -452,7 +453,17 @@
   // We choose withoutResponse=false for safer writes when we want confirmation,
   // but many devices accept withoutResponse=true
   const withoutResponse = false;
-  scope.discoveredCharacteristics.command.write(buffer);
+  // Local patch (2026-10-10): the write is still fire-and-forget, but its
+  // promise must not be left unhandled. Any write still pending when the device
+  // disconnects is rejected by the Bluetooth library ("Disconnected unknown");
+  // with nothing listening, that rejection crashed the plugin worker — on every
+  // disconnect, including the deliberate one during a restart or quit.
+  const pending = scope.discoveredCharacteristics.command.write(buffer);
+  if (pending && typeof pending.catch === 'function') {
+    pending.catch((error) => {
+      logging.info('command write did not complete:', error && error.message ? error.message : error);
+    });
+  }
 }
 
 function sendDetectBall(mode = 1, spinMode = 0) {
@@ -581,14 +592,37 @@
   bt.off('discover', handleDiscoveredDevice);
   await bt.stopScanning();
   scope.isScanning = false;
+}
+
+// Local patch (2026-10-10): this handler must always finish. If the Bluetooth
+// disconnect rejects ("Disconnected unknown") the error used to escape, kill
+// the plugin worker before it reported a clean stop, and leave OpenGolfSim
+// waiting forever — so "Restart launch monitor service" hung and only
+// restarting the whole app recovered it. Each step is now guarded and capped.
+function settleWithin(promise, ms) {
+  return Promise.race([
+    Promise.resolve(promise).catch((error) => {
+      logging.info('ignored during exit:', error && error.message ? error.message : error);
+    }),
+    new Promise((resolve) => setTimeout(resolve, ms)),
+  ]);
 }
 
 system.on('exit', async () => {
   logging.info('Exiting ogs-plugin-square...');
-  if (scope.peripheral) {
-    await scope.peripheral.disconnect();
+  clearInterval(scope.heartBeatInterval);
+  try {
+    if (scope.peripheral) {
+      await settleWithin(scope.peripheral.disconnect(), 3000);
+    }
+  } catch (error) {
+    logging.info('disconnect failed during exit (ignored):', error && error.message ? error.message : error);
   }
-  await cancelScan();
+  try {
+    await settleWithin(cancelScan(), 3000);
+  } catch (error) {
+    logging.info('stop scanning failed during exit (ignored):', error && error.message ? error.message : error);
+  }
 });
 
 shotData.on('club', (club) => {
```

## Status of the fix

I'm running this patch locally on 0.0.3. The plugin loads, connects to the
Square and reports ready as before, and on quit it now stops cleanly
(`plugin is safe to shutdown` about 200 ms after `Exiting ogs-plugin-square...`).
I haven't yet confirmed an in-app "Restart launch monitor service" mid-round
with the Square connected.

## Separate: quit still hangs (host app)

Even with this fix, quitting OpenGolfSim on macOS hangs *after* the plugin has
stopped cleanly. That's a teardown deadlock in the native Bluetooth binding
while the host joins the plugin's worker thread, not something this plugin's
JavaScript can fix, so it's reported separately against the desktop app: https://github.com/OpenGolfSim/opengolfsim-desktop/issues/6
