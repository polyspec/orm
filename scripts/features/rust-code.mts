// The test attribute of a Rust file as the compiler reads it: cargo runs every .rs file that holds one, wherever it lies, so a
// test file of Rust is named by its code as well as by its path.

const CARGO_TEST = /#\[\s*((?:\w+::)*(?:test|bench|test_case|rstest))\b[^\]]*\]/;

// The text of a Rust file as the compiler reads it: every comment (line, doc and nested block) and the contents of every string
// and char literal are blanked, newlines kept, so an attribute is read from code only and a doc comment that quotes one is no
// test. A lifetime is no char literal; a raw string closes at its quote and the same number of hashes.
export function rustCode(text: string): string {
  const blank = (span: string) => span.replace(/[^\n]/g, ' ');
  const rawString = /b?r(#*)"/y;
  const charLiteral = /'(?:\\u\{[0-9a-fA-F_]*\}|\\x[0-9a-fA-F]{2}|\\.|[^'\\\n])'/y;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (text.startsWith('/*', i)) {
      let depth = 0;
      let j = i;
      do {
        if (text.startsWith('/*', j)) { depth++; j += 2; } else if (text.startsWith('*/', j)) { depth--; j += 2; } else j++;
      } while (depth > 0 && j < text.length);
      out += blank(text.slice(i, j));
      i = j;
    } else if (text[i] === 'b' || text[i] === 'r') {
      rawString.lastIndex = i;
      const raw = /\w/.test(text[i - 1] ?? '') ? null : rawString.exec(text);
      if (raw === null) {
        out += text[i];
        i++;
      } else {
        const close = `"${raw[1]}`;
        const end = text.indexOf(close, i + raw[0].length);
        const stop = end === -1 ? text.length : end + close.length;
        out += blank(text.slice(i, stop));
        i = stop;
      }
    } else if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, text.length);
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (text[i] === "'") {
      charLiteral.lastIndex = i;
      const char = charLiteral.exec(text);
      if (char === null) {
        out += text[i];
        i++;
      } else {
        out += blank(char[0]);
        i += char[0].length;
      }
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}


/** holdsRustTest holds when the code of a Rust file (its comments and literals blanked) holds a test attribute. */
export function holdsRustTest(text: string): boolean {
  return CARGO_TEST.test(rustCode(text));
}
