//! Qualified native metadata; row identity is not mutation authorization.
use super::CatalogError;
use crate::tool_db::{Conn, QueryLimits, Rows, Val, P};

/// The column of one row of the column query of a server. MariaDB writes COLUMN_DEFAULT as SQL text, which the descriptor
/// reads in the MySQL form by the rule of the introspection (DIA-205); the query reads no EXTRA, and MariaDB writes no
/// DEFAULT_GENERATED.
fn column_of(row: &[Val], server: polyspec_orm_schema::dbspec::Server) -> Result<TableColumnMetadata, CatalogError> {
    if row.len() != 8 {
        return Err(format!("table_metadata_invalid: column shape of {} values", row.len()).into());
    }
    let mut column = TableColumnMetadata {
        name: text(&row[0])?,
        native_type: text(&row[1])?,
        nullable: row[2].bool().map_err(|e| e.to_string())?,
        generated: row[3].bool().map_err(|e| e.to_string())?,
        automatic_key: row[5].bool().map_err(|e| e.to_string())?,
        default_expression: match &row[6] {
            Val::Null => None,
            value => Some(text(value)?),
        },
        expression_default: row[7].bool().map_err(|e| e.to_string())?,
        check_precision: None,
    };
    if server == polyspec_orm_schema::dbspec::Server::MariaDb {
        (column.default_expression, column.expression_default) = polyspec_orm_schema::dbspec::mariadb_catalog_default(column.default_expression.take())
            .map_err(|error| format!("table_metadata_invalid: column {}: {error}", polyspec_orm_schema::message::Quoted(&column.name)))?;
    }
    Ok(column)
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TableRef {
    pub namespace: String,
    pub name: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum TableKind {
    Table,
    Partitioned,
    View,
    MaterializedView,
    Foreign,
    Virtual,
    Shadow,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TableColumnMetadata {
    pub name: String,
    pub native_type: String,
    pub nullable: bool,
    pub generated: bool,
    pub automatic_key: bool,
    pub default_expression: Option<String>,
    pub expression_default: bool,
    /// On SQLite, the fraction digits that the dbspec CHECK of a TIME or DATETIME column fixes; None when no CHECK fixes them
    /// and on the other dialects.
    pub check_precision: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TableMetadata {
    pub table: TableRef,
    pub kind: TableKind,
    pub columns: Vec<TableColumnMetadata>,
    pub primary_key: Vec<String>,
    pub reliable_row_identity: bool,
}
pub(super) fn validate_name(value: &str) -> Result<(), CatalogError> {
    if value.is_empty() || value.len() > 1024 || value.contains('\0') {
        return Err("table_reference_invalid: expected 1..1024 UTF-8 bytes without NUL".into());
    }
    Ok(())
}
fn text(value: &Val) -> Result<String, CatalogError> {
    match value {
        Val::Text(value) => Ok(value.clone()),
        _ => Err("table_metadata_invalid: expected text".into()),
    }
}
async fn rows(connection: &mut Conn, sql: &str, params: &[P]) -> Result<Rows, CatalogError> {
    connection
        .query_bounded(sql, params, QueryLimits { max_rows: 2048, max_bytes: 4 * 1024 * 1024 })
        .await
        .map_err(|error| CatalogError::caused(error.to_string(), error))
}
pub(super) async fn current_namespace(connection: &mut Conn, dialect: &str) -> Result<String, CatalogError> {
    if dialect == "sqlite" {
        return Ok("main".into());
    }
    let sql = match dialect {
        "mysql" => "SELECT DATABASE()",
        "postgres" => "SELECT current_schema()",
        _ => return Err("TABLE_DIALECT_UNSUPPORTED".into()),
    };
    let result = rows(connection, sql, &[]).await?;
    if result.len() != 1 || result[0].len() != 1 {
        return Err("TABLE_NAMESPACE_UNAVAILABLE".into());
    }
    let namespace = text(&result[0][0])?;
    validate_name(&namespace)?;
    Ok(namespace)
}
/// The server of a catalog connection of `dialect`, which a mysql connection reads once by `VERSION()` when it connects: a
/// version that contains `-MariaDB` is MariaDB, and any other is MySQL (DIA-201).
pub(super) async fn server(connection: &mut Conn, dialect: &str) -> Result<polyspec_orm_schema::dbspec::Server, CatalogError> {
    Ok(match dialect {
        "mysql" => {
            let result = rows(connection, "SELECT VERSION()", &[]).await?;
            if result.len() != 1 || result[0].len() != 1 {
                return Err("table_metadata_invalid: VERSION() returned no one value".into());
            }
            if text(&result[0][0])?.contains("-MariaDB") {
                polyspec_orm_schema::dbspec::Server::MariaDb
            } else {
                polyspec_orm_schema::dbspec::Server::MySql
            }
        }
        "postgres" => polyspec_orm_schema::dbspec::Server::Postgres,
        _ => polyspec_orm_schema::dbspec::Server::Sqlite,
    })
}
/// The descriptor of `table` on a connection of `dialect` whose server is `server` (DIA-201).
pub(super) async fn describe(
    connection: &mut Conn,
    dialect: &str,
    server: polyspec_orm_schema::dbspec::Server,
    table: &TableRef,
) -> Result<TableMetadata, CatalogError> {
    validate_name(&table.namespace)?;
    validate_name(&table.name)?;
    if dialect == "sqlite" && table.namespace != "main" {
        return Err("table_namespace_unsupported: SQLite requires main".into());
    }
    let params = [P::S(table.namespace.clone()), P::S(table.name.clone())];
    let kind_sql = match dialect {
        "mysql" => "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",
        "postgres" => "SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2",
        "sqlite" => "SELECT type FROM pragma_table_list WHERE schema=? AND name=?",
        _ => return Err("TABLE_DIALECT_UNSUPPORTED".into()),
    };
    let result = rows(connection, kind_sql, &params).await?;
    if result.is_empty() {
        return Err("TABLE_NOT_FOUND".into());
    }
    if result.len() != 1 || result[0].len() != 1 {
        return Err("table_metadata_invalid: ambiguous relation".into());
    }
    let native = text(&result[0][0])?;
    let kind = match (dialect, native.as_str()) {
        ("mysql", "BASE TABLE") | ("postgres", "r") | ("sqlite", "table") => TableKind::Table,
        ("mysql", "VIEW" | "SYSTEM VIEW") | ("postgres", "v") | ("sqlite", "view") => TableKind::View,
        ("postgres", "p") => TableKind::Partitioned,
        ("postgres", "m") => TableKind::MaterializedView,
        ("postgres", "f") => TableKind::Foreign,
        ("sqlite", "virtual") => TableKind::Virtual,
        ("sqlite", "shadow") => TableKind::Shadow,
        _ => return Err(format!("table_kind_unsupported: relation kind {} of {dialect}", polyspec_orm_schema::message::Quoted(&native)).into()),
    };
    let sql=match dialect {
        // The key ordinal is a subquery that names the table by constants: a join of KEY_COLUMN_USAGE opens every table of every
        // database on MariaDB, and the subquery none, with the same rows on both servers (DIA-210). It binds the table twice.
        // The native type is COLUMN_TYPE in the form of MySQL 8.4, which MariaDB writes with an integer display width (DIA-204).
        "mysql"=>"SELECT c.COLUMN_NAME,CASE WHEN c.COLUMN_TYPE='year(4)' THEN 'year' WHEN c.DATA_TYPE IN ('tinyint','smallint','mediumint','int','bigint') AND c.COLUMN_TYPE<>'tinyint(1)' AND c.COLUMN_TYPE NOT LIKE '%zerofill' AND LOCATE('(',c.COLUMN_TYPE)>0 THEN CONCAT(c.DATA_TYPE,SUBSTRING(c.COLUMN_TYPE,LOCATE(')',c.COLUMN_TYPE)+1)) ELSE c.COLUMN_TYPE END,c.IS_NULLABLE='YES',(c.GENERATION_EXPRESSION IS NOT NULL AND c.GENERATION_EXPRESSION<>''),COALESCE((SELECT k.ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE k WHERE k.TABLE_SCHEMA=? AND k.TABLE_NAME=? AND k.CONSTRAINT_NAME='PRIMARY' AND k.COLUMN_NAME=c.COLUMN_NAME),0),(c.EXTRA LIKE '%auto_increment%'),c.COLUMN_DEFAULT,(c.EXTRA LIKE '%DEFAULT_GENERATED%') FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA=? AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION",
        "postgres"=>"SELECT a.attname::text,format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,(a.attgenerated<>'' OR a.attidentity='a'),COALESCE(k.ord,0),(a.attidentity<>''),CASE WHEN length(a.attgenerated)=0 THEN pg_get_expr(d.adbin,d.adrelid) END,(d.adbin IS NOT NULL AND length(a.attgenerated)=0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord) ON k.attnum=a.attnum WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",
        "sqlite"=>"SELECT name,type,NOT \"notnull\",hidden<>0,pk,0,dflt_value,(dflt_value IS NOT NULL) FROM pragma_table_xinfo(?2,?1) ORDER BY cid",
        _=>unreachable!(),
    };
    let mysql_params = [params[0].clone(), params[1].clone(), params[0].clone(), params[1].clone()];
    let result = rows(connection, sql, if dialect == "mysql" { &mysql_params } else { &params }).await?;
    let mut columns = Vec::new();
    let mut keys = Vec::new();
    for row in result {
        let column = column_of(&row, server)?;
        if columns.iter().any(|c: &TableColumnMetadata| c.name == column.name) {
            return Err(format!("table_metadata_invalid: duplicate column {}", polyspec_orm_schema::message::Quoted(&column.name)).into());
        }
        let ordinal = row[4].int().map_err(|e| e.to_string())?;
        if ordinal < 0 {
            return Err("table_metadata_invalid: negative key ordinal".into());
        }
        if ordinal > 0 {
            keys.push((ordinal, columns.len()));
        }
        columns.push(column);
    }
    keys.sort_by_key(|key| key.0);
    for (index, key) in keys.iter().enumerate() {
        if key.0 != index as i64 + 1 {
            return Err("table_metadata_invalid: key order".into());
        }
    }
    if dialect == "sqlite" && kind == TableKind::Table && keys.len() == 1 && columns[keys[0].1].native_type.eq_ignore_ascii_case("INTEGER") {
        let indexes = rows(connection, "SELECT count(*) FROM pragma_index_list(?2,?1) WHERE origin='pk'", &params).await?;
        if indexes.len() != 1 || indexes[0].len() != 1 {
            return Err("table_metadata_invalid: primary index".into());
        }
        if indexes[0][0].int().map_err(|e| e.to_string())? == 0 {
            columns[keys[0].1].nullable = false;
            columns[keys[0].1].automatic_key = true;
        }
    }
    let reliable_row_identity =
        matches!(kind, TableKind::Table | TableKind::Partitioned) && !keys.is_empty() && keys.iter().all(|key| !columns[key.1].nullable);
    let primary_key = keys.iter().map(|key| columns[key.1].name.clone()).collect();
    let mut metadata = TableMetadata { table: table.clone(), kind, columns, primary_key, reliable_row_identity };
    let checks = super::temporal::sqlite_check_precisions(connection, &metadata, dialect).await?;
    for (column, check) in metadata.columns.iter_mut().zip(checks) {
        column.check_precision = check.map(|precision| precision as i64);
    }
    Ok(metadata)
}
