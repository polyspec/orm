//! The generated-model ops of the model_writes recipe (docs/spec/feature-coverage.md FCV-4): each op calls the generated model
//! that its step names, on the connection that model.connect opened. The test program includes the models of the bench
//! set as `crate::model`, and the modules of the recipe share this file. A model, a column or an op without an arm here fails its step by name.

use polyspec_orm::Db;
use polyspec_orm_tests::bench_models::{bench_config, bench_dispatcher, cells, columns, fail, int, names, text, BenchModels};
use polyspec_orm_tests::recipe::ModelDispatcher;
use polyspec_orm_tests::recipe::ModelError;
use polyspec_orm_tests::recipe_error::RecipeCode as _;
use serde_json::{json, Value};

use crate::model::{Author, CompositeAccount, CompositeMembership, RankedTask, SCHEMA};

/// The factory that the recipe helper calls once for each case.
pub fn models() -> Box<dyn ModelDispatcher> {
    bench_dispatcher(&SCHEMA, ModelWrites)
}

/// The ops of the model_writes recipe.
pub struct ModelWrites;

impl BenchModels for ModelWrites {
    async fn run(&self, db: &Db, op: &str, step: &Value) -> Result<Value, ModelError> {
        run(db, op, step).await
    }

    async fn run_unconnected(&self, op: &str, step: &Value) -> Result<Value, ModelError> {
        match op {
            "model.create" => assign_account(CompositeAccount::new(), &polyspec_orm_tests::recipe_reads::read(step, "values")["values"])?
                .create()
                .await
                .map(|_| json!({}))
                .map_err(fail),
            "model.count" => {
                let count = CompositeAccount::new().get_count().await.map_err(fail)?;
                Ok(json!({ "value": { "int": count.to_string() } }))
            }
            other => Err(format!("{other} has no unconnected form").into()),
        }
    }
}

/// The key of a CompositeAccount row of transaction.deadlock.
fn account_key(key: &Value) -> Result<(i64, i64), String> {
    Ok((int(&key["tenant_id"])?, int(&key["account_id"])?))
}

/// Writes `name` to the name column of the row of `key` on `db`, a read and then an update.
async fn write_account_name(db: &Db, key: (i64, i64), name: &str) -> polyspec_orm::Result<()> {
    let row = account(db).get_by_tenant_id_and_account_id(key.0, key.1).await?;
    let row = row.ok_or_else(|| polyspec_orm::Error::config(format!("composite_account {key:?} is missing")))?;
    row.set_name(name).update(false).await?;
    Ok(())
}

/// Two flows write two rows in opposite order (PLN-24), each on its own thread and connection: each holds its first row until
/// the other holds its own, so the database ends one flow with its deadlock error, the client retries it, and both commit.
async fn transaction_deadlock(db: &Db, step: &Value) -> Result<Value, ModelError> {
    if polyspec_orm_tests::recipe_reads::read(step, "column")["column"] != "name" {
        return Err(format!("CompositeAccount column {} has no recipe deadlock", polyspec_orm_tests::recipe_reads::read(step, "column")["column"]).into());
    }
    let dsn = polyspec_orm_tests::recipe_reads::read(step, "dsn")["dsn"].as_str().ok_or_else(|| "transaction.deadlock has no dsn".to_owned())?.to_owned();
    let keys = [
        account_key(&polyspec_orm_tests::recipe_reads::read(step, "rows")["rows"][0])?,
        account_key(&polyspec_orm_tests::recipe_reads::read(step, "rows")["rows"][1])?,
    ];
    let held = std::sync::Arc::new(std::sync::Barrier::new(2));
    let flows: Vec<_> = [0, 1]
        .into_iter()
        .map(|index: usize| {
            let (held, dsn) = (held.clone(), dsn.clone());
            std::thread::spawn(move || -> Result<(u64, u64), ModelError> {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| error.to_string())?;
                runtime.block_on(async move {
                    let conn = Db::connect_schema(&dsn, &SCHEMA, 1, bench_config()).await.map_err(fail)?;
                    let name = format!("flow-{index}");
                    let attempts = std::cell::Cell::new(0_u64);
                    let deadlocks = std::cell::Cell::new(0_u64);
                    let result: polyspec_orm::Result<()> = conn
                        .transaction(async || {
                            attempts.set(attempts.get() + 1);
                            let first_attempt = attempts.get() == 1;
                            let first = write_account_name(&conn, keys[index], &name).await;
                            if first_attempt {
                                held.wait();
                            }
                            first?;
                            let second = write_account_name(&conn, keys[1 - index], &name).await;
                            if first_attempt && second.as_ref().is_err_and(|error| error.code() == "DEADLOCK") {
                                deadlocks.set(1);
                            }
                            second
                        })
                        .isolation(polyspec_orm::Isolation::ReadCommitted)
                        .retry(3)
                        .await;
                    conn.close().await;
                    result.map_err(fail)?;
                    Ok((attempts.get(), deadlocks.get()))
                })
            })
        })
        .collect();
    let (mut attempts, mut deadlocks) = (0, 0);
    for flow in flows {
        let (flow_attempts, flow_deadlocks) = flow.join().map_err(|panic| polyspec_orm_tests::recipe::panicked("a flow thread", &*panic))??;
        attempts += flow_attempts;
        deadlocks += flow_deadlocks;
    }
    let mut names = Vec::new();
    for key in keys {
        let row = account(db).get_by_tenant_id_and_account_id(key.0, key.1).await.map_err(fail)?;
        let row = row.ok_or_else(|| format!("composite_account {key:?} is missing"))?;
        names.push(row.get_name().map_err(fail)?.to_owned());
    }
    let same_flow = names[0] == names[1] && (names[0] == "flow-0" || names[0] == "flow-1");
    Ok(json!({ "attempts": attempts, "deadlocks": deadlocks, "same_flow": same_flow }))
}

/// model.create and model.count of RankedTask, whose order column the application writes (DBS-79).
async fn ranked_task(db: &Db, op: &str, step: &Value) -> Result<Value, ModelError> {
    if op == "model.count" {
        let filter = &polyspec_orm_tests::recipe_reads::read(step, "where")["where"];
        if !filter.is_null() && filter.as_object().is_none_or(|filter| !filter.is_empty()) {
            return Err(format!("RankedTask where {filter} has no recipe entry").into());
        }
        let count = RankedTask::new().connect(db).get_count().await.map_err(fail)?;
        return Ok(json!({ "value": { "int": count.to_string() } }));
    }
    let mut row = RankedTask::new().connect(db);
    for (column, value) in columns(&polyspec_orm_tests::recipe_reads::read(step, "values")["values"])? {
        row = match column.as_str() {
            "title" => row.set_title(text(value)?),
            "position" => row.set_position(i32::try_from(int(value)?).map_err(|e| format!("RankedTask position {value}: {e}"))?),
            other => return Err(format!("RankedTask column {other} has no recipe entry").into()),
        };
    }
    row.create().await.map(|_| json!({})).map_err(fail)
}

/// The op of `step` on `db`: its fields, which the expect of the step compares.
async fn run(db: &Db, op: &str, step: &Value) -> Result<Value, ModelError> {
    match op {
        "transaction.deadlock" => transaction_deadlock(db, step).await,
        "model.create" | "model.count" if polyspec_orm_tests::recipe_reads::read(step, "model")["model"] == "RankedTask" => ranked_task(db, op, step).await,
        "model.create" => set_account(db, &polyspec_orm_tests::recipe_reads::read(step, "values")["values"])?.create().await.map(|_| json!({})).map_err(fail),
        "model.creates" if polyspec_orm_tests::recipe_reads::read(step, "model")["model"] == "CompositeMembership" => {
            let rows = polyspec_orm_tests::recipe_reads::read(step, "rows")["rows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|row| set_membership(db, row))
                .collect::<Result<Vec<_>, _>>()?;
            let count = membership(db).creates(rows, batch(step)?).await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        "model.creates" => {
            let rows = polyspec_orm_tests::recipe_reads::read(step, "rows")["rows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|row| set_account(db, row))
                .collect::<Result<Vec<_>, _>>()?;
            let count = account(db).creates(rows, batch(step)?).await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        // A set of the key and the named columns, with no read before it, then one save.
        "model.save" if polyspec_orm_tests::recipe_reads::read(step, "model")["model"] == "Author" => {
            let values = &polyspec_orm_tests::recipe_reads::read(step, "values")["values"];
            Author::new().connect(db).set_seq(int(&values["seq"])?).set_name(text(&values["name"])?).save().await.map(|_| json!({})).map_err(fail)
        }
        "model.save" => set_account(db, &polyspec_orm_tests::recipe_reads::read(step, "values")["values"])?.save().await.map(|_| json!({})).map_err(fail),
        "model.duplicate_create" => {
            let mut row = set_account(db, &polyspec_orm_tests::recipe_reads::read(step, "values")["values"])?
                .duplication(set_account(db, &polyspec_orm_tests::recipe_reads::read(step, "duplication")["duplication"])?);
            row.create().await.map(|_| json!({})).map_err(fail)
        }
        "model.update" => {
            let Some(mut row) = find_account(db, &polyspec_orm_tests::recipe_reads::read(step, "key")["key"]).await? else {
                return Err("model.update: the key names no row".to_owned().into());
            };
            for (column, value) in columns(&polyspec_orm_tests::recipe_reads::read(step, "set")["set"])? {
                if column != "name" {
                    return Err(format!("CompositeAccount column {column} has no recipe update").into());
                }
                row = row.set_name(text(value)?);
            }
            row.update(false).await.map_err(fail)?;
            Ok(affected(db))
        }
        "model.delete" => {
            let rows = filter_account(db, &polyspec_orm_tests::recipe_reads::read(step, "where")["where"])?.gets().await.map_err(fail)?;
            rows.delete(false).await.map_err(fail)?;
            Ok(affected(db))
        }
        "model.count" if polyspec_orm_tests::recipe_reads::read(step, "model")["model"] == "Author" => {
            let count = author_chain(db, &polyspec_orm_tests::recipe_reads::read(step, "where")["where"], &[])?.get_count().await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        "model.count" if polyspec_orm_tests::recipe_reads::read(step, "model")["model"] == "CompositeMembership" => {
            let count = filter_membership(db, &polyspec_orm_tests::recipe_reads::read(step, "where")["where"])?.get_count().await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        "model.count" => {
            let count = filter_account(db, &polyspec_orm_tests::recipe_reads::read(step, "where")["where"])?.get_count().await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        "model.get_by"
            if polyspec_orm_tests::recipe_reads::read(step, "model")["model"] == "Author"
                && polyspec_orm_tests::recipe_reads::read(step, "where").get("where").is_some() =>
        {
            let wanted = names(&polyspec_orm_tests::recipe_reads::read(step, "columns")["columns"]);
            let rows = match author_chain(db, &polyspec_orm_tests::recipe_reads::read(step, "where")["where"], &wanted)?.get().await.map_err(fail)? {
                None => Vec::new(),
                Some(row) => vec![cells(&wanted, |column| author_field(&row, column))?],
            };
            Ok(json!({ "rows": rows }))
        }
        "model.get_by" => {
            let wanted = names(&polyspec_orm_tests::recipe_reads::read(step, "columns")["columns"]);
            let rows = if polyspec_orm_tests::recipe_reads::read(step, "model")["model"] == "Author" {
                match Author::new().connect(db).get_by_seq(int(&polyspec_orm_tests::recipe_reads::read(step, "key")["key"]["seq"])?).await.map_err(fail)? {
                    None => Vec::new(),
                    Some(row) => vec![cells(&wanted, |column| author_field(&row, column))?],
                }
            } else {
                match find_account(db, &polyspec_orm_tests::recipe_reads::read(step, "key")["key"]).await? {
                    None => Vec::new(),
                    Some(row) => vec![cells(&wanted, |column| composite_cell(&row, column))?],
                }
            };
            Ok(json!({ "rows": rows }))
        }
        "model.query" if polyspec_orm_tests::recipe_reads::read(step, "model")["model"] == "Author" => author_query(db, step).await,
        "model.query" => {
            // A query with tuples and no where starts from the whole model; the tuples follow the equalities by and.
            let has_where = !polyspec_orm_tests::recipe_reads::read(step, "where")["where"].is_null();
            let mut query = if has_where { filter_account(db, &polyspec_orm_tests::recipe_reads::read(step, "where")["where"])? } else { account(db) };
            if !polyspec_orm_tests::recipe_reads::read(step, "tuples")["tuples"].is_null() {
                query = tuple_account(query, &polyspec_orm_tests::recipe_reads::read(step, "tuples")["tuples"], has_where)?;
            }
            for column in polyspec_orm_tests::recipe_reads::read(step, "order")["order"].as_array().into_iter().flatten() {
                query = match column.as_str() {
                    Some("tenant_id") => query.order_by_tenant_id_asc(),
                    Some("account_id") => query.order_by_account_id_asc(),
                    other => return Err(format!("CompositeAccount column {other:?} has no recipe order").into()),
                };
            }
            // The relation of a model.query (INT-87): each child row gives one output row, its columns after the parent's.
            let relation = &polyspec_orm_tests::recipe_reads::read(step, "relation")["relation"];
            let mut child_columns = None;
            if !relation.is_null() {
                let child: CompositeMembership = membership_relation(relation, db)?;
                query = match (relation["many"].as_bool() == Some(true), relation["alias"].as_str()) {
                    (true, Some("memberships")) => query.relations(child.alias_memberships()),
                    (_, Some(other)) => return Err(format!("CompositeMembership alias {other} has no recipe entry").into()),
                    (true, None) => query.relations(child),
                    (false, None) => query.relation(child),
                };
                child_columns = Some(names(&relation["columns"]));
            }
            // The lock of a model.query (INT-47): a lock outside a transaction is refused with CONFIG.
            if let Some(lock) = polyspec_orm_tests::recipe_reads::read(step, "lock")["lock"].as_str() {
                query = match lock {
                    "update" => query.for_update(),
                    "share" => query.for_share(),
                    "update_nowait" => query.for_update_no_wait(),
                    "share_nowait" => query.for_share_no_wait(),
                    other => return Err(format!("lock {other} is not a lock of the recipe").into()),
                };
            }
            let collection = query.gets().await.map_err(fail)?;
            let wanted = names(&polyspec_orm_tests::recipe_reads::read(step, "columns")["columns"]);
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
            let column = polyspec_orm_tests::recipe_reads::read(step, "column")["column"].as_str().unwrap_or_default();
            if column != "read_count" {
                return Err(format!("Author column {column} has no recipe arithmetic").into());
            }
            let Some(mut row) =
                Author::new().connect(db).get_by_seq(int(&polyspec_orm_tests::recipe_reads::read(step, "key")["key"]["seq"])?).await.map_err(fail)?
            else {
                return Err("model.arithmetic: the key names no row".to_owned().into());
            };
            let amount = i32::try_from(int(&polyspec_orm_tests::recipe_reads::read(step, "amount")["amount"])?).map_err(|e| e.to_string())?;
            row = match polyspec_orm_tests::recipe_reads::read(step, "operation")["operation"].as_str() {
                Some("plus") => row.plus_read_count(amount),
                Some("minus") => row.minus_read_count(amount),
                other => return Err(format!("the operation {other:?} is neither plus nor minus").into()),
            };
            row.update(false).await.map(|()| json!({})).map_err(fail)
        }
        other => Err(format!("OP_UNKNOWN {other}").into()),
    }
}

/// The affected count of the last write on db, the value that the expect of a model write names (F15, PRT-59).
fn affected(db: &Db) -> Value {
    json!({ "value": { "int": polyspec_orm::testing::last_affected(db).unwrap_or_default().to_string() } })
}

fn account(db: &Db) -> CompositeAccount {
    CompositeAccount::new().connect(db)
}

/// A CompositeAccount with the columns of `values`, which are the setters of the recipe.
fn set_account(db: &Db, values: &Value) -> Result<CompositeAccount, String> {
    assign_account(account(db), values)
}

/// `row` with the columns of `values`.
fn assign_account(mut row: CompositeAccount, values: &Value) -> Result<CompositeAccount, String> {
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
    Ok(child)
}

/// The CompositeMembership rows of one parent: through the generated getter of the alias, or of the result name of a
/// relation without one. A parent without a child gives none.
fn membership_children<'a>(row: &'a CompositeAccount, relation: &Value) -> Result<Vec<&'a CompositeMembership>, ModelError> {
    let many = relation["many"].as_bool() == Some(true);
    Ok(match (relation["alias"].as_str(), many) {
        (Some("memberships"), _) => row.get_memberships().map_err(fail)?.map(|c| c.models().collect()).unwrap_or_default(),
        (_, true) => row.get_composite_membership_models().map_err(fail)?.map(|c| c.models().collect()).unwrap_or_default(),
        _ => row.get_composite_membership_model().map_err(fail)?.into_iter().collect(),
    })
}

/// The CompositeAccount row of a key with `tenant_id` and `account_id`, or None when no row has it.
async fn find_account(db: &Db, key: &Value) -> Result<Option<CompositeAccount>, ModelError> {
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
                "aes_key_version" => author.add_column_aes_key_version(),
                "aes_hex_email" => author.add_column_aes_hex_email(),
                "aes_hex_phone" => author.add_column_aes_hex_phone(),
                other => return Err(format!("Author column {other} has no recipe column")),
            };
        }
    }
    Ok(author)
}

/// model.query on the Author model: the chain of `where`, the orders (a leading "-" is descending), the window when limit or
/// offset is greater than 0, and the projection of `columns`, each cell a recipe wrapper.
async fn author_query(db: &Db, step: &Value) -> Result<Value, ModelError> {
    let wanted = names(&polyspec_orm_tests::recipe_reads::read(step, "columns")["columns"]);
    let mut author = author_chain(db, &polyspec_orm_tests::recipe_reads::read(step, "where")["where"], &wanted)?;
    for order in polyspec_orm_tests::recipe_reads::read(step, "order")["order"].as_array().into_iter().flatten() {
        author = match order.as_str().unwrap_or_default() {
            "seq" => author.order_by_seq_asc(),
            "name" => author.order_by_name_asc(),
            "-seq" => author.order_by_seq_desc(),
            "-name" => author.order_by_name_desc(),
            other => return Err(format!("Author column {other} has no recipe order").into()),
        };
    }
    let window = |key: &str| match &polyspec_orm_tests::recipe_reads::read(step, key)[key] {
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

/// The recipe wrapper of a nullable text cell.
fn optional_text(cell: Option<&str>) -> Value {
    match cell {
        Some(text) => json!({ "text": text }),
        None => json!({ "null": "text" }),
    }
}

fn author_field(row: &Author, column: &str) -> Result<Value, ModelError> {
    match column {
        "seq" => Ok(json!({ "int": row.get_seq().map_err(fail)?.to_string() })),
        "name" => Ok(json!({ "text": row.get_name().map_err(fail)? })),
        "read_count" => Ok(json!({ "int": row.get_read_count().map_err(fail)?.to_string() })),
        "user_seq" => Ok(json!({ "int": row.get_user_seq().map_err(fail)?.to_string() })),
        "aes_key_version" => Ok(json!({ "int": row.get_aes_key_version().map_err(fail)?.to_string() })),
        "aes_hex_email" => Ok(optional_text(row.get_aes_hex_email().map_err(fail)?)),
        "aes_hex_phone" => Ok(optional_text(row.get_aes_hex_phone().map_err(fail)?)),
        other => Err(format!("Author column {other} has no recipe getter").into()),
    }
}

fn composite_cell(row: &CompositeAccount, column: &str) -> Result<Value, ModelError> {
    match column {
        "tenant_id" => Ok(json!({ "int": row.get_tenant_id().map_err(fail)?.to_string() })),
        "account_id" => Ok(json!({ "int": row.get_account_id().map_err(fail)?.to_string() })),
        "name" => Ok(json!({ "text": row.get_name().map_err(fail)? })),
        other => Err(format!("CompositeAccount column {other} has no recipe getter").into()),
    }
}

fn membership_cell(row: &CompositeMembership, column: &str) -> Result<Value, ModelError> {
    match column {
        "tenant_id" => Ok(json!({ "int": row.get_tenant_id().map_err(fail)?.to_string() })),
        "account_id" => Ok(json!({ "int": row.get_account_id().map_err(fail)?.to_string() })),
        "role" => Ok(json!({ "text": row.get_role().map_err(fail)? })),
        other => Err(format!("CompositeMembership column {other} has no recipe getter").into()),
    }
}

fn columns_of(object: &Value) -> Result<Vec<(&String, &Value)>, String> {
    if object.is_null() {
        return Ok(Vec::new());
    }
    Ok(columns(object)?.iter().collect())
}

fn batch(step: &Value) -> Result<usize, String> {
    let count = polyspec_orm_tests::recipe_reads::read(step, "batch")["batch"].as_u64().ok_or_else(|| "batch is not a count".to_owned())?;
    usize::try_from(count).map_err(|e| e.to_string())
}
