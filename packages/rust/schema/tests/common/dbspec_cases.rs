//! Reads tests/dbspec/cases.json strictly, as the Go reader does (engine/dbspec/vectors_test.go decodeCaseVectors):
//! every section and every field of the format must be present with its type, and a section or field the format does
//! not name is refused. A refusal is the error "<file>: <location> <problem>". The tests and the dbspec_compare
//! example include this file.

use serde_json::Value;

/// The type of a field: a scalar, an array of a type, or an object whose fields are (name, optional, type).
enum Kind {
    String,
    Boolean,
    Integer,
    Lines,
    LinesMap,
    Array(&'static Kind),
    Object(&'static [(&'static str, bool, Kind)]),
}

const ERRORS: Kind = Kind::Array(&Kind::Object(&[("line", false, Kind::Integer), ("column", false, Kind::Integer), ("rule", false, Kind::String)]));
const DOCUMENT_CASE: Kind = Kind::Array(&Kind::Object(&[
    ("id", false, Kind::String),
    ("documents", false, Kind::LinesMap),
    ("main", false, Kind::String),
    ("crlf", true, Kind::Boolean),
    ("mixed", true, Kind::Boolean),
]));
const SCHEMA: Kind = Kind::Object(&[
    ("version", false, Kind::Integer),
    ("note", false, Kind::String),
    ("canonical", false, DOCUMENT_CASE),
    (
        "normalize",
        false,
        Kind::Array(&Kind::Object(&[
            ("id", false, Kind::String),
            ("documents", false, Kind::LinesMap),
            ("main", false, Kind::String),
            ("crlf", true, Kind::Boolean),
            ("mixed", true, Kind::Boolean),
            ("canonical", false, Kind::Lines),
        ])),
    ),
    (
        "invalid",
        false,
        Kind::Array(&Kind::Object(&[
            ("id", false, Kind::String),
            ("documents", false, Kind::LinesMap),
            ("main", false, Kind::String),
            ("crlf", true, Kind::Boolean),
            ("mixed", true, Kind::Boolean),
            ("errors", false, ERRORS),
        ])),
    ),
    (
        "hashes",
        false,
        Kind::Array(&Kind::Object(&[
            ("id", false, Kind::String),
            ("documents", false, Kind::LinesMap),
            ("manifestText", false, Kind::Lines),
            ("schemaText", false, Kind::Lines),
            ("manifestHash", false, Kind::String),
            ("schemaHash", false, Kind::String),
        ])),
    ),
    (
        "sets",
        false,
        Kind::Array(&Kind::Object(&[
            ("id", false, Kind::String),
            ("documents", false, Kind::Array(&Kind::Lines)),
            ("parsing", false, Kind::LinesMap),
            ("errors", false, ERRORS),
            ("external", true, Kind::Array(&Kind::Lines)),
            (
                "manifest",
                true,
                Kind::Object(&[
                    ("manifestText", false, Kind::Lines),
                    ("externalText", false, Kind::Lines),
                    ("schemaText", false, Kind::Lines),
                    ("created", false, Kind::Lines),
                    ("manifestHash", false, Kind::String),
                    ("schemaHash", false, Kind::String),
                ]),
            ),
        ])),
    ),
    ("files", false, Kind::Array(&Kind::Object(&[("id", false, Kind::String), ("path", false, Kind::String), ("errors", false, ERRORS)]))),
    (
        "positions",
        false,
        Kind::Array(&Kind::Object(&[
            ("id", false, Kind::String),
            ("documents", false, Kind::LinesMap),
            ("main", false, Kind::String),
            (
                "positions",
                false,
                Kind::Array(&Kind::Object(&[
                    ("kind", false, Kind::String),
                    ("path", false, Kind::Lines),
                    ("line", false, Kind::Integer),
                    ("column", false, Kind::Integer),
                ])),
            ),
        ])),
    ),
]);

fn at(location: &str, key: &str) -> String {
    if location.is_empty() {
        key.to_string()
    } else {
        format!("{location}.{key}")
    }
}

fn refuse(name: &str, location: &str, problem: &str) -> String {
    format!("{name}: {} {problem}", if location.is_empty() { "$" } else { location })
}

fn check(name: &str, value: &Value, kind: &Kind, location: &str) -> Result<(), String> {
    let fail = |problem: &str| Err(refuse(name, location, problem));
    match kind {
        Kind::String if !value.is_string() => fail("is not a string"),
        Kind::Boolean if !value.is_boolean() => fail("is not a boolean"),
        Kind::Integer if !(value.is_i64() || value.is_u64()) => fail("is not an integer"),
        Kind::String | Kind::Boolean | Kind::Integer => Ok(()),
        Kind::Lines => check(name, value, &Kind::Array(&Kind::String), location),
        Kind::LinesMap => {
            let Some(object) = value.as_object() else { return fail("is not an object") };
            object.iter().try_for_each(|(key, lines)| check(name, lines, &Kind::Lines, &at(location, key)))
        }
        Kind::Array(item) => {
            let Some(items) = value.as_array() else { return fail("is not an array") };
            items.iter().enumerate().try_for_each(|(i, value)| check(name, value, item, &format!("{location}[{i}]")))
        }
        Kind::Object(fields) => {
            let Some(object) = value.as_object() else { return fail("is not an object") };
            if let Some((key, _, _)) = fields.iter().find(|(key, optional, _)| !optional && !object.contains_key(*key)) {
                return Err(refuse(name, &at(location, key), "is missing"));
            }
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();
            if let Some(key) = keys.into_iter().find(|key| !fields.iter().any(|(known, _, _)| known == key)) {
                return Err(refuse(name, &at(location, key), "is not a known field"));
            }
            for (key, _, field) in fields.iter() {
                if let Some(value) = object.get(*key) {
                    check(name, value, field, &at(location, key))?;
                }
            }
            if fields.iter().any(|(key, _, _)| *key == "main") {
                let main = object["main"].as_str().unwrap_or_default();
                if !object["documents"].as_object().is_some_and(|documents| documents.contains_key(main)) {
                    return Err(refuse(name, &at(&at(location, "documents"), main), "is missing"));
                }
            }
            Ok(())
        }
    }
}

/// Checks the parsed cases.json `value`; `name` names the file in the errors.
pub fn check_cases(value: &Value, name: &str) -> Result<(), String> {
    check(name, value, &SCHEMA, "")?;
    if value["version"] != 1 {
        return Err(refuse(name, "version", "is not 1"));
    }
    let Kind::Object(sections) = SCHEMA else { unreachable!("the schema is an object") };
    for (key, _, kind) in sections {
        if matches!(kind, Kind::Array(_)) && value[*key].as_array().is_some_and(Vec::is_empty) {
            return Err(refuse(name, key, "is empty"));
        }
    }
    Ok(())
}
