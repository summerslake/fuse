import { vi } from 'vitest';
import EventEmitter from 'eventemitter3';

// CourseGame listens for host-app key commands on the `app` bridge singleton,
// which lives in the library entry point. Importing that entry pulls in the
// whole renderer (and remote module URLs node can't load), so stand in a bare
// emitter — the tests only need something to subscribe to.
vi.mock('@/index', () => ({ app: new EventEmitter() }));
