// The generated-model ops of the recipe helper (docs/spec/feature-coverage.md FCV-4 model ops, FCV-14). Each op calls the
// generated model that its model name names, through the connection that model.connect bound. A model or a column without
// an entry here fails the case by name, so no recipe passes on a call that the helper does not make.
import { lastAffected } from '../dist/testing.js';
import { Author, CompositeAccount, CompositeMembership, CORE, Db, Engine, fulltextBoolean, NoteReader, SharedNote, User } from '../dist/index.js';

// The keys that the generated models of the bench set read their encrypted columns with (the native model tests use them).
const BENCH_KEYS = { aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index' };

const columnsOf = values => Object.keys(values).sort();

// The Author equality conditions that the recipes name, by column: the condition method of the chain grammar.
const CONDITIONS = {
  seq: 'seq',
  user_seq: 'userSeq',
  service_seq: 'serviceSeq',
  service_region_seq: 'serviceRegionSeq',
  service_member_seq: 'serviceMemberSeq',
};

// The Author columns that a recipe may read, by column: the method that adds it to the projection, and its getter.
const COLUMNS = {
  seq: ['addColumnSeq', 'getSeq'],
  name: ['addColumnName', 'getName'],
  user_seq: ['addColumnUserSeq', 'getUserSeq'],
  service_seq: ['addColumnServiceSeq', 'getServiceSeq'],
  service_region_seq: ['addColumnServiceRegionSeq', 'getServiceRegionSeq'],
  service_member_seq: ['addColumnServiceMemberSeq', 'getServiceMemberSeq'],
  read_count: ['addColumnReadCount', 'getReadCount'],
  like_count: ['addColumnLikeCount', 'getLikeCount'],
  uuid: ['addColumnUuid', 'getUuid'],
  aes_key_version: ['addColumnAesKeyVersion', 'getAesKeyVersion'],
  aes_hex_email: ['addColumnAesHexEmail', 'getAesHexEmail'],
  aes_hex_phone: ['addColumnAesHexPhone', 'getAesHexPhone'],
};

// The Author orders that a recipe may name, ascending, by column.
// A name with a leading '-' is descending (FCV-4 model.query).
const ORDERS = { seq: 'orderBySeqAsc', name: 'orderByNameAsc', '-seq': 'orderBySeqDesc', '-name': 'orderByNameDesc' };

/** The helpers of the recipe helper that the model ops use: the value of a field, and the native value of a wrapper. */
/** The order, getter and lock methods of the CompositeAccount model ops, by recipe column and lock name. */
const COMPOSITE_ORDERS = { tenant_id: 'orderByTenantIdAsc', account_id: 'orderByAccountIdAsc', name: 'orderByNameAsc' };
const COMPOSITE_GETTERS = { tenant_id: 'getTenantId', account_id: 'getAccountId', name: 'getName' };
/** The getters of the CompositeMembership columns that a model.query relation reads, by recipe column. */
const MEMBERSHIP_GETTERS = { tenant_id: 'getTenantId', account_id: 'getAccountId', role: 'getRole' };
const LOCKS = { update: 'forUpdate', share: 'forShare', update_nowait: 'forUpdateNoWait', share_nowait: 'forShareNoWait' };

// The affected count of the last write on db, the value that the expect of a model write names (F15, PRT-60).
const affected = db => ({ value: { int: String(lastAffected(db)) } });

/** The DSN that a model.connect opens (FCV-4): the case database, unless its dsn is "case-socket" or the DSN text of the step. */
export function connectDsn(dsn, database, caseDsn, socket = process.env.ORM_TEST_MYSQL_SOCKET) {
  if (dsn === undefined || dsn === 'case') return caseDsn;
  if (dsn !== 'case-socket') return dsn;
  if (database !== 'mysql') throw new Error(`dsn case-socket needs mysql, not ${database}`);
  if (!socket) throw new Error('dsn case-socket: ORM_TEST_MYSQL_SOCKET is unset; run make orm-test-servers');
  const match = /^mysql:\/\/([^@/]+)@[^/]+\/([^?]+)/.exec(caseDsn);
  if (match === null) throw new Error(`dsn case-socket: the case DSN ${caseDsn} is not a mysql DSN`);
  return `mysql://${match[1]}@localhost/${match[2]}?socket=${socket}`;
}

export function modelOps({ native, databaseValue, stepArgument, auditSourceOf }) {
  const valueOf = (value, context) => native(databaseValue(stepArgument(value, context), context));
  const objectValues = (object, context) => Object.fromEntries(Object.entries(object ?? {}).map(([k, v]) => [k, valueOf(v, context)]));
  const connection = (name, context) => {
    const db = context.bound.get(name);
    if (db === undefined) throw new Error(`model op: connection ${name} is not bound by model.connect`);
    return db;
  };

  // A model on no connection (PLN-16) runs in the active transaction of its flow.
  const onConnection = (model, db) => (db === undefined ? model : model.connect(db));
  const compositeSet = (db, values) => {
    const model = onConnection(new CompositeAccount(), db);
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
  // CompositeAccount filters: the equality of its key columns, as the generated model names them, joined by and().
  const compositeFilter = (db, where) => {
    const model = onConnection(new CompositeAccount(), db);
    for (const [index, column] of columnsOf(where).entries()) {
      if (index > 0) model.and();
      switch (column) {
        case 'tenant_id': model.tenantId(where[column]); break;
        case 'account_id': model.accountId(where[column]); break;
        default: throw new Error(`CompositeAccount column ${column} has no recipe filter`);
      }
    }
    return model;
  };
  const membershipSet = (db, values) => {
    const model = new CompositeMembership().connect(db);
    for (const column of columnsOf(values)) {
      switch (column) {
        case 'tenant_id': model.setTenantId(values[column]); break;
        case 'account_id': model.setAccountId(values[column]); break;
        case 'role': model.setRole(values[column]); break;
        default: throw new Error(`CompositeMembership column ${column} has no recipe setter`);
      }
    }
    return model;
  };
  // CompositeMembership filters: the tenant_id equality of the recipe count.
  const membershipFilter = (db, where) => {
    const model = new CompositeMembership().connect(db);
    for (const [index, column] of columnsOf(where).entries()) {
      if (column !== 'tenant_id') throw new Error(`CompositeMembership column ${column} has no recipe filter`);
      if (index > 0) model.and();
      model.tenantId(where[column]);
    }
    return model;
  };
  // membershipRelation is the CompositeMembership child of a CompositeAccount query: one generated match call per pair in the
  // written order, connected to the query's connection when connect is true, otherwise left on the parent's (INT-87).
  const membershipRelation = (db, relation) => {
    if (relation.model !== 'CompositeMembership') throw new Error(`CompositeAccount relation ${relation.model} has no recipe entry`);
    let child = new CompositeMembership();
    for (const pair of relation.match) {
      if (pair[0] === 'tenant_id' && pair[1] === 'tenant_id') child = child.matchTenantIdWithTenantId();
      else if (pair[0] === 'account_id' && pair[1] === 'account_id') child = child.matchAccountIdWithAccountId();
      else throw new Error(`CompositeMembership match ${JSON.stringify(pair)} has no recipe entry`);
    }
    if (relation.alias === 'memberships') child = child.aliasMemberships();
    else if (relation.alias !== undefined) throw new Error(`CompositeMembership alias ${relation.alias} has no recipe entry`);
    if (relation.connect) child = child.connect(db);
    return child;
  };
  // membershipChildren reads the CompositeMembership rows of one parent: through the generated getter of the alias, or of the
  // result name of a relation without one. A parent without a child gives none.
  const membershipChildren = (row, relation) => {
    const result = relation.alias === 'memberships'
      ? row.getMemberships()
      : relation.many ? row.getCompositeMembershipModels() : row.getCompositeMembershipModel();
    if (result === undefined || result === null) return [];
    return relation.many ? [...result.values()] : [result];
  };
  const compositeKey = (db, key) => new CompositeAccount().connect(db).getByTenantIdAndAccountId(key.tenant_id, key.account_id);
  const wrap = value => (typeof value === 'bigint' || typeof value === 'number' ? { int: String(value) } : { text: value });

  // chain applies the equalities of where, ANDed in the order of their column names, then the projection of columns (an empty
  // list keeps the default columns of the model).
  const chain = (db, where, columns) => {
    const model = new Author().connect(db);
    // The int equalities come first in name order; the bool equality of is_close is andIsClose after them (the chain has no bool
    // condition that opens it). The equalities are ANDed, so the order of the conditions does not change the rows.
    const names = Object.keys(where).sort();
    const ordered = [...names.filter(column => typeof where[column] !== 'boolean'), ...names.filter(column => typeof where[column] === 'boolean')];
    ordered.forEach((column, index) => {
      if (typeof where[column] === 'boolean') {
        if (column !== 'is_close' || index === 0) throw new Error(`Author column ${column}: a bool equality needs the is_close column after an int equality`);
        model.andIsClose(where[column]);
        return;
      }
      const condition = CONDITIONS[column];
      if (condition === undefined) throw new Error(`Author column ${column} has no recipe condition`);
      if (typeof where[column] !== 'number' && typeof where[column] !== 'bigint') throw new Error(`Author column ${column}: want an int wrapper`);
      if (index > 0) model.and();
      model[condition](where[column]);
    });
    if (columns.length > 0) {
      model.removeAllColumns();
      for (const column of columns) {
        if (COLUMNS[column] === undefined) throw new Error(`Author column ${column} has no recipe column`);
        model[COLUMNS[column][0]]();
      }
    }
    return model;
  };

  const isMatch = match => Array.isArray(match) && match.length === 1 && match[0].length === 2 && match[0][0] === 'shared_note_seq' && match[0][1] === 'seq';
  const isTitle = columns => Array.isArray(columns) && columns.length === 1 && columns[0] === 'title';
  const isSeq = columns => Array.isArray(columns) && columns.length === 1 && columns[0] === 'seq';
  // rowCells is the recipe wrappers of the named columns of one row, in the order of columns.
  const cells = (row, columns) => columns.map(column => wrap(row[COLUMNS[column][1]]()));

  return {
    async 'model.connect'(s, context) {
      // The case schema is registered on the connection, as the statement-event ops need it (FCV-4, model.connect).
      // A step with aes_keyring connects with that keyring in place of the bench key (FCV-4, model.connect).
      const keys = s.aes_keyring === undefined
        ? BENCH_KEYS
        : { blindIndexKey: BENCH_KEYS.blindIndexKey, aesKeys: new Map(Object.entries(s.aes_keyring.versions).map(([version, key]) => [Number(version), key])), aesVersion: s.aes_keyring.current };
      const db = await Db.connectSchema(connectDsn(s.dsn, context.database, context.dsn), context.schema, { poolSize: s.pool_size, ...keys, ...auditSourceOf(s, context) });
      context.closers.push(() => db.close());
      return { bind: db };
    },
    async 'model.create'(s, context) {
      if (s.model !== 'CompositeAccount') throw new Error(`model ${s.model} has no model.create entry`);
      await compositeSet(s.unconnected === true ? undefined : connection(s.connection, context), objectValues(s.values, context)).create();
      return {};
    },
    async 'model.creates'(s, context) {
      const db = connection(s.connection, context);
      if (s.model === 'CompositeMembership') {
        const rows = s.rows.map(row => membershipSet(db, objectValues(row, context)));
        return { value: { int: String(await new CompositeMembership().connect(db).creates(rows, s.batch)) } };
      }
      const rows = s.rows.map(row => compositeSet(db, objectValues(row, context)));
      return { value: { int: String(await new CompositeAccount().connect(db).creates(rows, s.batch)) } };
    },
    async 'model.save'(s, context) {
      if (s.model === 'Author') {
        // A set of the key and the named columns, with no read before it, then one save.
        const values = objectValues(s.values, context);
        await new Author().connect(connection(s.connection, context)).setSeq(values.seq).setName(values.name).save();
        return {};
      }
      await compositeSet(connection(s.connection, context), objectValues(s.values, context)).save();
      return {};
    },
    async 'model.duplicate_create'(s, context) {
      if (s.model !== 'CompositeAccount') throw new Error(`model ${s.model} has no model.duplicate_create entry`);
      const db = connection(s.connection, context);
      const model = compositeSet(db, objectValues(s.values, context));
      await model.duplication(compositeSet(db, objectValues(s.duplication, context))).create();
      return {};
    },
    async 'model.update'(s, context) {
      const db = connection(s.connection, context);
      if (s.model === 'Author') {
        // The row of key, its set columns changed, then one update of the row (Update).
        const row = await chain(db, objectValues(s.key, context), []).get();
        if (row === null) throw new Error('Author update: the key names no row');
        const set = objectValues(s.set, context);
        for (const column of columnsOf(set)) {
          const value = set[column];
          if (column === 'like_count' && (typeof value === 'number' || typeof value === 'bigint')) row.setLikeCount(Number(value));
          else if (column === 'uuid' && typeof value === 'string') row.setUuid(value);
          else throw new Error(`Author column ${column} has no recipe update`);
        }
        await row.update();
        return {};
      }
      const row = await compositeKey(db, objectValues(s.key, context));
      if (row === null) throw new Error('model.update: the key names no row');
      for (const column of columnsOf(objectValues(s.set, context))) {
        if (column !== 'name') throw new Error(`CompositeAccount column ${column} has no recipe update`);
        row.setName(objectValues(s.set, context).name);
      }
      await row.update();
      return affected(db);
    },
    async 'model.delete'(s, context) {
      const db = connection(s.connection, context);
      if (s.model === 'User') {
        // The User rows of where, which is the seq only (the referenced-user case of constraint_errors).
        const where = objectValues(s.where, context);
        const columns = columnsOf(where);
        if (columns.length !== 1 || columns[0] !== 'seq' || (typeof where.seq !== 'number' && typeof where.seq !== 'bigint')) {
          throw new Error('User delete: the recipe condition is seq only');
        }
        await (await new User().connect(db).seq(where.seq).gets()).delete();
        return {};
      }
      await (await compositeFilter(db, objectValues(s.where, context)).gets()).delete();
      return affected(db);
    },
    async 'model.count'(s, context) {
      if (s.unconnected === true) return { value: { int: String(await compositeFilter(undefined, objectValues(s.where ?? {}, context)).getCount()) } };
      const db = connection(s.connection, context);
      if (s.model === 'Author') return { value: wrap(await chain(db, objectValues(s.where, context), []).getCount()) };
      const filter = s.model === 'CompositeMembership' ? membershipFilter : compositeFilter;
      return { value: { int: String(await filter(db, objectValues(s.where, context)).getCount()) } };
    },
    // query.search (FCV-4, PRT-75): a count with a fulltext_boolean chain key over the columns. The statement is compiled with
    // the engine of the case dialect (DIA-187 refuses SQLite); a blank text runs on the case connection, where the bind check
    // refuses it with IR_INVALID (DIA-6).
    async 'query.search'(s, context) {
      const db = connection(s.connection, context);
      if (s.model !== 'Author') throw new Error(`model ${s.model} has no query.search entry`);
      const author = new Author().connect(db);
      author[CORE].whereChain('', [{ conn: '', op: 'fulltext_boolean', column: '', columns: s.columns, compare: '' }], [s.text]);
      const built = author[CORE].build('count');
      const plan = new Engine(Author.entity.model, context.database).compile(built.finish());
      // The value is the one the statement binds: the transform that the plan declares for its slot (DIA-6 declares
      // fulltext_boolean on MySQL only; PostgreSQL binds the text as it is).
      const boolean = plan.steps[0].bind_slots[0]?.transform === 'fulltext_boolean';
      const value = boolean ? fulltextBoolean(s.text) : s.text;
      if (boolean && value === '') {
        await author.getCount();
        throw new Error('query.search ran a blank text without a bind-check error');
      }
      return { sql: plan.steps[0].sql, params: [{ text: value }] };
    },
    // query.search_chain (FCV-4): the statement of the generated fulltext method of the mode, through getQuery.
    async 'query.search_chain'(s, context) {
      const db = connection(s.connection, context);
      if (s.model !== 'Author') throw new Error(`model ${s.model} has no query.search_chain entry`);
      const author = new Author().connect(db);
      const chain = s.mode === 'fulltext_boolean'
        ? author.fulltextBooleanNameWithDescription(s.text)
        : author.fulltextNameWithDescription(s.text);
      const statement = await chain.getQuery();
      return { sql: statement.sql, params: statement.binds.map(bind => ({ text: bind })) };
    },
    async 'model.get_by'(s, context) {
      const db = connection(s.connection, context);
      if (s.model === 'Author') {
        // The key and the where are one chain: the equalities, the projection of columns, then the terminal get.
        const found = await chain(db, objectValues(s.where ?? s.key, context), s.columns).get();
        return { rows: found === null ? [] : [cells(found, s.columns)] };
      }
      if (s.where !== undefined) throw new Error(`model ${s.model} has no recipe where`);
      const row = await compositeKey(db, objectValues(s.key, context));
      const rows = row === null ? [] : [s.columns.map(column => {
        if (column !== 'name') throw new Error(`CompositeAccount column ${column} has no recipe getter`);
        return wrap(row.getName());
      })];
      return { rows };
    },
    async 'model.query'(s, context) {
      const { columns } = s;
      const db = connection(s.connection, context);
      if (s.model === 'NoteReader') {
        // The rows of NoteReader in seq order, each with the title of its SharedNote row; a reader without a note
        // contributes no row (FCV-4 relation).
        const relation = s.relation;
        if (relation === undefined) throw new Error('NoteReader model.query needs its relation');
        if (relation.model !== 'SharedNote' || !isMatch(relation.match) || !isTitle(relation.columns)) {
          throw new Error(`NoteReader relation ${JSON.stringify(relation)} has no recipe entry`);
        }
        if (!isSeq(columns) || !isSeq(s.order) || Object.keys(s.where ?? {}).length > 0) throw new Error('NoteReader query has no recipe entry for this shape');
        const collection = await new NoteReader().connect(db).relation(new SharedNote().matchSharedNoteSeqWithSeq()).orderBySeqAsc().gets();
        const rows = [];
        for (const row of collection.values()) {
          const child = row.getSharedNoteModel();
          if (child === undefined || child === null) continue;
          rows.push([wrap(row.getSeq()), wrap(child.getTitle())]);
        }
        return { rows };
      }
      if (s.model === 'Author') {
        const model = chain(db, objectValues(s.where, context), columns);
        for (const column of s.order ?? []) {
          if (ORDERS[column] === undefined) throw new Error(`Author column ${column} has no recipe order`);
          model[ORDERS[column]]();
        }
        const offset = s.offset ?? 0;
        if ((s.limit ?? 0) > 0 || offset > 0) model.limit(offset, s.limit ?? 0);
        const collection = await model.gets();
        return { rows: collection.values().map(row => cells(row, columns)) };
      }
      const model = compositeFilter(db, objectValues(s.where, context));
      if (s.tuples !== undefined) {
        // The tuples narrow the chain through the generated tuple filter of the composite key, joined by and to the equalities before it.
        const { columns, values } = s.tuples;
        if (columns.length !== 2 || columns[0] !== 'tenant_id' || columns[1] !== 'account_id') throw new Error(`CompositeAccount tuple ${columns} has no recipe filter`);
        if (Object.keys(s.where ?? {}).length > 0) model.and();
        model.tupleTenantIdWithAccountId(values.map(tuple => {
          if (tuple.length !== 2) throw new Error(`a CompositeAccount tuple has ${tuple.length} values, not 2`);
          return tuple.map(value => valueOf(value, context));
        }));
      }
      for (const column of s.order ?? []) {
        if (COMPOSITE_ORDERS[column] === undefined) throw new Error(`CompositeAccount column ${column} has no recipe order`);
        model[COMPOSITE_ORDERS[column]]();
      }
      let child;
      if (s.relation !== undefined) {
        child = membershipRelation(db, s.relation);
        if (s.relation.many) model.relations(child);
        else model.relation(child);
      }
      // The lock of a model.query (INT-47): a lock outside a transaction is refused with CONFIG.
      if (s.lock !== undefined) {
        if (LOCKS[s.lock] === undefined) throw new Error(`lock ${s.lock} is not a lock of the recipe`);
        model[LOCKS[s.lock]]();
      }
      const collection = await model.gets();
      const rows = [];
      for (const row of collection.values()) {
        const cells = columns.map(column => {
          if (COMPOSITE_GETTERS[column] === undefined) throw new Error(`CompositeAccount column ${column} has no recipe getter`);
          return wrap(row[COMPOSITE_GETTERS[column]]());
        });
        if (child === undefined) {
          rows.push(cells);
          continue;
        }
        // Each child row gives one output row, the parent's columns followed by the child's; a parent with no child gives none.
        for (const member of membershipChildren(row, s.relation)) {
          rows.push([...cells, ...s.relation.columns.map(column => {
            if (MEMBERSHIP_GETTERS[column] === undefined) throw new Error(`CompositeMembership column ${column} has no recipe getter`);
            return wrap(member[MEMBERSHIP_GETTERS[column]]());
          })]);
        }
      }
      return { rows };
    },
    async 'model.arithmetic'(s, context) {
      const db = connection(s.connection, context);
      if (s.model !== 'Author') throw new Error(`model ${s.model} has no model.arithmetic entry`);
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
