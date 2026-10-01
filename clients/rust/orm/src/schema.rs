//! generated model의 schema: dbspec document set의 manifest text와 `manifestHash`,
//! 그리고 그 둘로 만든 runtime model (docs/dbspec.md, "Manifest and hashes",
//! "Runtime model").

use std::sync::{Arc, OnceLock};

use orm_schema::dbspec::{self, Document, Entity, RuntimeModel};

use crate::{codes, Error, Result};

/// hash를 확인한 manifest text의 runtime model.
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

/// manifest text의 document. 그 document의 manifest가 text 자신이고 hash가 `hash`여야 한다.
fn documents(text: &str, hash: &str) -> Result<Vec<Document>> {
    let documents = dbspec::parse_manifest(text).map_err(diagnostics)?;
    let refs: Vec<&Document> = documents.iter().collect();
    let manifest = dbspec::manifest(&refs).map_err(diagnostics)?;
    if manifest.manifest_text != text {
        return Err(invalid("the embedded text is not the manifest text of its documents".into()));
    }
    if manifest.manifest_hash != hash {
        return Err(invalid(format!("models were generated from manifest {hash} but the embedded manifest is {}", manifest.manifest_hash)));
    }
    Ok(documents)
}

impl Manifest {
    /// manifest text의 runtime model을 만들고 text의 hash가 `manifest_hash`인지 확인한다.
    pub fn load(manifest_text: &str, manifest_hash: &str) -> Result<Manifest> {
        let documents = documents(manifest_text, manifest_hash)?;
        let refs: Vec<&Document> = documents.iter().collect();
        let model = dbspec::runtime_model(&refs).map_err(diagnostics)?;
        Ok(Manifest { manifest_hash: manifest_hash.to_owned(), model })
    }

    pub fn entity(&self, name: &str) -> Result<&Entity> {
        self.model.entity(name).ok_or_else(|| Error::Engine { code: codes::ENTITY_UNKNOWN.into(), msg: name.to_owned() })
    }
}

/// generated model에 들어 있는 schema: manifest text와 그 hash.
/// runtime model은 처음 쓸 때 한 번 만든다.
pub struct Schema {
    text: &'static str,
    hash: &'static str,
    manifest: OnceLock<std::result::Result<Arc<Manifest>, String>>,
}

impl Schema {
    pub const fn new(manifest_text: &'static str, manifest_hash: &'static str) -> Schema {
        Schema { text: manifest_text, hash: manifest_hash, manifest: OnceLock::new() }
    }

    /// model을 생성한 `manifestHash`.
    pub fn hash(&self) -> &'static str {
        self.hash
    }

    /// manifest text.
    pub fn text(&self) -> &'static str {
        self.text
    }

    /// statement를 render할 manifest text의 document.
    pub fn documents(&self) -> Result<Vec<Document>> {
        documents(self.text, self.hash)
    }

    /// runtime model.
    pub fn manifest(&self) -> Result<Arc<Manifest>> {
        self.manifest
            .get_or_init(|| Manifest::load(self.text, self.hash).map(Arc::new).map_err(|e| e.to_string()))
            .clone()
            .map_err(|msg| Error::Engine { code: codes::SCHEMA_INVALID.into(), msg })
    }
}
