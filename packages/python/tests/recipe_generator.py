"""The generator.generate op of the recipe helper (docs/spec/feature-coverage.md FCV-4): it writes the scanned Python sources of a
step under a temporary root and calls generate_models with that root as the scan input."""

import ast
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from polyspec.orm import OrmError
from polyspec.orm.dbspec import read_dbspec_bytes
from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.generate.python import generate_models, pascal
from polyspec.orm.generate.scan import scan_model_calls


def _document_texts(recipe_dir: Path, names: list) -> list:
    """The texts of the .dbs documents named relative to the recipe directory."""
    texts = []
    for name in names:
        path = (recipe_dir / name).resolve()
        text, diagnostics = read_dbspec_bytes(str(path), path.read_bytes())
        if diagnostics:
            raise AssertionError(f"{path}: {diagnostics}")
        texts.append(text)
    return texts


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _generated_methods(model, root: Path) -> set:
    """The methods of each model class of models.py as table.name, without the language prefix (FCV-4), and the calls that the
    scan attributes to the class: Python resolves a chain at call time and declares no chain method for it (DSL-37)."""
    out = root / "model"
    names = set()
    for node in ast.parse((out / "models.py").read_text(encoding="utf-8")).body:
        if isinstance(node, ast.ClassDef):
            names.add(_snake(node.name))
            for member in node.body:
                if isinstance(member, ast.FunctionDef):
                    names.add(f"{_snake(node.name)}.{_without_prefix(member.name)}")
    calls = scan_model_calls(
        [str(root)], {pascal(name) for name in model.entities}, None, str(out)
    )
    for class_name, methods in calls.items():
        names.update(
            f"{_snake(class_name)}.{_without_prefix(method)}" for method in methods
        )
    return names


def _without_prefix(method: str) -> str:
    return re.sub(r"^(?:get|new|alias)_", "", method)


def _generate(step: dict, recipe_dir: Path, root: Path) -> set:
    """Writes the sources of the step, generates its sets under root and returns the generated method names."""
    options = step.get("options", {})
    for path, text in options.get("sources", {}).get("python", {}).items():
        file = root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding="utf-8")
    before = options.get("before")
    if before is not None:
        model = model_of_documents(
            parse_document_set(_document_texts(recipe_dir, [before["schema"]]), [])
        )
        generate_models(
            model, str(root / before["output"]), [str(root / before["scan"])]
        )
    documents = _document_texts(recipe_dir, [step["schema"]])
    replace = options.get("schema_replace")
    if replace is not None:
        documents = [text.replace(replace["from"], replace["to"]) for text in documents]
    model = model_of_documents(
        parse_document_set(
            documents, _document_texts(recipe_dir, options.get("used", []))
        )
    )
    generate_models(model, str(root / "model"), [str(root)])
    return _generated_methods(model, root)


def check_generator(step: dict, recipe_dir: Path, database: str) -> None:
    """Runs one generator.generate step and checks it against the expect of database."""
    want = step["expect"].get(database)
    if want is None:
        raise AssertionError(f"generator.generate has no expect for {database}")
    with tempfile.TemporaryDirectory(prefix="orm-recipe-generator-") as work:
        try:
            names = _generate(step, recipe_dir, Path(work).resolve())
            text = "".join(
                file.read_text(encoding="utf-8")
                for file in sorted((Path(work) / "model").iterdir())
                if file.is_file()
            )
        except OrmError as error:
            if "error" not in want:
                raise
            if error.code != want["error"]:
                raise AssertionError(
                    f"error code {error.code}, want {want['error']}: {error}"
                ) from error
            if "message" in want and want["message"] not in str(error):
                raise AssertionError(
                    f"error does not contain {want['message']}: {error}"
                ) from error
            if (Path(work) / "model").exists():
                raise AssertionError("a refused generation wrote its output") from error
            if "position" in want and f".py:{want['position']['line']}:" not in str(
                error
            ):
                raise AssertionError(
                    f"error position does not name line {want['position']['line']}: {error}"
                ) from error
            return
    if "error" in want:
        raise AssertionError(f"generation succeeded, want error {want['error']}")
    for name in want["value"]["includes"]:
        if name not in names:
            raise AssertionError(f"generated code lacks {name}")
    for name in want["value"]["excludes"]:
        if name in names:
            raise AssertionError(f"generated code declares {name}")
    for part in want["value"].get("text", {}).get("includes", []):
        if part not in text:
            raise AssertionError(f"generated text lacks {part}")
    for part in want["value"].get("text", {}).get("excludes", []):
        if part in text:
            raise AssertionError(f"generated text holds {part}")


def check_generated_files(step: dict, recipe_dir: Path) -> None:
    """Runs one generator.check step (FCV-4, DBS-175) through orm-gen gen --check of this client."""
    with tempfile.TemporaryDirectory(prefix="orm-recipe-generator-check-") as work:
        out = Path(work) / "model"
        out.mkdir()

        def gen(*extra: str) -> tuple:
            done = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "polyspec.orm.bin_orm_gen",
                    "gen",
                    "--set",
                    str((recipe_dir / step["document_set"]).resolve()),
                    "--out",
                    str(out),
                    *extra,
                ],
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            return done.returncode, done.stdout + done.stderr

        def expect(lines: list, file: str) -> None:
            want = "".join(line.replace("<file>", file) + "\n" for line in lines)
            got = gen("--check")
            if got != (1 if lines else 0, want):
                raise AssertionError(f"generator.check: got {got}, want {want!r}")

        code, output = gen()
        if code != 0:
            raise AssertionError(f"generator.check: generate exit {code}: {output}")
        file = next(
            path for path in sorted(out.iterdir()) if path.is_file() and path.stat().st_size
        )
        # A file that the generation does not write is not compared.
        (out / "zz_notes.py").write_text("# notes\n", encoding="utf-8")
        expect(step["unchanged"], "")
        text = bytearray(file.read_bytes())
        text[0] ^= 1
        file.write_bytes(bytes(text))
        expect(step["changed"], str(file))
        if file.read_bytes() != bytes(text):
            raise AssertionError(f"generator.check: the check wrote {file}")
        file.unlink()
        expect(step["removed"], str(file))
        if file.exists():
            raise AssertionError(f"generator.check: the check wrote {file}")


def check_refused_generation(step: dict, recipe_dir: Path) -> None:
    """Runs one generator.refused step (FCV-4, DBS-27) through orm-gen gen of this client."""
    with tempfile.TemporaryDirectory(prefix="orm-recipe-generator-refused-") as work:
        root = Path(work)
        for name, entry in step["files"].items():
            if isinstance(entry, str):
                (root / name).write_text(entry, encoding="utf-8", newline="")
            else:
                (root / name).write_bytes((recipe_dir / entry["path"]).read_bytes())
        out = root / "model"
        check = ["--check"] if step.get("check") else []
        done = subprocess.run(
            [
                sys.executable,
                "-m",
                "polyspec.orm.bin_orm_gen",
                "gen",
                "--set",
                str(root / "dbspec-set.json"),
                "--out",
                str(out),
                *check,
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if done.returncode != 1 or done.stdout != "":
            raise AssertionError(
                f"generator.refused: exit {done.returncode}, "
                f"stdout {done.stdout!r}, stderr {done.stderr}"
            )
        rest = done.stderr
        for part in step["parts"]:
            at = rest.find(part)
            if at < 0:
                raise AssertionError(
                    f"generator.refused: the output lacks {part!r} in order: {done.stderr}"
                )
            rest = rest[at + len(part) :]
        if not step.get("free_tail") and rest.strip():
            raise AssertionError(
                f"generator.refused: the output holds more after its last part: {done.stderr}"
            )
        if out.exists():
            raise AssertionError(f"generator.refused: the generation wrote {out}")
