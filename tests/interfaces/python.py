#!/usr/bin/env python3
# Python symbol extractor of tests/interfaces/check: prints the public declarations of the Python
# client as JSON in the form of tests/interfaces/typescript.mjs. A key names a top-level
# declaration as "<path>::<name>", a member as "<class key>.<name>" and a field as
# "<class key>#field.<name>"; a value is the class header, the signature or the annotation.
#
# Usage: python3 tests/interfaces/python.py <root> <source-root>...
import ast
import json
import os
import sys


def public(name: str) -> bool:
    return not name.startswith('_')


def signature(fn) -> str:
    decorators = ''.join(f'@{ast.unparse(d)} ' for d in fn.decorator_list)
    prefix = 'async def' if isinstance(fn, ast.AsyncFunctionDef) else 'def'
    returns = f' -> {ast.unparse(fn.returns)}' if fn.returns is not None else ''
    return f'{decorators}{prefix} {fn.name}({ast.unparse(fn.args)}){returns}'


def class_header(node: ast.ClassDef) -> str:
    bases = ', '.join(ast.unparse(b) for b in node.bases)
    return f'class {node.name}({bases})' if bases else f'class {node.name}'


def class_members(key: str, node: ast.ClassDef, symbols: dict) -> None:
    for stmt in node.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and public(stmt.name):
            symbols[f'{key}.{stmt.name}'] = signature(stmt)
            if stmt.name == '__init__':
                for inner in ast.walk(stmt):
                    if isinstance(inner, ast.AnnAssign) and isinstance(inner.target, ast.Attribute) \
                            and isinstance(inner.target.value, ast.Name) \
                            and inner.target.value.id == 'self' and public(inner.target.attr):
                        symbols[f'{key}#field.{inner.target.attr}'] = ast.unparse(inner.annotation)
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and public(stmt.target.id):
            symbols[f'{key}#field.{stmt.target.id}'] = ast.unparse(stmt.annotation)


def extract(root: str, roots: list) -> dict:
    files = []
    for source_root in roots:
        for directory, dirnames, filenames in os.walk(os.path.join(root, source_root)):
            dirnames[:] = sorted(d for d in dirnames if d != '__pycache__')
            files.extend(os.path.join(directory, f) for f in filenames if f.endswith('.py'))
    symbols: dict = {}
    for file in sorted(files):
        path = os.path.relpath(file, root)
        with open(file, encoding='utf-8') as handle:
            tree = ast.parse(handle.read(), filename=file)
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and public(node.name):
                symbols[f'{path}::{node.name}'] = signature(node)
            elif isinstance(node, ast.ClassDef) and public(node.name):
                key = f'{path}::{node.name}'
                symbols[key] = class_header(node)
                class_members(key, node, symbols)
    return symbols


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit('usage: python3 tests/interfaces/python.py <root> <source-root>...')
    root = os.path.abspath(sys.argv[1])
    sys.stdout.write(json.dumps(extract(root, sys.argv[2:]), indent=2, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
