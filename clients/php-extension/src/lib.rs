//! PHP 확장 `orm_dbspec`: orm-schema의 dbspec 인터페이스(docs/dbspec.md)를 PHP class로 등록한다.
//!
//! `Orm\Dbspec\Native\Dbspec`의 정적 메서드 readFile, readBytes, parse, emit, manifest, render는
//! 순수 PHP client `Orm\Dbspec\Dbspec`과 같은 이름, 인자와 결과 모양을 가지며, 결과는 이 확장의
//! `Orm\Dbspec\Native\*` class다. 동작은 Rust client(orm-schema)의 동작 그대로이고, PHP 문자열이
//! byte이므로 생기는 경우(UTF-8이 아닌 text)만 이 확장이 순수 PHP client와 같게 다룬다.
//! 선언은 stubs/orm_dbspec.stub.php에 있고, 확장 test가 load한 확장의 Reflection과 그 stub이
//! 같은지 확인한다.

// PHP property와 메서드 이름(manifestText, readFile)은 camelCase이고, getter의 property 이름은
// Rust 함수 이름에서 온다.
#![allow(non_snake_case)]

use ext_php_rs::binary_slice::BinarySlice;
use ext_php_rs::convert::{FromZval, IntoZval};
use ext_php_rs::exception::PhpException;
use ext_php_rs::prelude::*;
use ext_php_rs::types::{ArrayKey, ZendHashTable, Zval};
use ext_php_rs::zend::ClassEntry;
use orm_schema::dbspec;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

mod data;

use data::{ManifestResultObject, ParseResultObject, ReadResultObject, RenderResultObject};

/// PHP core가 등록한 예외 class `class`로 던질 예외를 만든다.
fn exception(class: &str, message: String) -> PhpException {
    match ClassEntry::try_find(class) {
        Some(entry) => PhpException::new(message, 0, entry),
        None => PhpException::default(format!("{class} is not registered: {message}")),
    }
}

fn invalid_argument(message: String) -> PhpException {
    exception("InvalidArgumentException", message)
}

/// 값을 PHP zval로 바꾼다. 바꿀 수 없는 값은 그 이유를 담은 예외다.
fn zval_of<T: IntoZval>(value: T) -> PhpResult<Zval> {
    value.into_zval(false).map_err(|error| {
        PhpException::default(format!("cannot convert a result to PHP: {error:?}"))
    })
}

/// diagnostic 목록을 `Orm\Dbspec\Native\Diagnostic`의 PHP list로 바꾼다. 줄과 칸은 문서 크기
/// 한도(docs/dbspec.md "Limits") 안이므로 i64에 들어간다.
fn diagnostics_of(diagnostics: Vec<dbspec::Diagnostic>) -> PhpResult<Zval> {
    let objects = diagnostics
        .into_iter()
        .map(|d| {
            data::object(
                &data::DIAGNOSTIC,
                vec![
                    zval_of(d.rule)?,
                    zval_of(d.line as i64)?,
                    zval_of(d.column as i64)?,
                    zval_of(d.message)?,
                ],
            )
        })
        .collect::<PhpResult<Vec<Zval>>>()?;
    zval_of(objects)
}

fn no_diagnostics() -> PhpResult<Zval> {
    zval_of(Vec::<Zval>::new())
}

fn read_result(text: Option<String>, diagnostics: Zval) -> PhpResult<ReadResultObject> {
    data::object(&data::READ_RESULT, vec![zval_of(text)?, diagnostics]).map(ReadResultObject)
}

/// 이름이나 path로 쓰는 PHP 문자열을 UTF-8 text로 읽는다.
fn text_argument(what: &str, bytes: &[u8]) -> PhpResult<String> {
    String::from_utf8(bytes.to_vec())
        .map_err(|_| invalid_argument(format!("The {what} is not valid UTF-8")))
}

/// parse와 검증을 마친 dbspec 문서 하나. 바뀌지 않으며, emit하면 canonical text가 된다.
#[php_class]
#[php(name = "Orm\\Dbspec\\Native\\Document")]
#[php(flags = ext_php_rs::flags::ClassFlags::Final)]
pub struct Document {
    document: dbspec::Document,
}

#[php_impl]
impl Document {}

/// dbspec 인터페이스: 문서 파일 읽기, parse, canonical emit, manifest와 렌더링.
#[php_class]
#[php(name = "Orm\\Dbspec\\Native\\Dbspec")]
#[php(flags = ext_php_rs::flags::ClassFlags::Final)]
pub struct Dbspec;

#[php_impl]
impl Dbspec {
    /// 모든 dbspec 문서 파일의 첫 byte다. header `dbspec 1 <document>`가 이것으로 시작한다.
    pub const SIGNATURE: &'static str = dbspec::SIGNATURE;

    /// path의 dbspec 문서 파일을 읽고 그 byte를 path를 이름으로 readBytes로 확인한다. 읽을 수 없는
    /// 파일(directory 포함)은 RuntimeException이다.
    pub fn readFile(path: BinarySlice<u8>) -> PhpResult<ReadResultObject> {
        let name = text_argument("path", &path)?;
        match dbspec::read_file(Path::new(OsStr::from_bytes(&path))) {
            Ok(text) => read_result(Some(text), no_diagnostics()?),
            Err(dbspec::ReadError::Diagnostics(diagnostics)) => {
                read_result(None, diagnostics_of(diagnostics)?)
            }
            Err(dbspec::ReadError::Io(error)) => Err(exception(
                "RuntimeException",
                format!("cannot read {name}: {error}"),
            )),
        }
    }

    /// 호출자가 읽은 dbspec 문서 파일의 byte를 parse 전에 확인한다. name은 message가 파일을 가리키는 이름이다.
    pub fn readBytes(name: BinarySlice<u8>, bytes: BinarySlice<u8>) -> PhpResult<ReadResultObject> {
        let name = text_argument("name", &name)?;
        match dbspec::read_bytes(&name, bytes.to_vec()) {
            Ok(text) => read_result(Some(text), no_diagnostics()?),
            Err(diagnostics) => read_result(None, diagnostics_of(diagnostics)?),
        }
    }

    /// text를 parse하고 검증한다. documents는 선언된 문서 집합의 다른 문서 이름마다 그 text다.
    pub fn parse(text: BinarySlice<u8>, documents: &ZendHashTable) -> PhpResult<ParseResultObject> {
        let mut set = BTreeMap::new();
        for (key, value) in documents {
            let (Some(name), Some(source)) = (key_name(&key), value.zend_str()) else {
                return Err(invalid_argument(
                    "The declared document set maps document names to texts".to_string(),
                ));
            };
            let source = String::from_utf8(source.as_bytes().to_vec()).map_err(|_| {
                invalid_argument(format!(
                    "The text of the declared document `{name}` is not valid UTF-8"
                ))
            })?;
            set.insert(name, source);
        }
        let result = match std::str::from_utf8(&text) {
            Ok(text) => dbspec::parse(text, &set),
            Err(_) => Err(vec![byte_encoding_diagnostic(&text)]),
        };
        match result {
            Ok(document) => data::object(
                &data::PARSE_RESULT,
                vec![zval_of(Document { document })?, no_diagnostics()?],
            ),
            Err(diagnostics) => data::object(
                &data::PARSE_RESULT,
                vec![Zval::null(), diagnostics_of(diagnostics)?],
            ),
        }
        .map(ParseResultObject)
    }

    /// 문서를 canonical text로 쓴다: canonical 입력이면 `emit(parse(s)) === s`다.
    pub fn emit(document: &Document) -> String {
        dbspec::emit(&document.document)
    }

    /// 문서 이름 순서로 놓은 문서 집합의 manifest, 또는 집합의 diagnostic.
    pub fn manifest(documents: &ZendHashTable) -> PhpResult<ManifestResultObject> {
        let documents = documents_of(documents)?;
        match dbspec::manifest(&documents) {
            Ok(m) => {
                let manifest = data::object(
                    &data::MANIFEST,
                    vec![
                        zval_of(m.manifest_text)?,
                        zval_of(m.schema_text)?,
                        zval_of(m.manifest_hash)?,
                        zval_of(m.schema_hash)?,
                        zval_of(m.external_text)?,
                    ],
                )?;
                data::object(&data::MANIFEST_RESULT, vec![manifest, no_diagnostics()?])
            }
            Err(diagnostics) => data::object(
                &data::MANIFEST_RESULT,
                vec![Zval::null(), diagnostics_of(diagnostics)?],
            ),
        }
        .map(ManifestResultObject)
    }

    /// 문서 집합의 table을 만드는 dialect(`mysql`, `postgres`, `sqlite`)의 statement, 또는 집합의
    /// diagnostic. 모르는 dialect는 InvalidArgumentException이다.
    pub fn render(documents: &ZendHashTable, dialect: String) -> PhpResult<RenderResultObject> {
        let dialect = match dialect.as_str() {
            "mysql" => dbspec::Dialect::MySql,
            "postgres" => dbspec::Dialect::Postgres,
            "sqlite" => dbspec::Dialect::Sqlite,
            _ => {
                return Err(invalid_argument(format!(
                    "Unknown dialect `{dialect}`; the dialects are mysql, postgres and sqlite"
                )))
            }
        };
        let documents = documents_of(documents)?;
        match dbspec::render(&documents, dialect) {
            Ok(statements) => data::object(
                &data::RENDER_RESULT,
                vec![zval_of(statements)?, no_diagnostics()?],
            ),
            Err(diagnostics) => data::object(
                &data::RENDER_RESULT,
                vec![Zval::null(), diagnostics_of(diagnostics)?],
            ),
        }
        .map(RenderResultObject)
    }
}

/// 배열 key를 문서 이름으로 읽는다. 정수 key와 UTF-8이 아닌 key는 이름이 아니다(순수 PHP client는
/// 정수 key를 거부한다).
fn key_name(key: &ArrayKey<'_>) -> Option<String> {
    match key {
        ArrayKey::String(name) => Some(name.clone()),
        ArrayKey::Str(name) => Some((*name).to_string()),
        ArrayKey::ZendString(name) => String::from_utf8(name.as_bytes().to_vec()).ok(),
        ArrayKey::Long(_) => None,
    }
}

/// manifest와 render가 받는 문서 list의 각 값을 이 확장의 Document로 읽는다.
fn documents_of(documents: &ZendHashTable) -> PhpResult<Vec<&dbspec::Document>> {
    documents
        .values()
        .map(|value| {
            <&Document>::from_zval(value)
                .map(|document| &document.document)
                .ok_or_else(|| {
                    invalid_argument(
                        "The document set lists Orm\\Dbspec\\Native\\Document objects".to_string(),
                    )
                })
        })
        .collect()
}

/// UTF-8이 아닌 text의 `encoding` diagnostic 하나를 순수 PHP client(clients/php/src/Dbspec/Parser.php
/// checkEncoding)와 같게 만든다: byte order mark로 시작하면 1:1, 아니면 첫 잘못된 byte와 줄 바꿈이
/// 따르지 않는 첫 CR 가운데 앞선 것의 줄과 칸(code point로 센다).
fn byte_encoding_diagnostic(bytes: &[u8]) -> dbspec::Diagnostic {
    let diagnostic = |line, column, message: &str| dbspec::Diagnostic {
        rule: "encoding".to_string(),
        line,
        column,
        message: message.to_string(),
    };
    if bytes.starts_with(b"\xEF\xBB\xBF") {
        return diagnostic(1, 1, "the document starts with a byte order mark");
    }
    let invalid = match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(error) => error.valid_up_to(),
    };
    let bare_cr = (0..bytes.len()).find(|&i| bytes[i] == b'\r' && bytes.get(i + 1) != Some(&b'\n'));
    let (offset, message) = match bare_cr {
        Some(cr) if cr < invalid => (cr, "the document has a carriage return without a line feed"),
        _ => (invalid, "the document is not valid UTF-8"),
    };
    let before = std::str::from_utf8(&bytes[..offset])
        .expect("the bytes before the first invalid byte are UTF-8");
    let line = before.matches('\n').count() + 1;
    let column = before.rsplit('\n').next().unwrap_or("").chars().count() + 1;
    diagnostic(line, column, message)
}

/// module startup에서 data class를 등록한다(src/data.rs). 실패는 그 이유를 stderr에 쓰고 PHP가
/// 확장을 load하지 않게 1을 돌려준다.
extern "C" fn register_data_classes(_type: i32, _module_number: i32) -> i32 {
    for class in data::DATA_CLASSES {
        if let Err(error) = data::register(class) {
            eprintln!("orm_dbspec: {error}");
            return 1;
        }
    }
    0
}

/// 확장의 class를 등록한다.
#[php_module]
#[php(startup = register_data_classes)]
pub fn module(module: ModuleBuilder) -> ModuleBuilder {
    module
        .name("orm_dbspec")
        .class::<Document>()
        .class::<Dbspec>()
}
