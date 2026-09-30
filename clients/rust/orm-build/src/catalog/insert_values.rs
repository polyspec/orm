//! Bounded typed insert assignment and generated-identity validation.
use super::{mutation::cell, row_snapshot, TableMetadata};
use crate::tool_db::{self, P};
use std::collections::HashSet;

pub(super) fn validate(metadata: &TableMetadata, values: &[(String, P)], dialect: &str) -> Result<Option<Vec<P>>, String> {
    row_snapshot::descriptor(metadata)?;
    if values.len() > metadata.columns.len() {
        return Err("ROW_INSERT_INVALID: invalid assignments".into());
    }
    tool_db::validate_param_refs(values.iter().map(|(_, value)| value), dialect).map_err(|e| e.to_string())?;
    let mut names = HashSet::new();
    let mut bytes = 0usize;
    for (name, value) in values {
        let column = metadata.columns.iter().find(|column| column.name == *name).ok_or_else(|| "ROW_INSERT_INVALID: unknown column".to_owned())?;
        if !names.insert(name) || column.generated || (!column.nullable && matches!(value, P::Null(_))) {
            return Err("ROW_INSERT_INVALID: invalid column assignment".into());
        }
        let size = match value {
            P::S(v) | P::Decimal(v) => v.len(),
            P::Binary(v) => v.len(),
            _ => 16,
        };
        bytes = bytes
            .checked_add(name.len())
            .and_then(|n| n.checked_add(size))
            .filter(|n| *n <= 8 * 1024 * 1024)
            .ok_or_else(|| "ROW_INSERT_LIMIT: assignment budget exceeded".to_owned())?;
    }
    let mut omitted = Vec::new();
    let keys = metadata
        .primary_key
        .iter()
        .map(|name| {
            values.iter().find(|(column, _)| column == name).map(|(_, value)| value.clone()).map_or_else(
                || {
                    let column = metadata.columns.iter().find(|column| column.name == *name).unwrap();
                    if !column.automatic_key && column.default_expression.is_none() {
                        return Err("ROW_INSERT_IDENTITY_REQUIRED: primary key has no generator".to_owned());
                    }
                    omitted.push(column);
                    Ok(None)
                },
                |value| Ok(Some(value)),
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    if dialect == "mysql" && omitted.iter().filter(|column| column.automatic_key).count() > 1 {
        return Err("ROW_INSERT_UNSUPPORTED: multiple AUTO_INCREMENT identities".into());
    }
    let params = values.iter().map(|(_, value)| value.clone()).collect::<Vec<_>>();
    tool_db::validate_params(&params, dialect).map_err(|e| e.to_string())?;
    let cells = params.iter().map(cell).collect::<Vec<_>>();
    row_snapshot::revision(metadata, &cells).map_err(|_| "ROW_INSERT_LIMIT: assignment encoding budget exceeded".to_owned())?;
    Ok(if omitted.is_empty() { Some(keys.into_iter().flatten().collect()) } else { None })
}
