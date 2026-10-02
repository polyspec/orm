use orm_build::tool_db::{self, GridCell, ParamType, QueryLimits, P};
#[tokio::test]
async fn native_typed_binds_preserve_values_and_typed_nulls() {
    let began = std::time::Instant::now();
    eprintln!("running typed_binds");
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let path = std::env::temp_dir().join(format!("orm-typed-binds-{}.sqlite", std::process::id()));
        assert!(!path.exists());
        let mut failures = Vec::new();
        for dialect in ["sqlite", "mysql", "postgres"] {
            let started = std::time::Instant::now();
            eprintln!("running typed_binds:{dialect}");
            let dsn = match dialect {
                "sqlite" => format!("sqlite://{}", path.display()),
                "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("MySQL fixture DSN"),
                _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("PostgreSQL fixture DSN"),
            };
            let (database, mut connection, _) = tool_db::open(&dsn).await.expect("fixture connection");
            let parameters = [P::Binary(vec![0, 255]), P::Float64(1.5f64.to_bits()), P::Null(ParamType::Text)];
            let sql = if dialect == "postgres" { "SELECT $1::bytea,$2::float8,$3::text" } else { "SELECT ?,?,?" };
            let result = connection.grid_query_bounded(sql, &parameters, QueryLimits::default()).await.expect("native binds");
            if result.rows != vec![vec![GridCell::Binary(vec![0, 255]), GridCell::Float64(1.5f64.to_bits()), GridCell::Null]] {
                failures.push("typed-bind-value");
            }
            if dialect == "postgres" {
                let bits = [P::Float32(f32::NAN.to_bits()), P::Float64(f64::NEG_INFINITY.to_bits()), P::Float64((-0.0f64).to_bits())];
                let result = connection
                    .grid_query_bounded("SELECT $1::float4,$2::float8,$3::float8", &bits, QueryLimits::default())
                    .await
                    .expect("native PostgreSQL nonfinite bits");
                if result.rows
                    != vec![vec![GridCell::Float32(f32::NAN.to_bits()), GridCell::Float64(f64::NEG_INFINITY.to_bits()), GridCell::Float64((-0.0f64).to_bits())]]
                {
                    failures.push("postgres-native-float-bits");
                }
            }
            drop(connection);
            database.close().await;
            eprintln!("finished typed_binds:{dialect} {:?}", started.elapsed());
        }
        std::fs::remove_file(path).expect("remove owned SQLite fixture");
        assert!(failures.is_empty(), "typed bind cases failed: {failures:?}");
    })
    .await
    .expect("typed bind deadline");
    eprintln!("passed typed_binds {:?}", began.elapsed());
}

#[tokio::test]
async fn native_typed_writes_roundtrip_reject_and_rollback() {
    let began = std::time::Instant::now();
    eprintln!("running typed_writes");
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let path = std::env::temp_dir().join(format!("orm-typed-writes-{}.sqlite", std::process::id()));
        assert!(!path.exists());
        let mut failures = Vec::new();
        for dialect in ["sqlite", "mysql", "postgres"] {
            let started = std::time::Instant::now();
            eprintln!("running typed_writes:{dialect}");
            let dsn = match dialect {
                "sqlite" => format!("sqlite://{}", path.display()),
                "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("MySQL fixture DSN"),
                _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("PostgreSQL fixture DSN"),
            };
            let (database, mut connection, _) = tool_db::open(&dsn).await.expect("owned fixture connection");
            let table = format!("orm_typed_bind_{}", std::process::id());
            let blob = if dialect == "postgres" { "BYTEA" } else { "BLOB" };
            let float = if dialect == "sqlite" { "REAL" } else { "DOUBLE PRECISION" };
            let extras = if dialect == "sqlite" {
                ""
            } else if dialect == "mysql" {
                ",small FLOAT,amount DECIMAL(40,5),unsigned_value BIGINT UNSIGNED"
            } else {
                ",small REAL,amount NUMERIC(40,5)"
            };
            connection
                .exec(&format!("CREATE TABLE {table}(id BIGINT PRIMARY KEY,note TEXT,payload {blob},flag BOOLEAN,number {float}{extras})"), &[])
                .await
                .expect("create owned fixture");
            let mut values = vec![P::I(i64::MAX), P::S("private'quote".into()), P::Binary(vec![0, 255]), P::Boolean(true), P::Float64((-0.125f64).to_bits())];
            let mut expected = vec![
                GridCell::Integer(i64::MAX),
                GridCell::Text("private'quote".into()),
                GridCell::Binary(vec![0, 255]),
                if dialect == "postgres" { GridCell::Boolean(true) } else { GridCell::Integer(1) },
                GridCell::Float64((-0.125f64).to_bits()),
            ];
            if dialect != "sqlite" {
                values.push(P::Float32(1.5f32.to_bits()));
                values.push(P::Decimal("12345678901234567890123456789012345.23000".into()));
                expected.push(GridCell::Float32(1.5f32.to_bits()));
                expected.push(GridCell::Decimal("12345678901234567890123456789012345.23000".into()));
            }
            if dialect == "mysql" {
                values.push(P::Unsigned(u64::MAX));
                expected.push(GridCell::Unsigned(u64::MAX));
            }
            let markers = (1..=values.len()).map(|index| tool_db::placeholder(dialect, index)).collect::<Vec<_>>().join(",");
            if connection.exec(&format!("INSERT INTO {table} VALUES({markers})"), &values).await.expect("typed owned insert") != 1 {
                failures.push("insert-count");
            }
            if !connection.exec(&format!("INSERT INTO {table} VALUES({markers})"), &values).await.is_err_and(|error| error.as_database_error().is_some()) {
                failures.push("native-constraint-error");
            }
            let read = format!("SELECT * FROM {table}");
            let result = connection.grid_query_bounded(&read, &[], QueryLimits::default()).await.expect("stored typed values");
            if dialect == "sqlite" {
                let storage = connection.query(&format!("SELECT typeof(flag) FROM {table}"), &[]).await.expect("owned boolean storage class");
                if storage != vec![vec![tool_db::Val::Text("integer".into())]] {
                    failures.push("sqlite-boolean-storage");
                }
            }
            if result.rows != vec![expected.clone()] {
                for (index, (actual, wanted)) in result.rows[0].iter().zip(&expected).enumerate() {
                    if actual != wanted {
                        let kind = match actual {
                            GridCell::Null => "null",
                            GridCell::Integer(_) => "integer",
                            GridCell::Unsigned(_) => "unsigned",
                            GridCell::Float32(_) => "float32",
                            GridCell::Float64(_) => "float64",
                            GridCell::Decimal(_) => "decimal",
                            GridCell::Text(_) => "text",
                            GridCell::Boolean(_) => "boolean",
                            GridCell::Binary(_) => "binary",
                            GridCell::Date(_) => "date",
                            GridCell::Time(_) => "time",
                            GridCell::DateTime(_) => "datetime",
                        };
                        eprintln!("failed typed_roundtrip:{dialect}:column-{index}:kind-{kind}");
                    }
                }
                failures.push("stored-roundtrip");
            }
            let mut invalid = vec![P::Decimal("1e3".into()), P::S("x".repeat(16 * 1024 * 1024 + 1))];
            match dialect {
                "mysql" => {
                    invalid.push(P::Float32(f32::NAN.to_bits()));
                    invalid.push(P::Float64(f64::INFINITY.to_bits()));
                }
                "postgres" => {
                    invalid.push(P::Unsigned(u64::MAX));
                    invalid.push(P::S("private\0nul".into()));
                }
                _ => {
                    invalid.push(P::Unsigned(1));
                    invalid.push(P::Float32(1.0f32.to_bits()));
                    invalid.push(P::Decimal("1.00".into()));
                    invalid.push(P::Float64(f64::NAN.to_bits()));
                }
            }
            for value in invalid {
                let error = connection
                    .exec(&format!("UPDATE {table} SET note={}", tool_db::placeholder(dialect, 1)), &[value])
                    .await
                    .expect_err("invalid bind must reject")
                    .to_string();
                if !error.contains("TOOL_BIND_") || error.contains("private") {
                    failures.push("bind-rejection");
                }
            }
            let kinds = [
                ParamType::Text,
                ParamType::Integer,
                ParamType::Float64,
                ParamType::Boolean,
                ParamType::Binary,
                ParamType::Float32,
                ParamType::Decimal,
                ParamType::Unsigned,
                ParamType::Date,
                ParamType::Time,
                ParamType::DateTime,
            ];
            for kind in kinds {
                let supported =
                    !(kind == ParamType::Unsigned && dialect != "mysql") && !(dialect == "sqlite" && matches!(kind, ParamType::Float32 | ParamType::Decimal));
                let sql = if dialect == "postgres" {
                    format!(
                        "SELECT $1::{}",
                        match kind {
                            ParamType::Text => "text",
                            ParamType::Integer => "int8",
                            ParamType::Float64 => "float8",
                            ParamType::Boolean => "bool",
                            ParamType::Binary => "bytea",
                            ParamType::Float32 => "float4",
                            ParamType::Decimal => "numeric",
                            ParamType::Unsigned => "int8",
                            ParamType::Date => "date",
                            ParamType::Time => "time",
                            ParamType::DateTime => "timestamp",
                        }
                    )
                } else {
                    "SELECT ?".into()
                };
                let result = connection.grid_query_bounded(&sql, &[P::Null(kind)], QueryLimits::default()).await;
                if supported {
                    if !result.is_ok_and(|result| result.rows == vec![vec![GridCell::Null]]) {
                        failures.push("typed-null");
                    }
                } else if !result.is_err_and(|error| error.to_string().contains("TOOL_BIND_INVALID")) {
                    failures.push("typed-null-rejection");
                }
            }
            connection.exec("BEGIN", &[]).await.expect("owned write transaction");
            let update = format!(
                "UPDATE {table} SET note={},payload={} WHERE id={}",
                tool_db::placeholder(dialect, 1),
                tool_db::placeholder(dialect, 2),
                tool_db::placeholder(dialect, 3)
            );
            if connection.exec(&update, &[P::Null(ParamType::Text), P::Binary(vec![]), P::I(i64::MAX)]).await.expect("typed NULL update") != 1 {
                failures.push("update-count");
            }
            let changed = connection.grid_query_bounded(&read, &[], QueryLimits::default()).await.expect("owned updated row");
            if changed.rows[0][1] != GridCell::Null || changed.rows[0][2] != GridCell::Binary(vec![]) {
                failures.push("updated-null-empty-binary");
            }
            connection.exec("ROLLBACK", &[]).await.expect("rollback owned update");
            if connection.grid_query_bounded(&read, &[], QueryLimits::default()).await.expect("rollback verification").rows != vec![expected] {
                failures.push("rollback-or-rejected-write");
            }
            if dialect == "sqlite" {
                let result = connection
                    .grid_query_bounded("SELECT ?", &[P::Float64(f64::INFINITY.to_bits())], QueryLimits::default())
                    .await
                    .expect("native SQLite infinity");
                if result.rows != vec![vec![GridCell::Float64(f64::INFINITY.to_bits())]] {
                    failures.push("sqlite-infinity");
                }
            }
            connection.exec(&format!("DROP TABLE {table}"), &[]).await.expect("remove owned fixture");
            drop(connection);
            database.close().await;
            eprintln!("finished typed_writes:{dialect} {:?}", started.elapsed());
        }
        std::fs::remove_file(path).expect("remove owned SQLite fixture");
        assert!(failures.is_empty(), "typed write cases failed: {failures:?}");
    })
    .await
    .expect("typed write deadline");
    eprintln!("passed typed_writes {:?}", began.elapsed());
}
