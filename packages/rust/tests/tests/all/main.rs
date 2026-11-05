//! The one test program of this crate: each module holds the tests of one recipe entry or one native test file, and its tests
//! are the trials `<module>::<name>` (docs/spec/feature-coverage.md FCV-3). The modules run one after another in this process;
//! the trials of a module run as `--test-threads` says, so what they share stays what they shared as programs of their own.
//! The generated models of the bench set are `crate::model`, once for every module.

polyspec_orm::models!();

#[path = "../../src/bench_set_dispatch.rs"]
pub mod bench_set_dispatch;
#[path = "fulltext_search/dispatch.rs"]
pub mod fulltext_dispatch;
#[path = "model_writes/dispatch.rs"]
pub mod model_writes_dispatch;

#[macro_use]
#[path = "../../../orm/tests/common/audit_rows.rs"]
pub mod audit_rows;
#[macro_use]
#[path = "../../../orm/tests/common/json_trials.rs"]
pub mod json_trials;
#[macro_use]
#[path = "../../../orm/tests/common/map_rows.rs"]
pub mod map_rows;
#[macro_use]
#[path = "../../../orm/tests/common/typed_model.rs"]
pub mod typed_model;
#[path = "../../../orm/tests/aes_keys.rs"]
mod aes_keys;
mod aes_rotation_mysql;
mod aes_rotation_postgres;
mod aes_rotation_sqlite;
#[path = "../../../orm/tests/audit.rs"]
mod audit;
mod audit_triggers_mysql;
mod audit_triggers_postgres;
mod audit_triggers_sqlite;
mod bind_messages;
mod canonical_none;
#[path = "../../../orm/tests/common/case_database_run.rs"]
pub mod case_database_run;
mod catalog_connection_mysql;
mod catalog_connection_postgres;
mod catalog_connection_sqlite;
mod catalog_connection_sqlite_only;
mod client_bench_args;
mod client_bench_dsn;
#[path = "../../../orm/tests/common/clock_test_support.rs"]
pub mod clock_test_support;
#[path = "../../../orm/tests/code_catalog.rs"]
mod code_catalog;
mod codec_integer_beyond_i64_none;
mod codec_none;
#[path = "../../../orm/tests/collection_identity.rs"]
mod collection_identity;
mod collection_none;
#[path = "../../../orm/tests/compiler_fixtures.rs"]
mod compiler_fixtures;
mod complex_query_mysql;
mod complex_query_postgres;
mod complex_query_sqlite;
mod composite_keys_mysql;
mod composite_keys_postgres;
mod composite_keys_sqlite;
mod conformance_runner;
mod conformance_verification_mysql;
mod conformance_verification_postgres;
mod conformance_verification_sqlite;
mod connection_pool_mysql;
mod connection_pool_postgres;
mod connection_pool_sqlite;
mod constraints_and_relations_mysql;
mod constraints_and_relations_postgres;
mod constraints_and_relations_sqlite;
#[path = "../../../orm/tests/coverage_dsn.rs"]
mod coverage_dsn;
mod coverage_model_generation;
mod coverage_performance_gate;
mod dbspec_add_tables_steps_none;
mod dbspec_apply_mysql;
mod dbspec_apply_postgres;
mod dbspec_apply_sqlite;
mod dbspec_apply_verification_errors_none;
mod dbspec_introspect_messages_none;
mod dbspec_introspect_mysql;
mod dbspec_introspect_postgres;
mod dbspec_introspect_sqlite;
mod dbspec_limits_none;
mod dbspec_load_set_none;
mod dbspec_mermaid_none;
#[path = "../../../schema/tests/dbspec_model.rs"]
mod dbspec_model;
mod dbspec_plan_cases_none;
mod dbspec_plan_chains_none;
mod dbspec_plan_comparisons_none;
mod dbspec_plan_invalid_none;
mod dbspec_plan_parse_none;
mod dbspec_read_set_none;
mod dbspec_render_physical_mysql;
mod dbspec_render_physical_postgres;
mod dbspec_render_physical_sqlite;
mod dbspec_render_statements_none;
mod dbspec_rules_recipe_none;
#[path = "../../../schema/tests/dbspec_runtime.rs"]
mod dbspec_runtime;
mod dbspec_set_decimal_mysql;
mod dbspec_set_decimal_postgres;
mod dbspec_set_decimal_sqlite;
#[path = "../../../schema/tests/dbspec_set_working_directory.rs"]
mod dbspec_set_working_directory;
mod dbspec_show_create_introspect_none;
#[path = "../../../orm/tests/decimal_model.rs"]
mod decimal_model;
mod decimal_physical;
mod default_select_set_none;
mod dsl_none;
mod dsn_connection_mysql;
mod dsn_connection_postgres;
mod dsn_connection_sqlite;
mod dsn_reject_none;
mod example_dsn;
mod external_audit_mysql;
mod external_audit_postgres;
mod external_audit_sqlite;
mod files_none;
#[path = "../../../testcase/tests/form.rs"]
mod form;
mod fulltext_search_recipe_mysql;
mod fulltext_search_recipe_postgres;
mod fulltext_search_recipe_sqlite;
#[path = "../../../build/tests/generate.rs"]
mod generate;
mod generator_none;
mod generator_scan_none;
mod hashes_none;
#[path = "../../../orm/tests/identity_load.rs"]
mod identity_load;
mod immutable_write_mysql;
mod immutable_write_postgres;
mod immutable_write_sqlite;
mod integration_program;
mod invalid_none;
mod ir_answers;
mod ir_validate_none;
#[path = "../../../build/tests/lock_probe/mod.rs"]
pub mod lock_probe;
#[path = "../../../build/tests/lock_probe_order.rs"]
mod lock_probe_order;
mod markdown_conformance;
#[path = "../../../orm/tests/model_output.rs"]
mod model_output;
mod model_queries_chain_mysql;
mod model_queries_chain_postgres;
mod model_queries_chain_sqlite;
mod model_queries_mysql;
mod model_queries_postgres;
mod model_queries_sqlite;
mod model_socket_mysql;
mod model_writes_chain_mysql;
mod model_writes_chain_postgres;
mod model_writes_chain_sqlite;
mod model_writes_mysql;
mod model_writes_postgres;
mod model_writes_sqlite;
#[path = "../../../orm/tests/mysql_tls.rs"]
mod mysql_tls;
mod normalize_none;
#[path = "common/or_panic.rs"]
pub mod or_panic;
#[path = "../../../orm/tests/package_entry.rs"]
mod package_entry;
mod parameter_chunking_mysql;
mod parameter_chunking_postgres;
mod parameter_chunking_sqlite;
mod performance_gate_mysql;
mod performance_gate_postgres;
mod performance_gate_sqlite;
#[path = "../../../build/tests/common/physical_fixture.rs"]
pub mod physical_fixture;
mod planner_compile_none;
mod positions_none;
mod public_interface_none;
mod recipe_keys;
mod request_hook_mysql;
mod request_hook_postgres;
mod request_hook_sqlite;
mod result_chains;
#[path = "common/result_code.rs"]
pub mod result_code;
#[path = "../../../orm/tests/rollback.rs"]
mod rollback;
#[path = "../../../build/tests/row_commit_permit.rs"]
mod row_commit_permit;
#[path = "../../../build/tests/row_insert_identity.rs"]
mod row_insert_identity;
#[path = "../../../build/tests/row_mutation.rs"]
mod row_mutation;
#[path = "../../../build/tests/row_snapshot.rs"]
mod row_snapshot;
mod runtime_model_entities_none;
mod runtime_model_plans_none;
mod schema_definition_none;
mod schema_install_mysql;
mod schema_install_postgres;
mod schema_install_sqlite;
#[path = "../../../orm/tests/common/secret_config.rs"]
pub mod secret_config;
#[path = "../../../orm/tests/common/service_model.rs"]
pub mod service_model;
mod set_parse_none;
mod sets_none;
#[path = "../../../orm/tests/common/sqlite_case.rs"]
pub mod sqlite_case;
#[path = "../../../orm/tests/sqlite_concurrency.rs"]
mod sqlite_concurrency;
#[path = "../../../orm/tests/sqlite_file_name.rs"]
mod sqlite_file_name;
mod statement_events_mysql;
mod statement_events_postgres;
mod statement_events_sqlite;
#[path = "../../../orm/tests/statement_fault.rs"]
mod statement_fault;
mod statement_runner_mysql;
mod statement_runner_postgres;
mod statement_runner_sqlite;
#[path = "../../../orm/tests/styled_column_states.rs"]
mod styled_column_states;
#[path = "../../../build/tests/tool_cells.rs"]
mod tool_cells;
#[path = "../../../build/tests/tool_columns.rs"]
mod tool_columns;
#[path = "../../../build/tests/tool_limits.rs"]
mod tool_limits;
#[path = "../../../build/tests/tool_statement.rs"]
mod tool_statement;
#[path = "../../../build/tests/tool_values.rs"]
mod tool_values;
#[path = "../../../orm/tests/transaction_flow.rs"]
mod transaction_flow;
mod transactions_mysql;
mod transactions_postgres;
mod transactions_sqlite;
#[path = "../../../build/tests/typed_binds.rs"]
mod typed_binds;
mod utils_recipe_mysql;
mod utils_recipe_postgres;
mod utils_recipe_sqlite;
#[path = "../../../orm/tests/value_types.rs"]
mod value_types;
#[path = "../../../orm/tests/was_inserted.rs"]
mod was_inserted;
#[path = "../../../orm/tests/zone.rs"]
mod zone;

fn main() {
    polyspec_orm_testcase::run_groups(vec![
        polyspec_orm_testcase::Group::new("aes_keys", aes_keys::trials),
        polyspec_orm_testcase::Group::new("audit", audit::trials),
        polyspec_orm_testcase::Group::new("code_catalog", code_catalog::trials),
        polyspec_orm_testcase::Group::new("collection_identity", collection_identity::trials),
        polyspec_orm_testcase::Group::new("compiler_fixtures", compiler_fixtures::trials).in_order(),
        polyspec_orm_testcase::Group::new("coverage_dsn", coverage_dsn::trials),
        polyspec_orm_testcase::Group::new("dbspec_model", dbspec_model::trials),
        polyspec_orm_testcase::Group::new("dbspec_runtime", dbspec_runtime::trials),
        polyspec_orm_testcase::Group::new("dbspec_set_working_directory", dbspec_set_working_directory::trials),
        polyspec_orm_testcase::Group::new("decimal_model", decimal_model::trials),
        polyspec_orm_testcase::Group::new("form", form::trials),
        polyspec_orm_testcase::Group::new("generate", generate::trials),
        polyspec_orm_testcase::Group::new("identity_load", identity_load::trials).in_order(),
        polyspec_orm_testcase::Group::new("lock_probe_order", lock_probe_order::trials),
        polyspec_orm_testcase::Group::new("model_output", model_output::trials),
        polyspec_orm_testcase::Group::new("mysql_tls", mysql_tls::trials),
        polyspec_orm_testcase::Group::new("package_entry", package_entry::trials),
        polyspec_orm_testcase::Group::new("rollback", rollback::trials),
        polyspec_orm_testcase::Group::new("row_commit_permit", row_commit_permit::trials),
        polyspec_orm_testcase::Group::new("row_insert_identity", row_insert_identity::trials),
        polyspec_orm_testcase::Group::new("row_mutation", row_mutation::trials),
        polyspec_orm_testcase::Group::new("row_snapshot", row_snapshot::trials),
        polyspec_orm_testcase::Group::new("sqlite_concurrency", sqlite_concurrency::trials),
        polyspec_orm_testcase::Group::new("sqlite_file_name", sqlite_file_name::trials),
        polyspec_orm_testcase::Group::new("statement_fault", statement_fault::trials).in_order(),
        polyspec_orm_testcase::Group::new("styled_column_states", styled_column_states::trials),
        polyspec_orm_testcase::Group::new("tool_cells", tool_cells::trials),
        polyspec_orm_testcase::Group::new("tool_columns", tool_columns::trials),
        polyspec_orm_testcase::Group::new("tool_limits", tool_limits::trials),
        polyspec_orm_testcase::Group::new("tool_statement", tool_statement::trials),
        polyspec_orm_testcase::Group::new("tool_values", tool_values::trials),
        polyspec_orm_testcase::Group::new("transaction_flow", transaction_flow::trials),
        polyspec_orm_testcase::Group::new("typed_binds", typed_binds::trials),
        polyspec_orm_testcase::Group::new("value_types", value_types::trials),
        polyspec_orm_testcase::Group::new("was_inserted", was_inserted::trials),
        polyspec_orm_testcase::Group::new("zone", zone::trials),
        polyspec_orm_testcase::Group::new("aes_rotation_mysql", aes_rotation_mysql::trials),
        polyspec_orm_testcase::Group::new("aes_rotation_postgres", aes_rotation_postgres::trials),
        polyspec_orm_testcase::Group::new("aes_rotation_sqlite", aes_rotation_sqlite::trials),
        polyspec_orm_testcase::Group::new("audit_triggers_mysql", audit_triggers_mysql::trials),
        polyspec_orm_testcase::Group::new("audit_triggers_postgres", audit_triggers_postgres::trials),
        polyspec_orm_testcase::Group::new("audit_triggers_sqlite", audit_triggers_sqlite::trials),
        polyspec_orm_testcase::Group::new("bind_messages", bind_messages::trials),
        polyspec_orm_testcase::Group::new("canonical_none", canonical_none::trials),
        polyspec_orm_testcase::Group::new("catalog_connection_mysql", catalog_connection_mysql::trials),
        polyspec_orm_testcase::Group::new("catalog_connection_postgres", catalog_connection_postgres::trials),
        polyspec_orm_testcase::Group::new("catalog_connection_sqlite", catalog_connection_sqlite::trials),
        polyspec_orm_testcase::Group::new("catalog_connection_sqlite_only", catalog_connection_sqlite_only::trials),
        polyspec_orm_testcase::Group::new("client_bench_args", client_bench_args::trials),
        polyspec_orm_testcase::Group::new("client_bench_dsn", client_bench_dsn::trials),
        polyspec_orm_testcase::Group::new("codec_integer_beyond_i64_none", codec_integer_beyond_i64_none::trials),
        polyspec_orm_testcase::Group::new("codec_none", codec_none::trials),
        polyspec_orm_testcase::Group::new("collection_none", collection_none::trials),
        polyspec_orm_testcase::Group::new("complex_query_mysql", complex_query_mysql::trials),
        polyspec_orm_testcase::Group::new("complex_query_postgres", complex_query_postgres::trials),
        polyspec_orm_testcase::Group::new("complex_query_sqlite", complex_query_sqlite::trials),
        polyspec_orm_testcase::Group::new("composite_keys_mysql", composite_keys_mysql::trials),
        polyspec_orm_testcase::Group::new("composite_keys_postgres", composite_keys_postgres::trials),
        polyspec_orm_testcase::Group::new("composite_keys_sqlite", composite_keys_sqlite::trials),
        polyspec_orm_testcase::Group::new("conformance_runner", conformance_runner::trials),
        polyspec_orm_testcase::Group::new("conformance_verification_mysql", conformance_verification_mysql::trials),
        polyspec_orm_testcase::Group::new("conformance_verification_postgres", conformance_verification_postgres::trials),
        polyspec_orm_testcase::Group::new("conformance_verification_sqlite", conformance_verification_sqlite::trials),
        polyspec_orm_testcase::Group::new("connection_pool_mysql", connection_pool_mysql::trials),
        polyspec_orm_testcase::Group::new("connection_pool_postgres", connection_pool_postgres::trials),
        polyspec_orm_testcase::Group::new("connection_pool_sqlite", connection_pool_sqlite::trials),
        polyspec_orm_testcase::Group::new("constraints_and_relations_mysql", constraints_and_relations_mysql::trials),
        polyspec_orm_testcase::Group::new("constraints_and_relations_postgres", constraints_and_relations_postgres::trials),
        polyspec_orm_testcase::Group::new("constraints_and_relations_sqlite", constraints_and_relations_sqlite::trials),
        polyspec_orm_testcase::Group::new("coverage_model_generation", coverage_model_generation::trials),
        polyspec_orm_testcase::Group::new("coverage_performance_gate", coverage_performance_gate::trials),
        polyspec_orm_testcase::Group::new("dbspec_add_tables_steps_none", dbspec_add_tables_steps_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_apply_mysql", dbspec_apply_mysql::trials),
        polyspec_orm_testcase::Group::new("dbspec_apply_postgres", dbspec_apply_postgres::trials),
        polyspec_orm_testcase::Group::new("dbspec_apply_sqlite", dbspec_apply_sqlite::trials),
        polyspec_orm_testcase::Group::new("dbspec_apply_verification_errors_none", dbspec_apply_verification_errors_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_introspect_messages_none", dbspec_introspect_messages_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_introspect_mysql", dbspec_introspect_mysql::trials),
        polyspec_orm_testcase::Group::new("dbspec_introspect_postgres", dbspec_introspect_postgres::trials),
        polyspec_orm_testcase::Group::new("dbspec_introspect_sqlite", dbspec_introspect_sqlite::trials),
        polyspec_orm_testcase::Group::new("dbspec_limits_none", dbspec_limits_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_load_set_none", dbspec_load_set_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_mermaid_none", dbspec_mermaid_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_plan_cases_none", dbspec_plan_cases_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_plan_chains_none", dbspec_plan_chains_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_plan_comparisons_none", dbspec_plan_comparisons_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_plan_invalid_none", dbspec_plan_invalid_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_plan_parse_none", dbspec_plan_parse_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_read_set_none", dbspec_read_set_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_render_physical_mysql", dbspec_render_physical_mysql::trials),
        polyspec_orm_testcase::Group::new("dbspec_render_physical_postgres", dbspec_render_physical_postgres::trials),
        polyspec_orm_testcase::Group::new("dbspec_render_physical_sqlite", dbspec_render_physical_sqlite::trials),
        polyspec_orm_testcase::Group::new("dbspec_render_statements_none", dbspec_render_statements_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_rules_recipe_none", dbspec_rules_recipe_none::trials),
        polyspec_orm_testcase::Group::new("dbspec_set_decimal_mysql", dbspec_set_decimal_mysql::trials),
        polyspec_orm_testcase::Group::new("dbspec_set_decimal_postgres", dbspec_set_decimal_postgres::trials),
        polyspec_orm_testcase::Group::new("dbspec_set_decimal_sqlite", dbspec_set_decimal_sqlite::trials),
        polyspec_orm_testcase::Group::new("dbspec_show_create_introspect_none", dbspec_show_create_introspect_none::trials),
        polyspec_orm_testcase::Group::new("decimal_physical", decimal_physical::trials),
        polyspec_orm_testcase::Group::new("default_select_set_none", default_select_set_none::trials),
        polyspec_orm_testcase::Group::new("dsl_none", dsl_none::trials),
        polyspec_orm_testcase::Group::new("dsn_connection_mysql", dsn_connection_mysql::trials),
        polyspec_orm_testcase::Group::new("dsn_connection_postgres", dsn_connection_postgres::trials),
        polyspec_orm_testcase::Group::new("dsn_connection_sqlite", dsn_connection_sqlite::trials),
        polyspec_orm_testcase::Group::new("dsn_reject_none", dsn_reject_none::trials),
        polyspec_orm_testcase::Group::new("example_dsn", example_dsn::trials),
        polyspec_orm_testcase::Group::new("external_audit_mysql", external_audit_mysql::trials),
        polyspec_orm_testcase::Group::new("external_audit_postgres", external_audit_postgres::trials),
        polyspec_orm_testcase::Group::new("external_audit_sqlite", external_audit_sqlite::trials),
        polyspec_orm_testcase::Group::new("files_none", files_none::trials),
        polyspec_orm_testcase::Group::new("fulltext_search_recipe_mysql", fulltext_search_recipe_mysql::trials),
        polyspec_orm_testcase::Group::new("fulltext_search_recipe_postgres", fulltext_search_recipe_postgres::trials),
        polyspec_orm_testcase::Group::new("fulltext_search_recipe_sqlite", fulltext_search_recipe_sqlite::trials),
        polyspec_orm_testcase::Group::new("generator_none", generator_none::trials),
        polyspec_orm_testcase::Group::new("generator_scan_none", generator_scan_none::trials),
        polyspec_orm_testcase::Group::new("hashes_none", hashes_none::trials),
        polyspec_orm_testcase::Group::new("immutable_write_mysql", immutable_write_mysql::trials),
        polyspec_orm_testcase::Group::new("immutable_write_postgres", immutable_write_postgres::trials),
        polyspec_orm_testcase::Group::new("immutable_write_sqlite", immutable_write_sqlite::trials),
        polyspec_orm_testcase::Group::new("integration_program", integration_program::trials),
        polyspec_orm_testcase::Group::new("invalid_none", invalid_none::trials),
        polyspec_orm_testcase::Group::new("ir_answers", ir_answers::trials),
        polyspec_orm_testcase::Group::new("ir_validate_none", ir_validate_none::trials),
        polyspec_orm_testcase::Group::new("markdown_conformance", markdown_conformance::trials).in_order().after(markdown_conformance::release),
        polyspec_orm_testcase::Group::new("model_queries_chain_mysql", model_queries_chain_mysql::trials),
        polyspec_orm_testcase::Group::new("model_queries_chain_postgres", model_queries_chain_postgres::trials),
        polyspec_orm_testcase::Group::new("model_queries_chain_sqlite", model_queries_chain_sqlite::trials),
        polyspec_orm_testcase::Group::new("model_queries_mysql", model_queries_mysql::trials),
        polyspec_orm_testcase::Group::new("model_queries_postgres", model_queries_postgres::trials),
        polyspec_orm_testcase::Group::new("model_queries_sqlite", model_queries_sqlite::trials),
        polyspec_orm_testcase::Group::new("model_socket_mysql", model_socket_mysql::trials),
        polyspec_orm_testcase::Group::new("model_writes_chain_mysql", model_writes_chain_mysql::trials),
        polyspec_orm_testcase::Group::new("model_writes_chain_postgres", model_writes_chain_postgres::trials),
        polyspec_orm_testcase::Group::new("model_writes_chain_sqlite", model_writes_chain_sqlite::trials),
        polyspec_orm_testcase::Group::new("model_writes_mysql", model_writes_mysql::trials),
        polyspec_orm_testcase::Group::new("model_writes_postgres", model_writes_postgres::trials),
        polyspec_orm_testcase::Group::new("model_writes_sqlite", model_writes_sqlite::trials),
        polyspec_orm_testcase::Group::new("normalize_none", normalize_none::trials),
        polyspec_orm_testcase::Group::new("parameter_chunking_mysql", parameter_chunking_mysql::trials),
        polyspec_orm_testcase::Group::new("parameter_chunking_postgres", parameter_chunking_postgres::trials),
        polyspec_orm_testcase::Group::new("parameter_chunking_sqlite", parameter_chunking_sqlite::trials),
        polyspec_orm_testcase::Group::new("performance_gate_mysql", performance_gate_mysql::trials),
        polyspec_orm_testcase::Group::new("performance_gate_postgres", performance_gate_postgres::trials),
        polyspec_orm_testcase::Group::new("performance_gate_sqlite", performance_gate_sqlite::trials),
        polyspec_orm_testcase::Group::new("planner_compile_none", planner_compile_none::trials),
        polyspec_orm_testcase::Group::new("positions_none", positions_none::trials),
        polyspec_orm_testcase::Group::new("public_interface_none", public_interface_none::trials),
        polyspec_orm_testcase::Group::new("recipe_keys", recipe_keys::trials),
        polyspec_orm_testcase::Group::new("request_hook_mysql", request_hook_mysql::trials),
        polyspec_orm_testcase::Group::new("request_hook_postgres", request_hook_postgres::trials),
        polyspec_orm_testcase::Group::new("request_hook_sqlite", request_hook_sqlite::trials),
        polyspec_orm_testcase::Group::new("result_chains", result_chains::trials),
        polyspec_orm_testcase::Group::new("runtime_model_entities_none", runtime_model_entities_none::trials),
        polyspec_orm_testcase::Group::new("runtime_model_plans_none", runtime_model_plans_none::trials),
        polyspec_orm_testcase::Group::new("schema_definition_none", schema_definition_none::trials),
        polyspec_orm_testcase::Group::new("schema_install_mysql", schema_install_mysql::trials),
        polyspec_orm_testcase::Group::new("schema_install_postgres", schema_install_postgres::trials),
        polyspec_orm_testcase::Group::new("schema_install_sqlite", schema_install_sqlite::trials),
        polyspec_orm_testcase::Group::new("set_parse_none", set_parse_none::trials),
        polyspec_orm_testcase::Group::new("sets_none", sets_none::trials),
        polyspec_orm_testcase::Group::new("statement_events_mysql", statement_events_mysql::trials),
        polyspec_orm_testcase::Group::new("statement_events_postgres", statement_events_postgres::trials),
        polyspec_orm_testcase::Group::new("statement_events_sqlite", statement_events_sqlite::trials),
        polyspec_orm_testcase::Group::new("statement_runner_mysql", statement_runner_mysql::trials),
        polyspec_orm_testcase::Group::new("statement_runner_postgres", statement_runner_postgres::trials),
        polyspec_orm_testcase::Group::new("statement_runner_sqlite", statement_runner_sqlite::trials),
        polyspec_orm_testcase::Group::new("transactions_mysql", transactions_mysql::trials),
        polyspec_orm_testcase::Group::new("transactions_postgres", transactions_postgres::trials),
        polyspec_orm_testcase::Group::new("transactions_sqlite", transactions_sqlite::trials),
        polyspec_orm_testcase::Group::new("utils_recipe_mysql", utils_recipe_mysql::trials),
        polyspec_orm_testcase::Group::new("utils_recipe_postgres", utils_recipe_postgres::trials),
        polyspec_orm_testcase::Group::new("utils_recipe_sqlite", utils_recipe_sqlite::trials),
    ]);
}
