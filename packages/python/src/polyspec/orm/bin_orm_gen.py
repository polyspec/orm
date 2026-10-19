# orm-gen: the Python model generator.
#
#   orm-gen gen --set <dbspec-set.json> --out <directory> [--scan <file or directory>]... [--check]
#
# The document set is read from its set file (docs/spec/dbspec.md "Document sets"). A set file with an
# error, or a listed file with a diagnostic, prints every error and diagnostic, exits with status 1
# and writes nothing.
import argparse
import os
import sys

from polyspec.orm.dbspec import read_dbspec_bytes, read_dbspec_set
from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.errors import OrmError
from polyspec.orm.generate.python import generate_models, render_models


class _UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    """An argument parser that reports a usage error to main instead of exiting."""

    def error(self, message):
        raise _UsageError(f"{self.prog}: {message}\n{self.format_usage().rstrip()}")


def _parser() -> argparse.ArgumentParser:
    parser = _Parser(
        prog="orm-gen",
        allow_abbrev=False,
        description="Generates the Python models of a dbspec document set.",
    )
    commands = parser.add_subparsers(
        dest="command", required=True, parser_class=_Parser
    )
    gen = commands.add_parser(
        "gen", allow_abbrev=False, help="write models.py of the document set"
    )
    gen.add_argument(
        "--set",
        required=True,
        metavar="<dbspec-set.json>",
        help="the set file that declares the document set",
    )
    gen.add_argument(
        "--out",
        required=True,
        metavar="<directory>",
        help="the directory that receives models.py",
    )
    gen.add_argument(
        "--scan",
        action="append",
        default=[],
        metavar="<file or directory>",
        help="a source whose model method calls are checked (repeatable)",
    )
    gen.add_argument(
        "--check",
        action="store_true",
        help="compare models.py with the generated text instead of writing it",
    )
    return parser


def _read_set(path: str):
    """The texts of the set's documents and external documents, or every error and diagnostic of
    the set file and of its listed files as printable lines."""
    found, errors = read_dbspec_set(path)
    if found is None:
        return None, None, [f"{error.rule}: {error.message}" for error in errors]
    problems = []
    texts = ([], [])
    for index, files in enumerate((found.documents, found.external)):
        for file in files:
            text, diagnostics = read_dbspec_bytes(file.path, file.data)
            problems.extend(
                f"{file.path}:{d.line}:{d.column}: {d.rule}: {d.message}"
                for d in diagnostics
            )
            texts[index].append(text)
    if problems:
        return None, None, problems
    return texts[0], texts[1], []


def _gen(options) -> int:
    documents, external, problems = _read_set(options.set)
    if problems:
        for problem in problems:
            print(f"orm-gen: {problem}", file=sys.stderr)
        return 1
    model = model_of_documents(parse_document_set(documents, external))
    out = options.out
    if options.check:
        path = os.path.join(out, "models.py")
        try:
            with open(path, encoding="utf-8") as handle:
                current = handle.read()
        except FileNotFoundError:
            print(f"missing: {path}")
            return 1
        if current == render_models(model, out, options.scan):
            return 0
        print(f"differs: {path}")
        return 1
    generate_models(model, out, options.scan)
    print(
        f"orm-gen: {len(model.entities)} models (manifest {model.manifest_hash}) "
        f"-> {out}/models.py",
        file=sys.stderr,
    )
    return 0


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        options = _parser().parse_args(args)
    except _UsageError as error:
        print(str(error), file=sys.stderr)
        return 2
    try:
        return _gen(options)
    except OrmError as error:
        print(f"orm-gen: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
