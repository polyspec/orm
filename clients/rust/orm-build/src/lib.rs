//! Build-time model generator for the Rust ORM.
//!
//! A crate that uses models calls the generator from its `build.rs`. The
//! generator reads a dbspec document set, scans the crate's source for model
//! method calls, and writes the models and the manifest text into `OUT_DIR`;
//! `orm::models!()` includes them as the module `model`.
//!
//! ```text
//! // build.rs
//! fn main() {
//!     orm_build::Builder::new(["schema/shop.dbs"]).scan("src").generate();
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

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The name of the generated file in `OUT_DIR`.
pub const MODEL_FILE: &str = "orm_model.rs";

/// generated model이 `include_str!`로 담는 manifest text file의 `OUT_DIR` 안 이름.
pub const MANIFEST_FILE: &str = "orm_manifest.dbs";

/// Configures one generation.
pub struct Builder {
    documents: Vec<PathBuf>,
    scan: Vec<PathBuf>,
    out_dir: Option<PathBuf>,
}

impl Builder {
    /// dbspec document set의 file path로 생성을 시작한다. path는 package directory 기준이다.
    pub fn new<P: AsRef<Path>>(documents: impl IntoIterator<Item = P>) -> Builder {
        Builder { documents: documents.into_iter().map(|p| p.as_ref().to_path_buf()).collect(), scan: Vec::new(), out_dir: None }
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
    /// stops the build with the collected messages.
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
        let documents: Vec<PathBuf> = self.documents.iter().map(|p| abs(p)).collect();
        let out_dir = match &self.out_dir {
            Some(d) => abs(d),
            None => PathBuf::from(std::env::var_os("OUT_DIR").ok_or("OUT_DIR is not set; call the generator from build.rs or set out_dir")?),
        };
        let set = manifest::load(&documents.iter().map(PathBuf::as_path).collect::<Vec<_>>())?;
        let models: HashSet<String> = set.model.entities.iter().map(|e| names::pascal(&e.name)).collect();
        let paths: Vec<PathBuf> = self.scan.iter().map(|p| abs(p)).collect();
        let fallible_setters = generate::fallible_setters(&set.model);
        let scanned = scan::scan(&paths, &models, &fallible_setters)?;
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
        let manifest_file = out_dir.join(MANIFEST_FILE);
        write_if_changed(&manifest_file, set.manifest_text.as_bytes())?;
        let source = generate::generate(&set, &scanned, &manifest_file.display().to_string())?;
        let out = out_dir.join(MODEL_FILE);
        write_if_changed(&out, source.as_bytes())?;
        for document in &documents {
            println!("cargo:rerun-if-changed={}", document.display());
        }
        for p in &paths {
            println!("cargo:rerun-if-changed={}", p.display());
        }
        for f in &scanned.files {
            println!("cargo:rerun-if-changed={}", f.display());
        }
        Ok(out)
    }
}

fn write_if_changed(path: &Path, content: &[u8]) -> Result<(), String> {
    if std::fs::read(path).map(|old| old == content).unwrap_or(false) {
        return Ok(());
    }
    std::fs::write(path, content).map_err(|e| format!("{}: {e}", path.display()))
}
