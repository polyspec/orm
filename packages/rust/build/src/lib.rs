//! Build-time model generator for the Rust ORM.
//!
//! A crate that uses models calls the generator from its `build.rs`. The
//! generator reads a dbspec document set from its set file `dbspec-set.json`
//! (docs/dbspec.md, "Document sets"), scans the crate's source for model
//! method calls, and writes the models and the manifest text into `OUT_DIR`;
//! `polyspec_orm::models!()` includes them as the module `model`.
//!
//! ```text
//! // build.rs
//! fn main() {
//!     polyspec_orm_build::Builder::set("contracts/fixtures/bench/dbspec-set.json").scan("src").generate();
//! }
//! ```
//!
//! Every model gets its fixed methods. The chain, join, relation, column, and
//! getter methods named by the grammar of the model syntax are generated for
//! the calls the scanned source makes; an unknown column, operator, or
//! argument count fails the build.

#[cfg(feature = "live-db")]
pub mod catalog;
mod generate;
mod manifest;
mod names;
mod scan;
#[cfg(feature = "live-db")]
pub mod tool_db;

use polyspec_orm_schema::dbspec;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The name of the generated file in `OUT_DIR`.
pub const MODEL_FILE: &str = "orm_model.rs";

/// The name, inside `OUT_DIR`, of the manifest text file that the generated model embeds with `include_str!`.
pub const MANIFEST_FILE: &str = "orm_manifest.dbs";

/// The text of the tables that the set uses from external documents, written next to the manifest text when
/// the set has external documents.
pub const EXTERNAL_FILE: &str = "orm_external.dbs";

/// Configures one generation.
pub struct Builder {
    set: PathBuf,
    scan: Vec<PathBuf>,
    out_dir: Option<PathBuf>,
}

impl Builder {
    /// Starts a generation from the set file `path` (`dbspec-set.json`), relative to the package
    /// directory. The set file lists the documents that the set owns and its external documents:
    /// documents of other sets that the set uses but does not own, which are parsed with the set
    /// and of which only the tables that the set uses travel in the generated schema value; they
    /// get no models and are never installed.
    pub fn set(path: impl AsRef<Path>) -> Builder {
        Builder { set: path.as_ref().to_path_buf(), scan: Vec::new(), out_dir: None }
    }

    /// Adds a source file or directory whose model calls are generated.
    pub fn scan(mut self, path: impl AsRef<Path>) -> Builder {
        self.scan.push(path.as_ref().to_path_buf());
        self
    }

    /// Writes into `dir` instead of `OUT_DIR`.
    pub fn out_dir(mut self, dir: impl AsRef<Path>) -> Builder {
        self.out_dir = Some(dir.as_ref().to_path_buf());
        self
    }

    /// Generates the models, printing the cargo rerun directives. A failure
    /// stops the build with the collected messages: every error of the set
    /// file and every diagnostic of its documents, and nothing is written.
    pub fn generate(self) {
        if let Err(e) = self.try_generate() {
            eprintln!("orm-build: {e}");
            std::process::exit(1);
        }
    }

    /// Generates the models and returns the generated file.
    pub fn try_generate(self) -> Result<PathBuf, String> {
        let set_path = Self::absolute(&self.set);
        let out_dir = self.output_dir()?;
        let loaded = self.load(&set_path)?;
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
        // The generated source embeds the manifest file's path with include_str!. However the path was written (`./`, `..`,
        // a trailing `/`, a relative path), the same directory is converted to a canonical path so it gives the same source.
        let out_dir = std::fs::canonicalize(&out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
        let manifest_file = out_dir.join(MANIFEST_FILE);
        write_if_changed(&manifest_file, loaded.set.manifest_text.as_bytes())?;
        if !loaded.set.external_text.is_empty() {
            write_if_changed(&out_dir.join(EXTERNAL_FILE), loaded.set.external_text.as_bytes())?;
        }
        let source = generate::generate(&loaded.set, &loaded.scanned, &manifest_file.display().to_string())?;
        let out = out_dir.join(MODEL_FILE);
        write_if_changed(&out, source.as_bytes())?;
        for input in &loaded.inputs {
            println!("cargo:rerun-if-changed={}", input.display());
        }
        Ok(out)
    }

    /// Generates the models like [`Builder::try_generate`] without writing anything, and returns one line for each
    /// generated file of the output directory that differs (`differs: <file>`) or is missing (`missing: <file>`), and
    /// `extra: orm_external.dbs` when the directory holds that file but the set has no external text. The lines are
    /// ordered by file name; an empty list means the directory holds the generated files. The check touches only the
    /// generated file names, since the output directory of a build can hold other files. A failure of generation is
    /// returned as its error, as in [`Builder::try_generate`], and the directory is not created.
    pub fn check(self) -> Result<Vec<String>, String> {
        let set_path = Self::absolute(&self.set);
        let out_dir = self.output_dir()?;
        let loaded = self.load(&set_path)?;
        // A directory that does not exist yet holds no file; the generated source then names it as given.
        let out_dir = if out_dir.exists() { std::fs::canonicalize(&out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))? } else { out_dir };
        let manifest_file = out_dir.join(MANIFEST_FILE);
        let source = generate::generate(&loaded.set, &loaded.scanned, &manifest_file.display().to_string())?;
        let has_external = !loaded.set.external_text.is_empty();
        let mut expected: Vec<(&str, &[u8])> = vec![(MANIFEST_FILE, loaded.set.manifest_text.as_bytes()), (MODEL_FILE, source.as_bytes())];
        if has_external {
            expected.push((EXTERNAL_FILE, loaded.set.external_text.as_bytes()));
        }
        let mut lines = Vec::new();
        for (name, content) in &expected {
            match std::fs::read(out_dir.join(name)) {
                Ok(old) if old == *content => {}
                Ok(_) => lines.push((*name, format!("differs: {name}"))),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => lines.push((*name, format!("missing: {name}"))),
                Err(e) => return Err(format!("{}: {e}", out_dir.join(name).display())),
            }
        }
        if !has_external && out_dir.join(EXTERNAL_FILE).exists() {
            lines.push((EXTERNAL_FILE, format!("extra: {EXTERNAL_FILE}")));
        }
        lines.sort_by_key(|(name, _)| *name);
        Ok(lines.into_iter().map(|(_, line)| line).collect())
    }

    /// The absolute form of `path`, relative to the package directory (`CARGO_MANIFEST_DIR`).
    fn absolute(path: &Path) -> PathBuf {
        if path.is_absolute() {
            return path.to_path_buf();
        }
        std::env::var_os("CARGO_MANIFEST_DIR").map(PathBuf::from).unwrap_or_default().join(path)
    }

    /// The output directory: the one that `out_dir` names, else `OUT_DIR`.
    fn output_dir(&self) -> Result<PathBuf, String> {
        match &self.out_dir {
            Some(d) => Ok(Self::absolute(d)),
            None => Ok(PathBuf::from(std::env::var_os("OUT_DIR").ok_or("OUT_DIR is not set; call the generator from build.rs or set out_dir")?)),
        }
    }

    /// Reads the set file and scans the source without writing: the parsed set, the scan, and the inputs of the
    /// build (the set file, its listed documents, the scanned paths and the files they hold).
    fn load(&self, set_path: &Path) -> Result<Loaded, String> {
        // The set file is an input of the build even when it does not read, so that a fix reruns it.
        let files = dbspec::read_set(set_path).map_err(|errors| errors.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"))?;
        let set = manifest::load_set(&files)?;
        let models: HashSet<String> = set.model.entities.iter().map(|e| names::pascal(&e.name)).collect();
        let paths: Vec<PathBuf> = self.scan.iter().map(|p| Self::absolute(p)).collect();
        let fallible_setters = generate::fallible_setters(&set.model);
        let scanned = scan::scan(&paths, &models, &fallible_setters)?;
        let inputs = set_inputs(set_path, &files).into_iter().map(Path::to_path_buf).chain(paths).chain(scanned.files.iter().cloned()).collect();
        Ok(Loaded { set, scanned, inputs })
    }
}

/// What a build reads: the parsed set, its scan and the paths that cargo reruns the build for.
struct Loaded {
    set: manifest::DocumentSet,
    scanned: scan::Scan,
    inputs: Vec<PathBuf>,
}

/// The inputs of a set for cargo's rerun directives: the set file, then every listed document in
/// the set file's order, owned documents first.
fn set_inputs<'a>(set_path: &'a Path, files: &'a dbspec::Set) -> Vec<&'a Path> {
    std::iter::once(set_path).chain(files.documents.iter().chain(&files.external).map(|f| f.path.as_path())).collect()
}

fn write_if_changed(path: &Path, content: &[u8]) -> Result<(), String> {
    if std::fs::read(path).map(|old| old == content).unwrap_or(false) {
        return Ok(());
    }
    std::fs::write(path, content).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // cargo reruns the build script when the set file or any listed document changes.
    #[test]
    fn rerun_inputs_name_the_set_file_and_every_document() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let file = |p: &str| dbspec::SetFile { path: PathBuf::from(p), bytes: Vec::new() };
        let files = dbspec::Set { documents: vec![file("a/shop.dbs"), file("a/billing/invoices.dbs")], external: vec![file("a/../core/core.dbs")] };
        let inputs = set_inputs(Path::new("a/dbspec-set.json"), &files);
        assert_eq!(inputs, [Path::new("a/dbspec-set.json"), Path::new("a/shop.dbs"), Path::new("a/billing/invoices.dbs"), Path::new("a/../core/core.dbs")]);
    }
}
