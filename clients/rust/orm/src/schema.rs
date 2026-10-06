//! generated model의 schema: dbspec document set의 manifest text와 `manifestHash`,
//! 그리고 그 둘로 만든 runtime model (docs/dbspec.md, "Manifest and hashes",
//! "Runtime model").

use std::sync::{Arc, OnceLock};

use polyspec_orm_schema::dbspec::{self, Document, Entity, RuntimeModel};

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

/// manifest text와 external text의 document. 외부 문서는 `external`이다. 그 document의 manifest text와 external
/// text가 두 text 자신이고 hash가 `hash`여야 한다.
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
        // text는 manifest지만 선언한 hash로 hash되지 않는다 (docs/dbspec.md, "Manifest and hashes").
        return Err(Error::Engine {
            code: codes::SCHEMA_HASH_MISMATCH.into(),
            msg: format!("models were generated from manifest {hash} but the embedded manifest is {}", manifest.manifest_hash),
        });
    }
    Ok(documents)
}

impl Manifest {
    /// manifest text의 runtime model을 만들고 text의 hash가 `manifest_hash`인지 확인한다.
    pub fn load(manifest_text: &str, manifest_hash: &str) -> Result<Manifest> {
        Manifest::load_set(manifest_text, "", manifest_hash)
    }

    /// manifest text와 external text(외부 문서에서 set이 쓰는 table)의 runtime model을 만들고 두 text의 hash가
    /// `manifest_hash`인지 확인한다. 외부 문서의 table은 entity가 아니다.
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

/// generated model에 들어 있는 schema: manifest text와 그 hash.
/// runtime model은 처음 쓸 때 한 번 만든다.
pub struct Schema {
    text: &'static str,
    /// 외부 문서에서 set이 쓰는 table의 text(`dbspec::Manifest::external_text`). 외부 문서를 쓰지 않는 set은
    /// 비어 있다.
    external: &'static str,
    hash: &'static str,
    /// 처음 만든 runtime model, 또는 그때 난 오류의 code와 message.
    manifest: OnceLock<std::result::Result<Arc<Manifest>, (String, String)>>,
}

impl Schema {
    pub const fn new(manifest_text: &'static str, manifest_hash: &'static str) -> Schema {
        Schema::with_external(manifest_text, "", manifest_hash)
    }

    /// 외부 문서를 쓰는 set의 schema: manifest text, 외부 문서에서 쓰는 table의 text, 두 text의 hash.
    pub const fn with_external(manifest_text: &'static str, external_text: &'static str, manifest_hash: &'static str) -> Schema {
        Schema { text: manifest_text, external: external_text, hash: manifest_hash, manifest: OnceLock::new() }
    }

    /// 외부 문서에서 set이 쓰는 table의 text. 외부 문서를 쓰지 않으면 비어 있다.
    pub fn external(&self) -> &'static str {
        self.external
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
        documents(self.text, self.external, self.hash)
    }

    /// 등록할 schema의 runtime model. text가 선언한 hash로 hash되지 않으면 어떤
    /// statement보다 먼저 CONFIG이고, text가 manifest가 아니면 SCHEMA_INVALID다.
    pub(crate) fn registered(&self) -> Result<Arc<Manifest>> {
        self.manifest().map_err(|e| match e {
            Error::Engine { code, msg } if code == codes::SCHEMA_HASH_MISMATCH => Error::Config(format!("invalid schema manifest: {msg}")),
            other => other,
        })
    }

    /// 같은 manifest text와 hash의 schema 하나. 연결이 등록한 set의 schema를 request에 쓰도록 process에서
    /// hash마다 한 번 만들고 둔다.
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

    /// contracts/fixtures/rollback.dbs의 manifest text와 manifestHash.
    fn rollback_manifest() -> (String, String) {
        let text = include_str!("../../../../contracts/fixtures/rollback.dbs");
        let document = dbspec::parse(text, &Default::default()).expect("rollback.dbs parses");
        let manifest = dbspec::manifest(&[&document]).expect("rollback.dbs manifest");
        (manifest.manifest_text, manifest.manifest_hash)
    }

    fn leak(text: String) -> &'static str {
        Box::leak(text.into_boxed_str())
    }

    // 선언한 hash로 hash되지 않는 manifest text는 SCHEMA_HASH_MISMATCH이고, manifest가 아닌 text는 SCHEMA_INVALID다.
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
