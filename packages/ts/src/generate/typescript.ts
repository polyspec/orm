// models.ts generation. The file declares one class per entity with the
// fixed column methods. Methods named by the chain grammar are resolved at
// run time from the method name; their types are declared on a model for the
// names the scanned sources call on that model, so an unknown name or a wrong
// value type fails the type check.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Entity, Field as Column, RuntimeModel as Manifest } from '../engine/model.js';
import { Model } from '../model.js';
import { category, checkColumnNames, columnName, functionColumn, numeric, parseChain, pascal, splitPair, validOrder, type ChainKey } from './names.js';
import { scanModelCalls, type ScanSite } from './scan.js';

function tsString(s: string): string {
  return `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`;
}

/** A template literal whose value is s, one source line per line of s. */
function tsTemplate(s: string): string {
  return `\`${s.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${')}\``;
}

function byteOrder(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** The value type of a column in conditions and setters. */
function tsScalar(c: Column): string {
  switch (category(c)) {
    case 'int': case 'float': return 'number';
    case 'decimal': return 'string';
    case 'bool': return 'boolean';
    case 'time': return 'string | Date';
    case 'bytes': return 'Uint8Array';
    case 'styled': return 'unknown';
  }
  return 'string';
}

/** Whether a column holds a styled value. */
function styledStage(c: Column): boolean {
  return category(c) === 'styled';
}

/** Whether the styled value of a column is an ordered-json value. */
function jsonStage(c: Column): boolean {
  return c.stages[0] === 'ordered_json';
}

/** The type a setter takes. */
function tsSet(c: Column): string {
  if (jsonStage(c)) return 'StyledValue<JsonValue | CodecValue>';
  if (styledStage(c)) return 'StyledValue<CodecValue>';
  // A time column's setter takes the text form, as its getter returns it (T189).
  const t = category(c) === 'time' ? 'string' : tsScalar(c);
  return c.nullable && t !== 'unknown' ? `${t} | null` : t;
}

/** The type a getter returns. */
function tsField(c: Column): string {
  if (jsonStage(c)) return 'StyledValue<JsonValue>';
  if (styledStage(c)) return 'StyledValue<CodecValue>';
  const t = category(c) === 'time' ? 'string' : tsScalar(c);
  return c.nullable ? `${t} | null` : t;
}

/**
 * The check of a getter that the column holds a value of its declared type, which reads `value` without a type assertion;
 * undefined for a column of the ordered_json stage, whose ordered-json class no runtime name of the client reaches.
 */
function fieldCheck(c: Column): string | undefined {
  if (jsonStage(c)) return undefined;
  // A styled value carries SQL NULL itself, so its getter admits no null.
  if (styledStage(c)) return 'value instanceof StyledValue && codecStyled(value)';
  const t = category(c) === 'time' ? 'string' : tsScalar(c);
  const check = t === 'Uint8Array' ? 'value instanceof Uint8Array' : `typeof value === ${tsString(t)}`;
  return c.nullable ? `value === null || ${check}` : check;
}

/** The module-local functions that the getters of a generated file call, each emitted when a getter calls it. */
const LOCAL_FUNCTIONS: readonly (readonly [string, string])[] = [
  ['codecStyled', `/** Whether a styled value holds the common value model. */
function codecStyled(value: StyledValue): value is StyledValue<CodecValue> {
  return value.kind === 'sql-null' || codecValue(value.payload());
}
`],
  ['codecValue', `/** Whether a value is of the common value model. */
function codecValue(value: unknown): value is CodecValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return true;
  if (Array.isArray(value)) return value.every(item => codecValue(item));
  return typeof value === 'object' && Object.values(value).every(item => codecValue(item));
}
`],
];

// The methods of the runtime Model, which every generated model inherits: a generated method with the same name would replace one.
// They are read from the class, so a method added to Model is a base method here without a second list.
export const baseMethods: readonly string[] = Object.getOwnPropertyNames(Model.prototype).filter(name => !name.startsWith('_'));

function staticNames(e: Entity): Set<string> {
  const out = new Set(baseMethods);
  for (const c of e.fields) {
    const p = pascal(c.name);
    for (const prefix of ['get', 'set', 'addColumn', 'removeColumn', 'groupBy', 'keyName']) out.add(prefix + p);
    out.add(`orderBy${p}Asc`);
    out.add(`orderBy${p}Desc`);
    if (numeric(c)) for (const prefix of ['plus', 'minus', 'sum', 'avg']) out.add(prefix + p);
  }
  for (const name of e.indexes) out.add(`forceIndex${pascal(name)}`);
  return out;
}

function isUpperAt(s: string, i: number): boolean {
  const c = s[i];
  return c !== undefined && c >= 'A' && c <= 'Z';
}

class Generator {
  public readonly methods = new Map<string, Map<string, string>>();
  public readonly getters = new Map<string, string>();

  public constructor(private readonly m: Manifest) {}

  /** The union of model classes that have the column. */
  private owners(column: string): string {
    return [...this.m.entities.values()].filter(e => e.fields.some(c => c.name === column)).map(e => pascal(e.name)).join(' | ');
  }

  private column(e: Entity, name: string): Column {
    const found = e.fields.find(c => c.name === name);
    if (found === undefined) throw new Error(`entity ${e.name} has no column ${name}`);
    return found;
  }

  private keyType(e: Entity, k: ChainKey): string {
    switch (k.op) {
      case 'tuple': case 'ne_tuple': return `ReadonlyArray<readonly [${k.columns.map(c => tsScalar(this.column(e, c))).join(', ')}]>`;
    }
    if (k.compare !== '') return this.owners(k.compare);
    const c = this.column(e, k.column);
    const s = tsScalar(c);
    const plain = category(c) !== 'styled';
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
    const [k] = keys;
    if (k !== undefined && keys.length === 1 && k.compare === '' && k.column !== '' && ['', 'ne', 'gt', 'lt', 'ge', 'le'].includes(k.op) && functionColumn(this.column(e, k.column))) {
      return `...args: [${params[0]}] | [v0: ColumnFunction, compared: unknown]`;
    }
    return params.join(', ');
  }

  /** The declaration of a method named by the chain grammar. */
  public declare(e: Entity, name: string): string | undefined {
    const P = name.charAt(0).toUpperCase() + name.slice(1);
    for (const [prefix, result] of [['GetsBy', 'Promise<Collection<this>>'], ['GetBy', 'Promise<this | null>'], ['GetCountBy', 'Promise<number>']] as const) {
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
    if (P.startsWith('AddColumn') && P.length > 9) {
      const rest = P.slice(9);
      const i = rest.indexOf('Alias');
      if (i > 0 && columnName(this.m, e, rest.slice(0, i)) !== '' && rest.length > i + 5) {
        return columnName(this.m, e, rest.slice(i + 5)) !== '' ? undefined : `${name}(fn: ColumnFunction): this;`;
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
    let b = '';
    b += `/** The manifest text of the dbspec document set the models were generated from. */\nexport const MANIFEST_TEXT = ${tsTemplate(m.manifestText)};\n\n`;
    b += `export const MANIFEST_HASH = ${tsString(m.manifestHash)};\n\n`;
    if (m.externalText === '') {
      b += '/** The generated schema value: install takes it to create the tables and register the set. */\nexport const SCHEMA: Schema = { manifestText: MANIFEST_TEXT, manifestHash: MANIFEST_HASH };\n\n';
    } else {
      b += `/** The text of the tables that the document set uses from external documents. */\nexport const EXTERNAL_TEXT = ${tsTemplate(m.externalText)};\n\n`;
      b += '/** The generated schema value: install takes it to create the tables and register the set. */\nexport const SCHEMA: Schema = { manifestText: MANIFEST_TEXT, manifestHash: MANIFEST_HASH, externalText: EXTERNAL_TEXT };\n\n';
    }
    b += '/** Opens the database selected by the DSN URI and registers the set of these models on the connection. */\nexport function connect(dsn: string, options: ConnectOptions = {}): Promise<Db> {\n  return Db.connectSchema(dsn, SCHEMA, options);\n}\n\n';
    b += m.externalText === '' ? 'const model = registerModel(MANIFEST_TEXT, MANIFEST_HASH);\n' : 'const model = registerModel(MANIFEST_TEXT, MANIFEST_HASH, EXTERNAL_TEXT);\n';
    b += '\n/** The entity `name` of the model set, which registerModel built from the manifest. */\nfunction modelEntity(name: string): EntityDef[\'entity\'] {\n  const found = model.entities.get(name);\n  if (found === undefined) throw new Error(`the model set has no entity ${name}`);\n  return found;\n}\n';

    const getters = [...this.getters.keys()].sort(byteOrder);
    for (const e of m.entities.values()) {
      const entity = e.name;
      const t = pascal(entity);
      b += `\n/** A ${entity} model or row. */\nexport class ${t} extends Model {\n`;
      b += `  public static readonly entity: EntityDef = { model, entity: modelEntity(${tsString(entity)}), create: core => new ${t}(core) };\n`;
      for (const c of e.fields) {
        const p = pascal(c.name);
        const n = tsString(c.name);
        const check = fieldCheck(c);
        if (check === undefined) b += `  public get${p}(): ${tsField(c)} { return this[CORE].jsonColumn(${n}); }\n`;
        else {
          const wrong = tsString(`${entity}.${c.name} holds a value of type `);
          b += `  public get${p}(): ${tsField(c)} { const value = this[CORE].column(${n}); if (${check}) return value; throw new TypeError(${wrong} + typeof value + ${tsString(`, not ${tsField(c)}`)}); }\n`;
        }
        b += `  public set${p}(value: ${tsSet(c)}): this { this[CORE].setValue(${n}, value); return this; }\n`;
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
      for (const name of [...e.indexes].sort(byteOrder)) {
        b += `  public forceIndex${pascal(name)}(): this { this[CORE].index = ${tsString(name)}; return this; }\n`;
      }
      b += '}\n';
      const statics = staticNames(e);
      const declared = this.methods.get(entity);
      if (declared === undefined) throw new Error(`the methods of entity ${entity} were not declared`);
      const members = [...declared.keys()].sort(byteOrder).map(name => `  ${declared.get(name)}`);
      for (const name of getters) {
        if (statics.has(name)) continue;
        members.push(`  /** Returns ${this.getters.get(name)}. */\n  ${name}<T = unknown>(): T;`);
      }
      // The chain methods the source calls are provided by Model at run time; the class declares
      // their types as fields, so each model type is declared once.
      if (members.length > 0) b = b.slice(0, -2) + '\n' + members.map(declareMember).join('\n') + '\n}\n';
    }
    // The getters' module-local functions follow the classes, each once when the code calls it.
    for (const [name, code] of LOCAL_FUNCTIONS) if (new RegExp(`\\b${name}\\(`).test(b)) b += `\n${code}`;
    // The file imports exactly the runtime names its code refers to.
    const used = RUNTIME_IMPORTS.filter(([name]) => new RegExp(`\\b${name}\\b`).test(b));
    const names = used.map(([name, type]) => (type ? `type ${name}` : name)).join(', ');
    return `// Code generated by orm-gen; DO NOT EDIT.\nimport { ${names} } from ${tsString(runtime)};\n\n${b}`;
  }
}

/** The runtime names a generated file may import, each with whether it is a type. */
const RUNTIME_IMPORTS: readonly (readonly [string, boolean])[] = [
  ['CORE', false], ['Db', false], ['Model', false], ['registerModel', false], ['CodecValue', true], ['Collection', true],
  ['ColumnFunction', true], ['ConnectOptions', true], ['EntityDef', true], ['JsonValue', true], ['Schema', true],
  ['StyledValue', false], ['ValueFunction', true],
];

/** Writes the signature `name<G>(params): R;` (with its doc comment) as the class field `declare name: <G>(params) => R;`. */
function declareMember(member: string): string {
  return member.replace(/^(\s*)(\w+)(<[^(]*>)?\((.*)\): (.*);$/m, (_all, indent: string, name: string, generic: string | undefined, params: string, result: string) => `${indent}declare ${name}: ${generic ?? ''}(${params}) => ${result};`);
}

/** The module the generated file imports the runtime from. */
function runtimeImport(outDir: string): string {
  const path = resolve(outDir).replaceAll('\\', '/');
  const marker = '/packages/ts/src/models';
  if (path.endsWith(marker)) return '../index.js';
  const nested = path.indexOf(marker + '/');
  if (nested >= 0) {
    const segments = path.slice(nested + marker.length + 1).split('/');
    return '../'.repeat(segments.length + 1) + 'index.js';
  }
  return '@polyspec/orm';
}

/** Returns models.ts for a runtime model; scan lists files or directories whose model calls are typed. */
export function renderTypeScript(m: Manifest, outDir: string, scan: readonly string[]): string {
  checkColumnNames(m);
  const sites: ScanSite[] = [];
  const calls = scanModelCalls(scan, new Set([...m.entities.keys()].map(pascal)), sites);
  const names = [...new Set([...calls.values()].flatMap(set => [...set]))].sort(byteOrder);
  const g = new Generator(m);
  for (const e of m.entities.values()) {
    const entity = e.name;
    const statics = staticNames(e);
    const declared = new Map<string, string>();
    for (const name of [...(calls.get(pascal(entity)) ?? [])].sort(byteOrder)) {
      if (statics.has(name)) continue;
      const decl = g.declare(e, name);
      if (decl !== undefined) declared.set(name, decl);
    }
    // Each prefix of a key names a method of the model, whether or not a scanned source calls it (the schema rule): a single
    // column is its column method, and several columns are the tuple method of the columns.
    for (const columns of [e.primaryKey, ...e.uniques, ...e.indexColumns]) {
      for (let k = 1; k <= columns.length; k++) {
        const prefix = columns.slice(0, k);
        const [only] = prefix;
        const name = prefix.length === 1 && only !== undefined ? pascal(only).replace(/^./, c => c.toLowerCase()) : `tuple${prefix.map(pascal).join('With')}`;
        if (statics.has(name) || declared.has(name)) continue;
        const decl = g.declare(e, name);
        if (decl !== undefined) declared.set(name, decl);
      }
    }
    g.methods.set(entity, declared);
  }
  const used = new Set(names);
  for (const name of names) {
    if (!name.startsWith('get') || name.length < 4 || !isUpperAt(name, 3)) continue;
    const key = name.slice(3);
    for (const entity of m.entities.keys()) {
      if (key === `${pascal(entity)}Model` || key === `${pascal(entity)}Models`) g.getters.set(name, `the ${entity} relation result; T is its model type`);
    }
    let named = used.has(`alias${key}`) || used.has(`new${key}`) || used.has(`addColumn${key}`);
    for (const n of used) if (n.startsWith('addColumn') && n.endsWith(`Alias${key}`)) named = true;
    if (named) g.getters.set(name, `the value or relation result named ${key}`);
  }
  // A scanned getter call is refused only when no class the call may be on attaches it: a class of the call that lacks the getter is
  // not an error, since the call runs on a class that has it. A call that nothing attaches would leave the model without the method
  // the source calls; generation stops naming the model and the method (docs/dsl.md, the scan).
  const entities = new Map([...m.entities.values()].map(e => [pascal(e.name), e] as const));
  for (const site of sites) {
    if (!site.name.startsWith('get') || site.name.length < 4 || !isUpperAt(site.name, 3)) continue;
    const attached = site.classes.some(cls => {
      const e = entities.get(cls);
      return e !== undefined && (staticNames(e).has(site.name) || g.getters.has(site.name) || g.methods.get(e.name)?.has(site.name) === true);
    });
    if (!attached) throw new Error(`orm-gen --scan: ${site.classes[0]}.${site.name}() is called, but no alias${site.name.slice(3)}, new${site.name.slice(3)} or addColumn call attaches it`);
  }
  return g.write(runtimeImport(outDir));
}

/** Writes models.ts to outDir. */
export function generateTypeScript(m: Manifest, outDir: string, scan: readonly string[]): void {
  const text = renderTypeScript(m, outDir, scan);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'models.ts'), text);
}
