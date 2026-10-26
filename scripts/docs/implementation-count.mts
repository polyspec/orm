const numberWords: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const koreanNumbers: Record<string, number> = {
  두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10,
};
const englishNumber = '(?:two|three|four|five|six|seven|eight|nine|ten|\\d+)';
const countedEnglish = new RegExp(
  `\\b(${englishNumber})\\b(?:[ \\t]+[\\w-]+){0,2}?[ \\t]+(clients?|implementations?|runners?|planners|outputs?)\\b|\\b(${englishNumber})-(clients?)\\b`,
  'gi',
);
const countedKorean = /(?<![가-힣])(두|세|네|다섯|여섯|일곱|여덟|아홉|열|\d+)[ \t]*(?:개[ \t]*)?(클라이언트|구현|러너|플래너)/g;

export type ClientAlias = { client: string; alias: string };

export function declaredClientAliases(clients: string[], displayNames: Record<string, string>): ClientAlias[] {
  const aliases: ClientAlias[] = [];
  for (const client of clients) {
    const display = displayNames[client] ?? client;
    aliases.push({ client: display, alias: display });
    if (client === 'php') aliases.push({ client: display, alias: 'PHP library' });
    if (client === 'php-extension') aliases.push({ client: display, alias: 'PHP-extension' });
  }
  return aliases.sort((a, b) => b.alias.length - a.alias.length);
}

export function countMismatches(text: string, isKorean: boolean, clientCount: number): string[] {
  const failures: string[] = [];
  if (!isKorean) {
    for (const match of text.matchAll(countedEnglish)) {
      const candidates = [match[1], match[3]].filter((value): value is string => value !== undefined);
      for (const word of candidates) {
        const normalized = word.toLowerCase();
        const value = /^\d+$/.test(normalized) ? Number(normalized) : numberWords[normalized];
        if (value !== undefined && value !== clientCount) failures.push(match[0].trim());
      }
    }
    return failures;
  }
  for (const match of text.matchAll(countedKorean)) {
    const word = match[1] ?? '';
    const value = /^\d+$/.test(word) ? Number(word) : koreanNumbers[word];
    if (value !== undefined && value !== clientCount) failures.push(match[0].trim());
  }
  return failures;
}

export type IncompleteClientSet = { line: number; phrase: string; missing: string[] };

export function incompleteClientSets(text: string, aliases: ClientAlias[]): IncompleteClientSet[] {
  const aliasNames = [...new Set(aliases.map(value => value.alias))].sort((a, b) => b.length - a.length);
  const aliasPattern = aliasNames.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const enumerated = new RegExp(
    `\\b(?:${aliasPattern})\\b(?:(?:\\s*[,·]\\s*(?:(?:and|or)\\s+)?(?:the\\s+)?|\\s+(?:and|or)\\s+)(?:${aliasPattern})\\b)+`,
    'g',
  );
  const aliasByName = new Map(aliases.map(value => [value.alias, value.client]));
  const aliasReader = new RegExp(`\\b(${aliasPattern})\\b`, 'g');
  const setNoun = /\b(clients?|implementations?|languages?|runners?|planners?)\b|클라이언트|구현|언어|러너|플래너/i;
  const findings: IncompleteClientSet[] = [];
  const lines = text.replace(/```[\s\S]*?```|<!--[\s\S]*?-->/g, block => block.replace(/[^\n]/g, '')).replace(/`/g, '').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    for (const match of line.matchAll(enumerated)) {
      const start = match.index ?? 0;
      const before = line.slice(0, start).split(/[.!?。]\s+/).pop()?.trim().split(/\s+/).slice(-2).join(' ') ?? '';
      const after = line.slice(start + match[0].length).split(/[.!?。]\s+/)[0]?.trim().split(/\s+/).slice(0, 2).join(' ') ?? '';
      if (!setNoun.test(before) && !setNoun.test(after)) continue;
      const found = new Set([...match[0].matchAll(aliasReader)].map(item => aliasByName.get(item[1] ?? '')).filter((name): name is string => name !== undefined));
      const required = [...new Set(aliases.map(value => value.client))];
      const missing = required.filter(name => !found.has(name));
      if (missing.length) findings.push({ line: index + 1, phrase: match[0], missing });
    }
  }
  return findings;
}
