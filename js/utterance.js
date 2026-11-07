// Pure helpers for spoken utterances. No DOM, no browser APIs — tested under Node (test/web/).

// Leading wake word: optional greeting ("hey", "ok"), then "wisp" or a common mis-hearing of it,
// as a whole word, followed by any punctuation/space. Look-alikes that could be real items
// ("whisk", "wispy") are deliberately NOT matched.
const WAKE_WORD = /^\s*(?:(?:hey|hi|ok|okay)[\s,]+)?(?:wisp|whisp|wysp)(?=$|[\s,.:;!?\-–—])[\s,.:;!?\-–—]*/i;

/**
 * Remove a leading "WISP" (optionally "hey wisp") and the punctuation after it.
 * @param {string} text raw transcript
 * @returns {string} transcript without the wake word, trimmed
 */
export function stripWakeWord(text) {
  if (typeof text !== 'string') return '';
  return text.replace(WAKE_WORD, '').trim();
}
