use orm_build::{catalog::CatalogConnection, tool_db::{self, GridCell, QueryLimits}};

#[tokio::test]
async fn finite_grid_decimals_preserve_precision_and_scale() {
    tokio::time::timeout(std::time::Duration::from_secs(30),check()).await.expect("grid decimal deadline");
}
async fn check(){
    let path=std::env::temp_dir().join(format!("orm-grid-decimals-{}.sqlite",std::process::id()));
    assert!(!path.exists());let mut failures=Vec::new();
    for dialect in ["sqlite","mysql","postgres"]{
        let started=std::time::Instant::now();eprintln!("running grid_decimals:{dialect}");
        let dsn=match dialect{"sqlite"=>format!("sqlite://{}",path.display()),"mysql"=>std::env::var("ORM_TOOLS_MYSQL_DSN").expect("MySQL fixture DSN"),_=>std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("PostgreSQL fixture DSN")};
        let(database,seed,_)=tool_db::open(&dsn).await.expect("fixture connection");drop(seed);
        let mut catalog=CatalogConnection::connect(&dsn).await.expect("catalog connection");
        let large="123456789012345678901234567890123456789012345678901234567890123.45";
        let(sql,expected)=match dialect{
            "mysql"=>(format!("SELECT CAST('{large}' AS DECIMAL(65,2)), CAST('100.23000' AS DECIMAL(10,5)), CAST('0.00000' AS DECIMAL(10,5))"),vec![GridCell::Decimal(large.into()),GridCell::Decimal("100.23000".into()),GridCell::Decimal("0.00000".into())]),
            "postgres"=>(format!("SELECT '{large}'::numeric(65,2), '100.23000'::numeric(10,5), '0.00000'::numeric(10,5)"),vec![GridCell::Decimal(large.into()),GridCell::Decimal("100.23000".into()),GridCell::Decimal("0.00000".into())]),
            _=>(format!("SELECT '{large}', 123, 1.5"),vec![GridCell::Text(large.into()),GridCell::Integer(123),GridCell::Float64(1.5f64.to_bits())]),
        };
        match catalog.read_only_grid_query(&sql,&[],QueryLimits::default()).await{Ok(result) if result.rows==vec![expected]=>{},_=>failures.push(dialect)}
        if !catalog.read_only_grid_query(&sql,&[],QueryLimits{max_rows:1,max_bytes:2}).await.err().is_some_and(|error|error.contains("TOOL_QUERY_LIMIT")){failures.push("decimal-budget")}
        let null_sql=match dialect{"mysql"=>"SELECT CAST(NULL AS DECIMAL(10,5))","postgres"=>"SELECT NULL::numeric(10,5)",_=>"SELECT NULL"};
        match catalog.read_only_grid_query(null_sql,&[],QueryLimits::default()).await{Ok(result) if result.rows==vec![vec![GridCell::Null]]=>{},_=>failures.push("decimal-null")}
        if dialect=="postgres"{
            let huge="9".repeat(200);
            let sql=format!("SELECT '{huge}'::numeric, '1e-20'::numeric");
            match catalog.read_only_grid_query(&sql,&[],QueryLimits::default()).await{Ok(result) if result.rows==vec![vec![GridCell::Decimal(huge),GridCell::Decimal("0.00000000000000000001".into())]]=>{},_=>failures.push("large-numeric")}
            if catalog.read_only_grid_query("SELECT 'NaN'::numeric",&[],QueryLimits::default()).await.is_ok(){failures.push("nonfinite-numeric")}
        }
        catalog.close().await;database.close().await;eprintln!("finished grid_decimals:{dialect} {:?}",started.elapsed());
    }
    std::fs::remove_file(path).expect("remove owned SQLite fixture");assert!(failures.is_empty(),"decimal cases failed: {failures:?}");
}
