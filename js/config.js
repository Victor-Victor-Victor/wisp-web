// Public settings for the WISP phone app. Nothing secret here: this file is published to GitHub Pages.
export const APP_VERSION = '0.7.3';

/** The Apps Script web app (backend/deployment.json — a test keeps them in sync). Requests need the token. */
export const BACKEND_URL =
  'https://script.google.com/macros/s/AKfycbzfAke6qwxLrDt9nM5ORIPDvBiUkQR2dOFGqB5Ll0dfZLaLow2Z2VlsFQIzkp5b6e9wyw/exec';

export const TIMING = {
  commandListenMs: 8000, // launch / mic tap: give up if no speech starts
  answerListenMs: 8000, // spec §8: no answer to a question in ~8 s → cancel
  graceListenMs: 3000, // ADR-010: after a phrase with no "and", more speech still continues the list (⚙: first phrase)
  listGraceMinMs: 3000, // 0.6.8: once a list is underway, never wait less than this between items
  // defaults; each phone can change these two in ⚙ (settings.js)
  listPauseMs: 15000, // ADR-010: silence after "and" this long → list paused (no more Android mic beeps)
  pausedFinishMs: 30000, // ADR-010: paused this long → the list is finished (questions, then the read-back)
  echoTailMs: 200, // after WISP speaks, wait this long before opening the mic so it doesn't hear the tail
  undoVisibleMs: 10000, // spec §8: Undo button for 10 s
  requestTimeoutMs: 15000,
};
