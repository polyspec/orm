//! group_rows_db: the grouped counts of the seeded bench database, read through the generated model: a group holds only
//! the grouped column and its count, the grouped boolean and integer values keep their types, the counts sum to the row
//! count, and a SQL NULL group is kept.
use super::coverage_env::{connect, run};
use super::model::Author;
use polyspec_orm::{codes, Val};

#[tokio::test]
// Requirements: INT-31.
async fn coverage_group_rows_db() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("group_rows_db", async {
        let db = connect().await;
        let groups = Author::new().connect(&db).group_by_is_close().order_by_is_close_asc().gets_count().await.unwrap();
        assert_eq!(groups.len(), 2, "getsCount returned partial models");
        let mut total = 0i64;
        for row in groups.iter() {
            assert!(matches!(row.value("is_close").unwrap(), Val::Bool(_)), "grouped boolean has the wrong type");
            assert!(row.count() >= 1, "grouped count");
            let array = row.to_array().unwrap();
            let keys: Vec<&str> = array.as_object().unwrap().keys().map(String::as_str).collect();
            assert_eq!(keys, ["is_close", "row_count"], "group row includes an unselected field");
            assert_eq!(row.value("name").unwrap_err().code(), codes::COLUMN_UNSELECTED, "unselected model column");
            total += row.count();
        }
        assert_eq!(total, Author::new().connect(&db).get_count().await.unwrap(), "group counts do not sum to the row count");
        let services = Author::new().connect(&db).group_by_service_seq().gets_count().await.unwrap();
        let mut service_total = 0i64;
        for row in services.iter() {
            assert!(matches!(row.value("service_seq").unwrap(), Val::I64(_)), "grouped integer changed type");
            service_total += row.count();
        }
        assert_eq!(service_total, total, "service group counts differ");
        let nullable = Author::new().connect(&db).group_by_price().gets_count().await.unwrap();
        let mut saw_null = false;
        let mut nullable_total = 0i64;
        for row in nullable.iter() {
            saw_null |= matches!(row.value("price").unwrap(), Val::Null);
            nullable_total += row.count();
        }
        assert!(saw_null && nullable_total == total, "SQL NULL group value was lost");
        db.close().await;
    })
    .await;
}
