"""Print the comment tokens of Python source files.

Comments come from the tokenize module (COMMENT tokens). A docstring is a string token, so the ast module finds the
docstrings of modules, classes and functions, and each docstring is reported as one entry that spans its lines.
The file paths come one per line on standard input. The output is one JSON array per path, in input order; each entry
holds the line, the column and the text, and a multi-line entry keeps its newlines in text.
"""

import ast
import io
import json
import sys
import tokenize


def docstring_entries(source: str):
    """Yield (line, col, text) for every docstring of the module, its classes and its functions."""
    lines = source.split("\n")
    tree = ast.parse(source)
    nodes = [tree] + [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    for node in nodes:
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        if not (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str)):
            continue
        start_line, start_col = first.value.lineno, first.value.col_offset
        end_line, end_col = first.value.end_lineno, first.value.end_col_offset
        if start_line == end_line:
            text = lines[start_line - 1][start_col:end_col]
        else:
            parts = [lines[start_line - 1][start_col:]]
            parts += lines[start_line:end_line - 1]
            parts.append(lines[end_line - 1][:end_col])
            text = "\n".join(parts)
        yield start_line, start_col, text


def comments_of(path: str):
    with open(path, "rb") as handle:
        data = handle.read()
    source = data.decode("utf-8")
    entries = []
    for token in tokenize.tokenize(io.BytesIO(data).readline):
        if token.type == tokenize.COMMENT:
            entries.append({"line": token.start[0], "col": token.start[1], "text": token.string})
    for line, col, text in docstring_entries(source):
        entries.append({"line": line, "col": col, "text": text})
    entries.sort(key=lambda entry: (entry["line"], entry["col"]))
    return entries


def main() -> int:
    paths = [line.strip() for line in sys.stdin if line.strip()]
    out = []
    failed = False
    for path in paths:
        try:
            out.append(comments_of(path))
        except (OSError, SyntaxError, tokenize.TokenError, UnicodeDecodeError) as error:
            print(f"python-comments: {path}: {error}", file=sys.stderr)
            failed = True
            out.append([])
    if failed:
        return 1
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
