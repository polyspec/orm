//! Qualified native metadata; row identity is not mutation authorization.
use crate::tool_db::{Conn, QueryLimits, Rows, Val, P};

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
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TableMetadata {
    pub table: TableRef,
    pub kind: TableKind,
    pub columns: Vec<TableColumnMetadata>,
    pub primary_key: Vec<String>,
    pub reliable_row_identity: bool,
}
pub(super) fn validate_name(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 1024 || value.contains('\0') {
        return Err("TABLE_REFERENCE_INVALID: expected 1..1024 UTF-8 bytes without NUL".into());
    }
    Ok(())
}
fn text(value: &Val) -> Result<String, String> {
    match value {
        Val::Text(value) => Ok(value.clone()),
        _ => Err("TABLE_METADATA_INVALID: expected text".into()),
    }
}
async fn rows(connection: &mut Conn, sql: &str, params: &[P]) -> Result<Rows, String> {
    connection.query_bounded(sql, params, QueryLimits { max_rows: 2048, max_bytes: 4 * 1024 * 1024 }).await.map_err(|e| e.to_string())
}
pub(super) async fn current_namespace(connection: &mut Conn, dialect: &str) -> Result<String, String> {
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
pub(super) async fn describe(connection: &mut Conn, dialect: &str, table: &TableRef) -> Result<TableMetadata, String> {
    validate_name(&table.namespace)?;
    validate_name(&table.name)?;
    if dialect == "sqlite" && table.namespace != "main" {
        return Err("TABLE_NAMESPACE_UNSUPPORTED: SQLite requires main".into());
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
        return Err("TABLE_METADATA_INVALID: ambiguous relation".into());
    }
    let kind = match (dialect, text(&result[0][0])?.as_str()) {
        ("mysql", "BASE TABLE") | ("postgres", "r") | ("sqlite", "table") => TableKind::Table,
        ("mysql", "VIEW" | "SYSTEM VIEW") | ("postgres", "v") | ("sqlite", "view") => TableKind::View,
        ("postgres", "p") => TableKind::Partitioned,
        ("postgres", "m") => TableKind::MaterializedView,
        ("postgres", "f") => TableKind::Foreign,
        ("sqlite", "virtual") => TableKind::Virtual,
        ("sqlite", "shadow") => TableKind::Shadow,
        _ => return Err("TABLE_KIND_UNSUPPORTED".into()),
    };
    let sql=match dialect {
        "mysql"=>"SELECT c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE='YES',(c.GENERATION_EXPRESSION IS NOT NULL AND c.GENERATION_EXPRESSION<>''),COALESCE(pk.ORDINAL_POSITION,0) FROM information_schema.COLUMNS c LEFT JOIN information_schema.KEY_COLUMN_USAGE pk ON pk.CONSTRAINT_SCHEMA=c.TABLE_SCHEMA AND pk.TABLE_NAME=c.TABLE_NAME AND pk.COLUMN_NAME=c.COLUMN_NAME AND pk.CONSTRAINT_NAME='PRIMARY' WHERE c.TABLE_SCHEMA=? AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION",
        "postgres"=>"SELECT a.attname::text,format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,(a.attgenerated<>'' OR a.attidentity='a'),COALESCE(k.ord,0) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord) ON k.attnum=a.attnum WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",
        "sqlite"=>"SELECT name,type,NOT \"notnull\",hidden<>0,pk FROM pragma_table_xinfo(?2,?1) ORDER BY cid",
        _=>unreachable!(),
    };
    let result = rows(connection, sql, &params).await?;
    let mut columns = Vec::new();
    let mut keys = Vec::new();
    for row in result {
        if row.len() != 5 {
            return Err("TABLE_METADATA_INVALID: column shape".into());
        }
        let column = TableColumnMetadata {
            name: text(&row[0])?,
            native_type: text(&row[1])?,
            nullable: row[2].bool().map_err(|e| e.to_string())?,
            generated: row[3].bool().map_err(|e| e.to_string())?,
        };
        if columns.iter().any(|c: &TableColumnMetadata| c.name == column.name) {
            return Err("TABLE_METADATA_INVALID: duplicate column".into());
        }
        let ordinal = row[4].int().map_err(|e| e.to_string())?;
        if ordinal < 0 {
            return Err("TABLE_METADATA_INVALID: negative key ordinal".into());
        }
        if ordinal > 0 {
            keys.push((ordinal, columns.len()));
        }
        columns.push(column);
    }
    keys.sort_by_key(|key| key.0);
    for (index, key) in keys.iter().enumerate() {
        if key.0 != index as i64 + 1 {
            return Err("TABLE_METADATA_INVALID: key order".into());
        }
    }
    if dialect == "sqlite" && kind == TableKind::Table && keys.len() == 1 && columns[keys[0].1].native_type.eq_ignore_ascii_case("INTEGER") {
        let indexes = rows(connection, "SELECT count(*) FROM pragma_index_list(?2,?1) WHERE origin='pk'", &params).await?;
        if indexes.len() != 1 || indexes[0].len() != 1 {
            return Err("TABLE_METADATA_INVALID: primary index".into());
        }
        if indexes[0][0].int().map_err(|e| e.to_string())? == 0 {
            columns[keys[0].1].nullable = false;
        }
    }
    let reliable_row_identity =
        matches!(kind, TableKind::Table | TableKind::Partitioned) && !keys.is_empty() && keys.iter().all(|key| !columns[key.1].nullable);
    let primary_key = keys.iter().map(|key| columns[key.1].name.clone()).collect();
    Ok(TableMetadata { table: table.clone(), kind, columns, primary_key, reliable_row_identity })
}
