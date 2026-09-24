//! Build-time model generator for the Rust ORM.
//!
//! A crate that uses models calls the generator from its `build.rs`. The
//! generator reads `schema.json`, scans the crate's source for model method
//! calls, and writes the models into `OUT_DIR`; `orm::models!()` includes them
//! as the module `model`.
//!
//! ```text
//! // build.rs
//! fn main() {
//!     orm_build::Builder::new("schema/schema.json").scan("src").generate();
//! }
//! ```
//!
//! Every model gets its fixed methods. The chain, join, relation, column, and
//! getter methods named by the grammar of the model syntax are generated for
//! the calls the scanned source makes; an unknown column, operator, or
//! argument count fails the build.

mod generate;
pub mod live;
mod manifest;
pub mod migration;
mod names;
mod scan;
pub use orm_schema::{ddl, schema, triggers};

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The name of the generated file in `OUT_DIR`.
pub const MODEL_FILE: &str = "orm_model.rs";

/// Configures one generation.
pub struct Builder {
    schema: PathBuf,
    scan: Vec<PathBuf>,
    out_dir: Option<PathBuf>,
}

impl Builder {
    /// Starts a generation from a schema.json path, relative to the package
    /// directory.
    pub fn new(schema: impl AsRef<Path>) -> Builder {
        Builder { schema: schema.as_ref().to_path_buf(), scan: Vec::new(), out_dir: None }
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
        let schema_path = abs(&self.schema);
        let out_dir = match &self.out_dir {
            Some(d) => abs(d),
            None => PathBuf::from(std::env::var_os("OUT_DIR").ok_or("OUT_DIR is not set; call the generator from build.rs or set out_dir")?),
        };
        let text = std::fs::read_to_string(&schema_path).map_err(|e| format!("{}: {e}", schema_path.display()))?;
        let m = manifest::Manifest::load(&text).map_err(|e| format!("{}: {e}", schema_path.display()))?;
        let models: HashSet<String> = m.entities().map(|e| names::pascal(&e.name)).collect();
        let paths: Vec<PathBuf> = self.scan.iter().map(|p| abs(p)).collect();
        let scanned = scan::scan(&paths, &models)?;
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
        let schema_copy = out_dir.join("orm_schema.json");
        write_if_changed(&schema_copy, text.as_bytes())?;
        let source = generate::generate(&m, &scanned, &schema_copy.display().to_string())?;
        let out = out_dir.join(MODEL_FILE);
        write_if_changed(&out, source.as_bytes())?;
        println!("cargo:rerun-if-changed={}", schema_path.display());
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
