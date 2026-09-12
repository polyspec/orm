import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('../..', import.meta.url).pathname);
const manifest = JSON.parse(await readFile(resolve(root, 'contracts/features.json'), 'utf8'));
const clients = ['go', 'php', 'rust', 'typescript'];
const table = (ko) => manifest.features.map(feature => `| ${feature.id} | ${ko ? feature.title_ko : feature.title} | ${feature.status} | ${clients.map(client => `${client}: ${feature.clients[client]}`).join('<br>')} |`).join('\n');
const body = `# Feature contracts\n\nThe executable source is [contracts/features.json](../contracts/features.json). Read the manifest, then its \`source.read_order\` paths and every path listed by the selected feature. Each entry defines inputs, outputs, state transitions, errors, client support, fixtures, tests, paired documentation, and executable verification commands.\n\n| ID | Feature | Status | Client support |\n|---|---|---|---|\n${table(false)}\n\nRun make feature-check to validate paths and execute every verification command declared for non-planned features. An implemented feature requires tests and paired documentation; partial and planned are incomplete.\n`;
const korean = `# Feature contract\n\n실행 정본은 [contracts/features.json](../contracts/features.json)이다. 먼저 매니페스트의 \`source.read_order\` 경로를 읽고 선택한 기능의 모든 참조 경로를 읽는다. 각 항목은 input, output, 상태 전이, 오류, client 지원 상태, fixture, test, paired document, 실제 검증 명령을 정의한다.\n\n| ID | 기능 | 상태 | Client 지원 |\n|---|---|---|---|\n${table(true)}\n\nmake feature-check는 경로를 검사하고 planned가 아닌 기능의 검증 명령을 실제 실행한다. implemented 항목은 test와 paired document가 필요하다. partial과 planned는 미완료 상태다.\n`;
const outputs = [['docs/features.md', body], ['docs/features.ko.md', korean]];
if (process.argv.includes('--check')) {
  for (const [relative, expected] of outputs) {
    const actual = await readFile(resolve(root, relative), 'utf8').catch(() => '');
    if (actual !== expected) {
      console.error(`features: generated document is stale: ${relative}`);
      process.exit(1);
    }
  }
} else {
  for (const [relative, content] of outputs) await writeFile(resolve(root, relative), content);
}
console.log(`features: generated ${manifest.features.length} feature rows`);
