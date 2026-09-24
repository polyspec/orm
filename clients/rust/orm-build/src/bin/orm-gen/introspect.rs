//! Reads the tables of a live database from its catalog.

use std::collections::{BTreeSet, HashMap, HashSet};

use orm_build::live::{self, Check, Column, ForeignKey, Index, Table, NO_DEFAULT};
use orm_build::schema::Manifest;

use crate::db::{Conn, Rows};

fn err(e: sqlx::Error) -> String {
    e.to_string()
}

/// The tables of the connected database; `only` limits the tables.
pub async fn read_tables(conn: &mut Conn, driver: &str, only: Option<&HashSet<String>>) -> Result<Vec<Table>, String> {
    match driver {
        "postgres" => read_postgres(conn, only).await,
        "sqlite" => read_sqlite(conn, only).await,
        _ => read_mysql(conn, only).await,
    }
}

/// The manifest of the connected database, as a migration reads its source.
pub async fn live_manifest(conn: &mut Conn, driver: &str) -> Result<Manifest, String> {
    let tables = read_tables(conn, driver, None).await?;
    let bodies = trigger_bodies(conn, driver).await?;
    live::manifest(&tables, &bodies)
}

/// The bodies of the current schema's triggers that carry ORM markers.
pub async fn trigger_bodies(conn: &mut Conn, driver: &str) -> Result<Vec<String>, String> {
    let rows = conn.query(orm_build::triggers::trigger_bodies_query(driver), &[]).await.map_err(err)?;
    Ok(rows.iter().map(|r| r[0].text()).filter(|b| b.contains(orm_build::triggers::TRIGGER_MARKER)).collect())
}

/// The literal of an expression default such as DEFAULT ('x'), which MySQL
/// reports as _utf8mb4\\'x\\'; the expression text escapes the literal.
fn mysql_expression_literal(def: &str) -> Option<String> {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^_[A-Za-z0-9]+\\'(.*)\\'$").expect("mysql default pattern"));
    if let Some(caps) = RE.captures(def) {
        return Some(mysql_unescape(&mysql_unescape(&caps[1])));
    }
    orm_build::ddl::is_number(def).then(|| def.to_owned())
}

fn mysql_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// The expression of a pg_get_constraintdef CHECK definition.
pub fn postgres_check_expr(definition: &str) -> String {
    let expr = definition.trim();
    if expr.len() >= 5 && expr[..5].eq_ignore_ascii_case("CHECK") {
        expr[5..].trim().to_owned()
    } else {
        expr.to_owned()
    }
}

fn keep(only: Option<&HashSet<String>>, table: &str) -> bool {
    only.is_none_or(|o| o.contains(table))
}

fn finish(order: Vec<String>, mut by_name: HashMap<String, Table>) -> Vec<Table> {
    let sorted: BTreeSet<String> = order.into_iter().collect();
    sorted.into_iter().filter_map(|n| by_name.remove(&n)).collect()
}

fn column(by_name: &mut HashMap<String, Table>, order: &mut Vec<String>, table: &str, c: Column) {
    let t = by_name.entry(table.to_owned()).or_insert_with(|| {
        order.push(table.to_owned());
        Table { name: table.to_owned(), ..Default::default() }
    });
    t.columns.push(c);
}

fn add_foreign_key(t: &mut Table, name: &str, target: &str, action: String, column: &str, target_column: &str) {
    if t.foreign_keys.last().is_none_or(|fk| fk.name != name) {
        t.foreign_keys.push(ForeignKey { name: name.to_owned(), target: target.to_owned(), on_delete: action, ..Default::default() });
    }
    let fk = t.foreign_keys.last_mut().unwrap();
    fk.columns.push(column.to_owned());
    fk.target_columns.push(target_column.to_owned());
}

async fn read_mysql(conn: &mut Conn, only: Option<&HashSet<String>>) -> Result<Vec<Table>, String> {
    let rows: Rows = conn
        .query(
            "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_KEY, COLUMN_COMMENT
		FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION",
            &[],
        )
        .await
        .map_err(err)?;
    let mut by_name: HashMap<String, Table> = HashMap::new();
    let mut order = Vec::new();
    for r in rows {
        let table = r[0].text();
        if !keep(only, &table) {
            continue;
        }
        let mut c = Column {
            name: r[1].text(),
            typ: r[2].text(),
            nullable: r[3].text() == "YES",
            default: r[4].opt_text().unwrap_or_else(|| NO_DEFAULT.into()),
            extra: r[5].text(),
            key: r[6].text(),
            comment: r[7].text(),
        };
        if r[4].opt_text().is_some() && c.extra.contains("DEFAULT_GENERATED") {
            if let Some(literal) = mysql_expression_literal(&c.default) {
                c.default = literal;
                c.extra = c.extra.replacen("DEFAULT_GENERATED", "", 1).trim().to_owned();
            }
        }
        column(&mut by_name, &mut order, &table, c);
    }
    for r in conn.query("SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()", &[]).await.map_err(err)? {
        if let Some(t) = by_name.get_mut(&r[0].text()) {
            t.comment = r[1].text();
        }
    }
    let indexes = conn
        .query(
            "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
            &[],
        )
        .await
        .map_err(err)?;
    for r in indexes {
        let name = r[1].text();
        let Some(t) = by_name.get_mut(&r[0].text()) else { continue };
        if name == "PRIMARY" {
            continue;
        }
        let col = r[4].text();
        if let Some(last) = t.indexes.last_mut().filter(|ix| ix.name == name) {
            last.columns.push(col);
            continue;
        }
        t.indexes.push(Index { name, unique: r[2].int() == 0, fulltext: r[3].text() == "FULLTEXT", columns: vec![col] });
    }
    let fks = conn
        .query(
            "SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME,
		k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE
		FROM information_schema.KEY_COLUMN_USAGE k
		JOIN information_schema.REFERENTIAL_CONSTRAINTS r
		  ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
		WHERE k.TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
		ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
            &[],
        )
        .await
        .map_err(err)?;
    for r in fks {
        let Some(t) = by_name.get_mut(&r[0].text()) else { continue };
        add_foreign_key(t, &r[1].text(), &r[3].text(), live::import_delete_action(&r[5].text()), &r[2].text(), &r[4].text());
    }
    let checks = conn
        .query(
            "SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
		FROM information_schema.TABLE_CONSTRAINTS tc
		JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
		WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.CONSTRAINT_TYPE='CHECK'
		ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME",
            &[],
        )
        .await
        .map_err(err)?;
    for r in checks {
        let table = r[0].text();
        // DDL writes the physical name ck_<table>_<name>; import returns the declared name.
        let physical = r[1].text();
        let name = physical.strip_prefix(&format!("ck_{table}_")).map_or_else(|| physical.clone(), str::to_string);
        if let Some(t) = by_name.get_mut(&table) {
            t.checks.push(Check { name, expr: r[2].text() });
        }
    }
    Ok(finish(order, by_name))
}

async fn read_postgres(conn: &mut Conn, only: Option<&HashSet<String>>) -> Result<Vec<Table>, String> {
    let rows = conn
        .query(
            "SELECT c.table_name::text, c.column_name::text, c.data_type::text, c.character_maximum_length::int8,
		       c.numeric_precision::int8, c.numeric_scale::int8, c.datetime_precision::int8, c.udt_name::text,
		       c.is_nullable::text, c.column_default::text, c.is_identity::text, coalesce(d.description, '')
		  FROM information_schema.columns c
		  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
		  LEFT JOIN pg_catalog.pg_class cl ON cl.relname = c.table_name
		  LEFT JOIN pg_catalog.pg_description d ON d.objoid = cl.oid AND d.objsubid = c.ordinal_position
		 WHERE c.table_schema = current_schema()
		 ORDER BY c.table_name, c.ordinal_position",
            &[],
        )
        .await
        .map_err(err)?;
    let mut by_name: HashMap<String, Table> = HashMap::new();
    let mut order = Vec::new();
    for r in rows {
        let table = r[0].text();
        if !keep(only, &table) {
            continue;
        }
        let mut c = Column {
            name: r[1].text(),
            typ: live::pg_type_text(&r[2].text(), &r[7].text(), r[3].opt_int(), r[4].opt_int(), r[5].opt_int(), r[6].opt_int()),
            nullable: r[8].text() == "YES",
            comment: r[11].text(),
            default: NO_DEFAULT.into(),
            ..Default::default()
        };
        let default = r[9].opt_text();
        if r[10].text() == "YES" || default.as_deref().is_some_and(|d| d.starts_with("nextval(")) {
            c.extra = "auto_increment".into();
        } else if let Some(d) = default {
            c.default = live::pg_default_text(&d);
        }
        column(&mut by_name, &mut order, &table, c);
    }
    let comments = conn
        .query(
            "SELECT c.relname::text, coalesce(d.description, '')
		FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace AND n.nspname=current_schema()
		LEFT JOIN pg_catalog.pg_description d ON d.objoid=c.oid AND d.objsubid=0
		WHERE c.relkind='r'",
            &[],
        )
        .await
        .map_err(err)?;
    for r in comments {
        if let Some(t) = by_name.get_mut(&r[0].text()) {
            t.comment = r[1].text();
        }
    }
    let indexes = conn
        .query(
            "SELECT cl.relname::text AS table_name, ic.relname::text AS index_name, ix.indisunique, ix.indisprimary,
		       am.amname::text, a.attname::text, k.ord
		  FROM pg_class cl
		  JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = current_schema()
		  JOIN pg_index ix ON ix.indrelid = cl.oid
		  JOIN pg_class ic ON ic.oid = ix.indexrelid
		  JOIN pg_am am ON am.oid = ic.relam
		  JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
		  JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum
		 ORDER BY cl.relname, ic.relname, k.ord",
            &[],
        )
        .await
        .map_err(err)?;
    for r in indexes {
        let table = r[0].text();
        let Some(t) = by_name.get_mut(&table) else { continue };
        let col = r[5].text();
        if r[3].bool() {
            for c in t.columns.iter_mut().filter(|c| c.name == col) {
                c.key = "PRI".into();
            }
            continue;
        }
        let unique = r[2].bool();
        let name = live::postgres_logical_index_name(&table, &r[1].text(), unique);
        if let Some(last) = t.indexes.last_mut().filter(|ix| ix.name == name) {
            last.columns.push(col);
            continue;
        }
        t.indexes.push(Index { name, unique, fulltext: r[4].text() == "gin", columns: vec![col] });
    }
    let fks = conn
        .query(
            "SELECT child.relname::text, con.conname::text, ca.attname::text, parent.relname::text, pa.attname::text, con.confdeltype::text, ck.ord
		FROM pg_constraint con
		JOIN pg_class child ON child.oid=con.conrelid
		JOIN pg_namespace n ON n.oid=child.relnamespace AND n.nspname=current_schema()
		JOIN pg_class parent ON parent.oid=con.confrelid
		JOIN LATERAL unnest(con.conkey) WITH ORDINALITY ck(attnum, ord) ON true
		JOIN LATERAL unnest(con.confkey) WITH ORDINALITY pk(attnum, ord) ON pk.ord=ck.ord
		JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=ck.attnum
		JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=pk.attnum
		WHERE con.contype='f'
		ORDER BY child.relname, con.conname, ck.ord",
            &[],
        )
        .await
        .map_err(err)?;
    for r in fks {
        let Some(t) = by_name.get_mut(&r[0].text()) else { continue };
        add_foreign_key(t, &r[1].text(), &r[3].text(), live::postgres_delete_action(&r[5].text()), &r[2].text(), &r[4].text());
    }
    let checks = conn
        .query(
            "SELECT child.relname::text, con.conname::text, pg_get_constraintdef(con.oid)
		FROM pg_constraint con
		JOIN pg_class child ON child.oid=con.conrelid
		JOIN pg_namespace n ON n.oid=child.relnamespace AND n.nspname=current_schema()
		WHERE con.contype='c' ORDER BY child.relname, con.conname",
            &[],
        )
        .await
        .map_err(err)?;
    for r in checks {
        let expr = postgres_check_expr(&r[2].text());
        if let Some(t) = by_name.get_mut(&r[0].text()) {
            t.checks.push(Check { name: r[1].text(), expr });
        }
    }
    let gins = conn
        .query(
            "SELECT cl.relname::text, ic.relname::text, pg_get_indexdef(ic.oid)
		FROM pg_class cl
		JOIN pg_namespace n ON n.oid=cl.relnamespace AND n.nspname=current_schema()
		JOIN pg_index ix ON ix.indrelid=cl.oid
		JOIN pg_class ic ON ic.oid=ix.indexrelid
		JOIN pg_am am ON am.oid=ic.relam
		WHERE am.amname='gin'
		ORDER BY cl.relname, ic.relname",
            &[],
        )
        .await
        .map_err(err)?;
    for r in gins {
        let (table, name) = (r[0].text(), r[1].text());
        let Some(t) = by_name.get_mut(&table) else { continue };
        let columns = live::postgres_fulltext_columns(&r[2].text()).map_err(|e| format!("table {table} index {name}: {e}"))?;
        t.indexes.push(Index { name, unique: false, fulltext: true, columns });
    }
    Ok(finish(order, by_name))
}

fn sqlite_quote(s: &str) -> String {
    s.replace('\'', "''")
}

async fn read_sqlite(conn: &mut Conn, only: Option<&HashSet<String>>) -> Result<Vec<Table>, String> {
    let tables = conn
        .query(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'orm_schema_migrations' AND name <> 'orm_schema_comments' AND name <> 'orm__context' ORDER BY name",
            &[],
        )
        .await
        .map_err(err)?;
    let mut out = Vec::new();
    for r in tables {
        let name = r[0].text();
        if !keep(only, &name) {
            continue;
        }
        let create_sql = r[1].text();
        let mut t = Table { name: name.clone(), checks: live::sqlite_checks(&name, &create_sql)?, ..Default::default() };
        let qname = sqlite_quote(&name);
        let cols = conn.query(&format!("PRAGMA table_info('{qname}')"), &[]).await.map_err(|e| format!("table {name} columns: {e}"))?;
        for c in cols {
            let (column_name, pk) = (c[1].text(), c[5].int());
            let default = match c[4].opt_text() {
                None => NO_DEFAULT.into(),
                Some(d) if live::sqlite_clock_default(&d) => "CURRENT_TIMESTAMP".into(),
                Some(d) => d,
            };
            let auto = pk > 0 && live::sqlite_auto_increment(&create_sql, &column_name);
            t.columns.push(Column {
                name: column_name,
                typ: c[2].text(),
                nullable: c[3].int() == 0 && pk == 0,
                default,
                extra: if auto { "auto_increment".into() } else { String::new() },
                key: if pk > 0 { "PRI".into() } else { String::new() },
                ..Default::default()
            });
        }
        for ix in conn.query(&format!("PRAGMA index_list('{qname}')"), &[]).await.map_err(err)? {
            let (index_name, unique, origin) = (ix[1].text(), ix[2].int() != 0, ix[3].text());
            if origin == "pk" {
                continue;
            }
            let icols = conn.query(&format!("PRAGMA index_info('{}')", sqlite_quote(&index_name)), &[]).await.map_err(err)?;
            let logical = if unique { index_name.clone() } else { index_name.strip_prefix(&format!("{name}_")).unwrap_or(&index_name).to_owned() };
            let columns: Vec<String> = icols.iter().map(|c| c[2].text()).collect();
            if !columns.is_empty() {
                t.indexes.push(Index { name: logical, unique, fulltext: false, columns });
            }
        }
        let mut by_id: HashMap<i64, usize> = HashMap::new();
        for fk in conn.query(&format!("PRAGMA foreign_key_list('{qname}')"), &[]).await.map_err(err)? {
            let id = fk[0].int();
            let position = *by_id.entry(id).or_insert_with(|| {
                t.foreign_keys.push(ForeignKey {
                    name: format!("fk_{name}_{id}"),
                    target: fk[2].text(),
                    on_delete: live::import_delete_action(&fk[6].text()),
                    ..Default::default()
                });
                t.foreign_keys.len() - 1
            });
            t.foreign_keys[position].columns.push(fk[3].text());
            t.foreign_keys[position].target_columns.push(fk[4].text());
        }
        out.push(t);
    }
    match conn.query("SELECT table_name, column_name, comment FROM orm_schema_comments", &[]).await {
        Ok(comments) => {
            for c in comments {
                let (table, column, comment) = (c[0].text(), c[1].text(), c[2].text());
                let Some(t) = out.iter_mut().find(|t| t.name == table) else { continue };
                if column.is_empty() {
                    t.comment = comment;
                } else {
                    for col in t.columns.iter_mut().filter(|col| col.name == column) {
                        col.comment = comment.clone();
                    }
                }
            }
        }
        Err(e) if e.to_string().to_lowercase().contains("no such table") => {}
        Err(e) => return Err(format!("sqlite schema comments: {e}")),
    }
    Ok(out)
}
