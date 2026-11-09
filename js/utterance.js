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

// ---------- list mode (ADR-009) ----------
const FILLER = '(?:\\s+(?:um+|uh+|er+|erm|hmm+))*';
const END_PHRASE = "(?:that'?s it|that is it|that'?s all|that is all|that'?s everything|that'?ll do|i'?m done|all done|done|finished|nothing else|no more|end of (?:the )?list|stop)";
const POLITE = '(?:\\s+(?:for now|thanks|thank you))?';
const END_ONLY = new RegExp(`^(?:(?:ok|okay|um+|uh+|and|so|yeah)[\\s,]+)*${END_PHRASE}${POLITE}[\\s.!…]*$`, 'i');
const END_TAIL = new RegExp(`[\\s,.]+(?:and\\s+)?${END_PHRASE}${POLITE}[\\s.!…]*$`, 'i');
const CANCEL_ONLY = /^(?:(?:oh|ok|okay|no|wait)[\s,]+)*(?:never ?mind|cancel(?: that| it| the list)?|forget it|forget that)[\s.!…]*$/i;
const SKIP_ONLY = /^(?:(?:oh|ok|okay|um+|uh+|no|just|let'?s)[\s,]+)*(?:skip(?: it| that| this| this one| that one)?|pass|next|i don'?t know|no idea|not sure)[\s.!…]*$/i;
// A question rather than a list item: it gets no "Okay" and no "anything else?" wait (ADR-011 revision, 0.6.1).
const QUESTION = /^(?:(?:hey|ok|okay|so|and|um+|uh+)[\s,]+)*(?:what(?:['’]?s| is| are| do| does| did)?|where(?:['’]?s| is| are| do| did)?|how (?:many|much|long|old|do|does|can)|help|do (?:we|i|you)|does|did|is there|are there|have (?:we|i)|which|when|who|tell me|show me)\b/i;
// Just a place ("In the pantry,", "on the workbench"): an introduction — more is coming, like a trailing "and" (0.6.8).
const PLACE_INTRO = /^(?:(?:okay|ok|so|and|um+|uh+)[\s,]+)*(?:in|on|into|inside|at)\s+(?:the|my|our)\s+[a-z'’-]+(?:\s+[a-z'’-]+){0,2}[\s,.…:]*$/i;
const AND_TAIL = new RegExp(`[\\s,]+and${FILLER}[\\s,.…]*$`, 'i');
const LEADING_AND = /^\s*and[\s,]+/i;
const BARE_AND = new RegExp(`^and${FILLER}[\\s,.…]*$`, 'i');

// ---------- spoken corrections (ADR-017) ----------
// "no, I meant a box of crackers", "no, a box of crackers", "scratch that", "make that two cans": the phrase before
// is taken back and what follows replaces it. A bare "no" + a word that isn't an amount ("no salt crackers") is not a
// correction, and "no more" stays "end of list".
const AMOUNT_WORD = '(?:a|an|the|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|a couple|\\d+)';
const SAID = "(?:i meant|i mean|i said|that'?s|that is|that was|it'?s|it is|it was|it should be|should be|make (?:that|it))";
const NO_WORD = '(?:no|nope|nah)(?:[\\s,]+wait)?';
const CORRECTION = new RegExp(
  `^(?:(?:oh|oops|sorry|wait|um+|uh+)[\\s,]+)*(?:${NO_WORD}[\\s,]+${SAID}|${NO_WORD}(?=[\\s,]+${AMOUNT_WORD}\\b)`
  + '|scratch that|i meant|i mean|correction|make (?:that|it)|change (?:that|it) to)(?=$|[\\s,.:;!])[\\s,.:;!]*',
  'i',
);
const NO_ONLY = /^(?:(?:oh|um+|uh+|well)[\s,]+)*(?:no|nope|nah|not quite|wrong|that'?s wrong|no that'?s wrong|no thanks|no do not|no don'?t)[\s.!…]*$/i;
const NO_THEN = new RegExp(`^(?:(?:oh|um+|uh+|well)[\\s,]+)*${NO_WORD}[\\s,]+(?:${SAID}[\\s,:]+)?`, 'i');
const YES_ONLY = /^(?:(?:oh|um+|uh+|well)[\s,]+)*(?:yes|yeah|yep|yup|sure|ok|okay|right|correct|that'?s right)[\s.!…]*$/i;
const tidy = (raw) => stripWakeWord(String(raw ?? '')).replace(/\s+/g, ' ').trim();

/**
 * An answer to "I heard: … Right?": not a "no" (null), a plain "no" ({rest: ''}), or a "no" that says what was meant
 * ("no, that's one box of crackers" → {rest: 'one box of crackers'}).
 */
export function parseNo(raw) {
  const text = tidy(raw);
  if (NO_ONLY.test(text)) return { rest: '' };
  const m = NO_THEN.exec(text) ?? CORRECTION.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length).replace(/[\s.!…]+$/, '').trim();
  return { rest };
}

/** "yes", "yeah", "right"… on its own. */
export function isYes(raw) {
  return YES_ONLY.test(tidy(raw));
}

/**
 * How a finished utterance moves a spoken list along.
 * @returns {{kind:"end"} | {kind:"cancel"} | {kind:"chunk", text:string, continues:boolean, ends?:true}}
 *  - "end": the person closed the list ("that's it", "done").
 *  - "cancel": "never mind" / "cancel".
 *  - "chunk": something to send; `continues` is true when it ended with "and…" (more is coming), `ends` when it
 *    closed the list in the same breath ("a loaf of bread and that's it").
 */
/** An answer that skips just this question ("skip", "I don't know"); "never mind" skips them all. */
export function isSkip(raw) {
  return SKIP_ONLY.test(stripWakeWord(String(raw ?? '')).replace(/\s+/g, ' ').trim());
}

export function classifyUtterance(raw) {
  const text = stripWakeWord(String(raw ?? '')).replace(/\s+/g, ' ').trim();
  if (!text || END_ONLY.test(text)) return { kind: 'end' };
  if (CANCEL_ONLY.test(text)) return { kind: 'cancel' };
  if (BARE_AND.test(text)) return { kind: 'chunk', text: '', continues: true }; // just "and…": keep listening
  const fix = CORRECTION.exec(text);
  if (fix) {
    // a correction: the newest phrase is taken back (dialog.js), and what follows is a phrase like any other
    const rest = text.slice(fix[0].length).trim();
    if (!rest) return { kind: 'chunk', text: '', continues: true, corrects: true }; // "scratch that": keep listening
    const c = classifyUtterance(rest);
    if (c.kind === 'cancel') return c;
    return { ...c, corrects: true };
  }
  if (END_TAIL.test(text)) {
    const body = text.replace(END_TAIL, '').replace(LEADING_AND, '').trim();
    return body ? { kind: 'chunk', text: body, continues: false, ends: true } : { kind: 'end' };
  }
  const continues = AND_TAIL.test(text);
  const body = text.replace(AND_TAIL, '').replace(LEADING_AND, '').trim();
  if (!body) return continues ? { kind: 'chunk', text: '', continues: true } : { kind: 'end' };
  if (!continues && PLACE_INTRO.test(body)) return { kind: 'chunk', text: body, continues: true, intro: true };
  return continues || !(QUESTION.test(body) || /\?\s*$/.test(body))
    ? { kind: 'chunk', text: body, continues }
    : { kind: 'chunk', text: body, continues, question: true };
}
