//! Reads the shared dbspec vector files against their JSON Schemas (tests/dbspec/schema, draft 2020-12) with the
//! jsonschema crate, the schemas that the TypeScript runner reads them with (tests/dbspec/vectors.mts). A refused file
//! is reported in the form that every compare runner shares (tests/dbspec/compare/runners.test.mts): one
//! "<file>: <location> <problem>" line per refusal, where the location is the dotted path of the value
//! (`canonical[0].documents.shop`). tests/dbspec/cases.json is read against its schema, and check_cases also refuses a
//! case whose main document is not one of its documents, which the schema cannot state. The tests and the
//! dbspec_compare example include this file.

use jsonschema::error::{TypeKind, ValidationErrorKind};
use jsonschema::paths::LocationSegment;
use jsonschema::ValidationError;
use serde_json::Value;

/// The dotted path of a value: object keys joined with ".", array indexes in brackets.
fn location<'a>(segments: impl IntoIterator<Item = LocationSegment<'a>>, property: Option<&str>) -> String {
    let mut path = String::new();
    let mut push = |segment: &str, index: bool| {
        if index {
            path.push_str(&format!("[{segment}]"));
        } else if path.is_empty() {
            path.push_str(segment);
        } else {
            path.push_str(&format!(".{segment}"));
        }
    };
    for segment in segments {
        match segment {
            LocationSegment::Index(i) => push(&i.to_string(), true),
            LocationSegment::Property(name) => push(&name, name.bytes().all(|b| b.is_ascii_digit()) && !name.is_empty()),
        }
    }
    if let Some(property) = property {
        push(property, property.bytes().all(|b| b.is_ascii_digit()) && !property.is_empty());
    }
    path
}

/// The article form of a JSON type.
fn article(name: &str) -> String {
    match name {
        "integer" => "an integer".to_string(),
        "object" => "an object".to_string(),
        "array" => "an array".to_string(),
        "string" => "a string".to_string(),
        "boolean" => "a boolean".to_string(),
        "number" => "a number".to_string(),
        other => other.to_string(),
    }
}

/// The shared form of one refusal: the location of each value it refuses and what is wrong there. A refusal of
/// anyOf or oneOf is the refusals of its branches.
fn problems(error: &ValidationError<'_>) -> Vec<String> {
    let at = || error.instance_path().iter();
    match error.kind() {
        ValidationErrorKind::AnyOf { context } | ValidationErrorKind::OneOfNotValid { context } => context.iter().flatten().flat_map(problems).collect(),
        ValidationErrorKind::Required { property } => vec![format!("{} is missing", location(at(), Some(property.as_str().unwrap_or_default())))],
        ValidationErrorKind::AdditionalProperties { unexpected } | ValidationErrorKind::UnevaluatedProperties { unexpected } => {
            unexpected.iter().map(|name| format!("{} is not a known field", location(at(), Some(name)))).collect()
        }
        ValidationErrorKind::Type { kind } => {
            let types: Vec<String> = match kind {
                TypeKind::Single(single) => vec![article(&single.to_string())],
                TypeKind::Multiple(set) => set.iter().map(|t| article(&t.to_string())).collect(),
            };
            vec![format!("{} is not {}", location(at(), None), types.join(" or "))]
        }
        ValidationErrorKind::MinItems { .. } => vec![format!("{} is empty", location(at(), None))],
        ValidationErrorKind::Constant { expected_value } => vec![format!("{} is not {expected_value}", location(at(), None))],
        kind => vec![format!("{} fails the {} rule of its schema: {error}", location(at(), None), kind.keyword())],
    }
}

/// The schema tests/dbspec/schema/`kind`.schema.json, built into the binary, so a copied test or runner reads the
/// schemas of the checkout it was built from.
fn schema_text(kind: &str) -> Result<&'static str, String> {
    match kind {
        "cases" => Ok(include_str!("../../../../../tests/dbspec/schema/cases.schema.json")),
        "ddl" => Ok(include_str!("../../../../../tests/dbspec/schema/ddl.schema.json")),
        "plans" => Ok(include_str!("../../../../../tests/dbspec/schema/plans.schema.json")),
        "mermaid" => Ok(include_str!("../../../../../tests/dbspec/schema/mermaid.schema.json")),
        "syntax" => Ok(include_str!("../../../../../tests/dbspec/schema/syntax.schema.json")),
        other => Err(format!("tests/dbspec/schema has no schema {other}")),
    }
}

/// Checks the parsed vector file `value` against the schema tests/dbspec/schema/`kind`.schema.json; a refusal is an
/// error holding one "<name>: <location> <problem>" line per problem.
pub fn check_vectors(value: &Value, kind: &str, name: &str) -> Result<(), String> {
    let place = format!("tests/dbspec/schema/{kind}.schema.json");
    let schema: Value = serde_json::from_str(schema_text(kind)?).map_err(|e| format!("{place}: {e}"))?;
    let validator = jsonschema::validator_for(&schema).map_err(|e| format!("{place}: {e}"))?;
    let mut lines: Vec<String> = Vec::new();
    for error in validator.iter_errors(value) {
        for problem in problems(&error) {
            let line = format!("{name}: {problem}");
            if !lines.contains(&line) {
                lines.push(line);
            }
        }
    }
    if lines.is_empty() {
        Ok(())
    } else {
        Err(lines.join("\n"))
    }
}

/// Checks the parsed cases.json `value`; `name` names the file in the errors.
pub fn check_cases(value: &Value, name: &str) -> Result<(), String> {
    check_vectors(value, "cases", name)?;
    for section in ["canonical", "normalize", "invalid", "positions"] {
        for (i, case) in value[section].as_array().into_iter().flatten().enumerate() {
            let main = case["main"].as_str().unwrap_or_default();
            if !case["documents"].as_object().is_some_and(|documents| documents.contains_key(main)) {
                return Err(format!("{name}: {section}[{i}].documents.{main} is missing"));
            }
        }
    }
    Ok(())
}
