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
//!     polyspec_orm_build::Builder::set("schema/dbspec-set.json").scan("src").generate();
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

/// generated model이 `include_str!`로 담는 manifest text file의 `OUT_DIR` 안 이름.
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
        let base = std::env::var_os("CARGO_MANIFEST_DIR").map(PathBuf::from).unwrap_or_default();
        let abs = |p: &Path| if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
        let set_path = abs(&self.set);
        let out_dir = match &self.out_dir {
            Some(d) => abs(d),
            None => PathBuf::from(std::env::var_os("OUT_DIR").ok_or("OUT_DIR is not set; call the generator from build.rs or set out_dir")?),
        };
        // The set file is an input of the build even when it does not read, so that a fix reruns it.
        println!("cargo:rerun-if-changed={}", set_path.display());
        let files = dbspec::read_set(&set_path).map_err(|errors| errors.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"))?;
        for input in &set_inputs(&set_path, &files)[1..] {
            println!("cargo:rerun-if-changed={}", input.display());
        }
        let set = manifest::load_set(&files)?;
        let models: HashSet<String> = set.model.entities.iter().map(|e| names::pascal(&e.name)).collect();
        let paths: Vec<PathBuf> = self.scan.iter().map(|p| abs(p)).collect();
        let fallible_setters = generate::fallible_setters(&set.model);
        let scanned = scan::scan(&paths, &models, &fallible_setters)?;
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
        // generated source는 manifest file의 path를 include_str!로 담는다. path를 어떻게 썼든(`./`, `..`,
        // 끝의 `/`, 상대 path) 같은 directory는 같은 source가 되도록 canonical path로 바꾼다.
        let out_dir = std::fs::canonicalize(&out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
        let manifest_file = out_dir.join(MANIFEST_FILE);
        write_if_changed(&manifest_file, set.manifest_text.as_bytes())?;
        if !set.external_text.is_empty() {
            write_if_changed(&out_dir.join(EXTERNAL_FILE), set.external_text.as_bytes())?;
        }
        let source = generate::generate(&set, &scanned, &manifest_file.display().to_string())?;
        let out = out_dir.join(MODEL_FILE);
        write_if_changed(&out, source.as_bytes())?;
        for p in &paths {
            println!("cargo:rerun-if-changed={}", p.display());
        }
        for f in &scanned.files {
            println!("cargo:rerun-if-changed={}", f.display());
        }
        Ok(out)
    }
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
