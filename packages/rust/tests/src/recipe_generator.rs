//! The generator.generate op of the recipe helper (docs/spec/feature-coverage.md FCV-4): it writes the scanned Rust sources of a
//! step under a temporary root and calls `Builder::try_generate` with that root as the scan input.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

static NEXT: AtomicU64 = AtomicU64::new(0);

/// Runs one generator.generate step and checks it against the expect of `database`.
pub fn check(step: &Value, database: &str, dir: &Path) -> Result<(), String> {
    let want = crate::recipe_reads::read(step, "expect")["expect"].get(database).ok_or_else(|| format!("generator.generate has no expect for {database}"))?;
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("orm-recipe-generator-{}-{n}", std::process::id()));
    let result = generate(step, dir, &root);
    let outcome = if result.is_err() && root.join("model").exists() {
        Err("a refused generation wrote its output".to_string())
    } else {
        compare(want, result).and_then(|()| compare_text(want, &root))
    };
    std::fs::remove_dir_all(&root).map_err(|e| format!("remove {}: {e}", root.display()))?;
    outcome
}

/// Runs one generator.check step (FCV-4, DBS-175) through `Builder::check`, the check of the generated files of Rust,
/// which returns its lines and names a file by its name in the output directory.
pub fn check_files(step: &Value, dir: &Path) -> Result<(), String> {
    let set = dir.join(crate::recipe_reads::read(step, "document_set")["document_set"].as_str().unwrap_or_default());
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("orm-recipe-generator-check-{}-{n}", std::process::id()));
    let out = root.join("model");
    let result = check_files_in(step, &set, &out);
    std::fs::remove_dir_all(&root).map_err(|e| format!("remove {}: {e}", root.display()))?;
    result
}

fn check_files_in(step: &Value, set: &Path, out: &Path) -> Result<(), String> {
    let lines = |key: &str, file: &str| -> Vec<String> {
        crate::recipe_reads::read(step, key)[key]
            .as_array()
            .into_iter()
            .flatten()
            .map(|line| line.as_str().unwrap_or_default().replace("<file>", file))
            .collect()
    };
    let check = || polyspec_orm_build::Builder::set(set).out_dir(out).check();
    polyspec_orm_build::Builder::set(set).out_dir(out).try_generate()?;
    let mut names: Vec<PathBuf> = std::fs::read_dir(out)
        .map_err(|e| format!("{}: {e}", out.display()))?
        .map(|entry| entry.map(|entry| entry.path()).map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;
    names.sort();
    let path = names
        .into_iter()
        .find(|path| std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 0))
        .ok_or_else(|| format!("{} holds no generated file", out.display()))?;
    // A file that the generation does not write is not compared.
    std::fs::write(out.join("zz_notes.rs"), "// notes\n").map_err(|e| format!("{}: {e}", out.display()))?;
    let got = check()?;
    if got != lines("unchanged", "") {
        return Err(format!("generator.check: the unchanged files give {got:?}"));
    }
    let mut text = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    text[0] ^= 1;
    std::fs::write(&path, &text).map_err(|e| format!("{}: {e}", path.display()))?;
    let file = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let got = check()?;
    if got != lines("changed", &file) {
        return Err(format!("generator.check: the changed file gives {got:?}"));
    }
    if std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))? != text {
        return Err(format!("generator.check: the check wrote {}", path.display()));
    }
    std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let got = check()?;
    if got != lines("removed", &file) {
        return Err(format!("generator.check: the removed file gives {got:?}"));
    }
    if path.exists() {
        return Err(format!("generator.check: the check wrote {}", path.display()));
    }
    Ok(())
}

/// Runs one generator.refused step (FCV-4, DBS-27) through `Builder::try_generate`, or `Builder::check` when the
/// step says `check`.
pub fn check_refused(step: &Value, dir: &Path) -> Result<(), String> {
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("orm-recipe-generator-refused-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&root).map_err(|e| format!("{}: {e}", root.display()))?;
    let result = check_refused_in(step, dir, &root);
    std::fs::remove_dir_all(&root).map_err(|e| format!("remove {}: {e}", root.display()))?;
    result
}

fn check_refused_in(step: &Value, dir: &Path, root: &Path) -> Result<(), String> {
    for (name, entry) in crate::recipe_reads::read(step, "files")["files"].as_object().into_iter().flatten() {
        let body = match entry.as_str() {
            Some(text) => text.as_bytes().to_vec(),
            None => {
                let from = dir.join(entry["path"].as_str().unwrap_or_default());
                std::fs::read(&from).map_err(|e| format!("{}: {e}", from.display()))?
            }
        };
        std::fs::write(root.join(name), body).map_err(|e| format!("{name}: {e}"))?;
    }
    let out = root.join("model");
    let builder = polyspec_orm_build::Builder::set(root.join("dbspec-set.json")).out_dir(&out);
    let refused = if crate::recipe_reads::read(step, "check")["check"].as_bool().unwrap_or(false) {
        builder.check().map(|_| ())
    } else {
        builder.try_generate().map(|_| ())
    };
    let output = match refused {
        Ok(()) => return Err("generator.refused: the generation succeeded".to_owned()),
        Err(message) => message,
    };
    let mut rest = output.as_str();
    for part in crate::recipe_reads::read(step, "parts")["parts"].as_array().into_iter().flatten() {
        let part = part.as_str().unwrap_or_default();
        let at = rest.find(part).ok_or_else(|| format!("generator.refused: the output lacks {part} in order: {output}"))?;
        rest = &rest[at + part.len()..];
    }
    if crate::recipe_reads::read(step, "free_tail")["free_tail"].as_bool() != Some(true) && !rest.trim().is_empty() {
        return Err(format!("generator.refused: the output holds more after its last part: {output}"));
    }
    if out.exists() {
        return Err(format!("generator.refused: the generation wrote {}", out.display()));
    }
    Ok(())
}

/// Compares the outcome of a generation with the expect: the error with its code and line, or the included and excluded names.
fn compare(want: &Value, result: Result<BTreeSet<String>, String>) -> Result<(), String> {
    if let Some(code) = want["error"].as_str() {
        let message = match result {
            Ok(_) => return Err(format!("generation succeeded, want error {code}")),
            Err(message) => message,
        };
        if !message.starts_with(&format!("{code}: ")) {
            return Err(format!("error does not start with {code}: {message}"));
        }
        if let Some(text) = want["message"].as_str() {
            if !message.contains(text) {
                return Err(format!("error does not contain {text:?}: {message}"));
            }
        }
        if let Some(line) = want["position"]["line"].as_i64() {
            if !message.contains(&format!(".rs:{line}:")) {
                return Err(format!("error position does not name line {line}: {message}"));
            }
        }
        return Ok(());
    }
    let names = result?;
    for name in want["value"]["includes"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if !names.contains(name) {
            return Err(format!("generated code lacks {name}"));
        }
    }
    for name in want["value"]["excludes"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if names.contains(name) {
            return Err(format!("generated code declares {name}"));
        }
    }
    Ok(())
}

/// Compares the generated files of the set with the texts of the expect.
fn compare_text(want: &Value, root: &Path) -> Result<(), String> {
    let wanted = &want["value"]["text"];
    if wanted.is_null() {
        return Ok(());
    }
    let mut text = String::new();
    for entry in std::fs::read_dir(root.join("model")).map_err(|e| e.to_string())? {
        text.push_str(&std::fs::read_to_string(entry.map_err(|e| e.to_string())?.path()).map_err(|e| e.to_string())?);
    }
    for part in wanted["includes"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if !text.contains(part) {
            return Err(format!("generated text lacks {part}"));
        }
    }
    for part in wanted["excludes"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if text.contains(part) {
            return Err(format!("generated text holds {part}"));
        }
    }
    Ok(())
}

/// Writes the sources of the step, generates its sets under `root` and returns the method names of the generated models.
fn generate(step: &Value, dir: &Path, root: &Path) -> Result<BTreeSet<String>, String> {
    let options = &crate::recipe_reads::read(step, "options")["options"];
    for (path, text) in options["sources"]["rust"].as_object().into_iter().flatten() {
        let file = root.join(path);
        let parent = file.parent().ok_or_else(|| format!("no parent of {path}"))?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        std::fs::write(&file, text.as_str().unwrap_or_default()).map_err(|e| e.to_string())?;
    }
    let before = &options["before"];
    if let Some(schema) = before["schema"].as_str() {
        let set = set_file(&root.join(".set-before"), dir, &[schema], &[])?;
        let output = root.join(before["output"].as_str().unwrap_or_default());
        let scan = root.join(before["scan"].as_str().unwrap_or_default());
        polyspec_orm_build::Builder::set(set).scan(&scan).out_dir(output).try_generate()?;
    }
    let schema = crate::recipe_reads::read(step, "schema")["schema"].as_str().ok_or("generator.generate needs a schema")?;
    let used: Vec<&str> = options["used"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let set = set_file(&root.join(".set"), dir, &[schema], &used)?;
    if let Some(from) = options["schema_replace"]["from"].as_str() {
        let to = options["schema_replace"]["to"].as_str().unwrap_or_default();
        let document = set.with_file_name(file_name(schema));
        let text = std::fs::read_to_string(&document).map_err(|e| e.to_string())?;
        std::fs::write(&document, text.replace(from, to)).map_err(|e| e.to_string())?;
    }
    let path = polyspec_orm_build::Builder::set(set).scan(root).out_dir(root.join("model")).try_generate()?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(generated_methods(&text))
}

/// Writes a set file in `at`/set over copies of the documents of the recipe directory `dir`.
fn set_file(at: &Path, dir: &Path, documents: &[&str], external: &[&str]) -> Result<PathBuf, String> {
    for (group, names) in [("set", documents), ("external", external)] {
        std::fs::create_dir_all(at.join(group)).map_err(|e| e.to_string())?;
        for name in names {
            std::fs::copy(dir.join(name), at.join(group).join(file_name(name))).map_err(|e| format!("{name}: {e}"))?;
        }
    }
    let documents: Vec<&str> = documents.iter().map(|name| file_name(name)).collect();
    let external: Vec<String> = external.iter().map(|name| format!("../external/{}", file_name(name))).collect();
    let set = at.join("set/dbspec-set.json");
    let text = serde_json::json!({"schema": 1, "documents": documents, "external": external}).to_string();
    std::fs::write(&set, text).map_err(|e| e.to_string())?;
    Ok(set)
}

/// The file name of a document that the recipe names relative to its directory.
fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// The methods of each generated model as table.name, without the language prefix of the name (FCV-4).
fn generated_methods(text: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for section in text.split("pub struct ").skip(1) {
        let model = section.split(|c: char| !c.is_alphanumeric()).next().unwrap_or_default();
        let table = snake(model);
        names.insert(table.clone());
        for piece in section.split("pub fn ").skip(1) {
            let method = piece.split(|c: char| !c.is_alphanumeric() && c != '_').next().unwrap_or_default();
            names.insert(format!("{table}.{}", without_prefix(method)));
        }
    }
    names
}

/// The snake_case identifier of a generated method without its language prefix (get_, new_, alias_).
fn without_prefix(method: &str) -> &str {
    ["get_", "new_", "alias_"].iter().find_map(|prefix| method.strip_prefix(prefix)).unwrap_or(method)
}

/// Converts a CamelCase model name to the snake_case name of its table.
fn snake(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            out.push('_');
        }
        out.extend(c.to_lowercase());
    }
    out
}
