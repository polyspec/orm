import assert from 'node:assert/strict';
import test from 'node:test';
import { classesFromModel, models } from './registered_models.mjs';

test('registers a model class for each entity in the document', () => {
  const text = [
    'dbspec 1 test',
    '',
    'table item {',
    '  id i64 identity',
    '  value varchar(20)',
    '  primary key (id)',
    '}',
    '',
  ].join('\n');
  const registered = models(text);

  assert.deepEqual(Object.keys(registered), ['item']);
  assert.equal(registered.item.entity.entity.name, 'item');
  assert.ok(registered.item.entity.model);
  assert.equal(registered.item.entity.model.entities.get('item'), registered.item.entity.entity);
  assert.equal(typeof registered.item.entity.create, 'function');
  assert.deepEqual(Object.keys(classesFromModel(registered.item.entity.model)), ['item']);
});
