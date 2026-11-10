//! The test program of the recipe entries of mariadb (docs/spec/feature-coverage.md FCV-3, docs/spec/dialects.md DIA-200): each
//! module runs one recipe on MariaDB, a server of the MySQL dialect, and its tests are the trials `<module>::<case>`. The entries
//! need the MariaDB servers of make orm-test-mariadb, which a runner of the MySQL servers cannot hold, so the program is no test
//! of a plain cargo test (test = false in Cargo.toml) and make mariadb-recipes-check/rust runs it by `--test mariadb`. The
//! generated models of the bench set are `crate::model`, as in the program all.

polyspec_orm::models!();

#[path = "../../src/bench_set_dispatch.rs"]
pub mod bench_set_dispatch;
#[path = "../all/fulltext_search/dispatch.rs"]
pub mod fulltext_dispatch;
#[path = "../all/model_writes/dispatch.rs"]
pub mod model_writes_dispatch;

mod aes_rotation_mariadb;
mod audit_triggers_mariadb;
mod case_database_mariadb;
mod catalog_connection_mariadb;
mod complex_query_mariadb;
mod composite_keys_mariadb;
mod conformance_verification_mariadb;
mod connection_pool_mariadb;
mod constraints_and_relations_mariadb;
mod dbspec_apply_mariadb;
mod dbspec_introspect_mariadb;
mod dbspec_render_physical_mariadb;
mod dbspec_set_decimal_mariadb;
mod dsn_connection_mariadb;
mod external_audit_mariadb;
mod fulltext_search_recipe_mariadb;
mod immutable_write_mariadb;
mod model_queries_chain_mariadb;
mod model_queries_mariadb;
mod model_socket_mariadb;
mod model_writes_chain_mariadb;
mod model_writes_mariadb;
mod parameter_chunking_mariadb;
mod performance_gate_mariadb;
mod request_hook_mariadb;
mod schema_install_mariadb;
mod statement_events_mariadb;
mod statement_runner_mariadb;
mod transactions_mariadb;
mod utils_recipe_mariadb;

fn main() {
    polyspec_orm_testcase::run_groups(vec![
        polyspec_orm_testcase::Group::new("aes_rotation_mariadb", aes_rotation_mariadb::trials),
        polyspec_orm_testcase::Group::new("audit_triggers_mariadb", audit_triggers_mariadb::trials),
        polyspec_orm_testcase::Group::new("case_database_mariadb", case_database_mariadb::trials),
        polyspec_orm_testcase::Group::new("zone_mariadb", polyspec_orm_cases::zone::mariadb_trials),
        polyspec_orm_testcase::Group::new("catalog_connection_mariadb", catalog_connection_mariadb::trials),
        polyspec_orm_testcase::Group::new("complex_query_mariadb", complex_query_mariadb::trials),
        polyspec_orm_testcase::Group::new("composite_keys_mariadb", composite_keys_mariadb::trials),
        polyspec_orm_testcase::Group::new("conformance_verification_mariadb", conformance_verification_mariadb::trials),
        polyspec_orm_testcase::Group::new("connection_pool_mariadb", connection_pool_mariadb::trials),
        polyspec_orm_testcase::Group::new("constraints_and_relations_mariadb", constraints_and_relations_mariadb::trials),
        polyspec_orm_testcase::Group::new("dbspec_apply_mariadb", dbspec_apply_mariadb::trials),
        polyspec_orm_testcase::Group::new("dbspec_introspect_mariadb", dbspec_introspect_mariadb::trials),
        polyspec_orm_testcase::Group::new("dbspec_render_physical_mariadb", dbspec_render_physical_mariadb::trials),
        polyspec_orm_testcase::Group::new("dbspec_set_decimal_mariadb", dbspec_set_decimal_mariadb::trials),
        polyspec_orm_testcase::Group::new("dsn_connection_mariadb", dsn_connection_mariadb::trials),
        polyspec_orm_testcase::Group::new("external_audit_mariadb", external_audit_mariadb::trials),
        polyspec_orm_testcase::Group::new("fulltext_search_recipe_mariadb", fulltext_search_recipe_mariadb::trials),
        polyspec_orm_testcase::Group::new("immutable_write_mariadb", immutable_write_mariadb::trials),
        polyspec_orm_testcase::Group::new("model_queries_chain_mariadb", model_queries_chain_mariadb::trials),
        polyspec_orm_testcase::Group::new("model_queries_mariadb", model_queries_mariadb::trials),
        polyspec_orm_testcase::Group::new("model_socket_mariadb", model_socket_mariadb::trials),
        polyspec_orm_testcase::Group::new("model_writes_chain_mariadb", model_writes_chain_mariadb::trials),
        polyspec_orm_testcase::Group::new("model_writes_mariadb", model_writes_mariadb::trials),
        polyspec_orm_testcase::Group::new("parameter_chunking_mariadb", parameter_chunking_mariadb::trials),
        polyspec_orm_testcase::Group::new("performance_gate_mariadb", performance_gate_mariadb::trials),
        polyspec_orm_testcase::Group::new("request_hook_mariadb", request_hook_mariadb::trials),
        polyspec_orm_testcase::Group::new("schema_install_mariadb", schema_install_mariadb::trials),
        polyspec_orm_testcase::Group::new("statement_events_mariadb", statement_events_mariadb::trials),
        polyspec_orm_testcase::Group::new("statement_runner_mariadb", statement_runner_mariadb::trials),
        polyspec_orm_testcase::Group::new("transactions_mariadb", transactions_mariadb::trials),
        polyspec_orm_testcase::Group::new("utils_recipe_mariadb", utils_recipe_mariadb::trials),
    ]);
}
