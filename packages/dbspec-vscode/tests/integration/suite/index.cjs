// The integration suite inside VS Code: every fixture of tests/editor, opened as a dbspec document, gives through
// `vscode.provideDocumentSemanticTokens` exactly the tokens of its .json, decoded with the legend of
// `vscode.provideDocumentSemanticTokensLegend`; the semantic highlighting default of the extension is in effect.
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

const EXTENSION = 'polyspec.polyspec-dbspec';

// Decodes the relative five-number encoding of the semantic tokens into [class, [[line, start], [line, end]]].
function decode(tokens, legend) {
  const out = [];
  let line = 0;
  let start = 0;
  for (let i = 0; i < tokens.data.length; i += 5) {
    const [deltaLine, deltaStart, length, type] = tokens.data.slice(i, i + 4);
    line += deltaLine;
    start = deltaLine === 0 ? start + deltaStart : deltaStart;
    out.push({ class: legend.tokenTypes[type], range: [[line, start], [line, start + length]] });
  }
  return out;
}

async function run() {
  const fixtures = process.env.DBSPEC_FIXTURES;
  assert.ok(fixtures, 'DBSPEC_FIXTURES names the fixture folder');
  const extension = vscode.extensions.getExtension(EXTENSION);
  assert.ok(extension, `${EXTENSION} is loaded`);
  await extension.activate();
  const names = readdirSync(fixtures).filter(name => name.endsWith('.dbs')).sort();
  assert.ok(names.length > 0, 'the editor fixtures exist');
  let passed = 0;
  for (const name of names) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(fixtures, name)));
    assert.equal(document.languageId, 'dbspec', name);
    assert.equal(vscode.workspace.getConfiguration('editor', document).get('semanticHighlighting.enabled'), true, name);
    const legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', document.uri);
    const tokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', document.uri);
    assert.ok(legend && tokens, `${name}: the server provides semantic tokens`);
    const expected = JSON.parse(readFileSync(join(fixtures, name.replace(/\.dbs$/, '.json')), 'utf8')).tokens;
    assert.deepEqual(decode(tokens, legend), expected, name);
    console.log(`[suite] ${name}: ${expected.length} tokens`);
    passed++;
  }
  console.log(`[suite] ${passed} of ${names.length} fixtures passed`);
}

module.exports = { run };
