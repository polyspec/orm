import { caseTest, COMPUTE } from '../../tests/testcase.mjs';
import assert from 'node:assert/strict';
import { checkChecklistPair } from './check.mjs';

const english = '- [ ] A1 Waiting\n- [~] A2 Running\n- [o] A3 Done\n- [!] A4 Bypassed. Cause: server unavailable. Retry: server responds.\n';
const korean = '- [ ] A1 대기\n- [~] A2 진행\n- [o] A3 완료\n- [!] A4 우회. 원인: 서버 사용 불가. 재시도: 서버 응답.\n';

caseTest('accepts aligned four-state checklists', COMPUTE, () => {
  assert.deepEqual(checkChecklistPair(english, korean), []);
});

caseTest('rejects old and unknown states', COMPUTE, () => {
  assert.match(checkChecklistPair(english.replace('[o]', '[x]'), korean).join('\n'), /invalid state/);
});

caseTest('rejects missing paired item and mismatched state', COMPUTE, () => {
  assert.match(checkChecklistPair(english, korean.replace('A3', 'A5')).join('\n'), /item IDs/);
  assert.match(checkChecklistPair(english, korean.replace('[~]', '[ ]')).join('\n'), /state differs/);
});

caseTest('requires a cause and retry condition for a bypass in both languages', COMPUTE, () => {
  assert.match(checkChecklistPair(english.replace('Retry: server responds.', ''), korean).join('\n'), /retry condition/);
  assert.match(checkChecklistPair(english, korean.replace('원인: 서버 사용 불가.', '')).join('\n'), /cause/);
});

caseTest('rejects unnumbered policy and status prose in the task tracker', COMPUTE, () => {
  const withPolicy = `${english}\nRules: use a timer for every request.\n`;
  assert.match(checkChecklistPair(withPolicy, korean).join('\n'), /unnumbered content/);
  const withStatus = `${english}\n## Current status\n- Every client is complete.\n`;
  assert.match(checkChecklistPair(withStatus, korean).join('\n'), /unnumbered content/);
  const withLane = `${english}\n## Work lanes\n| Lane | Completion |\n`;
  assert.match(checkChecklistPair(withLane, korean).join('\n'), /unnumbered content/);
});

caseTest('compares the ids and states of indented sub-items too', COMPUTE, () => {
  const englishSub = `${english}  - [o] A3.1 Done part\n  - [~] A3-2 Running part\n    continued text\n`;
  const koreanSub = `${korean}  - [o] A3.1 완료한 부분\n  - [~] A3-2 진행 중인 부분\n    이어지는 글\n`;
  assert.deepEqual(checkChecklistPair(englishSub, koreanSub), []);
  assert.match(checkChecklistPair(englishSub, koreanSub.replace('[~] A3-2', '[o] A3-2')).join('\n'), /A3-2: English and Korean state differs/);
  assert.match(checkChecklistPair(englishSub, koreanSub.replace('A3-2', 'A3-3')).join('\n'), /item IDs/);
  assert.match(checkChecklistPair(englishSub.replace('[o] A3.1', '[x] A3.1'), koreanSub).join('\n'), /invalid state \[x\] for A3\.1/);
  assert.match(checkChecklistPair(englishSub, koreanSub.replace('  - [o] A3.1 완료한 부분\n', '  - [o] A3.1 완료한 부분\n  - [o] A3.1 다시\n')).join('\n'), /duplicate item ID A3\.1/);
});
