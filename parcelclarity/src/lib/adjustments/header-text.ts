/**
 * How a column header is read before any rule looks at it (Milestone 5, review finding F4). This is the TypeScript twin of the database
 * functions `app.adjustment_header_fold` and `app.adjustment_header_norm`: the same steps in the same order, so the guard in the browser's
 * upload path and the backstop inside the database agree. tests/db/adjustments-header-parity.test.ts runs every character of the confusable
 * table, and the shared header table, through both.
 *
 * Every function here is linear in the length of its input (no regular expression with nested or overlapping repeats), because a header
 * is attacker-controlled text and the guard runs on every header of every sheet.
 *
 *   fold:  Unicode compatibility decomposition (NFKD: fullwidth and styled letters become plain ones, an accented letter splits from its
 *          accent), then every invisible format character (zero-width space and joiners, soft hyphen, bidi marks, byte order mark, word
 *          joiner, tag characters, variation selectors, fillers) and every combining mark is removed, then common Cyrillic, Greek and
 *          Latin small-capital look-alikes are mapped to the Latin letter they imitate. Case and punctuation are kept.
 *   norm:  split camelCase and PascalCase ("CarrierCost", "UPSCost"), lower-case ASCII, every run of other characters becomes one space.
 *          The result holds only a-z, 0-9 and single spaces ("" when the header has nothing readable).
 */

/** Longest header the guard reads as a header (code points). A longer one is refused, never folded. */
export const MAX_HEADER_CHARS = 200;
/** The folding never looks further than this many characters into a cell (words-only checks of cells that are not headers). */
export const FOLD_WINDOW = 400;

const INVISIBLE =
  /[­͏؀-؅؜۝܏࢐࢑࣢ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻\u{110bd}\u{110cd}\u{13430}-\u{1343f}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0001}\u{e0020}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const COMBINING_MARKS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g;

/** The look-alike letters (Cyrillic, Greek, Latin small capitals and a few others) and the Latin letter each imitates: the same pairs, in the same order, as the database's translate(). */
const CONFUSABLE_FROM =
  "АВЕКМНОРСТХУІЈЅавекмнорстхуіјѕһԁԛԝӏΑΒΕΖΗΙΚΜΝΟΡΤΥΧαεικνορτυχγωμηıɑɡᴀᴄᴇᴏᴛꜱɢʙᴘʀɪɴᴍʟᴜᴠᴡᴢᴅʜᴊᴋ";
const CONFUSABLE_TO = "ABEKMHOPCTXYIJSabekmhopctxyijshdqwlABEZHIKMNOPTYXaeikvoptuxywuniagaceotsgbprinmluvwzdhjk";
const CONFUSABLES: ReadonlyMap<string, string> = (() => {
  const from = [...CONFUSABLE_FROM];
  const to = [...CONFUSABLE_TO];
  if (from.length !== to.length) throw new Error("the confusable table is misaligned");
  const map = new Map<string, string>();
  // translate() keeps the first mapping of a repeated character.
  from.forEach((ch, i) => {
    if (!map.has(ch)) map.set(ch, to[i]!);
  });
  return map;
})();

/** The look-alike characters the fold maps, for the parity test. */
export const CONFUSABLE_CHARACTERS: readonly string[] = [...CONFUSABLES.keys()];

/** Steps 1 to 3 of the fold: compatibility decomposition, invisible characters and combining marks removed, look-alikes mapped. */
export function foldHeader(raw: string): string {
  const stripped = raw.normalize("NFKD").replace(INVISIBLE, "").replace(COMBINING_MARKS, "");
  let out = "";
  for (const ch of stripped) out += CONFUSABLES.get(ch) ?? ch;
  return out;
}

/** Step 4 (norm) on an already folded text: split camelCase, lower-case ASCII, every run of anything else one space. One pass over the text. */
export function normalizeFolded(s: string): string {
  let out = "";
  let gap = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const upper = c >= 65 && c <= 90;
    const lower = c >= 97 && c <= 122;
    const digit = c >= 48 && c <= 57;
    if (!upper && !lower && !digit) {
      if (out) gap = true;
      continue;
    }
    if (!gap && out) {
      // The previous character of `s` is a letter or digit here (otherwise `gap` would be set).
      const p = s.charCodeAt(i - 1);
      const prevLowerOrDigit = (p >= 97 && p <= 122) || (p >= 48 && p <= 57);
      const prevUpper = p >= 65 && p <= 90;
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      // "carrierCost": a lower-case letter or digit then an upper-case one; "UPSCost": an upper-case letter that starts a capitalised word after another upper-case letter.
      if (upper && (prevLowerOrDigit || (prevUpper && n >= 97 && n <= 122))) gap = true;
    }
    if (gap) {
      out += " ";
      gap = false;
    }
    out += upper ? String.fromCharCode(c + 32) : s[i]!;
  }
  return out;
}

/** The normalised form of a header (`app.adjustment_header_norm`): what the word rules and the synonym lists read. Looks at the first 400 characters only. */
export function normalizeGuardHeader(h: string): string {
  return normalizeFolded(foldHeader(h.length > FOLD_WINDOW ? h.slice(0, FOLD_WINDOW) : h));
}

/** True for a header that is blank in the database's sense: nothing but spaces, tabs and line breaks. */
export function isBlankHeader(h: string): boolean {
  for (let i = 0; i < h.length; i++) {
    const c = h.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 13 && c !== 10) return false;
  }
  return true;
}

/** Number of code points, without walking a long string: more than FOLD_WINDOW UTF-16 units is more than MAX_HEADER_CHARS code points. */
export function codePointCountAtMost(h: string, max: number): boolean {
  if (h.length <= max) return true;
  if (h.length > max * 2) return false;
  let n = 0;
  for (let i = 0; i < h.length; i++) {
    const c = h.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < h.length) {
      const d = h.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    if (++n > max) return false;
  }
  return true;
}

/**
 * True when, after the fold, the text still holds a character the database's residual test refuses: anything outside ASCII, the Latin-1
 * punctuation and symbol block (U+0080 to U+00BF), general punctuation and symbols (U+2000 to U+2BFF) and CJK punctuation (U+3000 to U+303F).
 * Letters of another script that look like nothing we know, a mix of scripts, and the replacement character all land here.
 */
export function hasUnreadableCharacters(folded: string): boolean {
  for (let i = 0; i < folded.length; i++) {
    const c = folded.charCodeAt(i);
    if (c <= 0x7f) continue;
    if (c >= 0x80 && c <= 0xbf) continue;
    if (c >= 0x2000 && c <= 0x2bff) continue;
    if (c >= 0x3000 && c <= 0x303f) continue;
    return true;
  }
  return false;
}
