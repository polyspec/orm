//! The generator.generate op of the recipe helper (docs/spec/feature-coverage.md FCV-4): it writes the scanned Rust sources of a
//! step under a temporary root and calls `Builder::try_generate` with that root as the scan input.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

static NEXT: AtomicU64 = AtomicU64::new(0);

/// Runs one generator.generate step and checks it against the expect of `database`.
pub fn check(step: &Value, database: &str, dir: &Path) -> Result<(), String> {
    let want = step["expect"].get(database).ok_or_else(|| format!("generator.generate has no expect for {database}"))?;
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("orm-recipe-generator-{}-{n}", std::process::id()));
    let result = generate(step, dir, &root);
    let outcome = if result.is_err() && root.join("model").exists() { Err("a refused generation wrote its output".to_string()) } else { compare(want, result) };
    std::fs::remove_dir_all(&root).map_err(|e| format!("remove {}: {e}", root.display()))?;
    outcome
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

/// Writes the sources of the step, generates its sets under `root` and returns the method names of the generated models.
fn generate(step: &Value, dir: &Path, root: &Path) -> Result<BTreeSet<String>, String> {
    let options = &step["options"];
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
    let schema = step["schema"].as_str().ok_or("generator.generate needs a schema")?;
    let used: Vec<&str> = options["used"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let set = set_file(&root.join(".set"), dir, &[schema], &used)?;
    let path = polyspec_orm_build::Builder::set(set).scan(root).out_dir(root.join("model")).try_generate()?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(generated_methods(&text))
}

/// Writes a set file in `at`/set over copies of the documents of the recipe directory `dir`.
fn set_file(at: &Path, dir: &Path, documents: &[&str], external: &[&str]) -> Result<PathBuf, String> {
    for (group, names) in [("set", documents), ("external", external)] {
        std::fs::create_dir_all(at.join(group)).map_err(|e| e.to_string())?;
        for name in names {
            std::fs::copy(dir.join(name), at.join(group).join(name)).map_err(|e| format!("{name}: {e}"))?;
        }
    }
    let external: Vec<String> = external.iter().map(|name| format!("../external/{name}")).collect();
    let set = at.join("set/dbspec-set.json");
    let text = serde_json::json!({"schema": 1, "documents": documents, "external": external}).to_string();
    std::fs::write(&set, text).map_err(|e| e.to_string())?;
    Ok(set)
}

/// The methods of each generated model as table.name, without the language prefix of the name (FCV-4).
fn generated_methods(text: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for section in text.split("pub struct ").skip(1) {
        let model = section.split(|c: char| !c.is_alphanumeric()).next().unwrap_or_default();
        let table = snake(model);
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
