# Code that vulture reports as unused but that a consumer, the language, or unittest uses (kit's lint-python).
# Each entry names the kept code and its reason.
# ruff: F821 is ignored for this file by ruff.toml, since an entry is a bare name or an attribute of `_`.

# unittest calls these by name: setUpModule before the tests of a module, load_tests to build its suite, and
# shortDescription to describe a test; a TestCase subclass is found by discovery, never referenced.
setUpModule
load_tests
_.shortDescription
SetParseVectors
BindMessageVectors
BindVectors
MysqlCells
PostgresCells
MysqlPlaceholders
PostgresPlaceholders
PostgresUtilityStatements

# The case reporter of the tests (tests/testcase.py): TextTestResult reads dots and showAll, TextTestRunner reads
# resultclass, and warning is the helper by which a test reports a measurement above its documented bound.
_.dots
_.showAll
_.resultclass
warning

# Attributes that a library reads: ruamel.yaml's emitter options and representer hook, sqlite3's autocommit mode.
_.default_flow_style
_.allow_unicode
_.ignore_aliases
_.isolation_level

# Public API of the Python client, kept in parity with the other languages (docs/interfaces.md).
_.CODES  # CodecError: the stable codes a codec failure carries
_.max_open_connections  # DbStats fields of stats()
_.open_connections
_.in_use
_.fetched_values  # identity-map rows of a load
_.for_share  # query builder locks, conditions and order
_.for_share_no_wait
_.or_not
_.order_by_random
_.today  # values: time helpers
_.minutes_ago
_.hours_ago
_.days_ago
_.months_ago
_.seconds_later
_.minutes_later
_.hours_later
_.days_later
_.secret  # planner: the secret slot of a statement
_.totalCount  # Page: the fields of one page of rows
_.totalPages
_.perPage

# Public types of the dbspec API and of the IR (docs/protocol.md), which consumers annotate with; a TypedDict
# key names a field of the wire form, read by key, never by attribute.
DbspecChange
DbspecPlanStep
DbspecDifference
DbspecTableRename
DbspecColumnRename
DbspecColumnName
DbspecApplyEvent
_.rollback_restore
_.restore_if
_.finalize
IRItem
_.flatten
_.limit_per_parent
_.no_cascade_delete
_.ir_version
_.on_duplicate
_.n_params
_.plus_p
_.minus_p

# Core methods that the generated models (src/polyspec/orm/models, excluded as generated text) and every model that
# orm-gen writes call.
_.add_column
_.remove_column
_.aggregate
_.put_plus
_.put_minus

# A contract name of the symbol file (tests/interfaces), declared by every client.
function_column
