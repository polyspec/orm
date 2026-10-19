// The comment language check reads each ecosystem's comments with that ecosystem's own tokenizer, so Hangul in a
// string, a raw string or a template is accepted, and Hangul in a comment is rejected with its line.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { commentsByFile, familyOf, hangulComments } from './check.mts';

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
  { name: 'TypeScript regular expression does not hide the comment after it', path: 'a.ts', text: `const r = /'/;\n// ${KO}\n`, lines: [2] },
  { name: 'TypeScript URL inside a string does not start a comment', path: 'a.mts', text: `const u = "https://x";\n/* ${KO} */\n`, lines: [2] },
  { name: 'PHP hash comment is reported', path: 'a.php', text: `<?php\n# ${KO}\n`, lines: [2] },
  { name: 'PHP double-slash comment is reported', path: 'a.php', text: `<?php\n// ${KO}\n`, lines: [2] },
  { name: 'PHP attribute is code, not a comment', path: 'a.php', text: `<?php\n#[Attr("${KO}")]\n`, lines: [] },
  { name: 'Python hash comment is reported', path: 'a.py', text: `x = 1  # ${KO}\n`, lines: [1] },
  { name: 'Python docstring is a comment', path: 'a.py', text: `def f():\n    """\n    ${KO}\n    """\n`, lines: [3] },
  { name: 'Python triple-quoted data that is not a docstring is accepted', path: 'a.py', text: `sql = """\n${KO}\n"""\n`, lines: [] },
  { name: 'Makefile comment is reported', path: 'Makefile', text: `all:\n\t@true\n# ${KO}\n`, lines: [3] },
  { name: 'Makefile escaped hash is not a comment', path: 'Makefile', text: `x = \\#${KO}\n`, lines: [] },
  { name: 'TOML comment is reported and a string with hash is not', path: 'a.toml', text: `a = "#${KO}"\n# ${KO}\n`, lines: [2] },
  { name: 'Shebang selects PHP for an extension-less file', path: 'bin/tool', text: `#!/usr/bin/env php\n<?php\n// ${KO}\n`, lines: [3] },
];

// Every case is written to its own directory, so one batch run of each tokenizer covers all of them.
const dir = await mkdtemp(join(tmpdir(), 'orm-comments-'));
const placed = cases.map((c, i) => ({ ...c, path: join(String(i), c.path) }));
for (const c of placed) {
  await mkdir(dirname(join(dir, c.path)), { recursive: true });
  await writeFile(join(dir, c.path), c.text);
}
const byFile = await commentsByFile(dir, placed.map(c => c.path));

placed.forEach(({ name, lines, path }) => {
  caseTest(name, COMPUTE, () => {
    // A case whose file the tokenizer did not read is a defect, not an empty result.
    const comments = byFile.get(path);
    if (comments === undefined) throw new Error(`${path} was not read by its tokenizer`);
    assert.deepEqual(hangulComments(comments).map(comment => comment.line), lines);
  });
});

caseTest('a file without comment syntax has no family', COMPUTE, () => {
  assert.equal(familyOf('docs/a.md'), undefined);
  assert.equal(familyOf('config/a.json'), undefined);
});

caseTest('commentsByFile splits a block comment into its physical lines', COMPUTE, async () => {
  const rel = join('block', 'a.go');
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await writeFile(join(dir, rel), 'x\n// one\n/* two\nthree */\n');
  const comments = (await commentsByFile(dir, [rel])).get(rel) ?? [];
  assert.deepEqual(comments.map(comment => comment.line), [2, 3, 4]);
});
