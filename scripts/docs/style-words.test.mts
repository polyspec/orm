import assert from 'node:assert/strict';
import { caseTest } from '../../tests/testcase.mts';
import { holdsStyleEntry } from './style-words.mts';

caseTest('a Korean entry inside a longer word is not found', () => {
  assert.equal(holdsStyleEntry('독립 작업을 먼저 끝낸다.', '낸다', 'ko'), false);
  assert.equal(holdsStyleEntry('required로 남는 이유도 같다.', '유도', 'ko'), false);
  assert.equal(holdsStyleEntry('서버는 오류 코드로 응답한다.', '답한다', 'ko'), false);
});

caseTest('a Korean entry at the start of an eojeol is found, with or without a particle or an ending after it', () => {
  assert.equal(holdsStyleEntry('검사는 지적 34건을 낸다.', '낸다', 'ko'), true);
  assert.equal(holdsStyleEntry('호출자를 유도한다.', '유도', 'ko'), true);
  assert.equal(holdsStyleEntry('서버는 오류 코드를 답한다(PRT-71).', '답한다', 'ko'), true);
  assert.equal(holdsStyleEntry('모듈의 경계를 정한다.', '경계', 'ko'), true);
  assert.equal(holdsStyleEntry('유도', '유도', 'ko'), true);
  assert.equal(holdsStyleEntry('값은 "유도"다.', '유도', 'ko'), true);
});

caseTest('a Korean entry of several words is found across any white space', () => {
  assert.equal(holdsStyleEntry('규칙을 못 박다.', '못 박다', 'ko'), true);
  assert.equal(holdsStyleEntry('규칙을 못\n  박다.', '못 박다', 'ko'), true);
  assert.equal(holdsStyleEntry('규칙을 못박다.', '못 박다', 'ko'), false);
});

caseTest('an English entry is a whole word, whatever its case', () => {
  assert.equal(holdsStyleEntry('The Gate of the run.', 'gate', 'en'), true);
  assert.equal(holdsStyleEntry('The gates of kit.', 'gate', 'en'), false);
  assert.equal(holdsStyleEntry('It investigates the run.', 'gate', 'en'), false);
});

caseTest('an entry with outer spaces or no word is refused', () => {
  assert.throws(() => holdsStyleEntry('text', ' 유도', 'ko'), /outer spaces/);
  assert.throws(() => holdsStyleEntry('text', '', 'en'), /empty/);
});
