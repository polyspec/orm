# scan collects the method names that the source calls on a generated model. It counts a call
# only when the receiver is read as that model's class. It reads the Python source with ast.
import ast
import os

__all__ = ["scan_model_calls"]

_SKIPPED = frozenset({"node_modules", "__pycache__", ".venv"})
# Model methods whose result is no model: a call on it ends the chain.
_TERMINALS = frozenset(
    {"create", "creates", "update", "save", "delete", "restore", "to_array", "to_json", "to_json_text"}
)
# The annotation names of a collection of models.
_COLLECTIONS = frozenset({"Iterable", "Iterator", "list", "List", "Sequence", "Collection", "tuple"})
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

    # A binding maps a local name to a model class name, or to ("many", class name) for a collection of models.
    def annotated(node, names):
        # The model that a type annotation names: Author, Author | None, Optional[Author], or a collection of Author
        # (Iterable, list, Sequence, Collection) as ("many", Author).
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            try:
                node = ast.parse(node.value, mode="eval").body
            except SyntaxError:
                return None
        if isinstance(node, ast.Name):
            class_name = names.get(node.id)
            return class_name if isinstance(class_name, str) and class_name in classes else None
        if isinstance(node, ast.Attribute):
            return node.attr if node.attr in classes else None
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            found = [v for v in (annotated(node.left, names), annotated(node.right, names)) if v is not None]
            return found[0] if len(found) == 1 else None
        if isinstance(node, ast.Subscript):
            outer = node.value.attr if isinstance(node.value, ast.Attribute) else getattr(node.value, "id", "")
            inner = annotated(node.slice, names)
            if outer == "Optional":
                return inner
            if outer in _COLLECTIONS and isinstance(inner, str):
                return ("many", inner)
        return None

    def value_of(node, names):
        # The model, or ("many", model) for a collection, that the expression holds, or None.
        while isinstance(node, ast.Await):
            node = node.value
        if isinstance(node, ast.Name):
            value = names.get(node.id)
            return value if value is None or isinstance(value, tuple) or value in classes else None
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            # The generation call Author() makes a model of that class.
            class_name = names.get(node.func.id)
            return class_name if isinstance(class_name, str) and class_name in classes else None
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            receiver = value_of(node.func.value, names)
            name = node.func.attr
            if isinstance(receiver, tuple):
                return receiver[1] if name in ("first", "get") else None
            if receiver is None:
                return None
            if name == "gets" or name.startswith("gets_by_"):
                return ("many", receiver)
            if name == "get" or name.startswith("get_by_"):
                return receiver
            if name in _TERMINALS or name.startswith("get"):
                return None
            return receiver
        if isinstance(node, ast.Subscript):
            collection = value_of(node.value, names)
            return collection[1] if isinstance(collection, tuple) else None
        return None

    def model_of(node, names):
        value = value_of(node, names)
        return value if isinstance(value, str) else None

    def bind(target, value, names):
        if isinstance(target, ast.Name):
            if value is None:
                names.pop(target.id, None)
            else:
                names[target.id] = value

    def visit(node, names):
        if isinstance(node, ast.Assign):
            for child in ast.iter_child_nodes(node):
                visit(child, names)
            value = value_of(node.value, names)
            for target in node.targets:
                if isinstance(target, ast.Name) and value is not None:
                    names[target.id] = value
            return
        if isinstance(node, ast.AnnAssign):
            # A getter returns no declared model, so an annotation is how a receiver read through a getter names its
            # model: writer: User | None = row.get_writer().
            if node.value is not None:
                visit(node.value, names)
            value = annotated(node.annotation, names)
            bind(node.target, value if value is not None else (value_of(node.value, names) if node.value is not None else None), names)
            return
        if isinstance(node, (ast.For, ast.AsyncFor)):
            visit(node.iter, names)
            collection = value_of(node.iter, names)
            bind(node.target, collection[1] if isinstance(collection, tuple) else None, names)
            for stmt in node.body + node.orelse:
                visit(stmt, names)
            return
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            inner = dict(names)
            for arg in list(node.args.posonlyargs) + list(node.args.args) + list(node.args.kwonlyargs):
                inner.pop(arg.arg, None)
                if arg.annotation is not None:
                    bind(ast.Name(id=arg.arg), annotated(arg.annotation, names), inner)
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
                        visit(func.value, names)
                        body = callback.body if isinstance(callback.body, list) else [callback.body]
                        for stmt in body:
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
