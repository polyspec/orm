//! The generated-model ops of the model_writes recipe (docs/spec/feature-coverage.md FCV-4): each op calls the generated model
//! that its step names, on the connection that model.connect opened. The three trial binaries include the models of the
//! bench set as `crate::model` and share this file. A model, a column or an op without an arm here fails its step by name.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use polyspec_orm::{Config, Db};
use polyspec_orm_tests::recipe::{ModelDispatcher, ModelFuture};
use serde_json::{json, Value};

use crate::model::{connect, Author, CompositeAccount, CompositeMembership};

/// The dispatcher of one case: the connections that model.connect opened, by name.
#[derive(Default)]
pub struct Models {
    connections: HashMap<String, Db>,
}

/// The factory that the recipe helper calls once for each case.
pub fn models() -> Box<dyn ModelDispatcher> {
    Box::new(Models::default())
}

/// The keys that the generated models of the bench set read their encrypted columns with (the native model tests use them).
fn bench_config() -> Config {
    Config { aes_key: "bench-salt".into(), blind_index_key: "bench-blind-index".into(), ..Default::default() }
}

impl ModelDispatcher for Models {
    fn connect<'a>(&'a mut self, name: &'a str, dsn: &'a str, pool_size: u32) -> ModelFuture<'a> {
        Box::pin(async move {
            let db = connect(dsn, pool_size, bench_config()).await.map_err(fail)?;
            self.connections.insert(name.to_owned(), db);
            Ok(json!({}))
        })
    }

    fn call<'a>(&'a mut self, op: &'a str, connection: &'a str, step: &'a Value) -> ModelFuture<'a> {
        Box::pin(async move {
            let Some(db) = self.connections.get(connection) else {
                return Err(format!("model op: connection {connection} is not bound by model.connect"));
            };
            run(db, op, step).await
        })
    }

    fn db(&self, name: &str) -> Option<Db> {
        self.connections.get(name).cloned()
    }

    fn close<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            for (_, db) in self.connections.drain() {
                db.close().await;
            }
        })
    }
}

/// The op of `step` on `db`: its fields, which the expect of the step compares.
async fn run(db: &Db, op: &str, step: &Value) -> Result<Value, String> {
    match op {
        "model.create" => set_account(db, &step["values"])?.create().await.map(|_| json!({})).map_err(fail),
        "model.creates" if step["model"] == "CompositeMembership" => {
            let rows = step["rows"].as_array().into_iter().flatten().map(|row| set_membership(db, row)).collect::<Result<Vec<_>, _>>()?;
            let count = membership(db).creates(rows, batch(step)?).await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        "model.creates" => {
            let rows = step["rows"].as_array().into_iter().flatten().map(|row| set_account(db, row)).collect::<Result<Vec<_>, _>>()?;
            let count = account(db).creates(rows, batch(step)?).await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        "model.save" => set_account(db, &step["values"])?.save().await.map(|_| json!({})).map_err(fail),
        "model.duplicate_create" => {
            let mut row = set_account(db, &step["values"])?.duplication(set_account(db, &step["duplication"])?);
            row.create().await.map(|_| json!({})).map_err(fail)
        }
        "model.update" => {
            let Some(mut row) = find_account(db, &step["key"]).await? else {
                return Err("model.update: the key names no row".to_owned());
            };
            for (column, value) in columns(&step["set"])? {
                if column != "name" {
                    return Err(format!("CompositeAccount column {column} has no recipe update"));
                }
                row = row.set_name(text(value)?);
            }
            row.update(false).await.map(|()| json!({})).map_err(fail)
        }
        "model.delete" => {
            let rows = filter_account(db, &step["where"])?.gets().await.map_err(fail)?;
            rows.delete(false).await.map(|()| json!({})).map_err(fail)
        }
        "model.count" if step["model"] == "Author" => {
            let count = author_chain(db, &step["where"], &[])?.get_count().await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        "model.count" if step["model"] == "CompositeMembership" => {
            let count = filter_membership(db, &step["where"])?.get_count().await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        "model.count" => {
            let count = filter_account(db, &step["where"])?.get_count().await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        "model.get_by" if step["model"] == "Author" && step.get("where").is_some() => {
            let wanted = names(&step["columns"]);
            let rows = match author_chain(db, &step["where"], &wanted)?.get().await.map_err(fail)? {
                None => Vec::new(),
                Some(row) => vec![cells(&wanted, |column| author_field(&row, column))?],
            };
            Ok(json!({ "rows": rows }))
        }
        "model.get_by" => {
            let wanted = names(&step["columns"]);
            let rows = if step["model"] == "Author" {
                match Author::new().connect(db).get_by_seq(int(&step["key"]["seq"])?).await.map_err(fail)? {
                    None => Vec::new(),
                    Some(row) => vec![cells(&wanted, |column| author_cell(&row, column))?],
                }
            } else {
                match find_account(db, &step["key"]).await? {
                    None => Vec::new(),
                    Some(row) => vec![cells(&wanted, |column| composite_cell(&row, column))?],
                }
            };
            Ok(json!({ "rows": rows }))
        }
        "model.query" if step["model"] == "Author" => author_query(db, step).await,
        "model.query" => {
            // A query with tuples and no where starts from the whole model; the tuples follow the equalities by and.
            let has_where = !step["where"].is_null();
            let mut query = if has_where { filter_account(db, &step["where"])? } else { account(db) };
            if !step["tuples"].is_null() {
                query = tuple_account(query, &step["tuples"], has_where)?;
            }
            for column in step["order"].as_array().into_iter().flatten() {
                query = match column.as_str() {
                    Some("tenant_id") => query.order_by_tenant_id_asc(),
                    Some("account_id") => query.order_by_account_id_asc(),
                    other => return Err(format!("CompositeAccount column {other:?} has no recipe order")),
                };
            }
            // The relation of a model.query (INT-87): each child row gives one output row, its columns after the parent's.
            let relation = &step["relation"];
            let mut child_columns = None;
            if !relation.is_null() {
                let child = membership_relation(relation, db)?;
                query = if relation["many"].as_bool() == Some(true) { query.relations(child) } else { query.relation(child) };
                child_columns = Some(names(&relation["columns"]));
            }
            // The lock of a model.query (INT-47): a lock outside a transaction is refused with CONFIG.
            if let Some(lock) = step["lock"].as_str() {
                query = match lock {
                    "update" => query.for_update(),
                    "share" => query.for_share(),
                    "update_nowait" => query.for_update_no_wait(),
                    "share_nowait" => query.for_share_no_wait(),
                    other => return Err(format!("lock {other} is not a lock of the recipe")),
                };
            }
            let collection = query.gets().await.map_err(fail)?;
            let wanted = names(&step["columns"]);
            let mut rows = Vec::new();
            for (_, row) in collection.iter() {
                let out = wanted.iter().map(|column| composite_cell(row, column)).collect::<Result<Vec<_>, _>>()?;
                let Some(columns) = &child_columns else {
                    rows.push(Value::Array(out));
                    continue;
                };
                // A parent with no child row gives none.
                for child in membership_children(row, relation)? {
                    let mut cells = out.clone();
                    for column in columns {
                        cells.push(membership_cell(child, column)?);
                    }
                    rows.push(Value::Array(cells));
                }
            }
            Ok(json!({ "rows": rows }))
        }
        "model.arithmetic" => {
            let column = step["column"].as_str().unwrap_or_default();
            if column != "read_count" {
                return Err(format!("Author column {column} has no recipe arithmetic"));
            }
            let Some(mut row) = Author::new().connect(db).get_by_seq(int(&step["key"]["seq"])?).await.map_err(fail)? else {
                return Err("model.arithmetic: the key names no row".to_owned());
            };
            let amount = i32::try_from(int(&step["amount"])?).map_err(|e| e.to_string())?;
            row = match step["operation"].as_str() {
                Some("plus") => row.plus_read_count(amount),
                Some("minus") => row.minus_read_count(amount),
                other => return Err(format!("the operation {other:?} is neither plus nor minus")),
            };
            row.update(false).await.map(|()| json!({})).map_err(fail)
        }
        other => Err(format!("OP_UNKNOWN {other}")),
    }
}

fn fail(error: polyspec_orm::Error) -> String {
    error.to_string()
}

fn account(db: &Db) -> CompositeAccount {
    CompositeAccount::new().connect(db)
}

/// A CompositeAccount with the columns of `values`, which are the setters of the recipe.
fn set_account(db: &Db, values: &Value) -> Result<CompositeAccount, String> {
    let mut row = account(db);
    for (column, value) in columns(values)? {
        row = match column.as_str() {
            "tenant_id" => row.set_tenant_id(int(value)?),
            "account_id" => row.set_account_id(int(value)?),
            "name" => row.set_name(text(value)?),
            other => return Err(format!("CompositeAccount column {other} has no recipe setter")),
        };
    }
    Ok(row)
}

/// The CompositeAccount filter of the equalities of `where`: tenant_id first, then account_id as the AND of the builder
/// (the generated name of the account_id filter is and_account_id, since the model has a field of that name).
fn filter_account(db: &Db, where_: &Value) -> Result<CompositeAccount, String> {
    let map = columns(where_)?;
    if let Some(column) = map.keys().find(|column| *column != "tenant_id" && *column != "account_id") {
        return Err(format!("CompositeAccount column {column} has no recipe filter"));
    }
    let mut query = account(db);
    if let Some(value) = map.get("tenant_id") {
        query = query.tenant_id(int(value)?);
    }
    if let Some(value) = map.get("account_id") {
        query = query.and_account_id(int(value)?);
    }
    Ok(query)
}

fn membership(db: &Db) -> CompositeMembership {
    CompositeMembership::new().connect(db)
}

/// A CompositeMembership with the columns of `values`, which are the setters of the recipe.
fn set_membership(db: &Db, values: &Value) -> Result<CompositeMembership, String> {
    let mut row = membership(db);
    for (column, value) in columns(values)? {
        row = match column.as_str() {
            "tenant_id" => row.set_tenant_id(int(value)?),
            "account_id" => row.set_account_id(int(value)?),
            "role" => row.set_role(text(value)?),
            other => return Err(format!("CompositeMembership column {other} has no recipe setter")),
        };
    }
    Ok(row)
}

/// The CompositeMembership filter of the equalities of `where`, which the recipe names by tenant_id only.
fn filter_membership(db: &Db, where_: &Value) -> Result<CompositeMembership, String> {
    let map = columns(where_)?;
    if let Some(column) = map.keys().find(|column| *column != "tenant_id") {
        return Err(format!("CompositeMembership column {column} has no recipe filter"));
    }
    let mut query = membership(db);
    if let Some(value) = map.get("tenant_id") {
        query = query.tenant_id(int(value)?);
    }
    Ok(query)
}

/// The tuple filter of a model.query on CompositeAccount: the tuple method of its composite key, joined by and to the
/// equalities before it when `after` is set.
fn tuple_account(query: CompositeAccount, tuples: &Value, after: bool) -> Result<CompositeAccount, String> {
    let key = names(&tuples["columns"]);
    if key != ["tenant_id", "account_id"] {
        return Err(format!("CompositeAccount tuple {key:?} has no recipe filter"));
    }
    let mut groups = Vec::new();
    for tuple in tuples["values"].as_array().into_iter().flatten() {
        match tuple.as_array().map(Vec::as_slice) {
            Some([tenant, account]) => groups.push((int(tenant)?, int(account)?)),
            _ => return Err(format!("a CompositeAccount tuple is not a pair: {tuple}")),
        }
    }
    let query = if after { query.and(()) } else { query };
    Ok(query.tuple_tenant_id_with_account_id(groups))
}

/// The CompositeMembership relation of a model.query on CompositeAccount: matched by its pairs in the written order, and
/// connected to the connection of the query when connect is true.
fn membership_relation(relation: &Value, db: &Db) -> Result<CompositeMembership, String> {
    if relation["model"] != "CompositeMembership" {
        return Err(format!("CompositeAccount relation {} has no recipe entry", relation["model"]));
    }
    let mut child = if relation["connect"].as_bool() == Some(true) { membership(db) } else { CompositeMembership::new() };
    for pair in relation["match"].as_array().into_iter().flatten() {
        let pair = names(pair);
        child = match pair.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
            ["tenant_id", "tenant_id"] => child.match_tenant_id_with_tenant_id(),
            ["account_id", "account_id"] => child.match_account_id_with_account_id(),
            other => return Err(format!("CompositeMembership match {other:?} has no recipe entry")),
        };
    }
    match relation["alias"].as_str() {
        None => Ok(child),
        Some("memberships") => Ok(child.alias_memberships()),
        Some(other) => Err(format!("CompositeMembership alias {other} has no recipe entry")),
    }
}

/// The CompositeMembership rows of one parent: through the generated getter of the alias, or of the result name of a
/// relation without one. A parent without a child gives none.
fn membership_children<'a>(row: &'a CompositeAccount, relation: &Value) -> Result<Vec<&'a CompositeMembership>, String> {
    let many = relation["many"].as_bool() == Some(true);
    Ok(match (relation["alias"].as_str(), many) {
        (Some("memberships"), _) => row.get_memberships().map_err(fail)?.map(|c| c.models().collect()).unwrap_or_default(),
        (_, true) => row.get_composite_membership_models().map_err(fail)?.map(|c| c.models().collect()).unwrap_or_default(),
        _ => row.get_composite_membership_model().map_err(fail)?.into_iter().collect(),
    })
}

/// The CompositeAccount row of a key with `tenant_id` and `account_id`, or None when no row has it.
async fn find_account(db: &Db, key: &Value) -> Result<Option<CompositeAccount>, String> {
    account(db).get_by_tenant_id_and_account_id(int(&key["tenant_id"])?, int(&key["account_id"])?).await.map_err(fail)
}

/// The Author chain of the equalities of `where`: the int equalities in name order, joined by and(()), then the bool equality
/// of is_close, which the generated chain cannot open with; then the projection of `columns`, when it names any.
fn author_chain(db: &Db, where_: &Value, columns: &[String]) -> Result<Author, String> {
    let (mut ints, mut bools) = (Vec::new(), Vec::new());
    for (column, wrapper) in columns_of(where_)? {
        if wrapper.get("bool").is_some() {
            bools.push((column.as_str(), wrapper["bool"].as_bool().ok_or_else(|| format!("{wrapper} is not a bool"))?));
        } else {
            ints.push((column.as_str(), int(wrapper)?));
        }
    }
    ints.sort_unstable();
    let mut author = Author::new().connect(db);
    for (index, &(column, value)) in ints.iter().enumerate() {
        if !matches!(column, "seq" | "user_seq" | "service_seq" | "service_region_seq" | "service_member_seq") {
            return Err(format!("Author column {column} has no recipe condition"));
        }
        if index > 0 {
            author = author.and(());
        }
        author = match column {
            "seq" => author.seq(value),
            "user_seq" => author.user_seq(value),
            "service_seq" => author.service_seq(value),
            "service_region_seq" => author.service_region_seq(value),
            _ => author.service_member_seq(value),
        };
    }
    for (column, value) in bools {
        if column != "is_close" || ints.is_empty() {
            return Err(format!("Author column {column}: a bool equality needs the is_close column after an int equality"));
        }
        author = author.and_is_close(value);
    }
    if !columns.is_empty() {
        author = author.remove_all_columns();
        for column in columns {
            author = match column.as_str() {
                "seq" => author.add_column_seq(),
                "name" => author.add_column_name(),
                other => return Err(format!("Author column {other} has no recipe column")),
            };
        }
    }
    Ok(author)
}

/// model.query on the Author model: the chain of `where`, the orders (a leading "-" is descending), the window when limit or
/// offset is greater than 0, and the projection of `columns`, each cell a recipe wrapper.
async fn author_query(db: &Db, step: &Value) -> Result<Value, String> {
    let wanted = names(&step["columns"]);
    let mut author = author_chain(db, &step["where"], &wanted)?;
    for order in step["order"].as_array().into_iter().flatten() {
        author = match order.as_str().unwrap_or_default() {
            "seq" => author.order_by_seq_asc(),
            "name" => author.order_by_name_asc(),
            "-seq" => author.order_by_seq_desc(),
            "-name" => author.order_by_name_desc(),
            other => return Err(format!("Author column {other} has no recipe order")),
        };
    }
    let window = |key: &str| match &step[key] {
        Value::Null => Ok(0),
        value => match value.as_u64().map(u32::try_from) {
            Some(Ok(n)) => Ok(n),
            _ => Err(format!("{key} is not a count: {value}")),
        },
    };
    let (limit, offset) = (window("limit")?, window("offset")?);
    if limit > 0 || offset > 0 {
        author = author.limit(offset, limit);
    }
    let collection = author.gets().await.map_err(fail)?;
    let rows = collection.iter().map(|(_, row)| cells(&wanted, |column| author_field(row, column))).collect::<Result<Vec<_>, _>>()?;
    Ok(json!({ "rows": rows }))
}

fn author_field(row: &Author, column: &str) -> Result<Value, String> {
    match column {
        "seq" => Ok(json!({ "int": row.get_seq().map_err(fail)?.to_string() })),
        "name" => Ok(json!({ "text": row.get_name().map_err(fail)? })),
        "read_count" => Ok(json!({ "int": row.get_read_count().map_err(fail)?.to_string() })),
        other => Err(format!("Author column {other} has no recipe getter")),
    }
}

fn author_cell(row: &Author, column: &str) -> Result<Value, String> {
    match column {
        "read_count" => Ok(json!({ "int": row.get_read_count().map_err(fail)?.to_string() })),
        other => Err(format!("Author column {other} has no recipe getter")),
    }
}

fn composite_cell(row: &CompositeAccount, column: &str) -> Result<Value, String> {
    match column {
        "tenant_id" => Ok(json!({ "int": row.get_tenant_id().map_err(fail)?.to_string() })),
        "account_id" => Ok(json!({ "int": row.get_account_id().map_err(fail)?.to_string() })),
        "name" => Ok(json!({ "text": row.get_name().map_err(fail)? })),
        other => Err(format!("CompositeAccount column {other} has no recipe getter")),
    }
}

fn membership_cell(row: &CompositeMembership, column: &str) -> Result<Value, String> {
    match column {
        "tenant_id" => Ok(json!({ "int": row.get_tenant_id().map_err(fail)?.to_string() })),
        "account_id" => Ok(json!({ "int": row.get_account_id().map_err(fail)?.to_string() })),
        "role" => Ok(json!({ "text": row.get_role().map_err(fail)? })),
        other => Err(format!("CompositeMembership column {other} has no recipe getter")),
    }
}

/// One row of the cells of `columns`, each read by `cell`.
fn cells(columns: &[String], cell: impl Fn(&str) -> Result<Value, String>) -> Result<Value, String> {
    columns.iter().map(|column| cell(column)).collect::<Result<Vec<_>, _>>().map(Value::Array)
}

fn names(array: &Value) -> Vec<String> {
    array.as_array().into_iter().flatten().filter_map(|name| name.as_str().map(str::to_owned)).collect()
}

fn columns_of(object: &Value) -> Result<Vec<(&String, &Value)>, String> {
    if object.is_null() {
        return Ok(Vec::new());
    }
    Ok(columns(object)?.iter().collect())
}

fn columns(object: &Value) -> Result<&serde_json::Map<String, Value>, String> {
    object.as_object().ok_or_else(|| format!("{object} is not an object of columns"))
}

fn int(wrapper: &Value) -> Result<i64, String> {
    let digits = wrapper["int"].as_str().ok_or_else(|| format!("{wrapper} is not an int wrapper"))?;
    digits.parse().map_err(|e: std::num::ParseIntError| format!("{wrapper}: {e}"))
}

fn text(wrapper: &Value) -> Result<String, String> {
    wrapper["text"].as_str().map(str::to_owned).ok_or_else(|| format!("{wrapper} is not a text wrapper"))
}

fn batch(step: &Value) -> Result<usize, String> {
    let count = step["batch"].as_u64().ok_or_else(|| "batch is not a count".to_owned())?;
    usize::try_from(count).map_err(|e| e.to_string())
}
