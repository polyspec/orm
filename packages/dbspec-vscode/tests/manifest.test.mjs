// The VS Code extension without VS Code (docs/editor.md): the manifest contributes the language `dbspec` with no
// TextMate grammar, one semantic token type and one TextMate scope for each class of the language service, semantic
// highlighting enabled by default; the bundle starts the bundled server, whose legend is the classes in their order.
// VS Code itself runs in tests/integration.
//
// Usage: node --test packages/dbspec-vscode/tests/manifest.test.mjs (after the build of this package)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKEN_CLASSES } from '@polyspec/dbspec-language';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { caseTest, COMPUTE, PROCESS } from '../../../tests/testcase.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const contributes = manifest.contributes ?? {};
const LANGUAGE = 'dbspec';

caseTest('the manifest contributes the language dbspec for .dbs', COMPUTE, () => {
  const languages = contributes.languages ?? [];
  assert.equal(languages.length, 1);
  assert.equal(languages[0].id, LANGUAGE);
  assert.deepEqual(languages[0].extensions, ['.dbs']);
  const configuration = JSON.parse(readFileSync(join(root, languages[0].configuration), 'utf8'));
  assert.equal(configuration.comments.lineComment, '#');
  assert.ok(Array.isArray(configuration.brackets) && configuration.brackets.length > 0);
});

caseTest('the manifest has no TextMate grammar', COMPUTE, () => {
  assert.equal(contributes.grammars, undefined);
});

caseTest('the semantic token types are the token classes in order, each with a scope', COMPUTE, () => {
  assert.deepEqual((contributes.semanticTokenTypes ?? []).map(type => type.id), [...TOKEN_CLASSES]);
  const scopes = contributes.semanticTokenScopes ?? [];
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].language, LANGUAGE);
  assert.deepEqual(Object.keys(scopes[0].scopes).sort(), [...TOKEN_CLASSES].sort());
  for (const cls of TOKEN_CLASSES) {
    const list = scopes[0].scopes[cls];
    assert.ok(Array.isArray(list) && list.length > 0 && list.every(scope => typeof scope === 'string' && scope.endsWith('.dbspec')), cls);
  }
});

caseTest('semantic highlighting is enabled by default for dbspec', COMPUTE, () => {
  assert.deepEqual(contributes.configurationDefaults?.[`[${LANGUAGE}]`], { 'editor.semanticHighlighting.enabled': true });
});

caseTest('the bundle starts the bundled server', COMPUTE, () => {
  assert.equal(manifest.main, './dist/extension.cjs');
  const extension = readFileSync(join(root, 'dist', 'extension.cjs'), 'utf8');
  assert.ok(extension.includes('"dist/server.cjs"'), 'dist/extension.cjs names dist/server.cjs');
  assert.ok(existsSync(join(root, 'dist', 'server.cjs')));
  assert.ok(!/require\("@polyspec\//.test(extension + readFileSync(join(root, 'dist', 'server.cjs'), 'utf8')), 'the bundles carry the workspace packages');
});

caseTest('the bundled server answers with the token classes as its legend', PROCESS, async () => {
  const server = spawn(process.execPath, [join(root, 'dist', 'server.cjs'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => server.once('exit', code => resolve(code)));
  const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin));
  connection.listen();
  const result = await connection.sendRequest('initialize', { processId: process.pid, rootUri: null, capabilities: {} });
  assert.deepEqual(result.capabilities.semanticTokensProvider.legend.tokenTypes, [...TOKEN_CLASSES]);
  await connection.sendRequest('shutdown');
  await connection.sendNotification('exit');
  assert.equal(await exited, 0);
  connection.dispose();
});
