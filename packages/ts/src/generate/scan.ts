// Collects the method names that the scanned sources call on generated models.
// A call counts only when its receiver resolves to a model of the generated
// classes; docs/operations/usage.md states the receivers the scan resolves. A call on
// any other receiver adds no method.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { parseSync, visitorKeys } from 'oxc-parser';
import type { ArrowFunctionExpression, Expression, Function as FunctionNode, ImportDeclaration, ModuleExportName, Node, ParamPattern, Statement, TSType, TSTypeName } from 'oxc-parser';

/** The source files the scan reads; oxc-parser takes the language from the extension. */
const extensions = new Set(['.ts', '.mts', '.js', '.mjs']);

const skipped = new Set(['node_modules', 'dist']);

/** What an expression holds: a model, a promise of one, or a collection of models. */
type Shape = 'model' | 'promise' | 'collection' | 'promiseCollection' | 'union';
/** A value; a union holds the models that a name may hold, one member each. */
interface Value { readonly cls: string; readonly shape: Shape; readonly members?: readonly Value[] }

/** Model methods that return something other than the model they are called on. */
const terminals = new Set(['create', 'creates', 'update', 'save', 'delete', 'restore', 'restoreOrCreate', 'toArray', 'toJSON', 'toJSONText']);
/** Model methods whose callback receives a model of the receiver's class. */
const modelCallbacks = new Set(['and', 'or', 'not', 'andNot', 'orNot', 'on', 'fetchKey', 'fetchValue']);
/** Collection and array methods whose callback receives one element. */
const elementCallbacks = new Set(['map', 'forEach', 'filter', 'find', 'some', 'every']);

/** The value a method call on a resolved receiver returns. */
function callResult(receiver: Value, name: string): Value | undefined {
  if (receiver.shape === 'model') {
    if (name === 'get' || /^getBy[A-Z]/.test(name)) return { cls: receiver.cls, shape: 'promise' };
    if (name === 'gets' || /^getsBy[A-Z]/.test(name)) return { cls: receiver.cls, shape: 'promiseCollection' };
    if (terminals.has(name) || name.startsWith('get')) return undefined;
    return receiver;
  }
  if (receiver.shape === 'collection') {
    if (['first', 'get', 'at', 'find'].includes(name)) return { cls: receiver.cls, shape: 'model' };
    if (name === 'values' || name === 'filter') return receiver;
  }
  return undefined;
}

/** A name bound to something the scan cannot type holds an unknown model; it poisons a union. */
const hidden: Value = { cls: '', shape: 'model' };
/** The value of null, undefined and an uninitialized declaration: a union of no model, which contributes nothing to a union. */
const nothing: Value = { cls: '', shape: 'union', members: [] };

/** A getter call that a scanned source makes, with the classes its receiver may be. */
export interface ScanSite {
  readonly name: string;
  readonly classes: readonly string[];
}

/** The values that a value stands for: its members when it is a union, itself otherwise. */
function members(value: Value | undefined): readonly Value[] {
  if (value === undefined || value === hidden) return [];
  return value.shape === 'union' ? (value.members ?? []) : [value];
}

/** The value that may hold any of the values: undefined when one is unknown, the value when they agree, else a union of their members. */
function union(values: ReadonlyArray<Value | undefined>): Value | undefined {
  const items: Value[] = [];
  let holdsNothing = false;
  for (const value of values) {
    if (value === undefined || value === hidden) return undefined;
    if (members(value).length === 0) {
      holdsNothing = true;
      continue;
    }
    for (const member of members(value)) {
      if (!items.some(item => item.cls === member.cls && item.shape === member.shape)) items.push(member);
    }
  }
  const [only] = items;
  if (items.length === 0) return holdsNothing ? nothing : undefined;
  return items.length === 1 ? only : { cls: '', shape: 'union', members: items };
}

/** The value of f on each member of a value; a member without a value makes the result unknown. */
function mapValue(value: Value | undefined, f: (member: Value) => Value | undefined): Value | undefined {
  if (value === undefined) return undefined;
  if (value.shape !== 'union') return f(value);
  if ((value.members ?? []).length === 0) return value;
  return union((value.members ?? []).map(f));
}

/** A function node whose parameters and body the scan visits. */
type FunctionLike = FunctionNode | ArrowFunctionExpression;

/** The name of a static member access `a.name` or `a?.name`; undefined for a computed or private member. */
function memberName(node: Node): string | undefined {
  return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' ? node.property.name : undefined;
}

const exportName = (name: ModuleExportName): string => (name.type === 'Identifier' ? name.name : name.value);

/** The binding, declared type and default value of a parameter. */
function parameter(param: ParamPattern): { name: Node; type: TSType | undefined; initializer: Expression | undefined } {
  const pattern = param.type === 'TSParameterProperty' ? param.parameter : param;
  if (pattern.type === 'AssignmentPattern')
    return { name: pattern.left, type: typeOf(pattern.left), initializer: pattern.right };
  return { name: pattern.type === 'RestElement' ? pattern.argument : pattern, type: typeOf(pattern), initializer: undefined };
}

/** The type annotation of a binding, when it has one. */
function typeOf(node: Node): TSType | undefined {
  return 'typeAnnotation' in node && node.typeAnnotation?.type === 'TSTypeAnnotation' ? node.typeAnnotation.typeAnnotation : undefined;
}

/** The child nodes of a node, in the order of the ESTree visitor keys of oxc-parser. */
function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const key of visitorKeys[node.type] ?? []) {
    const value: unknown = Reflect.get(node, key);
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) out.push(value);
  }
  return out;
}

/** Whether a child value of a node is a node: an object with the string type that oxc-parser gives every node. */
function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

class Scanner {
  /** Local names of the generated model classes. */
  private readonly classes = new Map<string, string>();
  /** Namespace imports, whose members name model classes. */
  private readonly namespaces = new Set<string>();
  /** Functions whose declared return type is a model, a promise or a collection of models. */
  private readonly functions = new Map<string, Value>();
  private readonly scopes: Array<Map<string, Value>> = [];

  /** file is the scanned file; set is the generated module of the set and its manifest hash, which own decides an import by. */
  public constructor(private readonly models: ReadonlySet<string>, private readonly out: Map<string, Set<string>>, private readonly sites: ScanSite[], private readonly file: string, private readonly set: SetModule) {
    for (const name of models) this.classes.set(name, name);
  }

  private lookup(name: string): Value | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const value = this.scopes[i]?.get(name);
      if (value !== undefined) return value === hidden ? undefined : value;
    }
    return undefined;
  }

  /** Binds the names of a declaration in the innermost scope; a destructured name takes no model. */
  private bind(target: Node, value: Value | undefined): void {
    const scope = this.scopes.at(-1);
    if (scope === undefined) throw new Error('a binding is outside every scope of the scanner');
    if (target.type === 'Identifier') scope.set(target.name, value ?? hidden);
    else for (const name of boundNames(target)) scope.set(name, hidden);
  }

  /** Assigns a name: the assignment rebinds the scope that declares the name, as JavaScript does. */
  private assign(name: string, value: Value | undefined): void {
    let scope: Map<string, Value> | undefined;
    for (let i = this.scopes.length - 1; i >= 0 && scope === undefined; i--) {
      if (this.scopes[i]?.has(name) === true) scope = this.scopes[i];
    }
    (scope ?? this.scopes[0])?.set(name, value ?? hidden);
  }

  private snapshot(): Array<Map<string, Value>> {
    return this.scopes.map(scope => new Map(scope));
  }

  private restore(state: ReadonlyArray<ReadonlyMap<string, Value>>): void {
    this.scopes.forEach((scope, i) => {
      scope.clear();
      for (const [name, value] of state[i] ?? []) scope.set(name, value);
    });
  }

  /** The model class that the expression of a `new` or a type name refers to. */
  private className(node: Expression | TSTypeName): string | undefined {
    if (node.type === 'Identifier') return this.lookup(node.name) === undefined ? this.classes.get(node.name) : undefined;
    const [left, right] = node.type === 'MemberExpression' ? [node.object, memberName(node)] : node.type === 'TSQualifiedName' ? [node.left, node.right.name] : [undefined, undefined];
    if (left !== undefined && left.type === 'Identifier' && this.namespaces.has(left.name) && right !== undefined && this.models.has(right)) return right;
    return undefined;
  }

  /** The value a type declares: a model class, Promise, Collection or an array of models, or a union of one of them with other types. */
  private typeValue(type: TSType | undefined): Value | undefined {
    if (type === undefined) return undefined;
    if (type.type === 'TSParenthesizedType') return this.typeValue(type.typeAnnotation);
    if (type.type === 'TSUnionType') {
      const values = type.types.map(t => this.typeValue(t)).filter((v): v is Value => v !== undefined);
      return values.length === 1 ? values[0] : undefined;
    }
    if (type.type === 'TSArrayType') {
      const element = this.typeValue(type.elementType);
      return element?.shape === 'model' ? { cls: element.cls, shape: 'collection' } : undefined;
    }
    if (type.type !== 'TSTypeReference') return undefined;
    const cls = this.className(type.typeName);
    if (cls !== undefined) return { cls, shape: 'model' };
    const name = type.typeName.type === 'Identifier' ? type.typeName.name : '';
    const args = type.typeArguments?.params ?? [];
    const inner = args.length === 1 ? this.typeValue(args[0]) : undefined;
    if (inner === undefined) return undefined;
    if (name === 'Promise') {
      if (inner.shape === 'model') return { cls: inner.cls, shape: 'promise' };
      if (inner.shape === 'collection') return { cls: inner.cls, shape: 'promiseCollection' };
      return undefined;
    }
    return ['Collection', 'Array', 'ReadonlyArray', 'Iterable'].includes(name) && inner.shape === 'model' ? { cls: inner.cls, shape: 'collection' } : undefined;
  }

  /** The value of an expression, when it resolves to a model, a promise or a collection of models. */
  private valueOf(e: Expression): Value | undefined {
    if (e.type === 'ParenthesizedExpression' || e.type === 'TSNonNullExpression' || e.type === 'TSSatisfiesExpression' || e.type === 'ChainExpression') return this.valueOf(e.expression);
    if (e.type === 'TSAsExpression' || e.type === 'TSTypeAssertion') return this.typeValue(e.typeAnnotation) ?? this.valueOf(e.expression);
    if (e.type === 'AwaitExpression') {
      return mapValue(this.valueOf(e.argument), inner => {
        if (inner.shape === 'promise') return { cls: inner.cls, shape: 'model' };
        if (inner.shape === 'promiseCollection') return { cls: inner.cls, shape: 'collection' };
        return inner;
      });
    }
    if (e.type === 'NewExpression') {
      const cls = this.className(e.callee);
      return cls === undefined ? undefined : { cls, shape: 'model' };
    }
    // A conditional or a nullish default holds either operand, as the checker types it: the union of both values (DSL-151).
    if (e.type === 'ConditionalExpression') return union([this.valueOf(e.consequent), this.valueOf(e.alternate)]);
    if (e.type === 'LogicalExpression' && e.operator === '??') return union([this.valueOf(e.left), this.valueOf(e.right)]);
    if (e.type === 'Literal' && e.value === null) return nothing;
    if (e.type === 'Identifier') return this.lookup(e.name) ?? (e.name === 'undefined' ? nothing : undefined);
    if (e.type === 'ArrayExpression' && e.elements.length === 1 && e.elements[0]?.type === 'SpreadElement') {
      return mapValue(this.valueOf(e.elements[0].argument), inner => (inner.shape === 'collection' ? inner : undefined));
    }
    if (e.type === 'CallExpression') {
      if (e.callee.type === 'Identifier') return this.lookup(e.callee.name) === undefined ? this.functions.get(e.callee.name) : undefined;
      const name = memberName(e.callee);
      if (e.callee.type === 'MemberExpression' && name !== undefined) {
        // A getter `get<Name><T>()` returns the value its one type argument declares, so the receiver of a later call
        // typed through it resolves to that model.
        const args = e.typeArguments?.params ?? [];
        if (/^get[A-Z]/.test(name) && args.length === 1) {
          const typed = this.typeValue(args[0]);
          if (typed !== undefined) return typed;
        }
        return mapValue(this.valueOf(e.callee.object), receiver => callResult(receiver, name));
      }
    }
    if (e.type === 'MemberExpression' && e.computed) {
      return mapValue(this.valueOf(e.object), receiver => (receiver.shape === 'collection' ? { cls: receiver.cls, shape: 'model' } : undefined));
    }
    return undefined;
  }

  private record(cls: string, name: string): void {
    let names = this.out.get(cls);
    if (names === undefined) this.out.set(cls, names = new Set());
    names.add(name);
  }

  /** The scopes after branches that each end in one of the states: a name holds the union of its values in them. */
  private mergeAll(states: ReadonlyArray<ReadonlyArray<ReadonlyMap<string, Value>>>): Array<Map<string, Value>> {
    return (states[0] ?? []).map((_, i) => {
      const names = new Set<string>();
      for (const state of states) for (const name of state[i]?.keys() ?? []) names.add(name);
      const merged = new Map<string, Value>();
      for (const name of names) {
        // A state that does not bind the name contributes nothing.
        const values = states.flatMap(state => (state[i]?.has(name) === true ? [state[i]?.get(name)] : []));
        merged.set(name, union(values) ?? hidden);
      }
      return merged;
    });
  }

  /** Before a loop runs, a name that the loop assigns may hold what it held before the loop or what its assignments give it. */
  private enterLoop(loop: Node): void {
    const declared = new Set<string>();
    const assigned = new Map<string, Array<Value | undefined>>();
    const walk = (node: Node): void => {
      if (node.type === 'VariableDeclarator') for (const name of boundNames(node.id)) declared.add(name);
      if (node.type === 'AssignmentExpression') {
        const value = node.operator === '=' && node.left.type === 'Identifier' ? this.valueOf(node.right) : undefined;
        for (const name of boundNames(node.left)) assigned.set(name, [...(assigned.get(name) ?? []), value]);
      }
      for (const child of children(node)) walk(child);
    };
    walk(loop);
    for (const [name, values] of assigned) {
      if (declared.has(name)) continue;
      let scope: Map<string, Value> | undefined;
      for (let i = this.scopes.length - 1; i >= 0 && scope === undefined; i--) {
        if (this.scopes[i]?.has(name) === true) scope = this.scopes[i];
      }
      if (scope === undefined) continue;
      scope.set(name, union([scope.get(name), ...values]) ?? hidden);
    }
  }

  /** Visits a function; an untyped first parameter takes the value the call site gives it. */
  private visitFunction(fn: FunctionLike, given: Value | undefined): void {
    this.scopes.push(new Map());
    fn.params.forEach((p, i) => {
      const { name, type, initializer } = parameter(p);
      if (initializer !== undefined) this.visit(initializer);
      // An annotated parameter is the class its annotation names, or unknown if it names none. Only an untyped first parameter of a
      // model callback takes the receiver's model.
      this.bind(name, type === undefined ? (i === 0 ? given : undefined) : this.typeValue(type));
    });
    if (fn.body !== null) this.visit(fn.body);
    this.scopes.pop();
  }

  /**
   * The value a function returns: its declared return type, or the value of
   * an arrow function's expression body or of the only statement of its body
   * when that statement returns.
   */
  private returnValue(fn: FunctionLike): Value | undefined {
    const type = fn.returnType?.typeAnnotation;
    const declared = this.typeValue(type);
    if (declared !== undefined || type !== undefined || fn.body === null) return declared;
    if (fn.body.type !== 'BlockStatement') return this.valueOf(fn.body);
    const only = fn.body.body.length === 1 ? fn.body.body[0] : undefined;
    return only !== undefined && only.type === 'ReturnStatement' && only.argument !== null ? this.valueOf(only.argument) : undefined;
  }

  /** Records the functions of a block that return a model before the block's statements run. */
  private hoist(statements: readonly Node[]): void {
    for (const s of statements) if (s.type === 'ImportDeclaration') this.visitImport(s);
    for (const s of statements) {
      const declaration = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s;
      if (declaration?.type === 'FunctionDeclaration' && declaration.id !== null) {
        const value = this.returnValue(declaration);
        if (value !== undefined) this.functions.set(declaration.id.name, value);
      }
    }
  }

  private visitCall(call: Extract<Expression, { type: 'CallExpression' }>): void {
    this.visit(call.callee);
    let given: Value | undefined;
    const name = memberName(call.callee);
    if (call.callee.type === 'MemberExpression' && name !== undefined) {
      // A name that may hold several models gets the call on each of them.
      const receivers = members(this.valueOf(call.callee.object));
      const models = receivers.filter(r => r.shape === 'model');
      for (const model of models) this.record(model.cls, name);
      if (models.length > 0) this.sites.push({ name, classes: models.map(model => model.cls) });
      const collections = receivers.filter(r => r.shape === 'collection');
      if (models.length === 1 && (modelCallbacks.has(name) || name.startsWith('addColumn'))) given = models[0];
      else if (models.length === 0 && collections.length === 1 && elementCallbacks.has(name)) given = { cls: collections[0]?.cls ?? '', shape: 'model' };
    }
    for (const arg of call.arguments) {
      if (given !== undefined && (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression')) this.visitFunction(arg, given);
      else this.visit(arg);
    }
  }

  private visitImport(node: ImportDeclaration): void {
    const own = ownModule(this.set, this.file, node.source.value);
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        if (own) this.namespaces.add(specifier.local.name);
        else this.namespaces.delete(specifier.local.name);
        this.classes.delete(specifier.local.name);
      }
      if (specifier.type === 'ImportDefaultSpecifier') this.classes.delete(specifier.local.name);
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported = exportName(specifier.imported);
      if (own && this.models.has(imported)) this.classes.set(specifier.local.name, imported);
      else this.classes.delete(specifier.local.name);
    }
  }

  public visit(node: Node): void {
    if (node.type === 'ImportDeclaration') return;
    if (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'TSModuleBlock' || node.type === 'StaticBlock') {
      const statements: readonly Node[] = node.body as readonly Statement[];
      this.scopes.push(new Map());
      this.hoist(statements);
      for (const child of children(node)) this.visit(child);
      this.scopes.pop();
      return;
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'
      || node.type === 'TSDeclareFunction' || node.type === 'TSEmptyBodyFunctionExpression') {
      return this.visitFunction(node, undefined);
    }
    if (node.type === 'VariableDeclarator') {
      const init = node.init;
      if (init !== null) {
        if ((init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') && node.id.type === 'Identifier') {
          const value = this.returnValue(init);
          if (value !== undefined) this.functions.set(node.id.name, value);
        }
        this.visit(init);
      }
      this.bind(node.id, this.typeValue(typeOf(node.id)) ?? (init === null ? nothing : this.valueOf(init)));
      return;
    }
    if (node.type === 'ForOfStatement') {
      this.visit(node.right);
      const before = this.snapshot();
      this.enterLoop(node);
      const collection = this.valueOf(node.right);
      const element = mapValue(collection, c => (c.shape === 'collection' ? { cls: c.cls, shape: 'model' } : undefined));
      this.scopes.push(new Map());
      if (node.left.type === 'VariableDeclaration') for (const d of node.left.declarations) this.bind(d.id, this.typeValue(typeOf(d.id)) ?? element);
      this.visit(node.body);
      this.scopes.pop();
      // A loop may run zero times, so the scope after it joins the scope before it.
      this.restore(this.mergeAll([before, this.snapshot()]));
      return;
    }
    if (node.type === 'AssignmentExpression') {
      this.visit(node.right);
      if (node.left.type === 'Identifier') {
        this.assign(node.left.name, node.operator === '=' ? this.valueOf(node.right) : undefined);
        return;
      }
      this.visit(node.left);
      for (const name of boundNames(node.left)) this.assign(name, undefined);
      return;
    }
    if (node.type === 'IfStatement') {
      this.visit(node.test);
      const before = this.snapshot();
      this.visit(node.consequent);
      const consequent = this.snapshot();
      this.restore(before);
      if (node.alternate !== null) this.visit(node.alternate);
      const alternate = this.snapshot();
      // A branch that returns or throws contributes nothing to the scope after the if.
      const states = [];
      if (!exits(node.consequent)) states.push(consequent);
      if (node.alternate === null || !exits(node.alternate)) states.push(alternate);
      this.restore(states.length > 0 ? this.mergeAll(states) : alternate);
      return;
    }
    if (node.type === 'CatchClause') {
      this.scopes.push(new Map());
      if (node.param !== null) this.bind(node.param, undefined);
      this.visit(node.body);
      this.scopes.pop();
      return;
    }
    if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'WhileStatement' || node.type === 'DoWhileStatement') {
      const before = this.snapshot();
      this.enterLoop(node);
      // The declarations of a loop head belong to the loop.
      this.scopes.push(new Map());
      for (const child of children(node)) this.visit(child);
      this.scopes.pop();
      // A loop may run zero times, so the scope after it joins the scope before it.
      this.restore(this.mergeAll([before, this.snapshot()]));
      return;
    }
    if (node.type === 'SwitchStatement') {
      this.visit(node.discriminant);
      const base = this.snapshot();
      const ends: Array<Array<Map<string, Value>>> = [];
      let end: Array<Map<string, Value>> | undefined;
      let endExits = false;
      let hasDefault = false;
      for (const c of node.cases) {
        if (c.test === null) hasDefault = true;
        // A case starts from the scope before the switch, joined with the scope at the end of the case before it when that case
        // falls through; a case that returns or throws does not fall through.
        if (end === undefined || endExits) this.restore(base);
        else {
          ends.push(end);
          this.restore(this.mergeAll([base, end]));
        }
        if (c.test !== null) this.visit(c.test);
        for (const statement of c.consequent) this.visit(statement);
        end = this.snapshot();
        const last = c.consequent[c.consequent.length - 1];
        endExits = last !== undefined && exits(last);
      }
      if (end !== undefined && !endExits) ends.push(end);
      if (!hasDefault) ends.push(base);
      this.restore(this.mergeAll(ends.length > 0 ? ends : [base]));
      return;
    }
    if (node.type === 'TryStatement') {
      // A handler starts from the scope before the try joined with the scope at the end of the block, since an exception can leave
      // any statement. A branch that returns or throws contributes nothing after the try; the finalizer starts from every outcome.
      const base = this.snapshot();
      this.visit(node.block);
      const blockEnd = this.snapshot();
      const all = [base, blockEnd];
      const ends = exits(node.block) ? [] : [blockEnd];
      if (node.handler !== null) {
        this.restore(this.mergeAll([base, blockEnd]));
        this.visit(node.handler);
        const handlerEnd = this.snapshot();
        all.push(handlerEnd);
        if (!exits(node.handler.body)) ends.push(handlerEnd);
      }
      if (node.finalizer !== null) {
        this.restore(this.mergeAll(all));
        this.visit(node.finalizer);
        return;
      }
      this.restore(this.mergeAll(ends.length > 0 ? ends : [blockEnd]));
      return;
    }
    if (node.type === 'CallExpression') return this.visitCall(node);

    for (const child of children(node)) this.visit(child);
  }
}

/** Whether a statement, or the last statement of a block, returns or throws, so that the scope after it is not reached from its end. */
function exits(node: Node): boolean {
  if (node.type === 'ReturnStatement' || node.type === 'ThrowStatement') return true;
  if (node.type === 'BlockStatement') {
    const last = node.body.at(-1);
    return last !== undefined && exits(last);
  }
  return false;
}

/** The names that a binding or assignment target declares: an identifier, or the names of a destructuring pattern. */
function boundNames(node: Node): string[] {
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ObjectPattern') return node.properties.flatMap(p => boundNames(p.type === 'RestElement' ? p.argument : p.value));
  if (node.type === 'ArrayPattern') return node.elements.flatMap(e => (e === null ? [] : boundNames(e)));
  if (node.type === 'AssignmentPattern') return boundNames(node.left);
  if (node.type === 'RestElement') return boundNames(node.argument);
  return [];
}

/** Parses a source file; a syntax error fails the scan with the file and the errors, since an unparsed file would hide its calls. */
/** The generated module of the set: its path without the extension and the manifest hash it is generated from. */
export interface SetModule { readonly module: string; readonly hash: string }

const sourceExtensions: ReadonlyArray<readonly [string, readonly string[]]> = [['.js', ['.ts', '.tsx', '.js']], ['.mjs', ['.mts', '.mjs']], ['.cjs', ['.cts', '.cjs']], ['.jsx', ['.tsx', '.jsx']]];
const generatedHeader = '// Code generated by orm-gen; DO NOT EDIT.';
const hashLine = /^export const MANIFEST_HASH = '([^']*)';$/m;

/** The file a relative or absolute specifier names, as the TypeScript checker resolves it, or undefined when none exists. */
function moduleFile(path: string): string | undefined {
  const candidates = [path];
  for (const [ext, sources] of sourceExtensions) if (path.endsWith(ext)) candidates.unshift(...sources.map(source => path.slice(0, -ext.length) + source));
  candidates.push(...['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.mjs', '.cjs'].map(ext => path + ext), ...['index.ts', 'index.tsx', 'index.js'].map(name => join(path, name)));
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
}

/**
 * Whether an import names the classes of the set (docs/spec/dsl.md, DSL-151). A relative or absolute specifier resolves against the
 * importing file: the set's output module is the set's; a module that orm-gen generated from another manifest is another set's,
 * whose classes are not this set's models even where their names are the same; any other module, and a bare specifier (a package
 * or a path alias, which no file of the scan names), keeps the class name rule.
 */
function ownModule(set: SetModule, file: string, specifier: string): boolean {
  if (!specifier.startsWith('.') && !isAbsolute(specifier)) return true;
  const path = resolve(dirname(file), specifier);
  if (path.replace(/\.[cm]?[jt]sx?$/, '') === set.module || path === set.module) return true;
  const found = moduleFile(path);
  if (found === undefined) return true;
  const text = readFileSync(found, 'utf8');
  if (!text.startsWith(generatedHeader)) return true;
  const hash = hashLine.exec(text)?.[1];
  return hash === undefined || hash === set.hash;
}

function visitFile(path: string, models: ReadonlySet<string>, out: Map<string, Set<string>>, sites: ScanSite[], module: SetModule): void {
  if (!extensions.has(extname(path))) return;
  const parsed = parseSync(path, readFileSync(path, 'utf8'));
  const errors = parsed.errors.filter(error => error.severity === 'Error');
  if (errors.length > 0) throw new Error(`orm-gen --scan: ${path} does not parse: ${errors.map(error => error.message).join('; ')}`);
  new Scanner(models, out, sites, resolve(path), module).visit(parsed.program);
}

function visitDir(dir: string, models: ReadonlySet<string>, out: Map<string, Set<string>>, sites: ScanSite[], module: SetModule): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) visitDir(path, models, out, sites, module);
    } else if (entry.isFile()) visitFile(path, models, out, sites, module);
  }
}

/**
 * Returns, for each generated model class, the names of the methods that the
 * sources call on a receiver that resolves to that model. outDir is the
 * output directory of the set, whose models.ts the model classes are imported
 * from, and hash the manifest hash of the set.
 */
export function scanModelCalls(paths: readonly string[], models: ReadonlySet<string>, outDir: string, hash: string, sites: ScanSite[] = []): Map<string, Set<string>> {
  const module: SetModule = { module: join(resolve(outDir), 'models'), hash };
  const out = new Map<string, Set<string>>();
  for (const path of paths) {
    if (statSync(path).isDirectory()) visitDir(path, models, out, sites, module);
    else visitFile(path, models, out, sites, module);
  }
  return out;
}
