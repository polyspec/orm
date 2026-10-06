//! Build-time model generator for the Rust ORM.
//!
//! A crate that uses models calls the generator from its `build.rs`. The
//! generator reads a dbspec document set, scans the crate's source for model
//! method calls, and writes the models and the manifest text into `OUT_DIR`;
//! `polyspec_orm::models!()` includes them as the module `model`.
//!
//! ```text
//! // build.rs
//! fn main() {
//!     polyspec_orm_build::Builder::new(["schema/shop.dbs"]).scan("src").generate();
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

/// The text of the tables that the set uses from external documents, written next to the manifest text when
/// the set has external documents.
pub const EXTERNAL_FILE: &str = "orm_external.dbs";

/// Configures one generation.
pub struct Builder {
    documents: Vec<PathBuf>,
    uses: Vec<PathBuf>,
    scan: Vec<PathBuf>,
    out_dir: Option<PathBuf>,
}

impl Builder {
    /// dbspec document set의 file path로 생성을 시작한다. path는 package directory 기준이다.
    pub fn new<P: AsRef<Path>>(documents: impl IntoIterator<Item = P>) -> Builder {
        Builder { documents: documents.into_iter().map(|p| p.as_ref().to_path_buf()).collect(), uses: Vec::new(), scan: Vec::new(), out_dir: None }
    }

    /// Adds external dbspec documents: documents of other sets that the set
    /// uses but does not own. They are parsed with the set, and only the
    /// tables that the set uses travel in the generated schema value; they get
    /// no models and are never installed. Paths are relative to the package
    /// directory.
    pub fn uses<P: AsRef<Path>>(mut self, documents: impl IntoIterator<Item = P>) -> Builder {
        self.uses.extend(documents.into_iter().map(|p| p.as_ref().to_path_buf()));
        self
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
        let uses: Vec<PathBuf> = self.uses.iter().map(|p| abs(p)).collect();
        let set = manifest::load_set(&documents.iter().map(PathBuf::as_path).collect::<Vec<_>>(), &uses.iter().map(PathBuf::as_path).collect::<Vec<_>>())?;
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
        for document in documents.iter().chain(&uses) {
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
