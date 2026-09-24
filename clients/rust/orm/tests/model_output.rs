//! Output of a model: the JSON output writes an ordered-json value as its
//! text, and the array output of a value that serde_json cannot represent,
//! such as the number 1e400, returns CODEC_ENCODE instead of stopping the
//! process.

use std::collections::BTreeMap;

use orm::{Core, Entity, Model, Schema, Val};

// secret_config { bigint seq PK "auto"; int aes_key_version; longblob config "json aes" }
static SCHEMA: Schema = Schema::new(include_bytes!("testdata/aes_json.json"), "e10e4baa11dd59da");
static SECRET: Entity = Entity { name: "secret_config", schema: &SCHEMA, new: orm::model::new_boxed::<Secret>, collect: orm::model::collect_boxed::<Secret> };
const COLUMNS: [&str; 3] = ["seq", "aes_key_version", "config"];

/// A secret_config row whose values are read and written by column name.
#[derive(Clone)]
struct Secret {
    core: Core,
    values: BTreeMap<String, Val>,
}

impl Model for Secret {
    fn entity() -> &'static Entity {
        &SECRET
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        Secret { core, values: BTreeMap::new() }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> bool {
        if !COLUMNS.contains(&name) {
            return false;
        }
        self.values.insert(name.to_owned(), v);
        true
    }
    fn value(&self, name: &str) -> Option<Val> {
        self.values.get(name).cloned()
    }
}

#[test]
fn array_output_of_an_unrepresentable_number_is_an_error() {
    let value = orm::ordered_json::parse(r#"{"n":1e400}"#).unwrap();
    let mut row = Secret::from_core(Core::new(&SECRET));
    row.core_mut().set_ordered("config", value.clone());
    assert!(row.assign("config", Val::Ordered(value.clone())));
    match orm::model::to_array(&row) {
        Err(e) => assert_eq!(e.code(), "CODEC_ENCODE", "{e}"),
        Ok(v) => panic!("to_array returned {v}"),
    }
    match Val::Ordered(value).to_json() {
        Err(e) => assert_eq!(e.code(), "CODEC_ENCODE", "{e}"),
        Ok(v) => panic!("Val::to_json returned {v}"),
    }
}

#[test]
fn json_output_keeps_the_ordered_json_text() {
    for text in [r#"{"b":1,"a":[],"c":{},"n":1.50}"#, r#"{"n":1e400}"#] {
        let value = orm::ordered_json::parse(text).unwrap();
        let mut row = Secret::from_core(Core::new(&SECRET));
        row.core_mut().set_ordered("config", value.clone());
        assert!(row.assign("config", Val::Ordered(value)));
        assert_eq!(orm::model::to_json(&row).unwrap(), format!(r#"{{"config":{text}}}"#));
    }
}
