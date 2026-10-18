import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { COMPUTE, sections } from '../../tests/testcase.mts';
import { readFeatures } from './manifest.mts';
import { featureLanguages } from './languages.mts';
import { errorCode } from '../../tests/errors.mts';

// The feature doc build is one case that reads the manifest and makes or compares two docs.
const log = sections();
log.begin(process.argv.includes('--check') ? 'feature-docs-check' : 'feature-docs', COMPUTE);

const root = resolve(new URL('../..', import.meta.url).pathname);
const manifest = readFeatures(root);
const table = (ko: boolean) => manifest.features.map(feature => `| ${feature.id} | ${ko ? feature.title_ko : feature.title} | ${feature.status} | ${featureLanguages(feature.parity).join(', ')} |`).join('\n');
const descriptions = (ko: boolean) => manifest.features.map(feature => `- \`${feature.id}\`: ${ko ? feature.description_ko : feature.description}`).join('\n');
// The document pair carries the markers of the documents check of @polyspec/kit (make documents-check): the doc-id, and in the Korean document the sha256 of the English one.
const body = `<!-- doc-id: features -->\n# Feature definitions\n\nThe executable source is the repository feature manifest. Read the manifest, then its \`source.read_order\` paths and every path listed by the selected feature. Each entry defines inputs, outputs, state transitions, errors, parity units, fixtures, tests, paired documentation, and executable verification commands.\n\n| ID | Feature | Status | Languages |\n|---|---|---|---|\n${table(false)}\n\n## Current behavior\n\n${descriptions(false)}\n\nRun make feature-check to validate paths and execute every verification command declared for non-planned features. An implemented feature requires tests and paired documentation; partial and planned are incomplete.\n`;
const korean = `<!-- doc-id: features -->\n<!-- source-sha256: ${createHash('sha256').update(body).digest('hex')} -->\n# 기능 정의\n\n실행 기준은 저장소의 기능 manifest이다. 먼저 manifest의 \`source.read_order\` 경로를 읽고 선택한 기능의 모든 참조 경로를 읽는다. 각 항목은 input, output, 상태 전이, 오류, parity unit, fixture, test, paired document, 실제 검증 명령을 정의한다.\n\n| ID | 기능 | 상태 | 언어 |\n|---|---|---|---|\n${table(true)}\n\n## 현재 동작\n\n${descriptions(true)}\n\nmake feature-check는 경로를 검사하고 planned가 아닌 기능의 검증 명령을 실제 실행한다. implemented 항목은 test와 paired document가 필요하다. partial과 planned는 미완료 상태다.\n`;
const outputs: [string, string][] = [['docs/features.md', body], ['docs/features.ko.md', korean]];
if (process.argv.includes('--check')) {
  for (const [relative, expected] of outputs) {
    // A missing document is a stale one; any other failure to read it is an error of its own.
    const actual = await readFile(resolve(root, relative), 'utf8').catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (actual !== expected) {
      console.error(`features: generated document is stale: ${relative}`);
      process.exit(1);
    }
  }
} else {
  for (const [relative, content] of outputs) await writeFile(resolve(root, relative), content);
}
console.log(`features: generated ${manifest.features.length} feature rows`);
log.end();
