//! The functions of a loaded runtime model over JSON texts (docs/spec/flowmark-surface.md FMS-30 to FMS-35, FMS-41):
//! the model of its text, and the validation, the parameter uses, the restore key, the plan and the operators of a
//! request text. They are the functions of the class `runtime_model` of the contract and need no binding.

use polyspec_orm_schema::dbspec::json::{runtime_model_from_json, runtime_model_to_json};
use polyspec_orm_schema::dbspec::Type;
use serde_json::{json, Value};

use super::params::param_uses;
use super::{validate, Dialect};
use crate::ir::Request;
use crate::schema::Manifest;
use crate::{Error, Kind, Result};

/// The uses of each parameter of a validated request, in the order of the parameters (FMS-33): a slot with no column
/// is its type, and a slot of a column also has the name, the sizes and the nullability of the column, and `assign`
/// for an assignment.
pub(crate) fn param_uses_json(manifest: &Manifest, request: &Request) -> Result<Value> {
    let uses = param_uses(manifest, request)?;
    Ok(Value::Array(
        uses.iter()
            .map(|parameter| {
                Value::Array(
                    parameter
                        .iter()
                        .map(|use_| match use_.column {
                            None => json!({"type": use_.ty}),
                            Some(field) => {
                                let (length, precision, scale): (u32, u32, u32) = match field.ty {
                                    Type::Varchar(n) => (n.into(), 0, 0),
                                    Type::Decimal(p, s) => (0, p.into(), s.into()),
                                    Type::Time(p) | Type::DateTime(p) => (0, p.into(), 0),
                                    _ => (0, 0, 0),
                                };
                                let mut out =
                                    json!({"type": use_.ty, "column": field.name, "length": length, "null": field.nullable, "precision": precision, "scale": scale});
                                if use_.assign {
                                    out["assign"] = json!(true);
                                }
                                out
                            }
                        })
                        .collect(),
                )
            })
            .collect(),
    ))
}

/// The dialect of its name (FMS-41); another text is `config`.
fn dialect_of(name: &str) -> Result<Dialect> {
    Dialect::parse(name).ok_or_else(|| Error::config(format!("the dialect {name} is none of mysql, postgres and sqlite")))
}

impl Manifest {
    /// The model of its JSON text (FMS-16, FMS-30): the manifest hash that its requests name and its entities. A text
    /// that is no model of the form is `config`, with a message that names the member.
    pub fn from_json(model: &str) -> Result<Manifest> {
        let value: Value = serde_json::from_str(model).map_err(|error| Error::config(format!("the model is no JSON text: {error}")))?;
        let entities = runtime_model_from_json(&value).map_err(Error::config)?;
        match value.get("manifest_hash") {
            Some(Value::String(hash)) => Ok(Manifest { manifest_hash: hash.clone(), model: entities }),
            _ => Err(Error::config("model.manifest_hash is absent")),
        }
    }

    /// The form of the model (FMS-16).
    pub fn to_json(&self) -> Value {
        let mut out = runtime_model_to_json(&self.model);
        out["manifest_hash"] = Value::from(self.manifest_hash.as_str());
        out
    }

    /// Validates the request of the text `request` against the model (FMS-32). A text that is no request of the form
    /// is `ir_invalid`, and a request that the validation refuses fails with the kind of its cause.
    pub fn validate(&self, request: &str) -> Result<()> {
        validate::validate(self, &Request::from_json(request)?)
    }

    /// The uses of each parameter of the request of the text `request`, which is validated first, as JSON text (FMS-33).
    pub fn param_uses(&self, request: &str) -> Result<String> {
        let request = Request::from_json(request)?;
        validate::validate(self, &request)?;
        Ok(param_uses_json(self, &request)?.to_string())
    }

    /// The key of the restore request of the text `request` and the parts of its statement, as JSON text (FMS-34):
    /// `{"key": [..], "where": <group>, "set": [..], "soft_delete": <column>}`. An entity that the model does not have
    /// is `entity_unknown`.
    pub fn restore_key(&self, request: &str) -> Result<String> {
        let request = Request::from_json(request)?;
        let parts = validate::restore_key(self.entity(&request.query.entity)?, &request)?;
        let member = |name: &str, value: serde_json::Result<Value>| value.map_err(|error| Error::internal(format!("the {name} of a restore has no JSON form: {error}")));
        Ok(json!({
            "key": parts.key,
            "where": member("where", serde_json::to_value(&parts.where_))?,
            "set": member("set", serde_json::to_value(&parts.set))?,
            "soft_delete": parts.soft_delete,
        })
        .to_string())
    }

    /// Validates the request of the text `request` and plans it for the dialect `dialect`, `mysql`, `postgres` or
    /// `sqlite`; the plan is JSON text (FMS-40, FMS-41). Another dialect is `config`.
    pub fn compile(&self, request: &str, dialect: &str) -> Result<String> {
        let dialect = dialect_of(dialect)?;
        Ok(super::compile(self, dialect, &Request::from_json(request)?)?.to_json().to_string())
    }

    /// Whether a condition of the operator `operator` on the column `column` of the entity `entity` is allowed, as the
    /// validation decides (FMS-35). An entity that the model does not have is `entity_unknown`, and a column that the
    /// entity does not have is `column_unknown`.
    pub fn operator_allowed(&self, entity: &str, column: &str, operator: &str) -> Result<bool> {
        match self.entity(entity)?.field(column) {
            Some(field) => Ok(validate::op_allowed(field, operator)),
            None => Err(Error::new(Kind::ColumnUnknown, format!("{entity}.{column}"))),
        }
    }
}
