/**
 * Text hygiene helpers. Player text and model output are untrusted: everything that goes back to the
 * player (or into a mission title/description) is passed through these functions first.
 */

/** C0/C1 control chars (except \t \n \r), soft hyphen, zero-width and bidi-override characters, BOM. */
const esc = (n: number) => '\\u' + n.toString(16).padStart(4, '0');
const range = ([a, b]: [number, number]) => esc(a) + (b > a ? '-' + esc(b) : '');
const CONTROL_RANGES: [number, number][] = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff],
];
const CONTROL_RE = new RegExp('[' + CONTROL_RANGES.map(range).join('') + ']', 'g');

export function stripControl(s: string): string {
  return s.replace(CONTROL_RE, '').replace(/\r\n?/g, '\n');
}

/** Remove markup the game UI should never render: HTML, markdown, links, URLs, entities. */
export function stripMarkup(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/&#?[a-z0-9]{1,10};/gi, ' ')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\b(?:https?|ftp|file|data|javascript|vbscript|mailto|blob):[^\s)]*/gi, ' ')
    .replace(/\bwww\.[^\s)]+/gi, ' ')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
    .replace(/`+/g, '')
    .replace(/\*+/g, '')
    .replace(/__+|~~+/g, '')
    .replace(/\|{2,}/g, ' ');
}

/** Cut to `max` characters, preferring a sentence or word boundary. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const hard = s.slice(0, Math.max(1, max - 1));
  const sentence = Math.max(hard.lastIndexOf('. '), hard.lastIndexOf('! '), hard.lastIndexOf('? '));
  if (sentence >= max * 0.5) return hard.slice(0, sentence + 1).trimEnd();
  const space = hard.lastIndexOf(' ');
  return (space >= max * 0.5 ? hard.slice(0, space) : hard).trimEnd() + '…';
}

/** Single-line clean text (titles, plan steps, interpretation, tool arguments). */
export function cleanInline(s: string, max: number): string {
  return truncate(stripMarkup(stripControl(s)).replace(/\s+/g, ' ').trim(), max);
}

/** Multi-line clean text for replies: markup and control characters removed, blank lines collapsed. */
export function cleanReply(s: string, max = 600): string {
  const t = stripMarkup(stripControl(s))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncate(t, max);
}

/** Player message normalisation before it reaches any provider: no control chars, single spaces. */
export function normalizeMessage(s: string): string {
  return stripControl(s).replace(/\s+/g, ' ').trim();
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export function redactEmails(s: string): string {
  return s.replace(EMAIL_RE, '[hidden]');
}

const COMBINING_MARKS_RE = new RegExp('[' + esc(0x300) + '-' + esc(0x36f) + ']', 'g');

/** Lowercase, accent-free, apostrophe-free, punctuation-free form used by the rules engine and matchers. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS_RE, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
