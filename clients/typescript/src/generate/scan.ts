// Collects the method names that the scanned sources call on generated models.
// A call counts only when its receiver resolves to a model of the generated
// classes; docs/usage.md states the receivers the scan resolves. A call on
// any other receiver adds no method.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import ts from 'typescript';

const kinds: Readonly<Record<string, ts.ScriptKind>> = {
  '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS,
};

const skipped = new Set(['node_modules', 'dist']);

/** What an expression holds: a model, a promise of one, or a collection of models. */
type Shape = 'model' | 'promise' | 'collection' | 'promiseCollection';
interface Value { readonly cls: string; readonly shape: Shape }

/** Model methods that return something other than the model they are called on. */
const terminals = new Set(['create', 'creates', 'update', 'save', 'delete', 'toArray', 'toJSON', 'toJSONText']);
/** Model methods whose callback receives a model of the receiver's class. */
const modelCallbacks = new Set(['and', 'or', 'on', 'fetchKey', 'fetchValue']);
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

  private bind(name: ts.BindingName, value: Value | undefined): void {
    if (ts.isIdentifier(name)) this.scopes[this.scopes.length - 1]!.set(name.text, value ?? hidden);
  }

  /** The model class that the expression of a `new` or a type name refers to. */
  private className(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node)) return this.lookup(node.text) === undefined ? this.classes.get(node.text) : undefined;
    const [left, right] = ts.isPropertyAccessExpression(node) ? [node.expression, node.name] : ts.isQualifiedName(node) ? [node.left, node.right] : [undefined, undefined];
    if (left !== undefined && ts.isIdentifier(left) && this.namespaces.has(left.text) && this.models.has(right!.text)) return right!.text;
    return undefined;
  }

  /** The value a type declares: a model class, Promise, Collection or an array of models, or a union of one of them with other types. */
  private typeValue(type: ts.TypeNode | undefined): Value | undefined {
    if (type === undefined) return undefined;
    if (ts.isParenthesizedTypeNode(type)) return this.typeValue(type.type);
    if (ts.isUnionTypeNode(type)) {
      const values = type.types.map(t => this.typeValue(t)).filter((v): v is Value => v !== undefined);
      return values.length === 1 ? values[0] : undefined;
    }
    if (ts.isArrayTypeNode(type)) {
      const element = this.typeValue(type.elementType);
      return element?.shape === 'model' ? { cls: element.cls, shape: 'collection' } : undefined;
    }
    if (!ts.isTypeReferenceNode(type)) return undefined;
    const cls = this.className(type.typeName);
    if (cls !== undefined) return { cls, shape: 'model' };
    const name = ts.isIdentifier(type.typeName) ? type.typeName.text : '';
    const inner = type.typeArguments?.length === 1 ? this.typeValue(type.typeArguments[0]) : undefined;
    if (inner === undefined) return undefined;
    if (name === 'Promise') {
      if (inner.shape === 'model') return { cls: inner.cls, shape: 'promise' };
      if (inner.shape === 'collection') return { cls: inner.cls, shape: 'promiseCollection' };
      return undefined;
    }
    return ['Collection', 'Array', 'ReadonlyArray'].includes(name) && inner.shape === 'model' ? { cls: inner.cls, shape: 'collection' } : undefined;
  }

  /** The value of an expression, when it resolves to a model, a promise or a collection of models. */
  private valueOf(e: ts.Expression): Value | undefined {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) return this.valueOf(e.expression);
    if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) return this.typeValue(e.type) ?? this.valueOf(e.expression);
    if (ts.isAwaitExpression(e)) {
      const inner = this.valueOf(e.expression);
      if (inner?.shape === 'promise') return { cls: inner.cls, shape: 'model' };
      if (inner?.shape === 'promiseCollection') return { cls: inner.cls, shape: 'collection' };
      return inner;
    }
    if (ts.isNewExpression(e)) {
      const cls = this.className(e.expression);
      return cls === undefined ? undefined : { cls, shape: 'model' };
    }
    if (ts.isIdentifier(e)) return this.lookup(e.text);
    if (ts.isArrayLiteralExpression(e) && e.elements.length === 1 && ts.isSpreadElement(e.elements[0]!)) {
      const inner = this.valueOf(e.elements[0].expression);
      return inner?.shape === 'collection' ? inner : undefined;
    }
    if (ts.isCallExpression(e)) {
      if (ts.isIdentifier(e.expression)) return this.lookup(e.expression.text) === undefined ? this.functions.get(e.expression.text) : undefined;
      if (ts.isPropertyAccessExpression(e.expression)) {
        const receiver = this.valueOf(e.expression.expression);
        return receiver === undefined ? undefined : callResult(receiver, e.expression.name.text);
      }
    }
    if (ts.isElementAccessExpression(e)) {
      const receiver = this.valueOf(e.expression);
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
  private visitFunction(fn: ts.SignatureDeclaration & { readonly body?: ts.Node }, given: Value | undefined): void {
    this.scopes.push(new Map());
    fn.parameters.forEach((p, i) => {
      if (p.initializer !== undefined) this.visit(p.initializer);
      this.bind(p.name, this.typeValue(p.type) ?? (i === 0 ? given : undefined));
    });
    if (fn.body !== undefined) this.visit(fn.body);
    this.scopes.pop();
  }

  /**
   * The value a function returns: its declared return type, or the value of
   * an arrow function's expression body or of the only statement of its body
   * when that statement returns.
   */
  private returnValue(fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): Value | undefined {
    const declared = this.typeValue(fn.type);
    if (declared !== undefined || fn.type !== undefined || fn.body === undefined) return declared;
    if (!ts.isBlock(fn.body)) return this.valueOf(fn.body);
    const only = fn.body.statements.length === 1 ? fn.body.statements[0]! : undefined;
    return only !== undefined && ts.isReturnStatement(only) && only.expression !== undefined ? this.valueOf(only.expression) : undefined;
  }

  /** Records the functions of a block that return a model before the block's statements run. */
  private hoist(statements: ts.NodeArray<ts.Statement>): void {
    for (const s of statements) if (ts.isImportDeclaration(s)) this.visitImport(s);
    for (const s of statements) {
      if (ts.isFunctionDeclaration(s) && s.name !== undefined) {
        const value = this.returnValue(s);
        if (value !== undefined) this.functions.set(s.name.text, value);
      }
    }
  }

  private visitCall(call: ts.CallExpression): void {
    this.visit(call.expression);
    let given: Value | undefined;
    if (ts.isPropertyAccessExpression(call.expression)) {
      const receiver = this.valueOf(call.expression.expression);
      const name = call.expression.name.text;
      if (receiver?.shape === 'model') {
        this.record(receiver.cls, name);
        if (modelCallbacks.has(name) || name.startsWith('addColumn')) given = receiver;
      } else if (receiver?.shape === 'collection' && elementCallbacks.has(name)) {
        given = { cls: receiver.cls, shape: 'model' };
      }
    }
    for (const arg of call.arguments) {
      if (given !== undefined && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) this.visitFunction(arg, given);
      else this.visit(arg);
    }
  }

  private visitImport(node: ts.ImportDeclaration): void {
    const bindings = node.importClause?.namedBindings;
    if (bindings === undefined) return;
    if (ts.isNamespaceImport(bindings)) {
      this.namespaces.add(bindings.name.text);
      return;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (this.models.has(imported)) this.classes.set(element.name.text, imported);
      else this.classes.delete(element.name.text);
    }
  }

  public visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
      this.scopes.push(new Map());
      this.hoist(node.statements);
      ts.forEachChild(node, child => this.visit(child));
      this.scopes.pop();
      return;
    }
    if (ts.isFunctionLike(node) && !ts.isFunctionTypeNode(node) && !ts.isConstructorTypeNode(node) && !ts.isCallSignatureDeclaration(node)
      && !ts.isMethodSignature(node) && !ts.isIndexSignatureDeclaration(node) && !ts.isConstructSignatureDeclaration(node)) {
      return this.visitFunction(node as ts.SignatureDeclaration & { readonly body?: ts.Node }, undefined);
    }
    if (ts.isVariableDeclaration(node)) {
      const init = node.initializer;
      if (init !== undefined) {
        if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && ts.isIdentifier(node.name)) {
          const value = this.returnValue(init);
          if (value !== undefined) this.functions.set(node.name.text, value);
        }
        this.visit(init);
      }
      this.bind(node.name, this.typeValue(node.type) ?? (init === undefined ? undefined : this.valueOf(init)));
      return;
    }
    if (ts.isForOfStatement(node)) {
      this.visit(node.expression);
      const collection = this.valueOf(node.expression);
      const element: Value | undefined = collection?.shape === 'collection' ? { cls: collection.cls, shape: 'model' } : undefined;
      this.scopes.push(new Map());
      if (ts.isVariableDeclarationList(node.initializer)) for (const d of node.initializer.declarations) this.bind(d.name, this.typeValue(d.type) ?? element);
      this.visit(node.statement);
      this.scopes.pop();
      return;
    }
    if (ts.isCallExpression(node)) return this.visitCall(node);
    ts.forEachChild(node, child => this.visit(child));
  }
}

function visitFile(path: string, models: ReadonlySet<string>, out: Map<string, Set<string>>): void {
  const kind = kinds[extname(path)];
  if (kind === undefined) return;
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, false, kind);
  new Scanner(models, out).visit(source);
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
