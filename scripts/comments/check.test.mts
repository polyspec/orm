// The comment language check reads the comments of each language family and no string, so Hangul in a
// string, a raw string or a template is accepted, and Hangul in a comment is rejected with its line.
import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { commentsOf, hangulComments, syntaxOf } from './check.mts';

const KO = '한글';

const cases: Array<{ name: string; path: string; text: string; lines: number[] }> = [
  { name: 'Go line comment with Hangul is reported with its line', path: 'a.go', text: `package a\n// ${KO}\nvar x = 1\n`, lines: [2] },
  { name: 'Go block comment reports each Hangul line', path: 'a.go', text: `/*\nok\n${KO}\n*/\n`, lines: [3] },
  { name: 'Go string literal with Hangul is accepted', path: 'a.go', text: `var s = "${KO}"\nvar r = \`${KO}\`\n`, lines: [] },
  { name: 'Go rune literal of a quote does not hide the next comment', path: 'a.go', text: `var q = '\\''\n// ${KO}\n`, lines: [2] },
  { name: 'Go comment with English only is accepted', path: 'a.go', text: '// the value\nvar x = 1\n', lines: [] },
  { name: 'Rust nested block comment reports its inner Hangul line', path: 'a.rs', text: `/* a /* b */\n${KO}\n*/ fn f() {}\n`, lines: [2] },
  { name: 'Rust raw string with Hashes is a string', path: 'a.rs', text: `let s = r#"// ${KO}"#;\n`, lines: [] },
  { name: 'Rust lifetime is code, so the comment after it is found', path: 'a.rs', text: `fn f<'a>(x: &'a str) {} // ${KO}\n`, lines: [1] },
  { name: 'Rust string literal may span lines and hides its comment marker', path: 'a.rs', text: `let s = "a\n// ${KO}\n";\n`, lines: [] },
  { name: 'TypeScript line comment is reported', path: 'a.ts', text: `const x = 1; // ${KO}\n`, lines: [1] },
  { name: 'TypeScript template literal with Hangul is accepted', path: 'a.ts', text: 'const s = `' + KO + '`;\n', lines: [] },
  { name: 'TypeScript URL inside a string does not start a comment', path: 'a.mts', text: `const u = "https://x";\n/* ${KO} */\n`, lines: [2] },
  { name: 'PHP hash comment is reported', path: 'a.php', text: `<?php\n# ${KO}\n`, lines: [2] },
  { name: 'PHP attribute is code, not a comment', path: 'a.php', text: `<?php\n#[Attr("${KO}")]\n`, lines: [] },
  { name: 'Python hash comment is reported', path: 'a.py', text: `x = 1  # ${KO}\n`, lines: [1] },
  { name: 'Python docstring at a line start is a comment', path: 'a.py', text: `def f():\n    """\n    ${KO}\n    """\n`, lines: [3] },
  { name: 'Python triple-quoted data is accepted', path: 'a.py', text: `sql = """\n${KO}\n"""\n`, lines: [] },
  { name: 'Makefile comment is reported', path: 'Makefile', text: `all:\n\t@true\n# ${KO}\n`, lines: [3] },
  { name: 'Makefile escaped hash is not a comment in a string', path: 'Makefile', text: `x = \\#${KO}\n`, lines: [] },
  { name: 'TOML comment is reported and a string with hash is not', path: 'a.toml', text: `a = "#${KO}"\n# ${KO}\n`, lines: [2] },
  { name: 'Shebang selects PHP for an extension-less file', path: 'bin/tool', text: `#!/usr/bin/env php\n<?php\n// ${KO}\n`, lines: [3] },
];

for (const { name, path, text, lines } of cases) {
  caseTest(name, COMPUTE, () => {
    assert.deepEqual(hangulComments(path, text).map(comment => comment.line), lines);
  });
}

caseTest('a file without comment syntax is not read', COMPUTE, () => {
  assert.equal(syntaxOf('docs/a.md'), undefined);
  assert.equal(syntaxOf('config/a.json'), undefined);
  assert.deepEqual(hangulComments('config/a.json', `{"a": "${KO}"}`), []);
});

caseTest('commentsOf returns the line of each comment span', COMPUTE, () => {
  const syntax = syntaxOf('a.go');
  assert.ok(syntax);
  assert.deepEqual(commentsOf('x\n// one\n/* two\nthree */\n', syntax).map(comment => comment.line), [2, 3, 4]);
});
