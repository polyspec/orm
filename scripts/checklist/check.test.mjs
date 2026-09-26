import test from 'node:test';
import assert from 'node:assert/strict';
import { checkChecklistPair } from './check.mjs';

const english = '- [ ] A1 Waiting\n- [~] A2 Running\n- [o] A3 Done\n- [!] A4 Bypassed. Cause: server unavailable. Retry: server responds.\n';
const korean = '- [ ] A1 대기\n- [~] A2 진행\n- [o] A3 완료\n- [!] A4 우회. 원인: 서버 사용 불가. 재시도: 서버 응답.\n';

test('accepts aligned four-state checklists', () => {
  assert.deepEqual(checkChecklistPair(english, korean), []);
});

test('rejects old and unknown states', () => {
  assert.match(checkChecklistPair(english.replace('[o]', '[x]'), korean).join('\n'), /invalid state/);
});

test('rejects missing paired item and mismatched state', () => {
  assert.match(checkChecklistPair(english, korean.replace('A3', 'A5')).join('\n'), /item IDs/);
  assert.match(checkChecklistPair(english, korean.replace('[~]', '[ ]')).join('\n'), /state differs/);
});

test('requires a cause and retry condition for a bypass in both languages', () => {
  assert.match(checkChecklistPair(english.replace('Retry: server responds.', ''), korean).join('\n'), /retry condition/);
  assert.match(checkChecklistPair(english, korean.replace('원인: 서버 사용 불가.', '')).join('\n'), /cause/);
});

test('rejects unnumbered policy and status prose in the task tracker', () => {
  const withPolicy = `${english}\nRules: use a timer for every request.\n`;
  assert.match(checkChecklistPair(withPolicy, korean).join('\n'), /unnumbered content/);
  const withStatus = `${english}\n## Current status\n- Every client is complete.\n`;
  assert.match(checkChecklistPair(withStatus, korean).join('\n'), /unnumbered content/);
  const withLane = `${english}\n## Work lanes\n| Lane | Completion |\n`;
  assert.match(checkChecklistPair(withLane, korean).join('\n'), /unnumbered content/);
});
