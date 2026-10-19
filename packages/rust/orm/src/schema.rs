//! The schema of a generated model: the manifest text of the dbspec document set and `manifestHash`,
//! and the runtime model made from those two (docs/spec/dbspec.md, "Manifest and hashes",
//! "Runtime model").

use std::sync::{Arc, OnceLock};

use polyspec_orm_schema::dbspec::{self, Document, Entity, RuntimeModel};

use crate::{codes, Error, Result};

/// The runtime model of manifest text whose hash has been checked.
#[derive(Debug, Clone)]
pub struct Manifest {
    pub manifest_hash: String,
    pub model: RuntimeModel,
}

fn invalid(msg: String) -> Error {
    Error::Engine { code: codes::SCHEMA_INVALID.into(), msg }
}

fn diagnostics(errors: Vec<dbspec::Diagnostic>) -> Error {
    invalid(errors.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "))
}

/// A document of manifest text and external text. The external document is `external`. The document's manifest text and external
/// text are the two texts themselves, and the hash must be `hash`.
fn documents(text: &str, external: &str, hash: &str) -> Result<Vec<Document>> {
    let documents = dbspec::parse_manifest_set(text, external).map_err(diagnostics)?;
    let refs: Vec<&Document> = documents.iter().collect();
    let manifest = dbspec::manifest(&refs).map_err(diagnostics)?;
    if manifest.manifest_text != text {
        return Err(invalid("the embedded text is not the manifest text of its documents".into()));
    }
    if manifest.external_text != external {
        return Err(invalid("the embedded external text is not the text of the tables that the set uses from external documents".into()));
    }
    if manifest.manifest_hash != hash {
        // The text is a manifest but does not hash to the declared hash (docs/spec/dbspec.md, "Manifest and hashes").
        return Err(Error::Engine {
            code: codes::SCHEMA_HASH_MISMATCH.into(),
            msg: format!("models were generated from manifest {hash} but the embedded manifest is {}", manifest.manifest_hash),
        });
    }
    Ok(documents)
}

impl Manifest {
    /// Makes the runtime model of the manifest text and checks that the text's hash is `manifest_hash`.
    pub fn load(manifest_text: &str, manifest_hash: &str) -> Result<Manifest> {
        Manifest::load_set(manifest_text, "", manifest_hash)
    }

    /// Makes the runtime model of the manifest text and the external text (tables the set uses from external documents), and checks that the hash of the two texts is
    /// `manifest_hash`. A used table of an external document is an external entity.
    pub fn load_set(manifest_text: &str, external_text: &str, manifest_hash: &str) -> Result<Manifest> {
        let documents = documents(manifest_text, external_text, manifest_hash)?;
        let refs: Vec<&Document> = documents.iter().collect();
        let model = dbspec::runtime_model(&refs).map_err(diagnostics)?;
        Ok(Manifest { manifest_hash: manifest_hash.to_owned(), model })
    }

    pub fn entity(&self, name: &str) -> Result<&Entity> {
        self.model.entity(name).ok_or_else(|| Error::Engine { code: codes::ENTITY_UNKNOWN.into(), msg: name.to_owned() })
    }
}

/// The schema contained in a generated model: manifest text and its hash.
/// The runtime model is built once, on first use.
pub struct Schema {
    text: &'static str,
    /// The text of the tables the set uses from external documents (`dbspec::Manifest::external_text`). A set that uses no external documents
    /// is empty.
    external: &'static str,
    hash: &'static str,
    /// The runtime model built the first time, or the code and message of the error raised then.
    manifest: OnceLock<std::result::Result<Arc<Manifest>, (String, String)>>,
}

impl Schema {
    pub const fn new(manifest_text: &'static str, manifest_hash: &'static str) -> Schema {
        Schema::with_external(manifest_text, "", manifest_hash)
    }

    /// The schema of a set that uses external documents: manifest text, the text of tables used from external documents, and the hash of the two texts.
    pub const fn with_external(manifest_text: &'static str, external_text: &'static str, manifest_hash: &'static str) -> Schema {
        Schema { text: manifest_text, external: external_text, hash: manifest_hash, manifest: OnceLock::new() }
    }

    /// The text of the tables the set uses from external documents. Empty if no external documents are used.
    pub fn external(&self) -> &'static str {
        self.external
    }

    /// The `manifestHash` that generated the model.
    pub fn hash(&self) -> &'static str {
        self.hash
    }

    /// manifest text.
    pub fn text(&self) -> &'static str {
        self.text
    }

    /// The document of manifest text from which statements are rendered.
    pub fn documents(&self) -> Result<Vec<Document>> {
        documents(self.text, self.external, self.hash)
    }

    /// The runtime model of the schema to register. If the text does not hash to the declared hash, then
    /// before any statement it is CONFIG; if the text is not a manifest, it is SCHEMA_INVALID.
    pub(crate) fn registered(&self) -> Result<Arc<Manifest>> {
        self.manifest().map_err(|e| match e {
            Error::Engine { code, msg } if code == codes::SCHEMA_HASH_MISMATCH => Error::Config(format!("invalid schema manifest: {msg}")),
            other => other,
        })
    }

    /// One schema with the same manifest text and hash. So that requests use the schema of the set the connection registered, the process
    /// builds one per hash and keeps it.
    pub(crate) fn interned(&self) -> &'static Schema {
        static INTERNED: std::sync::Mutex<Vec<&'static Schema>> = std::sync::Mutex::new(Vec::new());
        let mut interned = INTERNED.lock().unwrap();
        if let Some(found) = interned.iter().find(|s| s.hash == self.hash && s.text == self.text && s.external == self.external) {
            return found;
        }
        let schema: &'static Schema = Box::leak(Box::new(Schema::with_external(self.text, self.external, self.hash)));
        interned.push(schema);
        schema
    }

    /// runtime model.
    pub fn manifest(&self) -> Result<Arc<Manifest>> {
        self.manifest
            .get_or_init(|| {
                Manifest::load_set(self.text, self.external, self.hash).map(Arc::new).map_err(|e| match e {
                    Error::Engine { code, msg } => (code, msg),
                    other => (codes::SCHEMA_INVALID.to_owned(), other.to_string()),
                })
            })
            .clone()
            .map_err(|(code, msg)| Error::Engine { code, msg })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The manifest text and manifestHash of contracts/fixtures/rollback.dbs.
    fn rollback_manifest() -> (String, String) {
        let text = include_str!("../../../../contracts/fixtures/rollback.dbs");
        let document = dbspec::parse(text, &Default::default()).map(|parsed| parsed.document).expect("rollback.dbs parses");
        let manifest = dbspec::manifest(&[&document]).expect("rollback.dbs manifest");
        (manifest.manifest_text, manifest.manifest_hash)
    }

    fn leak(text: String) -> &'static str {
        Box::leak(text.into_boxed_str())
    }

    // Manifest text that does not hash to the declared hash is SCHEMA_HASH_MISMATCH, and text that is not a manifest is SCHEMA_INVALID.
    #[test]
    fn manifest_hash_mismatch_is_reported() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let (text, hash) = rollback_manifest();
        assert_eq!(Manifest::load(&text, &hash).expect("matching manifest").manifest_hash, hash);
        let edited = text.replace("label varchar(32)", "label varchar(64)");
        assert_ne!(edited, text, "the fixture declares label varchar(32)");
        for schema in [Schema::new(leak(edited.clone()), leak(hash.clone())), Schema::new(leak(text.clone()), "0000000000000000")] {
            let error = schema.manifest().expect_err("edited manifest");
            assert_eq!(error.code(), codes::SCHEMA_HASH_MISMATCH, "{error}");
            let error = schema.documents().expect_err("edited manifest documents");
            assert_eq!(error.code(), codes::SCHEMA_HASH_MISMATCH, "{error}");
        }
        for invalid in ["not a manifest", "dbspec 1 rollback\n\ntable rollback_probe {\n"] {
            let error = Schema::new(invalid, leak(hash.clone())).manifest().expect_err("invalid manifest");
            assert_eq!(error.code(), codes::SCHEMA_INVALID, "{error}");
        }
    }
}
