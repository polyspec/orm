// tests/dbspec runner가 input file을 읽는다. 읽을 수 없는 input은 "<path>: <reason>"을
// stderr에 쓰고 1로 끝난다.
import { readFileSync } from 'node:fs';

// readInput은 path의 UTF-8 내용을 돌려주고, 읽을 수 없으면 그 경로와 이유를 쓰고 끝낸다.
export function readInput(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`${path}: ${error.message}`);
    process.exit(1);
  }
}
