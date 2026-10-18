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


# A binding that the scan cannot type (UNKNOWN) poisons a union; a binding that holds nothing (NOTHING: None or an uninitialized
# declaration) contributes nothing to it. An unbound name is absent from the scope and contributes nothing as well.
UNKNOWN = object()
NOTHING = ("union", ())


def _members(value) -> list:
    """The class or collection values that a binding may hold: none for an unknown value, each member of a union."""
    if value is None or value is UNKNOWN or value is NOTHING:
        return []
    if isinstance(value, tuple) and value[0] == "union":
        return list(value[1])
    return [value]


def _union(values) -> object:
    """The binding of a name that may hold any of the values: UNKNOWN when one is unknown, the value when they agree, a union
    of their members otherwise, and NOTHING when none of them holds a model."""
    items = []
    holds_nothing = False
    for value in values:
        if value is None or value is UNKNOWN:
            return UNKNOWN
        if value == NOTHING:
            holds_nothing = True
            continue
        for member in _members(value):
            if member not in items:
                items.append(member)
    if not items:
        return NOTHING if holds_nothing else UNKNOWN
    return items[0] if len(items) == 1 else ("union", tuple(items))


def _merge(*states) -> dict:
    """The bindings after branches that each end in one of the states: a name that a state does not bind contributes nothing."""
    keys = []
    for state in states:
        for key in state:
            if key not in keys:
                keys.append(key)
    return {key: _union([state[key] for state in states if key in state]) for key in keys}


def _element(collection) -> object:
    """The model that each element of a collection of models holds."""
    return _union([m[1] if isinstance(m, tuple) and m[0] == "many" else None for m in _members(collection)])


def _exits(stmts) -> bool:
    """Whether a block ends in return or raise, so that the scope after the block is not reached from its end."""
    last = stmts[-1] if stmts else None
    return isinstance(last, (ast.Return, ast.Raise))


def _scan_tree(tree, classes: dict, out: dict, sites=None) -> None:
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
            return _union([call_result(m, name) for m in _members(receiver)])
        if isinstance(node, ast.Subscript):
            return _element(value_of(node.value, names))
        if isinstance(node, ast.Constant) and node.value is None:
            return NOTHING
        return None

    def call_result(receiver, name):
        # The value of a method call on one class or collection of classes.
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

    def model_of(node, names):
        value = value_of(node, names)
        return value if isinstance(value, str) else None

    def models_of(node, names):
        # Each class that the expression may hold, so that a call on it is recorded for each of them.
        return [m for m in _members(value_of(node, names)) if isinstance(m, str)]

    def pattern_names(pattern):
        # The names that a match pattern captures.
        found = []
        for sub in ast.walk(pattern):
            if isinstance(sub, (ast.MatchAs, ast.MatchStar)) and sub.name is not None:
                found.append(sub.name)
            if isinstance(sub, ast.MatchMapping) and sub.rest is not None:
                found.append(sub.rest)
        return found

    def enter_loop(nodes, names):
        # Before a loop runs, a name that the loop assigns may hold what it held before or what its assignments give it,
        # since a later iteration sees the assignments of an earlier one.
        candidates = {}
        for stmt in nodes:
            for sub in ast.walk(stmt):
                if isinstance(sub, ast.Assign):
                    for target in sub.targets:
                        if isinstance(target, ast.Name):
                            candidates.setdefault(target.id, []).append(value_of(sub.value, names))
                        else:
                            for inner in ast.walk(target):
                                if isinstance(inner, ast.Name):
                                    candidates.setdefault(inner.id, []).append(None)
                elif isinstance(sub, ast.AnnAssign) and isinstance(sub.target, ast.Name):
                    candidates.setdefault(sub.target.id, []).append(value_of(sub.value, names) if sub.value is not None else None)
                elif isinstance(sub, (ast.With, ast.AsyncWith)):
                    for item in sub.items:
                        for inner in ast.walk(item.optional_vars) if item.optional_vars is not None else []:
                            if isinstance(inner, ast.Name):
                                candidates.setdefault(inner.id, []).append(None)
                elif isinstance(sub, ast.ExceptHandler) and sub.name is not None:
                    candidates.setdefault(sub.name, []).append(None)
                elif isinstance(sub, (ast.MatchAs, ast.MatchStar, ast.MatchMapping)):
                    for captured in pattern_names(sub):
                        candidates.setdefault(captured, []).append(None)
                elif isinstance(sub, (ast.AugAssign, ast.NamedExpr)) and isinstance(sub.target, ast.Name):
                    candidates.setdefault(sub.target.id, []).append(None)
                elif isinstance(sub, (ast.For, ast.AsyncFor)):
                    for inner in ast.walk(sub.target):
                        if isinstance(inner, ast.Name):
                            candidates.setdefault(inner.id, []).append(None)
        for name, values in candidates.items():
            before = [names[name]] if name in names else []
            names[name] = _union(before + values)

    def bind(target, value, names):
        if isinstance(target, ast.Name):
            names[target.id] = UNKNOWN if value is None else value

    def forget(target, names):
        # A target whose class is unknown, such as a tuple or a with-as name, makes every name it binds unknown.
        for node in ast.walk(target):
            if isinstance(node, ast.Name):
                names[node.id] = UNKNOWN

    def visit(node, names):
        if isinstance(node, ast.Assign):
            for child in ast.iter_child_nodes(node):
                visit(child, names)
            value = value_of(node.value, names)
            for target in node.targets:
                if isinstance(target, ast.Name):
                    bind(target, value, names)
                else:
                    forget(target, names)
            return
        if isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                visit(item.context_expr, names)
                if item.optional_vars is not None:
                    forget(item.optional_vars, names)
            for stmt in node.body:
                visit(stmt, names)
            return
        if isinstance(node, ast.NamedExpr):
            visit(node.value, names)
            bind(node.target, value_of(node.value, names), names)
            return
        if isinstance(node, ast.If):
            # Both branches start from the same bindings; a name that the branches bind differently is unknown after them.
            visit(node.test, names)
            then_names, else_names = dict(names), dict(names)
            for stmt in node.body:
                visit(stmt, then_names)
            for stmt in node.orelse:
                visit(stmt, else_names)
            # A branch that returns or raises contributes nothing to the scope after the if.
            states = ([] if _exits(node.body) else [then_names]) + ([] if _exits(node.orelse) else [else_names])
            names.clear()
            names.update(_merge(*states) if states else else_names)
            return
        if isinstance(node, ast.While):
            # A loop may run zero times, so the scope after it joins the scope before it.
            before = dict(names)
            visit(node.test, names)
            enter_loop([node.test, *node.body], names)
            for stmt in node.body + node.orelse:
                visit(stmt, names)
            after = dict(names)
            names.clear()
            names.update(_merge(before, after))
            return
        if isinstance(node, (ast.Try,) + ((ast.TryStar,) if hasattr(ast, "TryStar") else ())):
            # A handler starts from the scope before the try joined with the scope at the end of its body, since an exception can
            # leave any statement of the body; the handler's name is unknown inside the handler. A branch that returns or raises
            # contributes nothing after the try, but the finally block starts from every outcome of it.
            base = dict(names)
            for stmt in node.body:
                visit(stmt, names)
            body_end = dict(names)
            every = []
            ends = []
            for handler in node.handlers:
                state = _merge(base, body_end)
                if handler.type is not None:
                    visit(handler.type, state)
                if handler.name is not None:
                    state[handler.name] = UNKNOWN
                for stmt in handler.body:
                    visit(stmt, state)
                every.append(state)
                if not _exits(handler.body):
                    ends.append(state)
            normal = dict(body_end)
            for stmt in node.orelse:
                visit(stmt, normal)
            every.append(normal)
            if not _exits(node.body) and not _exits(node.orelse):
                ends.append(normal)
            if node.handlers or node.finalbody:
                every.append(base)
            names.clear()
            names.update(_merge(*(every if node.finalbody else (ends or every))))
            for stmt in node.finalbody:
                visit(stmt, names)
            return
        if isinstance(node, ast.Match):
            visit(node.subject, names)
            base = dict(names)
            ends = []
            irrefutable = False
            for case in node.cases:
                state = dict(base)
                for captured in pattern_names(case.pattern):
                    state[captured] = UNKNOWN
                if case.guard is not None:
                    visit(case.guard, state)
                for stmt in case.body:
                    visit(stmt, state)
                if not _exits(case.body):
                    ends.append(state)
                if case.guard is None and isinstance(case.pattern, ast.MatchAs) and case.pattern.pattern is None:
                    irrefutable = True
            if not irrefutable:
                ends.append(base)
            merged = _merge(*ends) if ends else base
            names.clear()
            names.update(merged)
            return
        if isinstance(node, ast.AnnAssign):
            # A getter returns no declared model, so an annotation is how a receiver read through a getter names its
            # model: writer: User | None = row.get_writer().
            if node.value is not None:
                visit(node.value, names)
            value = annotated(node.annotation, names)
            bind(node.target, value if value is not None else (value_of(node.value, names) if node.value is not None else NOTHING), names)
            return
        if isinstance(node, (ast.For, ast.AsyncFor)):
            before = dict(names)
            visit(node.iter, names)
            collection = value_of(node.iter, names)
            if isinstance(node.target, ast.Name):
                bind(node.target, _element(collection), names)
            else:
                forget(node.target, names)
            enter_loop(node.body, names)
            for stmt in node.body + node.orelse:
                visit(stmt, names)
            after = dict(names)
            names.clear()
            names.update(_merge(before, after))
            return
        if isinstance(node, (ast.Lambda, ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            # A lambda or a comprehension has its own scope: its parameters and targets shadow the enclosing names.
            inner = dict(names)
            if isinstance(node, ast.Lambda):
                for arg in list(node.args.posonlyargs) + list(node.args.args) + list(node.args.kwonlyargs):
                    inner.pop(arg.arg, None)
                visit(node.body, inner)
                return
            for generator in node.generators:
                visit(generator.iter, inner)
                collection = value_of(generator.iter, inner)
                if isinstance(generator.target, ast.Name):
                    bind(generator.target, _element(collection), inner)
                else:
                    forget(generator.target, inner)
                for condition in generator.ifs:
                    visit(condition, inner)
            for part in ((node.key, node.value) if isinstance(node, ast.DictComp) else (node.elt,)):
                visit(part, inner)
            return
        if isinstance(node, ast.ClassDef):
            # Names bound in a class body belong to that body.
            inner = dict(names)
            for stmt in node.body:
                visit(stmt, inner)
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
                receivers = models_of(func.value, names)
                if receivers:
                    for receiver in receivers:
                        out[receiver].add(func.attr)
                    if sites is not None:
                        sites.append({"name": func.attr, "classes": list(receivers)})
                    if (
                        func.attr in _MODEL_CALLBACKS
                        and node.args
                        and isinstance(node.args[0], (ast.FunctionDef, ast.Lambda))
                        and len(receivers) == 1
                    ):
                        receiver = receivers[0]
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


def _scan_file(path: str, classes: dict, out: dict, sites=None) -> None:
    if not path.endswith(".py"):
        return
    try:
        with open(path, encoding="utf-8") as handle:
            tree = ast.parse(handle.read(), filename=path)
    except SyntaxError:
        return
    _scan_tree(tree, classes, out, sites)


def scan_model_calls(paths, models, sites=None) -> dict:
    """For each generated model class, returns the list of method
    names that the source calls on that model's receiver."""
    classes = {name: name for name in models}
    out = {name: set() for name in models}
    for path in paths:
        if os.path.isdir(path):
            for base, directories, files in os.walk(path):
                directories[:] = sorted(d for d in directories if d not in _SKIPPED)
                for name in sorted(files):
                    _scan_file(os.path.join(base, name), classes, out, sites)
        else:
            _scan_file(path, classes, out, sites)
    return out
