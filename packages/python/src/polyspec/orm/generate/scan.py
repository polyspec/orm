# scan collects the method names that the source calls on a generated model. It counts a call
# only when the receiver is read as that model's class. It reads the Python source with ast.
import ast
import os

__all__ = ["scan_model_calls"]

_SKIPPED = frozenset({"node_modules", "__pycache__", ".venv"})
# A method whose first parameter receives the same model.
_MODEL_CALLBACKS = frozenset(
    {"and_", "or_", "not_", "and_not", "or_not", "on", "fetch_key", "fetch_value"}
)


def _scan_tree(tree, classes: dict, out: dict) -> None:
    # Local name -> generated class name. Import aliases and assignments are added here.
    imported = dict(classes)

    class ImportCollector(ast.NodeVisitor):
        def visit_ImportFrom(self, node):
            for alias in node.names:
                if alias.name in classes:
                    imported[alias.asname or alias.name] = alias.name

        def visit_Import(self, node):
            for alias in node.names:
                name = alias.name.rsplit(".", 1)[-1]
                if name in classes:
                    imported[alias.asname or name] = name

    ImportCollector().visit(tree)

    def model_of(node, names) -> str | None:
        # Local name of the model that the expression refers to, or None.
        while isinstance(node, ast.Await):
            node = node.value
        if isinstance(node, ast.Name):
            return names.get(node.id)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            # The generation call Author() makes a model of that class.
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
                    if (
                        func.attr in _MODEL_CALLBACKS
                        and node.args
                        and isinstance(node.args[0], (ast.FunctionDef, ast.Lambda))
                    ):
                        callback = node.args[0]
                        params = list(callback.args.args)
                        inner = dict(names)
                        if params:
                            inner[params[0].arg] = receiver
                        for stmt in getattr(callback, "body", []):
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
    if not path.endswith(".py"):
        return
    try:
        with open(path, encoding="utf-8") as handle:
            tree = ast.parse(handle.read(), filename=path)
    except SyntaxError:
        return
    _scan_tree(tree, classes, out)


def scan_model_calls(paths, models) -> dict:
    """For each generated model class, returns the list of method
    names that the source calls on that model's receiver."""
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
