import { readFile } from 'node:fs/promises';
import { createCaseAssertions } from './check-state.mjs';

/** Loads one schema fixture, its generated model and the common state for a database case program. */
export async function loadDatabaseCaseFixture(filename, modelName, { modelFactory, report } = {}) {
  const fixtureUrl = new URL(`../../../contracts/fixtures/${filename}`, import.meta.url);
  const text = await readFile(fixtureUrl, 'utf8');
  const factory = modelFactory ?? (await import('./registered_models.mjs')).models;
  const model = factory(text)[modelName];
  if (typeof model !== 'function') throw new Error(`${filename} does not provide model ${modelName}`);
  const state = { failures: 0, current: '' };
  const { check, raised } = createCaseAssertions(() => state.current, () => { state.failures++; }, undefined, report);
  return { text, model, deadline: 30_000, state, check, raised };
}
