/**
 * The multiplayer entry point — the "Multiplayer" tile in the OGS Desktop
 * library launches this page rather than a specific course.
 *
 * It is the same game as `courses/`; only the opening move differs. This page
 * starts in the lobby with a course picker, so the roster and the course are
 * both settled before anything is built. `courses.ts` recognises it by path
 * (see `isMultiplayerEntry`), which avoids depending on Desktop preserving a
 * query string through its launcher.
 */
import '../courses/courses';
