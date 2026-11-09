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
const QUESTION = /^(?:(?:hey|ok|okay|so|and|um+|uh+)[\s,]+)*(?:what(?:['’]?s| is| are| do| does| did)?|where(?:['’]?s| is| are| do| did)?|how (?:many|much|long|old)|do (?:we|i|you)|does|did|is there|are there|have (?:we|i)|which|when|who|tell me|show me)\b/i;
const AND_TAIL = new RegExp(`[\\s,]+and${FILLER}[\\s,.…]*$`, 'i');
const LEADING_AND = /^\s*and[\s,]+/i;
const BARE_AND = new RegExp(`^and${FILLER}[\\s,.…]*$`, 'i');

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
  if (END_TAIL.test(text)) {
    const body = text.replace(END_TAIL, '').replace(LEADING_AND, '').trim();
    return body ? { kind: 'chunk', text: body, continues: false, ends: true } : { kind: 'end' };
  }
  const continues = AND_TAIL.test(text);
  const body = text.replace(AND_TAIL, '').replace(LEADING_AND, '').trim();
  if (!body) return continues ? { kind: 'chunk', text: '', continues: true } : { kind: 'end' };
  return continues || !(QUESTION.test(body) || /\?\s*$/.test(body))
    ? { kind: 'chunk', text: body, continues }
    : { kind: 'chunk', text: body, continues, question: true };
}
