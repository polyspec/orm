// Collects the method names that the scanned sources call on generated models.
// A call counts only when its receiver resolves to a model of the generated
// classes; docs/usage.md states the receivers the scan resolves. A call on
// any other receiver adds no method.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseSync, visitorKeys } from 'oxc-parser';
import type { ArrowFunctionExpression, Expression, Function as FunctionNode, ImportDeclaration, ModuleExportName, Node, ParamPattern, Statement, TSType, TSTypeName } from 'oxc-parser';

/** The source files the scan reads; oxc-parser takes the language from the extension. */
const extensions = new Set(['.ts', '.mts', '.js', '.mjs']);

const skipped = new Set(['node_modules', 'dist']);

/** What an expression holds: a model, a promise of one, or a collection of models. */
type Shape = 'model' | 'promise' | 'collection' | 'promiseCollection';
interface Value { readonly cls: string; readonly shape: Shape }

/** Model methods that return something other than the model they are called on. */
const terminals = new Set(['create', 'creates', 'update', 'save', 'delete', 'restore', 'toArray', 'toJSON', 'toJSONText']);
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

/** A name bound to something other than a model hides an outer model binding. */
const hidden: Value = { cls: '', shape: 'model' };

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
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item !== null) out.push(item as Node);
    } else if (value !== null && value !== undefined) out.push(value as Node);
  }
  return out;
}

class Scanner {
  /** Local names of the generated model classes. */
  private readonly classes = new Map<string, string>();
  /** Namespace imports, whose members name model classes. */
  private readonly namespaces = new Set<string>();
  /** Functions whose declared return type is a model, a promise or a collection of models. */
  private readonly functions = new Map<string, Value>();
  private readonly scopes: Array<Map<string, Value>> = [];

  public constructor(private readonly models: ReadonlySet<string>, private readonly out: Map<string, Set<string>>) {
    for (const name of models) this.classes.set(name, name);
  }

  private lookup(name: string): Value | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const value = this.scopes[i]!.get(name);
      if (value !== undefined) return value === hidden ? undefined : value;
    }
    return undefined;
  }

  private bind(name: Node, value: Value | undefined): void {
    if (name.type === 'Identifier') this.scopes[this.scopes.length - 1]!.set(name.name, value ?? hidden);
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
    return ['Collection', 'Array', 'ReadonlyArray'].includes(name) && inner.shape === 'model' ? { cls: inner.cls, shape: 'collection' } : undefined;
  }

  /** The value of an expression, when it resolves to a model, a promise or a collection of models. */
  private valueOf(e: Expression): Value | undefined {
    if (e.type === 'ParenthesizedExpression' || e.type === 'TSNonNullExpression' || e.type === 'TSSatisfiesExpression' || e.type === 'ChainExpression') return this.valueOf(e.expression as Expression);
    if (e.type === 'TSAsExpression' || e.type === 'TSTypeAssertion') return this.typeValue(e.typeAnnotation) ?? this.valueOf(e.expression);
    if (e.type === 'AwaitExpression') {
      const inner = this.valueOf(e.argument);
      if (inner?.shape === 'promise') return { cls: inner.cls, shape: 'model' };
      if (inner?.shape === 'promiseCollection') return { cls: inner.cls, shape: 'collection' };
      return inner;
    }
    if (e.type === 'NewExpression') {
      const cls = this.className(e.callee);
      return cls === undefined ? undefined : { cls, shape: 'model' };
    }
    if (e.type === 'Identifier') return this.lookup(e.name);
    if (e.type === 'ArrayExpression' && e.elements.length === 1 && e.elements[0]?.type === 'SpreadElement') {
      const inner = this.valueOf(e.elements[0].argument);
      return inner?.shape === 'collection' ? inner : undefined;
    }
    if (e.type === 'CallExpression') {
      if (e.callee.type === 'Identifier') return this.lookup(e.callee.name) === undefined ? this.functions.get(e.callee.name) : undefined;
      const name = memberName(e.callee);
      if (e.callee.type === 'MemberExpression' && name !== undefined) {
        const receiver = this.valueOf(e.callee.object);
        return receiver === undefined ? undefined : callResult(receiver, name);
      }
    }
    if (e.type === 'MemberExpression' && e.computed) {
      const receiver = this.valueOf(e.object);
      return receiver?.shape === 'collection' ? { cls: receiver.cls, shape: 'model' } : undefined;
    }
    return undefined;
  }

  private record(cls: string, name: string): void {
    let names = this.out.get(cls);
    if (names === undefined) this.out.set(cls, names = new Set());
    names.add(name);
  }

  /** Visits a function; an untyped first parameter takes the value the call site gives it. */
  private visitFunction(fn: FunctionLike, given: Value | undefined): void {
    this.scopes.push(new Map());
    fn.params.forEach((p, i) => {
      const { name, type, initializer } = parameter(p);
      if (initializer !== undefined) this.visit(initializer);
      this.bind(name, this.typeValue(type) ?? (i === 0 ? given : undefined));
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
    const only = fn.body.body.length === 1 ? fn.body.body[0]! : undefined;
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
      const receiver = this.valueOf(call.callee.object);
      if (receiver?.shape === 'model') {
        this.record(receiver.cls, name);
        if (modelCallbacks.has(name) || name.startsWith('addColumn')) given = receiver;
      } else if (receiver?.shape === 'collection' && elementCallbacks.has(name)) {
        given = { cls: receiver.cls, shape: 'model' };
      }
    }
    for (const arg of call.arguments) {
      if (given !== undefined && (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression')) this.visitFunction(arg, given);
      else this.visit(arg);
    }
  }

  private visitImport(node: ImportDeclaration): void {
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') this.namespaces.add(specifier.local.name);
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported = exportName(specifier.imported);
      if (this.models.has(imported)) this.classes.set(specifier.local.name, imported);
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
      this.bind(node.id, this.typeValue(typeOf(node.id)) ?? (init === null ? undefined : this.valueOf(init)));
      return;
    }
    if (node.type === 'ForOfStatement') {
      this.visit(node.right);
      const collection = this.valueOf(node.right);
      const element: Value | undefined = collection?.shape === 'collection' ? { cls: collection.cls, shape: 'model' } : undefined;
      this.scopes.push(new Map());
      if (node.left.type === 'VariableDeclaration') for (const d of node.left.declarations) this.bind(d.id, this.typeValue(typeOf(d.id)) ?? element);
      this.visit(node.body);
      this.scopes.pop();
      return;
    }
    if (node.type === 'CallExpression') return this.visitCall(node);
    for (const child of children(node)) this.visit(child);
  }
}

/** Parses a source file; a syntax error fails the scan with the file and the errors, since an unparsed file would hide its calls. */
function visitFile(path: string, models: ReadonlySet<string>, out: Map<string, Set<string>>): void {
  if (!extensions.has(extname(path))) return;
  const parsed = parseSync(path, readFileSync(path, 'utf8'));
  const errors = parsed.errors.filter(error => error.severity === 'Error');
  if (errors.length > 0) throw new Error(`orm-gen --scan: ${path} does not parse: ${errors.map(error => error.message).join('; ')}`);
  new Scanner(models, out).visit(parsed.program);
}

function visitDir(dir: string, models: ReadonlySet<string>, out: Map<string, Set<string>>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) visitDir(path, models, out);
    } else if (entry.isFile()) visitFile(path, models, out);
  }
}

/**
 * Returns, for each generated model class, the names of the methods that the
 * sources call on a receiver that resolves to that model.
 */
export function scanModelCalls(paths: readonly string[], models: ReadonlySet<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const path of paths) {
    if (statSync(path).isDirectory()) visitDir(path, models, out);
    else visitFile(path, models, out);
  }
  return out;
}
