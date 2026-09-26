import type { GroupRows } from '../src/index.js';
import { Battle } from '../src/models/models.js';

async function generatedGroupResult(): Promise<GroupRows> {
  return new Battle().groupByIsClose().getsCount();
}

void generatedGroupResult;
