# scan은 생성된 model에 대해 소스가 부르는 method 이름을 모은다. 호출은 받는
# 사람이 그 model의 class로 읽힐 때만 센다. Python source를 ast로 읽는다.
import ast
import os

__all__ = ['scan_model_calls']

_SKIPPED = frozenset({'node_modules', '__pycache__', '.venv'})
# 첫 parameter가 같은 model을 받는 method다.
_MODEL_CALLBACKS = frozenset({'and_', 'or_', 'not_', 'and_not', 'or_not', 'on',
                              'fetch_key', 'fetch_value'})


def _scan_tree(tree, classes: dict, out: dict) -> None:
    # 지역 이름 -> 생성 class 이름. import 별명과 대입을 여기에 더한다.
    imported = dict(classes)

    class ImportCollector(ast.NodeVisitor):
        def visit_ImportFrom(self, node):
            for alias in node.names:
                if alias.name in classes:
                    imported[alias.asname or alias.name] = alias.name

        def visit_Import(self, node):
            for alias in node.names:
                name = alias.name.rsplit('.', 1)[-1]
                if name in classes:
                    imported[alias.asname or name] = name

    ImportCollector().visit(tree)

    def model_of(node, names) -> str | None:
        # 표현식이 가리키는 model의 지역 이름, 또는 None.
        while isinstance(node, ast.Await):
            node = node.value
        if isinstance(node, ast.Name):
            return names.get(node.id)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            # 생성 호출 Author()는 그 class의 model을 만든다.
            class_name = names.get(node.func.id)
            return class_name if class_name in classes else None
        return None

    def visit(node, names):
        if isinstance(node, ast.Assign):
            local = model_of(node.value, names)
            for target in node.targets:
                if isinstance(target, ast.Name) and local is not None:
                    names[target.id] = local
            for child in ast.iter_child_nodes(node):
                visit(child, names)
            return
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            inner = dict(names)
            for arg in list(node.args.args) + list(node.args.kwonlyargs):
                inner.pop(arg.arg, None)
            for child in node.args.defaults:
                visit(child, inner)
            for stmt in node.body:
                visit(stmt, inner)
            return
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute):
                receiver = model_of(func.value, names)
                if receiver is not None:
                    out[receiver].add(func.attr)
                    if func.attr in _MODEL_CALLBACKS and node.args \
                            and isinstance(node.args[0], (ast.FunctionDef, ast.Lambda)):
                        callback = node.args[0]
                        params = list(callback.args.args)
                        inner = dict(names)
                        if params:
                            inner[params[0].arg] = receiver
                        for stmt in getattr(callback, 'body', []):
                            visit(stmt, inner)
                        for default in callback.args.defaults:
                            visit(default, inner)
                        return
            for child in ast.iter_child_nodes(node):
                visit(child, names)
            return
        for child in ast.iter_child_nodes(node):
            visit(child, names)

    visit(tree, imported)


def _scan_file(path: str, classes: dict, out: dict) -> None:
    if not path.endswith('.py'):
        return
    try:
        with open(path, encoding='utf-8') as handle:
            tree = ast.parse(handle.read(), filename=path)
    except SyntaxError:
        return
    _scan_tree(tree, classes, out)


def scan_model_calls(paths, models) -> dict:
    """생성된 model class마다, 소스가 그 model의 받는 사람에 대해 부르는 method
    이름의 목록을 돌려준다."""
    classes = {name: name for name in models}
    out = {name: set() for name in models}
    for path in paths:
        if os.path.isdir(path):
            for base, directories, files in os.walk(path):
                directories[:] = sorted(d for d in directories if d not in _SKIPPED)
                for name in sorted(files):
                    _scan_file(os.path.join(base, name), classes, out)
        else:
            _scan_file(path, classes, out)
    return out
