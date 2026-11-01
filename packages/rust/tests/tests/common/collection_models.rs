//! The model ops of the collection recipe, tests/collection/collection.json (docs/spec/feature-coverage.md FCV-4), on the
//! generated bench models. A collection trial binary includes this file after `polyspec_orm::models!()`, so `crate::model`
//! names the generated models. Each model name maps to its generated model, its setters and its primary key, in a switch.

use polyspec_orm::{Config, Db, Model, Val};
use polyspec_orm_tests::recipe::{Count, Models, PageInfo, Query};

use crate::model::{self, Account, Author, CompositeAccount};

/// The rows of model.creates are inserted in batches of this size (INT-35).
const CREATES_BATCH: usize = 100;

/// The dispatcher of the collection trials: each model op calls the generated model of its name.
pub struct BenchModels;

fn config(message: String) -> polyspec_orm::Error {
    polyspec_orm::Error::Config(message)
}

fn unknown_model(name: &str) -> polyspec_orm::Error {
    config(format!("MODEL_UNKNOWN {name}"))
}

fn int(value: &Val, column: &str) -> polyspec_orm::Result<i64> {
    match value {
        Val::I64(n) => Ok(*n),
        _ => Err(config(format!("column {column} takes an int"))),
    }
}

fn text(value: &Val, column: &str) -> polyspec_orm::Result<String> {
    match value {
        Val::Str(s) => Ok(s.clone()),
        _ => Err(config(format!("column {column} takes a text"))),
    }
}

fn no_column(model: &str, column: &str) -> polyspec_orm::Error {
    config(format!("model {model} has no column {column}"))
}

/// The values of the named columns of a model, in order.
fn cells<M: Model>(m: &M, names: &[impl AsRef<str>]) -> polyspec_orm::Result<Vec<Val>> {
    names.iter().map(|name| m.value(name.as_ref()).ok_or_else(|| config(format!("{} is not a column", name.as_ref())))).collect()
}

fn account_row(row: Vec<(String, Val)>) -> polyspec_orm::Result<Account> {
    let mut m = Account::new();
    for (column, value) in row {
        m = match column.as_str() {
            "seq" => m.set_seq(int(&value, &column)?),
            "name" => m.set_name(text(&value, &column)?),
            other => return Err(no_column("account", other)),
        };
    }
    Ok(m)
}

fn author_row(row: Vec<(String, Val)>) -> polyspec_orm::Result<Author> {
    let mut m = Author::new();
    for (column, value) in row {
        m = match column.as_str() {
            "seq" => m.set_seq(int(&value, &column)?),
            "name" => m.set_name(text(&value, &column)?),
            other => return Err(no_column("author", other)),
        };
    }
    Ok(m)
}

fn composite_account_row(row: Vec<(String, Val)>) -> polyspec_orm::Result<CompositeAccount> {
    let mut m = CompositeAccount::new();
    for (column, value) in row {
        m = match column.as_str() {
            "tenant_id" => m.set_tenant_id(int(&value, &column)?),
            "account_id" => m.set_account_id(int(&value, &column)?),
            "name" => m.set_name(text(&value, &column)?),
            other => return Err(no_column("composite_account", other)),
        };
    }
    Ok(m)
}

/// The primary key columns of a model, which a model.query of the recipe returns as its keys.
fn primary_key(name: &str) -> polyspec_orm::Result<&'static [&'static str]> {
    match name {
        "account" | "author" => Ok(&["seq"]),
        "composite_account" => Ok(&["tenant_id", "account_id"]),
        other => Err(unknown_model(other)),
    }
}

/// model.query: gets when page is None, gets_page otherwise. The primary key values come first, then the selected columns.
async fn read<M: Model>(proto: M, keys: &[&str], columns: &[String], page: Option<(u32, u32)>) -> polyspec_orm::Result<Query> {
    match page {
        None => {
            let all = polyspec_orm::model::gets(&proto).await?;
            let keys = all.models().map(|m| cells(m, keys)).collect::<polyspec_orm::Result<Vec<_>>>()?;
            let rows = all.models().map(|m| cells(m, columns)).collect::<polyspec_orm::Result<Vec<_>>>()?;
            Ok(Query { keys, rows, page: None })
        }
        Some((page, per_page)) => {
            let found = polyspec_orm::model::gets_page(&proto, page, per_page).await?;
            let rows = found.items.models().map(|m| cells(m, columns)).collect::<polyspec_orm::Result<Vec<_>>>()?;
            let info = PageInfo { page: i64::from(found.page), per_page: i64::from(found.per_page), total_count: found.total_count, total_pages: found.total_pages };
            Ok(Query { keys: Vec::new(), rows, page: Some(info) })
        }
    }
}

/// model.count: get_count when group is empty, gets_count grouped by its columns otherwise.
async fn tally<M: Model>(proto: M, group: &[String]) -> polyspec_orm::Result<Count> {
    if group.is_empty() {
        return Ok(Count::Total(polyspec_orm::model::get_count(proto.core()).await?));
    }
    let mut proto = proto;
    for column in group {
        proto.core_mut().group_by(column);
    }
    let groups = polyspec_orm::model::gets_count(&proto).await?;
    let mut out = Vec::with_capacity(groups.len());
    for row in groups.iter() {
        let values = group.iter().map(|column| row.value(column).cloned()).collect::<polyspec_orm::Result<Vec<_>>>()?;
        out.push((values, row.count()));
    }
    Ok(Count::Groups(out))
}

impl Models for BenchModels {
    async fn connect(&self, dsn: &str, pool_size: u32) -> polyspec_orm::Result<Db> {
        model::connect(dsn, pool_size, Config::default()).await
    }

    async fn creates(&self, db: &Db, model: &str, rows: Vec<Vec<(String, Val)>>) -> polyspec_orm::Result<u64> {
        match model {
            "account" => {
                let rows = rows.into_iter().map(account_row).collect::<polyspec_orm::Result<Vec<_>>>()?;
                Account::new().connect(db).creates(rows, CREATES_BATCH).await
            }
            "author" => {
                let rows = rows.into_iter().map(author_row).collect::<polyspec_orm::Result<Vec<_>>>()?;
                Author::new().connect(db).creates(rows, CREATES_BATCH).await
            }
            "composite_account" => {
                let rows = rows.into_iter().map(composite_account_row).collect::<polyspec_orm::Result<Vec<_>>>()?;
                CompositeAccount::new().connect(db).creates(rows, CREATES_BATCH).await
            }
            other => Err(unknown_model(other)),
        }
    }

    async fn query(&self, db: &Db, model: &str, columns: &[String], page: Option<(u32, u32)>) -> polyspec_orm::Result<Query> {
        let keys = primary_key(model)?;
        match model {
            "account" => read(Account::new().connect(db), keys, columns, page).await,
            "author" => read(Author::new().connect(db), keys, columns, page).await,
            "composite_account" => read(CompositeAccount::new().connect(db), keys, columns, page).await,
            other => Err(unknown_model(other)),
        }
    }

    async fn count(&self, db: &Db, model: &str, group: &[String]) -> polyspec_orm::Result<Count> {
        match model {
            "account" => tally(Account::new().connect(db), group).await,
            "author" => tally(Author::new().connect(db), group).await,
            "composite_account" => tally(CompositeAccount::new().connect(db), group).await,
            other => Err(unknown_model(other)),
        }
    }
}
