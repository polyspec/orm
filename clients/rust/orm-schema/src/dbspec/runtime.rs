//! ORM runtime과 model generator가 함께 쓰는 document set의 runtime model
//! (docs/dbspec.md, "Runtime model")과, manifest text에서 다시 읽은 document.

use super::model::{DefaultValue, Document, Setting, Table, Type};
use super::Diagnostic;
use std::collections::BTreeMap;

/// document set의 entity: document는 이름 순서, table은 document 안의 순서다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeModel {
    pub entities: Vec<Entity>,
}

/// ORM이 보는 table 하나.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entity {
    /// `entity` setting, 없으면 table 이름.
    pub name: String,
    pub table: String,
    /// column마다 field 하나, column 순서.
    pub fields: Vec<Field>,
    pub primary_key: Vec<String>,
    /// identity column.
    pub identity: Option<String>,
    pub uniques: Vec<Key>,
    pub indexes: Vec<Key>,
    pub foreign_keys: Vec<ForeignKey>,
    /// `updated` column.
    pub updated: Option<String>,
    /// `soft_delete` column.
    pub soft_delete: Option<String>,
    /// `aes_version` column.
    pub aes_version: Option<String>,
    pub audit: Option<Audit>,
    pub immutable: bool,
}

/// ORM이 보는 column 하나.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    pub name: String,
    pub ty: Type,
    pub nullable: bool,
    pub identity: bool,
    pub primary_key: bool,
    /// foreign key에 속한 column이다.
    pub foreign_key: bool,
    pub default: Option<FieldDefault>,
    /// `select explicit`이 이름을 적은 column이라 default select set에서 빠진다.
    pub select_explicit: bool,
    /// 쓰기 순서의 codec stage.
    pub codec: Vec<String>,
    /// 이 AES column의 `blind_index` setting이 정한 index column.
    pub blind_index: Option<String>,
}

/// column의 default.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FieldDefault {
    /// `default now`.
    Now,
    /// canonical text의 literal.
    Literal(String),
}

/// 이름이 있는 unique key 또는 index와 그 column.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    pub name: String,
    pub columns: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub table: String,
    pub references: Vec<String>,
}

/// `audit` setting (docs/dbspec.md, "Audit").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Audit {
    pub history: String,
    /// transaction의 audit 기록 key를 담는 column.
    pub column: String,
    /// audit 기록 table의 entity 이름.
    pub record: String,
    pub action: String,
    pub previous: String,
}

impl RuntimeModel {
    /// 이름이 `name`인 entity.
    pub fn entity(&self, name: &str) -> Option<&Entity> {
        self.entities.iter().find(|e| e.name == name)
    }
}

impl Entity {
    /// 이름이 `name`인 field.
    pub fn field(&self, name: &str) -> Option<&Field> {
        self.fields.iter().find(|f| f.name == name)
    }
}

impl Field {
    /// field가 common value model의 styled value를 담는다: codec stage 중 하나가
    /// `ordered_json`, `serialize`, `yaml`, `gz`, `base64`다 (docs/dbspec.md, "Runtime model").
    pub fn styled_value(&self) -> bool {
        self.codec.iter().any(|s| matches!(s.as_str(), "ordered_json" | "serialize" | "yaml" | "gz" | "base64"))
    }

    /// field가 `aes` stage로 암호화된다.
    pub fn aes(&self) -> bool {
        self.codec.iter().any(|s| s == "aes")
    }
}

/// document를 이름 순서로 놓은 document set의 runtime model을 돌려준다.
/// 잘못된 document set이면 `manifest`와 같은 diagnostic을 돌려준다.
pub fn runtime_model(documents: &[&Document]) -> Result<RuntimeModel, Vec<Diagnostic>> {
    let ordered = super::check_set(documents)?;
    let mut entities: Vec<Entity> = ordered.iter().flat_map(|d| d.tables.iter()).map(entity).collect();
    let names: Vec<(String, String)> = entities.iter().map(|e| (e.table.clone(), e.name.clone())).collect();
    for audit in entities.iter_mut().filter_map(|e| e.audit.as_mut()) {
        if let Some((_, name)) = names.iter().find(|(table, _)| *table == audit.record) {
            audit.record = name.clone();
        }
    }
    Ok(RuntimeModel { entities })
}

fn entity(table: &Table) -> Entity {
    let lines: Vec<&Setting> = table.settings.iter().flat_map(|s| s.lines.iter()).map(|l| &l.setting).collect();
    let column = |find: fn(&Setting) -> Option<&super::model::Name>| lines.iter().find_map(|s| find(s)).map(|n| n.text.clone());
    let name = column(|s| if let Setting::Entity(n) = s { Some(n) } else { None }).unwrap_or_else(|| table.name.text.clone());
    let primary_key: Vec<String> = table.primary.iter().flat_map(|k| k.columns.iter()).map(|n| n.text.clone()).collect();
    let fields = table
        .columns
        .iter()
        .map(|c| {
            let name = c.name.text.clone();
            let codec = lines
                .iter()
                .find_map(|s| match s {
                    Setting::Codec(col, stages) if col.text == name => Some(stages.iter().map(|n| n.text.clone()).collect()),
                    _ => None,
                })
                .unwrap_or_default();
            let blind_index = lines.iter().find_map(|s| match s {
                Setting::BlindIndex(col, index) if col.text == name => Some(index.text.clone()),
                _ => None,
            });
            Field {
                ty: c.ty,
                nullable: c.nullable,
                identity: c.identity.is_some(),
                primary_key: primary_key.contains(&name),
                foreign_key: table.foreign_keys.iter().any(|k| k.columns.iter().any(|n| n.text == name)),
                default: c.default.as_ref().map(|d| match d {
                    DefaultValue::Now => FieldDefault::Now,
                    DefaultValue::Literal(text) => FieldDefault::Literal(text.clone()),
                }),
                select_explicit: lines.iter().any(|s| matches!(s, Setting::SelectExplicit(names) if names.iter().any(|n| n.text == name))),
                codec,
                blind_index,
                name,
            }
        })
        .collect();
    let keys = |names: &[super::model::Name]| names.iter().map(|n| n.text.clone()).collect::<Vec<_>>();
    Entity {
        name,
        table: table.name.text.clone(),
        fields,
        identity: table.columns.iter().find(|c| c.identity.is_some()).map(|c| c.name.text.clone()),
        primary_key,
        uniques: table.uniques.iter().map(|u| Key { name: u.name.text.clone(), columns: keys(&u.columns) }).collect(),
        indexes: table.indexes.iter().map(|i| Key { name: i.name.text.clone(), columns: i.columns.iter().map(|(n, _)| n.text.clone()).collect() }).collect(),
        foreign_keys: table
            .foreign_keys
            .iter()
            .map(|k| ForeignKey { name: k.name.text.clone(), columns: keys(&k.columns), table: k.table.text.clone(), references: keys(&k.references) })
            .collect(),
        updated: column(|s| if let Setting::Updated(n) = s { Some(n) } else { None }),
        soft_delete: column(|s| if let Setting::SoftDelete(n) = s { Some(n) } else { None }),
        aes_version: column(|s| if let Setting::AesVersion(n) = s { Some(n) } else { None }),
        audit: lines.iter().find_map(|s| match s {
            // record는 table 이름이며 runtime_model이 모든 entity를 만든 뒤 entity 이름으로 바꾼다.
            Setting::Audit { into, column, references, action, previous, .. } => Some(Audit {
                history: into.text.clone(),
                column: column.text.clone(),
                record: references.text.clone(),
                action: action.text.clone(),
                previous: previous.text.clone(),
            }),
            _ => None,
        }),
        immutable: lines.iter().any(|s| matches!(s, Setting::Immutable)),
    }
}

/// manifest text의 document를 읽는다 (docs/dbspec.md, "Manifest and hashes").
/// document는 header line에서 시작하고, 각 document는 나머지 document를 declared
/// document set으로 삼아 parse한다. diagnostic은 manifest text의 line을 갖고
/// message에 document 이름을 적는다. 첫 header 앞의 text는 `header` error다.
pub fn parse_manifest(text: &str) -> Result<Vec<Document>, Vec<Diagnostic>> {
    let mut chunks: Vec<(usize, String, String)> = Vec::new();
    for (i, line) in text.split_inclusive('\n').enumerate() {
        if line.starts_with("dbspec ") {
            let name = line.trim_end().split(' ').nth(2).unwrap_or("").to_owned();
            chunks.push((i, name, String::new()));
        }
        match chunks.last_mut() {
            Some((_, _, chunk)) => chunk.push_str(line),
            None => {
                return Err(vec![Diagnostic {
                    rule: "header".into(),
                    line: i + 1,
                    column: 1,
                    message: "a manifest text starts with a document header".into(),
                }]);
            }
        }
    }
    if chunks.is_empty() {
        return Err(vec![Diagnostic { rule: "header".into(), line: 1, column: 1, message: "a manifest text holds at least one document".into() }]);
    }
    let set: BTreeMap<String, String> = chunks.iter().map(|(_, name, chunk)| (name.clone(), chunk.clone())).collect();
    let mut documents = Vec::with_capacity(chunks.len());
    let mut errors = Vec::new();
    for (start, name, chunk) in &chunks {
        match super::parse(chunk, &set) {
            Ok(document) => documents.push(document),
            Err(diagnostics) => {
                errors.extend(diagnostics.into_iter().map(|d| Diagnostic { line: d.line + start, message: format!("document {name}: {}", d.message), ..d }))
            }
        }
    }
    if errors.is_empty() {
        Ok(documents)
    } else {
        Err(errors)
    }
}
