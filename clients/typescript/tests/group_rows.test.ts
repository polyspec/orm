import type { GroupRows } from '../src/index.js';
import { Author } from '../src/models/models.js';

async function generatedGroupResult(): Promise<GroupRows> {
  return new Author().groupByIsClose().getsCount();
}

void generatedGroupResult;
