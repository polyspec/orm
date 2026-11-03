//! group_rows_db: the grouped counts of the bench set on a SQLite case database, read through the generated model: a
//! group holds only the grouped column and its count, the grouped boolean and integer values keep their types, the
//! counts sum to the row count, and a SQL NULL group is kept.
use super::coverage_env::run;
use super::model::{self, Author, Service, ServiceMember, ServiceRegion, User};
use polyspec_orm::{codes, Db, Val};
use polyspec_orm_case_database::CaseDatabase;

/// Writes three authors: one closed and two open, in two services, one with a price and two with a NULL price.
async fn seed(db: &Db) {
    let user = User::new().connect(db).set_name("group").create().await.unwrap().get_seq().unwrap();
    let mut places = Vec::new();
    for name in ["first", "second"] {
        let service = Service::new().connect(db).set_name(name).create().await.unwrap().get_seq().unwrap();
        let region =
            ServiceRegion::new().connect(db).set_service_seq(service).set_name(name).create().await.unwrap().get_seq().unwrap();
        let member =
            ServiceMember::new().connect(db).set_service_seq(service).set_user_seq(user).create().await.unwrap().get_seq().unwrap();
        places.push((service, region, member));
    }
    for (name, is_close, place, price) in
        [("a", true, places[0], Some("12.500")), ("b", false, places[0], None), ("c", false, places[1], None)]
    {
        let author = Author::new()
            .connect(db)
            .set_name(name)
            .set_is_close(is_close)
            .set_user_seq(user)
            .set_service_seq(place.0)
            .set_service_region_seq(place.1)
            .set_service_member_seq(place.2)
            .set_start_dt("2026-01-01 00:00:00")
            .unwrap()
            .set_end_dt("2026-12-31 00:00:00")
            .unwrap();
        let author = match price {
            Some(price) => author.set_price(price).unwrap(),
            None => author,
        };
        author.create().await.unwrap();
    }
}

#[tokio::test]
// Requirements: INT-31.
async fn coverage_group_rows_db() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("group_rows_database", async {
        let database = CaseDatabase::create("sqlite").await;
        let db = model::connect(database.dsn(), 2, polyspec_orm::Config::default()).await.unwrap();
        db.utils().schema().install(&model::SCHEMA).await.unwrap();
        seed(&db).await;
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
        assert_eq!(total, 3, "group counts do not sum to the rows written");
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
        database.drop().await;
    })
    .await;
}
