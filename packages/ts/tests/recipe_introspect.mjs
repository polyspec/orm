// The dbspec.introspect op (docs/spec/feature-coverage.md FCV-4, DIA-133, DIA-198) of the recipe runner.
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { dbspecManifest, emitDbspec, introspectDbspec, parseDbspec, readDbspecFile, renderDbspec } from '../dist/dbspec/index.js';
import { nativeSession } from './coverage_case.mjs';

const CONNECTION_RULES = {
  mysql: ["SET time_zone = '+00:00'"],
  postgres: ['SET client_min_messages = warning', "SET TimeZone = 'UTC'"],
  sqlite: ['PRAGMA foreign_keys = ON'],
};

// counting wraps a native connection so that each catalog query of the introspection is counted: query on MySQL and
// PostgreSQL, prepare on SQLite.
function counting(database, connection) {
  const counter = { count: 0 };
  const method = database === 'sqlite' ? 'prepare' : 'query';
  const proxy = new Proxy(connection, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property !== method) return value.bind(target);
      return (...args) => {
        counter.count++;
        return value.apply(target, args);
      };
    },
  });
  return { proxy, counter };
}

// sourceOf is the documents of a step by name and its vector, which is empty for a step with paths.
function sourceOf(step, dir) {
  if (step.paths !== undefined) {
    const texts = {};
    for (const path of step.paths) {
      const read = readDbspecFile(resolve(dir, path));
      if (read.text === null) throw new Error(`${path}: ${JSON.stringify(read.diagnostics)}`);
      texts[basename(path, '.dbs')] = read.text;
    }
    return { texts, vector: {} };
  }
  const vectors = JSON.parse(readFileSync(resolve(dir, step.vectors), 'utf8'));
  const vector = vectors.cases.find(candidate => candidate.id === step.case);
  if (vector === undefined) throw new Error(`the vectors have no case ${step.case}`);
  const texts = {};
  for (const [name, lines] of Object.entries(vector.documents)) texts[name] = `${lines.join('\n')}\n`;
  return { texts, vector };
}

function parseSet(texts) {
  return Object.keys(texts).sort().map(name => {
    const others = { ...texts };
    delete others[name];
    const { document, diagnostics } = parseDbspec(texts[name], others);
    if (document === null) throw new Error(`${name}: ${JSON.stringify(diagnostics)}`);
    return document;
  });
}

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// schemaText is the schema text of one document that holds the tables of documents in name order.
function schemaText(documents) {
  const tables = documents.flatMap(document => document.tables).sort((a, b) => byteOrder(a.name, b.name));
  const { manifest, diagnostics } = dbspecManifest([{ name: 'introspected', uses: [], tables, diagrams: [], closingComments: [] }]);
  if (manifest === null || manifest === undefined) throw new Error(`the manifest is refused: ${JSON.stringify(diagnostics)}`);
  return manifest.schemaText;
}

// schemaName is what {schema} of a vector statement names on the case database.
function schemaName(database, dsn) {
  if (database === 'mysql') return decodeURIComponent(new URL(dsn).pathname.slice(1));
  return database === 'postgres' ? 'public' : 'main';
}

// catalogQueryFailure introspects the empty case database with the catalog queries of another dialect: their failure is the
// error of the call (DIA-133). The connection answers query as the driver of that dialect does, so that what fails is the SQL.
async function catalogQueryFailure(dialect, database, dsn) {
  const session = await nativeSession(database, dsn);
  try {
    const answering = { query: async statement => [await session.query(statement.sql ?? statement)] };
    const failure = await introspectDbspec(answering, dialect, 'introspected').then(() => null, error => error);
    if (failure === null) throw new Error(`the ${dialect} catalog queries did not fail on ${database}`);
    if (failure instanceof TypeError) throw failure;
    return { failed: true };
  } finally {
    await session.close();
  }
}

// introspectStep runs a dbspec.introspect step: on one native connection of the case database, the connection rules, the
// rendered documents and the statements of the vector, then the public introspectDbspec. A vector with a document compares
// the emitted document and the unsupported objects; any other requires none unsupported and the schema text of the source.
// Its result is the number of catalog queries, which the expect of the database compares (DIA-133, DIA-198).
export async function introspectStep(step, context) {
  const { database, dsn, dir } = context;
  if (step.catalog_of !== undefined) return catalogQueryFailure(step.catalog_of, database, dsn);
  const { texts, vector } = sourceOf(step, dir);
  const documents = parseSet(texts);
  const rendered = renderDbspec(documents, database);
  if (rendered.diagnostics.length > 0) throw new Error(`render: ${JSON.stringify(rendered.diagnostics)}`);
  // tests/dbspec/ddl.json holds the rendered statements of each dialect as an object; only a list runs.
  const extra = Array.isArray(vector.statements) ? vector.statements : [];
  const session = await nativeSession(database, dsn);
  let result;
  let counter;
  try {
    const schema = schemaName(database, dsn);
    for (const sql of [...CONNECTION_RULES[database], ...rendered.statements, ...extra]) await session.query(sql.replaceAll('{schema}', schema));
    const counted = counting(database, session.connection);
    counter = counted.counter;
    result = await introspectDbspec(counted.proxy, database, 'introspected');
  } finally {
    await session.close();
  }
  const { document, unsupported } = result;
  if (vector.document !== undefined) {
    const got = emitDbspec(document);
    if (got !== `${vector.document.join('\n')}\n`) throw new Error(`the introspected document differs:\n${got}`);
    const triples = JSON.stringify(unsupported.map(item => [item.kind, item.table, item.name]));
    const want = JSON.stringify(vector.unsupported.map(entry => entry.slice(0, 3)));
    if (triples !== want) throw new Error(`unsupported objects ${triples}, want ${want}`);
    for (const item of unsupported) {
      if (item.reason.length === 0) throw new Error(`the reason of ${item.kind} ${item.table} ${item.name} is empty`);
    }
    vector.unsupported.forEach((entry, index) => {
      if (entry.length === 4 && !unsupported[index].reason.includes(entry[3])) {
        throw new Error(`the reason of ${entry.slice(0, 3).join(' ')}: ${unsupported[index].reason}, want rule ${entry[3]}`);
      }
    });
  } else {
    if (unsupported.length > 0) throw new Error(`unsupported objects ${JSON.stringify(unsupported)}`);
    const got = schemaText([document]);
    const want = schemaText(documents);
    if (got !== want) throw new Error(`the schema text differs:\n${got}\nwant\n${want}`);
  }
  return { queries: counter.count };
}
