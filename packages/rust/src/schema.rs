//! The schema of a generated model: the manifest text of the dbspec document set and `manifestHash`,
//! and the runtime model made from those two (docs/spec/dbspec.md, "Manifest and hashes",
//! "Runtime model").

use std::sync::{Arc, OnceLock};

use polyspec_orm_schema::dbspec::{self, Document, Entity, RuntimeModel};

use crate::{Error, Result};

/// The runtime model of manifest text whose hash has been checked.
#[derive(Debug, Clone)]
pub struct Manifest {
    pub manifest_hash: String,
    pub model: RuntimeModel,
}

fn invalid(msg: String) -> Error {
    Error::new(crate::Kind::SchemaInvalid, msg)
}

fn diagnostics(errors: Vec<dbspec::Diagnostic>) -> Error {
    invalid(errors.iter().map(|d| format!("{}:{} {}: {}", d.line, d.column, d.rule, d.message)).collect::<Vec<_>>().join("; "))
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
        return Err(Error::new(
            crate::Kind::SchemaHashMismatch,
            format!("models were generated from manifest {hash} but the embedded manifest is {}", manifest.manifest_hash),
        ));
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
        self.model.entity(name).ok_or_else(|| Error::new(crate::Kind::EntityUnknown, name))
    }
}

/// A text of a schema: a static of generated code, or the copy that a loaded schema owns and its copies share (CORE-80).
#[derive(Clone)]
enum Text {
    Static(&'static str),
    Shared(Arc<str>),
}

impl std::ops::Deref for Text {
    type Target = str;

    fn deref(&self) -> &str {
        match self {
            Text::Static(text) => text,
            Text::Shared(text) => text,
        }
    }
}

/// A reference to a schema: the static of generated code, or a schema that its references share, whose memory is
/// returned when the last of them is dropped (CORE-80).
#[derive(Clone)]
pub enum SchemaRef {
    Static(&'static Schema),
    Shared(Arc<Schema>),
}

impl std::ops::Deref for SchemaRef {
    type Target = Schema;

    fn deref(&self) -> &Schema {
        match self {
            SchemaRef::Static(schema) => schema,
            SchemaRef::Shared(schema) => schema,
        }
    }
}

impl From<&'static Schema> for SchemaRef {
    fn from(schema: &'static Schema) -> SchemaRef {
        SchemaRef::Static(schema)
    }
}

/// The schema contained in a generated model: manifest text and its hash.
/// The runtime model is built once, on first use. A copy shares the texts and a runtime model that is already built.
#[derive(Clone)]
pub struct Schema {
    text: Text,
    /// The text of the tables the set uses from external documents (`dbspec::Manifest::external_text`). A set that uses no external documents
    /// is empty.
    external: Text,
    hash: Text,
    /// The runtime model built the first time, or the code and message of the error raised then.
    manifest: OnceLock<std::result::Result<Arc<Manifest>, (crate::Kind, String)>>,
}

impl Schema {
    pub const fn new(manifest_text: &'static str, manifest_hash: &'static str) -> Schema {
        Schema::with_external(manifest_text, "", manifest_hash)
    }

    /// The schema of a set that uses external documents: manifest text, the text of tables used from external documents, and the hash of the two texts.
    pub const fn with_external(manifest_text: &'static str, external_text: &'static str, manifest_hash: &'static str) -> Schema {
        Schema { text: Text::Static(manifest_text), external: Text::Static(external_text), hash: Text::Static(manifest_hash), manifest: OnceLock::new() }
    }

    /// The schema of a manifest that is given at run time (CORE-80). A text that is no manifest is `schema_invalid` and
    /// a text that does not hash to `manifest_hash` is `schema_hash_mismatch`. The schema owns its texts and its
    /// runtime model; its copies, the queries of it, their requests and the connections that it is registered on share
    /// them, and the memory is returned when the last of them is dropped.
    pub fn load(manifest_text: &str, external_text: &str, manifest_hash: &str) -> Result<Schema> {
        let manifest = Manifest::load_set(manifest_text, external_text, manifest_hash).map_err(|error| {
            let (kind, text) = manifest_refusal(error);
            Error::new(kind, text)
        })?;
        // The model that the check built is the model of the value, so the first use does not build it again.
        Ok(Schema {
            text: Text::Shared(manifest_text.into()),
            external: Text::Shared(external_text.into()),
            hash: Text::Shared(manifest_hash.into()),
            manifest: OnceLock::from(Ok(Arc::new(manifest))),
        })
    }

    /// The text of the tables the set uses from external documents. Empty if no external documents are used.
    pub fn external(&self) -> &str {
        &self.external
    }

    /// The `manifestHash` that generated the model.
    pub fn hash(&self) -> &str {
        &self.hash
    }

    /// manifest text.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// The document of manifest text from which statements are rendered.
    pub fn documents(&self) -> Result<Vec<Document>> {
        documents(&self.text, &self.external, &self.hash)
    }

    /// The runtime model of the schema to register. If the text does not hash to the declared hash, then
    /// before any statement it is CONFIG; if the text is not a manifest, it is SCHEMA_INVALID.
    pub(crate) fn registered(&self) -> Result<Arc<Manifest>> {
        self.manifest().map_err(|e| match e {
            error if error.kind() == crate::Kind::SchemaHashMismatch => Error::config(format!("invalid schema manifest: {}", error.text())),
            other => other,
        })
    }

    /// A reference that shares this schema: its texts and its runtime model, when it is built (CORE-80).
    pub(crate) fn shared(&self) -> SchemaRef {
        SchemaRef::Shared(Arc::new(self.clone()))
    }

    /// The number of the values that share the manifest text of a loaded schema, or `None` for a schema of generated
    /// code; the tests of CORE-80 count them.
    #[cfg(test)]
    pub(crate) fn text_owners(&self) -> Option<std::sync::Weak<str>> {
        match &self.text {
            Text::Static(_) => None,
            Text::Shared(text) => Some(Arc::downgrade(text)),
        }
    }

    /// runtime model.
    pub fn manifest(&self) -> Result<Arc<Manifest>> {
        self.manifest
            .get_or_init(|| Manifest::load_set(&self.text, &self.external, &self.hash).map(Arc::new).map_err(manifest_refusal))
            .clone()
            .map_err(|(kind, msg)| Error::new(kind, msg))
    }
}

/// The kind and the text of a manifest that did not load.
fn manifest_refusal(error: Error) -> (crate::Kind, String) {
    // A failure that is no refusal of the manifest itself, such as a configuration error, is SCHEMA_INVALID.
    if error.kind() == crate::Kind::Config {
        (crate::Kind::SchemaInvalid, error.to_string())
    } else {
        (error.kind(), error.text().to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The manifest text and manifestHash of contracts/fixtures/rollback.dbs.
    fn rollback_manifest() -> (String, String) {
        let text = include_str!("../../../contracts/fixtures/rollback.dbs");
        let document = dbspec::parse(text, &Default::default()).map(|parsed| parsed.document).expect("rollback.dbs parses");
        let manifest = dbspec::manifest(&[&document]).expect("rollback.dbs manifest");
        (manifest.manifest_text, manifest.manifest_hash)
    }

    fn leak(text: String) -> &'static str {
        Box::leak(text.into_boxed_str())
    }

    // Manifest text that does not hash to the declared hash is SCHEMA_HASH_MISMATCH, and text that is not a manifest is SCHEMA_INVALID.
    // Requirements: DBS-104, SCH-15.
    #[test]
    fn manifest_hash_mismatch_is_reported() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let (text, hash) = rollback_manifest();
        assert_eq!(Manifest::load(&text, &hash).expect("matching manifest").manifest_hash, hash);
        let edited = text.replace("label varchar(32)", "label varchar(64)");
        assert_ne!(edited, text, "the fixture declares label varchar(32)");
        for schema in [Schema::new(leak(edited.clone()), leak(hash.clone())), Schema::new(leak(text.clone()), "0000000000000000")] {
            let error = schema.manifest().expect_err("edited manifest");
            assert_eq!(error.kind(), crate::Kind::SchemaHashMismatch, "{error}");
            let error = schema.documents().expect_err("edited manifest documents");
            assert_eq!(error.kind(), crate::Kind::SchemaHashMismatch, "{error}");
        }
        for invalid in ["not a manifest", "dbspec 1 rollback\n\ntable rollback_probe {\n"] {
            let error = Schema::new(invalid, leak(hash.clone())).manifest().expect_err("invalid manifest");
            assert_eq!(error.kind(), crate::Kind::SchemaInvalid, "{error}");
        }
    }
}
