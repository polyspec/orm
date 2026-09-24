// models.ts generation. The file declares one class per entity with the
// fixed column methods. Methods named by the chain grammar are resolved at
// run time from the method name; their types are declared for the names the
// scanned sources call, so an unknown name or a wrong value type fails the
// type check.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Column, Entity, LoadedManifest, Manifest } from '../engine/manifest.js';
import { category, checkColumnNames, columnName, functionColumn, numeric, parseChain, pascal, splitPair, validOrder, type ChainKey } from './names.js';
import { scanCallNames } from './scan.js';

function tsString(s: string): string {
  return `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`;
}

function byteOrder(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** The value type of a column in conditions and setters. */
function tsScalar(c: Column): string {
  switch (category(c)) {
    case 'int': case 'float': return 'number';
    case 'decimal': return 'number | string';
    case 'bool': return 'boolean';
    case 'time': return 'string | Date';
    case 'bytes': return 'Uint8Array';
    case 'point': return 'Point';
    case 'none': return 'unknown';
  }
  return 'string';
}

/** The type a getter returns. */
function tsField(c: Column): string {
  let t: string;
  switch (category(c)) {
    case 'time': t = 'string'; break;
    case 'decimal': t = 'number'; break;
    case 'none': return 'unknown';
    default: t = tsScalar(c);
  }
  return c.nullable ? `${t} | null` : t;
}

const baseMethods = ['connect', 'and', 'or', 'raw', 'andRaw', 'orRaw', 'on', 'relation', 'relations', 'limit', 'orderByRandom', 'orderByRaw', 'groupByRaw',
  'removeAllColumns', 'addAllColumns', 'parentNode', 'groupLimit', 'deleteLock', 'fetchKey', 'fetchValue', 'forUpdate', 'forShare', 'forUpdateNoWait',
  'forShareNoWait', 'duplication', 'get', 'gets', 'getsCount', 'getCount', 'getSum', 'getAvg', 'getsPage', 'getQuery', 'create', 'creates', 'update',
  'save', 'delete', 'toArray', 'toJSON', 'constructor'];

function staticNames(e: Entity): Set<string> {
  const out = new Set(baseMethods);
  for (const c of e.columns) {
    const p = pascal(c.name);
    for (const prefix of ['get', 'set', 'setRaw', 'addColumn', 'removeColumn', 'groupBy', 'keyName']) out.add(prefix + p);
    out.add(`orderBy${p}Asc`);
    out.add(`orderBy${p}Desc`);
    if (numeric(c)) for (const prefix of ['plus', 'minus', 'sum', 'avg']) out.add(prefix + p);
  }
  for (const name of Object.keys(e.indexes ?? {})) out.add(`forceIndex${pascal(name)}`);
  return out;
}

function isUpperAt(s: string, i: number): boolean { return s[i]! >= 'A' && s[i]! <= 'Z'; }

class Generator {
  public readonly methods = new Map<string, Map<string, string>>();
  public readonly getters = new Map<string, string>();

  public constructor(private readonly m: Manifest) {}

  /** The union of model classes that have the column. */
  private owners(column: string): string {
    return this.m.order.filter(name => this.m.entities[name]!.columns.some(c => c.name === column)).map(pascal).join(' | ');
  }

  private column(e: Entity, name: string): Column { return e.columns.find(c => c.name === name)!; }

  private keyType(e: Entity, k: ChainKey): string {
    switch (k.op) {
      case 'fulltext': case 'fulltext_boolean': return 'string';
      case 'tuple': case 'ne_tuple': return `ReadonlyArray<readonly [${k.columns.map(c => tsScalar(this.column(e, c))).join(', ')}]>`;
    }
    if (k.compare !== '') return this.owners(k.compare);
    const c = this.column(e, k.column);
    const s = tsScalar(c);
    const plain = category(c) !== 'point' && category(c) !== 'none';
    const terms: string[] = [];
    switch (k.op) {
      case '': case 'ne':
        if (plain) terms.push(s, `readonly (${s})[]`);
        terms.push('ValueFunction');
        if (plain) terms.push('Model');
        if (c.nullable) terms.push('null');
        break;
      case 'lk': case 'lb':
        terms.push('string');
        break;
      case 'between':
        terms.push(`readonly [${s}, ${s}]`);
        break;
      default:
        if (plain) terms.push(s);
        terms.push('ValueFunction');
    }
    return terms.join(' | ');
  }

  private chainParams(e: Entity, keys: readonly ChainKey[]): string {
    const params = keys.map((k, i) => `v${i}: ${this.keyType(e, k)}`);
    const k = keys[0]!;
    if (keys.length === 1 && k.compare === '' && k.column !== '' && ['', 'ne', 'gt', 'lt', 'ge', 'le'].includes(k.op) && functionColumn(this.column(e, k.column))) {
      return `...args: [${params[0]}] | [v0: ColumnFunction, compared: unknown]`;
    }
    return params.join(', ');
  }

  /** The declaration of a method named by the chain grammar. */
  public declare(e: Entity, name: string): string | undefined {
    const P = name[0]!.toUpperCase() + name.slice(1);
    for (const [prefix, result] of [['GetsBy', 'Promise<Collection<this>>'], ['GetBy', 'Promise<this>'], ['GetCountBy', 'Promise<number>']] as const) {
      if (!P.startsWith(prefix)) continue;
      const keys = parseChain(this.m, e, P.slice(prefix.length));
      return keys ? `${name}(${this.chainParams(e, keys)}): ${result};` : undefined;
    }
    if (P.startsWith('OrderBy')) return validOrder(e, P.slice(7)) ? `${name}(): this;` : undefined;
    if (P.startsWith('LeftJoin') || P.startsWith('Join')) {
      const rest = P.replace(/^Left/, '').replace(/^Join/, '');
      const pair = splitPair(this.m, e, undefined, rest);
      return pair ? `${name}(child: ${this.owners(pair[1])}): this;` : undefined;
    }
    if (P.startsWith('Match') && P.length > 5) return splitPair(this.m, undefined, e, P.slice(5)) ? `${name}(): this;` : undefined;
    if (P.startsWith('Alias') && P.length > 5) return `${name}(): this;`;
    if (P.startsWith('Possible') && P.length > 8) return columnName(this.m, undefined, P.slice(8)) === '' ? undefined : `${name}(value: unknown): this;`;
    if (P.startsWith('New') && P.length > 3) return columnName(this.m, e, P.slice(3)) !== '' ? undefined : `${name}(value: unknown): this;`;
    if (P.startsWith('AddRawColumn') && P.length > 12) {
      return columnName(this.m, e, P.slice(12)) !== '' ? undefined : `${name}(sql: string, ...binds: unknown[]): this;`;
    }
    if (P.startsWith('AddColumn') && P.length > 9) {
      const rest = P.slice(9);
      const i = rest.indexOf('Alias');
      if (i > 0 && columnName(this.m, e, rest.slice(0, i)) !== '' && rest.length > i + 5) {
        return columnName(this.m, e, rest.slice(i + 5)) !== '' ? undefined : `${name}(format: string | ColumnFunction): this;`;
      }
      return columnName(this.m, e, rest) !== '' ? undefined : `${name}(fn: (model: this) => Model): this;`;
    }
    if (P.startsWith('Get')) return undefined;
    let chain = P;
    if (P.startsWith('And') && P.length > 3 && isUpperAt(P, 3)) chain = P.slice(3);
    else if (P.startsWith('Or') && P.length > 2 && isUpperAt(P, 2)) chain = P.slice(2);
    const keys = parseChain(this.m, e, chain);
    return keys ? `${name}(${this.chainParams(e, keys)}): this;` : undefined;
  }

  public write(runtime: string): string {
    const m = this.m;
    let b = '// Code generated by ormgen; DO NOT EDIT.\n';
    b += `import { CORE, Model, registerSchema, type Collection, type ColumnFunction, type EntityDef, type EntitySchema, type Point, type SchemaSet, type ValueFunction } from ${tsString(runtime)};\n\n`;
    b += `export const SCHEMA_HASH = ${tsString(m.schema_hash)};\n\n`;
    b += 'const schema: SchemaSet = { hash: SCHEMA_HASH, entities: new Map<string, EntitySchema>([\n';
    for (const entity of m.order) {
      const e = m.entities[entity]!;
      b += `  [${tsString(entity)}, { name: ${tsString(entity)}, table: ${tsString(e.table)}, pk: [${e.pk.map(tsString).join(', ')}]`;
      if (e.auto) b += `, auto: ${tsString(e.auto)}`;
      if (e.timestamps?.updated) b += `, updated: ${tsString(e.timestamps.updated)}`;
      if (e.aes_version) b += `, aesVersion: ${tsString(e.aes_version)}`;
      b += `, fulltext: [${(e.fulltext ?? []).map(index => `[${index.map(tsString).join(', ')}]`).join(', ')}], columns: {\n`;
      for (const c of e.columns) {
        b += `    ${c.name}: { type: ${tsString(c.type)}`;
        if (c.nullable) b += ', nullable: true';
        if ((c.styles ?? []).length > 0) b += `, styles: [${c.styles!.map(tsString).join(', ')}]`;
        b += ' },\n';
      }
      b += '  } }],\n';
    }
    b += ']) };\nregisterSchema(schema);\n';

    const getters = [...this.getters.keys()].sort(byteOrder);
    for (const entity of m.order) {
      const e = m.entities[entity]!;
      const t = pascal(entity);
      b += `\n/** A ${entity} model or row. */\nexport class ${t} extends Model {\n`;
      b += `  public static readonly entity: EntityDef = { schema: schema.entities.get(${tsString(entity)})!, set: schema, create: core => new ${t}(core) };\n`;
      for (const c of e.columns) {
        const p = pascal(c.name);
        const n = tsString(c.name);
        b += `  public get${p}(): ${tsField(c)} { return this[CORE].column(${n}) as ${tsField(c)}; }\n`;
        let setType = tsScalar(c);
        if (c.nullable && setType !== 'unknown') setType += ' | null';
        b += `  public set${p}(value: ${setType}): this { this[CORE].setValue(${n}, value); return this; }\n`;
        b += `  public setRaw${p}(sql: string, ...binds: unknown[]): this { this[CORE].putSet({ column: ${n}, raw: { sql, binds } }); return this; }\n`;
        b += `  public addColumn${p}(): this { this[CORE].addColumn(${n}); return this; }\n`;
        b += `  public removeColumn${p}(): this { this[CORE].removeColumn(${n}); return this; }\n`;
        b += `  public groupBy${p}(): this { this[CORE].groupBy.push(${n}); return this; }\n`;
        b += `  public keyName${p}(): this { this[CORE].keyName = ${n}; return this; }\n`;
        b += `  public orderBy${p}Asc(...fn: ColumnFunction[]): this { this[CORE].orderBy(${n}, false, fn); return this; }\n`;
        b += `  public orderBy${p}Desc(...fn: ColumnFunction[]): this { this[CORE].orderBy(${n}, true, fn); return this; }\n`;
        if (numeric(c)) {
          b += `  public plus${p}(n: number): this { this[CORE].putSet({ column: ${n}, value: n, plus: true }); return this; }\n`;
          b += `  public minus${p}(n: number): this { this[CORE].putSet({ column: ${n}, value: n, minus: true }); return this; }\n`;
          b += `  public sum${p}(): this { this[CORE].aggregate('sum', ${n}); return this; }\n`;
          b += `  public avg${p}(): this { this[CORE].aggregate('avg', ${n}); return this; }\n`;
        }
      }
      for (const name of Object.keys(e.indexes ?? {}).sort(byteOrder)) {
        b += `  public forceIndex${pascal(name)}(): this { this[CORE].index = ${tsString(name)}; return this; }\n`;
      }
      b += '}\n';
      const statics = staticNames(e);
      const declared = this.methods.get(entity)!;
      const members = [...declared.keys()].sort(byteOrder).map(name => `  ${declared.get(name)}`);
      for (const name of getters) {
        if (statics.has(name)) continue;
        members.push(`  /** Returns ${this.getters.get(name)}. */\n  ${name}<T = unknown>(): T;`);
      }
      if (members.length > 0) b += `export interface ${t} {\n${members.join('\n')}\n}\n`;
    }
    return b;
  }
}

/** The module the generated file imports the runtime from. */
function runtimeImport(outDir: string): string {
  return resolve(outDir).replaceAll('\\', '/').endsWith('clients/typescript/src/models') ? '../index.js' : '@polyspec/orm-typescript';
}

/** Returns models.ts for a manifest; scan lists files or directories whose model calls are typed. */
export function renderTypeScript(loaded: LoadedManifest, outDir: string, scan: readonly string[]): string {
  const m = loaded.manifest;
  checkColumnNames(m);
  const names = scanCallNames(scan);
  const g = new Generator(m);
  for (const entity of m.order) {
    const e = m.entities[entity]!;
    const statics = staticNames(e);
    const declared = new Map<string, string>();
    for (const name of names) {
      if (statics.has(name)) continue;
      const decl = g.declare(e, name);
      if (decl !== undefined) declared.set(name, decl);
    }
    g.methods.set(entity, declared);
  }
  const used = new Set(names);
  for (const name of names) {
    if (!name.startsWith('get') || name.length < 4 || !isUpperAt(name, 3)) continue;
    const key = name.slice(3);
    for (const entity of m.order) {
      if (key === `${pascal(entity)}Model` || key === `${pascal(entity)}Models`) g.getters.set(name, `the ${entity} relation result; T is its model type`);
    }
    let named = used.has(`alias${key}`) || used.has(`new${key}`) || used.has(`addRawColumn${key}`) || used.has(`addColumn${key}`);
    for (const n of used) if (n.startsWith('addColumn') && n.endsWith(`Alias${key}`)) named = true;
    if (named) g.getters.set(name, `the value or relation result named ${key}`);
  }
  return g.write(runtimeImport(outDir));
}

/** Writes models.ts to outDir. */
export function generateTypeScript(loaded: LoadedManifest, outDir: string, scan: readonly string[]): void {
  const text = renderTypeScript(loaded, outDir, scan);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'models.ts'), text);
}
