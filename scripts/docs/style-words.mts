/** The language of a document that the style lists of `docs.writing-style` are read for. */
export type StyleLanguage = 'en' | 'ko';

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The pattern that finds the entry `entry` of a style list in prose of `language`.
 *
 * An English entry is a whole word. A Korean entry is the start of an eojeol, the run of characters between spaces: the
 * character before the entry is not a Hangul syllable, and the eojeol may continue after it with a particle or an ending.
 * So `유도` is found in `유도한다` and not in `이유도`, and `낸다` in `낸다` and not in `끝낸다`. The words of an entry of several
 * words are separated by any white space.
 */
export function styleEntryPattern(entry: string, language: StyleLanguage): RegExp {
  if (entry.trim() === '' || entry !== entry.trim()) throw new Error(`style entry ${JSON.stringify(entry)} is empty or has outer spaces; write the word itself in contracts/rules.json`);
  const words = entry.split(/\s+/).map(escaped).join('\\s+');
  return language === 'ko' ? new RegExp(`(?<![가-힣])${words}`, 'u') : new RegExp(`\\b${words}\\b`, 'i');
}

/** Whether `text`, prose of `language`, holds the entry `entry` of a style list. */
export function holdsStyleEntry(text: string, entry: string, language: StyleLanguage): boolean {
  return styleEntryPattern(entry, language).test(text);
}
