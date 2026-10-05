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

// marker case는 상태 표시(대기, 진행 중, 완료, 우회의 괄호 표시)가 항목과 하위 항목의 맨 앞 상태가 아닌 곳(범례,
// 제목, 항목의 글, 이어지는 글, inline code)에 있으면 file, 줄, 열과 함께 거부하는지 확인한다. 예외와 허용
// 목록은 없고, 범례 줄은 그 자체로 항목이 아닌 내용이다.
caseTest('rejects a state marker anywhere but the leading state of an item', COMPUTE, () => {
  const legend = '# Checklist\n\nLegend: `[ ]` waiting, `[~]` in progress.\n\n';
  const englishText = `${legend}- [ ] A1 Waiting\n- [~] A2 Running while A1 is [~] too\n- [o] A3 Done, see \`  - [o] A3.1\`\n  continued while [!] bypassed\n- [!] A4 Bypassed. Cause: server unavailable. Retry: server responds.\n`;
  const koreanText = `# 체크리스트\n\n${korean}`;
  assert.deepEqual(checkChecklistPair(englishText, koreanText), [
    'docs/checklist.md:3:10: state marker [ ] outside the leading state of an item',
    'docs/checklist.md:3:25: state marker [~] outside the leading state of an item',
    'en:3: unnumbered content in task tracker',
    'docs/checklist.md:6:30: state marker [~] outside the leading state of an item',
    'docs/checklist.md:7:25: state marker [o] outside the leading state of an item',
    'docs/checklist.md:8:19: state marker [!] outside the leading state of an item',
  ]);
  assert.deepEqual(checkChecklistPair(`# Checklist\n\n${english}`, `# 체크리스트\n\n${korean}`), []);
});

// GitHub task list는 [x]와 [X]도 상태로 읽으므로, 그 표시도 항목 맨 앞의 상태가 아닌 곳에서는 거부한다. 맨 앞의
// [x]는 이 checklist의 상태가 아니므로 invalid state 하나로만 보고한다.
caseTest('rejects the GitHub task list markers x and X outside the leading state of an item', COMPUTE, () => {
  const koreanText = `# 체크리스트\n\n- [ ] A1 대기, GitHub의 [x] 표시\n- [~] A2 진행\n  이어지는 [X] 글\n- [o] A3 완료\n- [!] A4 우회. 원인: 서버 사용 불가. 재시도: 서버 응답.\n`;
  assert.deepEqual(checkChecklistPair(`# Checklist\n\n${english}`, koreanText), [
    'docs/checklist.ko.md:3:22: state marker [x] outside the leading state of an item',
    'docs/checklist.ko.md:5:8: state marker [X] outside the leading state of an item',
  ]);
  assert.deepEqual(checkChecklistPair(`# Checklist\n\n${english.replace('- [o] A3', '- [x] A3')}`, `# 체크리스트\n\n${korean}`), [
    'en:5: invalid state [x] for A3',
    'A3: English and Korean state differs',
  ]);
});
