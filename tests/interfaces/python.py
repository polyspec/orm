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


def wire_type(node) -> str:
    """The wire type of a field annotation of a TypedDict record, as the TypeScript extractor writes it:
    int as integer, str as text, bool as bool, list[X] as list<X>, dict[K, X] as map<X>, a record name as
    itself; a NotRequired or an optional X | None reads as X; a string annotation is a forward reference."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return wire_type(ast.parse(node.value, mode='eval').body)
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id in ('NotRequired', 'Required'):
        return wire_type(node.slice)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        if isinstance(node.right, ast.Constant) and node.right.value is None:
            return wire_type(node.left)
        if isinstance(node.left, ast.Constant) and node.left.value is None:
            return wire_type(node.right)
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name):
        if node.value.id == 'list':
            return f'list<{wire_type(node.slice)}>'
        if node.value.id == 'dict' and isinstance(node.slice, ast.Tuple):
            return f'map<{wire_type(node.slice.elts[1])}>'
    if isinstance(node, ast.Name):
        return {'int': 'integer', 'str': 'text', 'bool': 'bool'}.get(node.id, node.id)
    return ast.unparse(node)


def is_typed_dict(node: ast.ClassDef, typed_names: set) -> bool:
    """A class of a TypedDict record: it derives from TypedDict or from a record of the same module."""
    return any(isinstance(b, ast.Name) and (b.id == 'TypedDict' or b.id in typed_names) for b in node.bases)


def typed_dict_wire(node: ast.ClassDef) -> dict:
    """The record of a TypedDict class: its base as @flatten first, then each public field's wire type."""
    wire: dict = {}
    bases = [b.id for b in node.bases if isinstance(b, ast.Name) and b.id != 'TypedDict']
    if len(bases) == 1:
        wire['@flatten'] = bases[0]
    for stmt in node.body:
        if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and public(stmt.target.id):
            wire[stmt.target.id] = wire_type(stmt.annotation)
    return wire


def is_functional_typed_dict(node: ast.Assign) -> bool:
    """NAME = TypedDict('NAME', {...}), the form of a record with a field name that is a keyword."""
    call = node.value
    return (len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
            and isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == 'TypedDict')


def functional_typed_dict_wire(node: ast.Assign) -> dict:
    """The record of NAME = TypedDict('NAME', {...}): each key of the dict is a field with its wire type."""
    fields = node.value.args[1]
    return {key.value: wire_type(value) for key, value in zip(fields.keys, fields.values)}


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
        typed_names: set = set()
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and public(node.name):
                symbols[f'{path}::{node.name}'] = signature(node)
            elif isinstance(node, ast.ClassDef) and public(node.name):
                key = f'{path}::{node.name}'
                symbols[key] = class_header(node)
                class_members(key, node, symbols)
                if is_typed_dict(node, typed_names):
                    typed_names.add(node.name)
                    symbols[f'{key}#wire'] = json.dumps(typed_dict_wire(node), ensure_ascii=False, separators=(',', ':'))
            elif isinstance(node, ast.Assign) and is_functional_typed_dict(node) and public(node.targets[0].id):
                key = f'{path}::{node.targets[0].id}'
                symbols[key] = f'{node.targets[0].id} = TypedDict'
                typed_names.add(node.targets[0].id)
                symbols[f'{key}#wire'] = json.dumps(functional_typed_dict_wire(node), ensure_ascii=False, separators=(',', ':'))
    return symbols


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit('usage: python3 tests/interfaces/python.py <root> <source-root>...')
    root = os.path.abspath(sys.argv[1])
    sys.stdout.write(json.dumps(extract(root, sys.argv[2:]), indent=2, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
