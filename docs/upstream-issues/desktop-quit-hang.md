# Draft issue for `OpenGolfSim/opengolfsim-desktop`

**Posted 2026-11-02:** https://github.com/OpenGolfSim/opengolfsim-desktop/issues/6

---

**Title:** macOS: Cmd+Q never finishes — process hangs joining the Square plugin's worker (noble teardown deadlock)

## Summary

On macOS, quitting OpenGolfSim never finishes and needs a force quit. The
app's own shutdown completes in about 0.2 s, but Node then waits for the
Square plugin's worker thread to end, and that thread is deadlocked inside
the Bluetooth library (`@stoprocent/noble`) while it cleans up. Since
everything is already saved at that point, ending the process once shutdown
finishes, or running Bluetooth plugins in a separate process, would fix it.

## What happens

On macOS, quitting OpenGolfSim (Cmd+Q, or `tell application "OpenGolfSim" to quit`)
never finishes. The window closes but the process stays alive indefinitely and
has to be force quit. It happens every time, with or without the Square
connected and with or without a round in progress.

## Environment

- OpenGolfSim Desktop 1.21.1 (Electron 43.1.0), macOS 27.0.1, Apple silicon
- Launch monitor plugin: `ogs-plugin-square` (0.0.3)
- `@stoprocent/noble` 2.5.5

## The app's own shutdown completes

Everything in `gracefulShutdown` finishes in about 0.2 s, and `process.exit(0)`
is reached:

```
22:47:20.501 [debug]               before-quit false
22:47:20.502 [info]                Shutting down gracefully...
22:47:20.504 [debug] (PLUGIN)      Requesting plugin stop...
22:47:20.506 [info]  (PLUGIN)      [ogs-plugin-square-main] 'Exiting ogs-plugin-square...'
22:47:20.708 [error] (PLUGIN)      [ogs-plugin-square-main] plugin is safe to shutdown
22:47:20.710 [debug] (OGS_LAUNCH)  Launch monitor service is now shutdown.
22:47:20.711 [info]                Graceful shut down completed!
22:47:20.712 [info]                Exiting...
22:47:20.718 [info]                FINALLY
```

`FINALLY` being logged at all shows `process.exit(0)` returned instead of
ending the process. The 5 s fallback `app.quit()` re-enters `before-quit`,
calls `process.exit(0)` again, and hangs the same way.

## Where it's stuck

`sample <pid>` on the hung process. The main thread is tearing down Node and
waiting to join a worker thread:

```
ElectronMain
  node::FreeEnvironment
    node::Environment::stop_sub_worker_contexts
      node::worker::Worker::JoinThread
        uv_thread_join → _pthread_join → __ulock_wait
```

That worker is the plugin worker, deadlocked while the noble macOS binding is
finalized during the worker's own environment cleanup:

```
node::worker::Worker::Run
  node::FreeEnvironment
    node::Environment::RunCleanup → CleanupHandles → uv_run
      node_napi_env__::DeleteMe → v8impl::Reference::Finalize
        NobleMac::~NobleMac()                          (noble binding.node)
          -[BLEManager dealloc]
            -[BLEManager .cxx_destruct]
              ThreadSafeCallback (shared_ptr release)
                napi_release_threadsafe_function
                  uv_mutex_lock → __psynch_mutexwait   ← never returns
```

So the noble binding's destructor releases a thread-safe function during
environment teardown and blocks on a mutex that's never released. The main
thread then waits on that worker forever. `worker.terminate()` in
`lib/plugins.js` doesn't help: it can't interrupt native code, and exit still
joins the thread.

## Suggested fixes (any one would do)

1. **Don't let exit wait on the worker.** Shutdown is complete and everything
   is saved by the time `Exiting...` is logged, so after `gracefulShutdown()`
   resolves the app could end without Node's environment teardown, for example
   `process.kill(process.pid, 'SIGKILL')` or `process.reallyExit(0)`. At
   minimum, the 5 s fallback should be something that can't hang this way.
2. **Run Bluetooth plugins in a separate process** (Electron `utilityProcess`
   or `child_process.fork`) instead of a `worker_threads` Worker. A stuck
   child can be killed; a stuck thread blocks the whole app from exiting.
3. **Upstream in noble:** the macOS binding shouldn't release its
   thread-safe function from the finalizer during environment teardown. Worth
   reporting to `stoprocent/noble`, but (1) or (2) fixes the app regardless.

## Workaround for users

Force quit (⌥⌘⎋) after the window closes. Since shutdown has already finished
by then, nothing is lost.
