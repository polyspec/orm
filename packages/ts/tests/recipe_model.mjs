// The generated-model ops of the recipe helper (docs/spec/feature-coverage.md FCV-4 model ops, FCV-14). Each op calls the
// generated model that its model name names, through the connection that model.connect bound. A model or a column without
// an entry here fails the case by name, so no recipe passes on a call that the helper does not make.
import { Author, CompositeAccount, connect } from '../dist/index.js';

// The keys that the generated models of the bench set read their encrypted columns with (the native model tests use them).
const BENCH_KEYS = { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' };

const columnsOf = values => Object.keys(values).sort();

/** The helpers of the recipe helper that the model ops use: the value of a field, and the native value of a wrapper. */
export function modelOps({ native, databaseValue, stepArgument }) {
  const valueOf = (value, context) => native(databaseValue(stepArgument(value, context), context));
  const objectValues = (object, context) => Object.fromEntries(Object.entries(object ?? {}).map(([k, v]) => [k, valueOf(v, context)]));
  const connection = (name, context) => {
    const db = context.bound.get(name);
    if (db === undefined) throw new Error(`model op: connection ${name} is not bound by model.connect`);
    return db;
  };

  const compositeSet = (db, values) => {
    const model = new CompositeAccount().connect(db);
    for (const column of columnsOf(values)) {
      switch (column) {
        case 'tenant_id': model.setTenantId(values[column]); break;
        case 'account_id': model.setAccountId(values[column]); break;
        case 'name': model.setName(values[column]); break;
        default: throw new Error(`CompositeAccount column ${column} has no recipe setter`);
      }
    }
    return model;
  };
  // CompositeAccount filters: the equality of its key columns, as the generated model names them.
  const compositeFilter = (db, where) => {
    const model = new CompositeAccount().connect(db);
    for (const column of columnsOf(where)) {
      switch (column) {
        case 'tenant_id': model.tenantId(where[column]); break;
        case 'account_id': model.accountId(where[column]); break;
        default: throw new Error(`CompositeAccount column ${column} has no recipe filter`);
      }
    }
    return model;
  };
  const compositeKey = (db, key) => new CompositeAccount().connect(db).getByTenantIdAndAccountId(key.tenant_id, key.account_id);
  const wrap = value => (typeof value === 'bigint' || typeof value === 'number' ? { int: String(value) } : { text: value });

  return {
    async 'model.connect'(s, context) {
      const db = await connect(context.dsn, BENCH_KEYS);
      context.closers.push(() => db.close());
      return { bind: db };
    },
    async 'model.create'(s, context) {
      await compositeSet(connection(s.connection, context), objectValues(s.values, context)).create();
      return {};
    },
    async 'model.creates'(s, context) {
      const db = connection(s.connection, context);
      const rows = s.rows.map(row => compositeSet(db, objectValues(row, context)));
      return { value: { int: String(await new CompositeAccount().connect(db).creates(rows, s.batch)) } };
    },
    async 'model.save'(s, context) {
      await compositeSet(connection(s.connection, context), objectValues(s.values, context)).save();
      return {};
    },
    async 'model.duplicate_create'(s, context) {
      const db = connection(s.connection, context);
      const model = compositeSet(db, objectValues(s.values, context));
      await model.duplication(compositeSet(db, objectValues(s.duplication, context))).create();
      return {};
    },
    async 'model.update'(s, context) {
      const db = connection(s.connection, context);
      const row = await compositeKey(db, objectValues(s.key, context));
      if (row === null) throw new Error('model.update: the key names no row');
      for (const column of columnsOf(objectValues(s.set, context))) {
        if (column !== 'name') throw new Error(`CompositeAccount column ${column} has no recipe update`);
        row.setName(objectValues(s.set, context).name);
      }
      await row.update();
      return {};
    },
    async 'model.delete'(s, context) {
      const db = connection(s.connection, context);
      await (await compositeFilter(db, objectValues(s.where, context)).gets()).delete();
      return {};
    },
    async 'model.count'(s, context) {
      const db = connection(s.connection, context);
      return { value: { int: String(await compositeFilter(db, objectValues(s.where, context)).getCount()) } };
    },
    async 'model.get_by'(s, context) {
      const db = connection(s.connection, context);
      if (s.model === 'Author') {
        const author = await new Author().connect(db).getBySeq(objectValues(s.key, context).seq);
        const cells = author === null ? [] : [s.columns.map(column => {
          if (column !== 'read_count') throw new Error(`Author column ${column} has no recipe getter`);
          return wrap(author.getReadCount());
        })];
        return { rows: cells };
      }
      const row = await compositeKey(db, objectValues(s.key, context));
      const rows = row === null ? [] : [s.columns.map(column => {
        if (column !== 'name') throw new Error(`CompositeAccount column ${column} has no recipe getter`);
        return wrap(row.getName());
      })];
      return { rows };
    },
    async 'model.query'(s, context) {
      const db = connection(s.connection, context);
      const collection = await compositeFilter(db, objectValues(s.where, context)).gets();
      const rows = collection.values().map(row => s.columns.map(column => {
        if (column !== 'name') throw new Error(`CompositeAccount column ${column} has no recipe getter`);
        return wrap(row.getName());
      }));
      return { rows };
    },
    async 'model.arithmetic'(s, context) {
      const db = connection(s.connection, context);
      if (s.column !== 'read_count') throw new Error(`Author column ${s.column} has no recipe arithmetic`);
      const row = await new Author().connect(db).getBySeq(objectValues(s.key, context).seq);
      if (row === null) throw new Error('model.arithmetic: the key names no row');
      const amount = valueOf(s.amount, context);
      if (s.operation === 'plus') row.plusReadCount(amount); else row.minusReadCount(amount);
      await row.update();
      return {};
    },
  };
}
