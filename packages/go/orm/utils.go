package orm

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/polyspec/orm/packages/go/engine/dbspec"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
)

// Utils provides operations outside the query syntax.
type Utils struct{ db *DB }

// Utils returns the utilities of the connection.
func (d *DB) Utils() *Utils { return &Utils{db: d} }

// Stats returns the connection pool state.
func (u *Utils) Stats() DBStats { return u.db.Stats() }

func (u *Utils) active(name string) (*txConn, error) {
	t := activeFor(u.db)
	if t == nil {
		return nil, configErr("%s requires an active transaction of the connection", name)
	}
	return t, nil
}

// run executes fn in the active transaction of the connection, or in a new
// transaction when none is active.
func (u *Utils) run(fn func(t *txConn) error) error {
	if t := activeFor(u.db); t != nil {
		return fn(t)
	}
	return u.db.Transaction(func() error { return fn(activeFor(u.db)) }, Retry(0))
}

// read executes fn with a runner on the active transaction or the connection.
func (u *Utils) read(fn func(ctx context.Context, r runner) error) error {
	if t := activeFor(u.db); t != nil {
		return fn(t.ctx, t.run())
	}
	return fn(u.db.ctx, runner{d: u.db, q: u.db.sql})
}

type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func (u *Utils) ph(n int) string {
	if u.db.driver == "postgres" {
		return fmt.Sprintf("$%d", n)
	}
	return "?"
}

func validKey(key string) bool {
	if key == "" || len(key) > 64 {
		return false
	}
	for i, r := range key {
		if r != '.' && r != '_' && (r < 'A' || r > 'Z') && (r < 'a' || r > 'z') && (r < '0' || r > '9') || i == 0 && r == '.' {
			return false
		}
	}
	return true
}

// Lock takes a named lock that is released when the transaction ends.
func (u *Utils) Lock(key string) error {
	if err := u.db.unsupportedOnMarkdown("lock"); err != nil {
		return err
	}
	t, err := u.active("lock")
	if err != nil {
		return err
	}
	if !validKey(key) {
		return configErr("lock key %q is invalid", key)
	}
	switch u.db.driver {
	case "mysql":
		var got sql.NullInt64
		if err := t.run().scan(t.ctx, KindUtility, nil, "SELECT GET_LOCK(?, 50)", []any{key}, &got); err != nil {
			return err
		}
		if !got.Valid || got.Int64 != 1 {
			return TransactionConflict("lock " + key + " was not acquired")
		}
		t.locks = append(t.locks, key)
	case "postgres":
		if _, err := t.run().exec(t.ctx, KindUtility, nil, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", key); err != nil {
			return err
		}
	default:
		return acquireSQLiteRowLock(t.ctx, t, "update")
	}
	return nil
}

// releaseLocks releases MySQL named locks before the transaction ends. Named locks
// remain on the connection after COMMIT and ROLLBACK, so it returns every failed release and every non-1
// RELEASE_LOCK result (not holding the lock) as an error. A lock it attempted once
// is not released again.
func (t *txConn) releaseLocks() error {
	locks := t.locks
	t.locks = nil
	var errs []error
	for _, key := range locks {
		var released sql.NullInt64
		if err := t.machinery().scan(t.ctx, KindUtility, nil, "SELECT RELEASE_LOCK(?)", []any{key}, &released); err != nil {
			errs = append(errs, err)
			continue
		}
		if !released.Valid || released.Int64 != 1 {
			errs = append(errs, configErr("lock %s was not held at transaction end", key))
		}
	}
	return errors.Join(errs...)
}

// SetLocal sets a transaction-local value. PostgreSQL uses set_config, and MySQL
// writes a user variable, and SQLite keeps it only inside the transaction.
func (u *Utils) SetLocal(key, value string) error {
	if err := u.db.unsupportedOnMarkdown("setLocal"); err != nil {
		return err
	}
	t, err := u.active("setLocal")
	if err != nil {
		return err
	}
	if !validKey(key) {
		return configErr("local key %q is invalid", key)
	}
	switch u.db.driver {
	case "postgres":
		if _, err := t.run().exec(t.ctx, KindUtility, nil, "SELECT set_config($1, $2, true)", key, value); err != nil {
			return err
		}
	case "mysql":
		if _, err := t.run().exec(t.ctx, KindUtility, nil, "SET @`orm."+key+"` = ?", value); err != nil {
			return err
		}
	}
	if t.locals == nil {
		t.locals = map[string]string{}
	}
	t.locals[key] = value
	return nil
}

// clearLocals clears MySQL session variables before the transaction ends.
// MySQL user variables remain on the connection after COMMIT and ROLLBACK,
// (mysql.context.user_variable_session_scope) so a failed reset is returned as an error.
// A value attempted once is not cleared again.
func (t *txConn) clearLocals() error {
	locals := t.locals
	t.locals = nil
	if t.db.driver != "mysql" {
		return nil
	}
	var errs []error
	// The statements that clear values are sent in key order.
	for _, key := range slices.Sorted(maps.Keys(locals)) {
		if _, err := t.machinery().exec(t.ctx, KindUtility, nil, "SET @`orm."+key+"` = NULL"); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// Local returns a value set with SetLocal; NO_ROWS when it is missing.
func (u *Utils) Local(key string) (string, error) {
	if err := u.db.unsupportedOnMarkdown("local"); err != nil {
		return "", err
	}
	t, err := u.active("local")
	if err != nil {
		return "", err
	}
	v, ok := t.locals[key]
	if !ok {
		return "", &ir.Error{Code: CodeNoRows, Msg: "local value " + key + " is not set"}
	}
	return v, nil
}

// WasInserted reports whether a generated ORM insert for entity and its
// signed sequence key succeeded in the active transaction. The fact is local
// to the transaction, is restored across savepoint rollback, and is identical
// for every adapter. It does not inspect driver-specific transaction state.
func (u *Utils) WasInserted(entity string, key int64) (bool, error) {
	t, err := u.active("wasInserted")
	if err != nil {
		return false, err
	}
	if entity == "" || key <= 0 {
		return false, configErr("inserted entity and positive key are required")
	}
	_, ok := t.inserted[entity][key]
	return ok, nil
}

// SchemaUtils installs and inspects schemas.
type SchemaUtils struct{ u *Utils }

// Schema returns the schema utilities.
func (u *Utils) Schema() *SchemaUtils { return &SchemaUtils{u: u} }

// Register registers the generated schema's set on this connection. It reads and writes no database:
// it checks that the manifest text hashes to the declared hash (otherwise CONFIG) and only registers
// the set as a runtime model. Registering the same set again changes nothing. Whether the database matches the set
// is checked by Install and AddTablesAndColumns at install and upgrade time, and on connections opened for each request too,
// since Register registers the set without any statement (docs/spec/schema.md "Schema registration").
func (s *SchemaUtils) Register(schema *Schema) error {
	return s.u.db.register(schema)
}

// Install renders the generated schema's document set in this connection's dialect and applies it,
// then checks that the database matches the set and registers the set on this connection. The manifest
// text that does not hash to the declared hash is CONFIG before any statement. Install introspects the
// database; if a table that an external document uses differs from that document, it is CONFIG. If none of the set's
// owned tables exist, it creates them all; if all exist, it creates nothing; if only some exist,
// it is CONFIG. Then it reads the database again, compares the set's owned tables with the set, and if there is any
// difference, it is CONFIG with all the differences (docs/spec/schema.md "Schema installation").
// PostgreSQL and SQLite apply in an ongoing transaction or a new one, so a failed
// install leaves nothing behind. MySQL implicitly commits schema statements, so it applies them
// outside a transaction, and it is CONFIG inside one.
func (s *SchemaUtils) Install(schema *Schema) error {
	d := s.u.db
	if err := d.unsupportedOnMarkdown("schema install (flowmark install creates a corpus)"); err != nil {
		return err
	}
	m, err := schema.registered()
	if err != nil {
		return err
	}
	statements, diagnostics := dbspec.RenderStatements(m.Documents, dbspec.Dialect(d.driver))
	if len(diagnostics) > 0 {
		return &ir.Error{Code: CodeSchemaInvalid, Msg: runtimemodel.DiagnosticsError(diagnostics)}
	}
	target, err := schemaTarget(m)
	if err != nil {
		return err
	}
	if d.driver == "mysql" && activeFor(d) != nil {
		return configErr("MySQL commits schema statements implicitly; install outside a transaction")
	}
	dialect := dbspec.Dialect(d.driver)
	apply := func(ctx context.Context, r runner) error {
		q := &observed{r: r, kind: KindSchema, tables: noTables}
		live, unsupported, err := introspectSet(ctx, q, dialect, m)
		if err != nil {
			return err
		}
		found := map[string]bool{}
		for _, t := range live.Tables {
			found[t.Name] = true
		}
		for _, u := range unsupported {
			found[u.Table] = true
		}
		var present, missing []string
		for _, t := range target.Tables {
			if found[t.Name] {
				present = append(present, t.Name)
			} else {
				missing = append(missing, t.Name)
			}
		}
		switch {
		case len(missing) == 0:
		case len(present) > 0:
			return configErr("the manifest is partly installed: tables %s exist and %s do not", strings.Join(present, ", "), strings.Join(missing, ", "))
		default:
			for _, statement := range statements {
				if _, err := r.exec(ctx, KindSchema, []string{statement.Table}, statement.SQL); err != nil {
					return err
				}
			}
			if live, unsupported, err = dbspec.Introspect(ctx, q, dialect, "schema"); err != nil {
				return mapDriverErr(err)
			}
		}
		return setDiffers(dbspec.InstalledDifferences(live, unsupported, target))
	}
	if d.driver == "mysql" {
		err = apply(d.ctx, runner{d: d, q: d.sql})
	} else {
		err = s.u.run(func(t *txConn) error { return apply(t.ctx, t.run()) })
	}
	if err != nil {
		return err
	}
	return d.register(schema)
}

// AddTablesAndColumns upgrades an installed document set to a new version of the generated schema,
// only by adding (docs/spec/schema.md "Adding tables and columns"). It introspects the connection's database and compares the
// set's tables present in the database with the set. It creates the set's tables that are absent from the database,
// with their index, foreign key, check, and trigger, and adds to existing tables the columns that are missing
// and are nullable or have a default. It runs the plan steps of dbspec.AddTablesAndColumnsSteps, so the audit triggers
// of changed tables are also changed to record the new columns.
// It leaves tables of other sets as they are and does not register the set. If a table an external document uses
// differs from the database, it is CONFIG before any statement. Other differences are
// SCHEMA_DIFFERS before any statement. If the manifest text does not hash to the declared hash, it is CONFIG first.
// PostgreSQL applies in an ongoing or new transaction. MySQL implicitly commits schema
// statements, and SQLite re-creates tables with foreign keys off and adds
// columns; foreign key settings do not change inside a transaction, so both are applied outside one and are CONFIG inside.
// It returns created tables as "table" and added columns as
// "table.column", in table name and column order.
func (s *SchemaUtils) AddTablesAndColumns(schema *Schema) ([]string, error) {
	d := s.u.db
	if err := d.unsupportedOnMarkdown("addTablesAndColumns (schema evolution follows the flowmark migration rules)"); err != nil {
		return nil, err
	}
	m, err := schema.registered()
	if err != nil {
		return nil, err
	}
	target, err := schemaTarget(m)
	if err != nil {
		return nil, err
	}
	dialect := dbspec.Dialect(d.driver)
	var added []string
	apply := func(ctx context.Context, r runner) error {
		q := &observed{r: r, kind: KindSchema, tables: noTables}
		live, unsupported, err := introspectSet(ctx, q, dialect, m)
		if err != nil {
			return err
		}
		additions, steps, differences := dbspec.AddTablesAndColumnsSteps(live, unsupported, target, dialect)
		if len(differences) > 0 {
			return &ir.Error{Code: CodeSchemaDiffers, Msg: "the existing tables of the document set differ beyond missing tables, missing columns that are null or have a default and missing indexes: " + strings.Join(differences, "; ")}
		}
		for _, step := range steps {
			var tables []string
			if step.Effect.Table != "" {
				tables = []string{step.Effect.Table}
			}
			if _, err := r.exec(ctx, KindSchema, tables, step.Statement); err != nil {
				return err
			}
		}
		// After running the steps, it rereads the database and checks that it matches the set.
		if len(steps) > 0 {
			if live, unsupported, err = dbspec.Introspect(ctx, q, dialect, "schema"); err != nil {
				return mapDriverErr(err)
			}
		}
		if err := setDiffers(dbspec.InstalledDifferences(live, unsupported, target)); err != nil {
			return err
		}
		added = additions
		return nil
	}
	switch {
	case d.driver == "postgres":
		err = s.u.run(func(t *txConn) error { return apply(t.ctx, t.run()) })
	case activeFor(d) != nil:
		return nil, configErr("%s adds tables and columns outside a transaction: MySQL commits schema statements implicitly and SQLite turns foreign keys off to rebuild a table", d.driver)
	case d.driver == "mysql":
		err = apply(d.ctx, runner{d: d, q: d.sql})
	default:
		err = sqliteWithoutForeignKeys(d, apply)
	}
	if err != nil {
		return nil, err
	}
	return added, nil
}

// introspectSet introspects the connection's database, and if the set uses a table from an external document
// and that table differs from the external document, it is CONFIG (docs/spec/dbspec.md "External documents").
func introspectSet(ctx context.Context, q dbspec.Querier, dialect dbspec.Dialect, m *runtimemodel.Model) (*dbspec.Document, []dbspec.Unsupported, error) {
	live, unsupported, err := dbspec.Introspect(ctx, q, dialect, "schema")
	if err != nil {
		return nil, nil, mapDriverErr(err)
	}
	if differences := dbspec.ExternalDifferences(live, m.Documents); len(differences) > 0 {
		return nil, nil, externalErr(differences)
	}
	return live, unsupported, nil
}

// setDiffers is the CONFIG that carries all differences when the database differs from the set.
func setDiffers(differences []string) error {
	if len(differences) == 0 {
		return nil
	}
	return configErr("the database differs from the document set: %s", strings.Join(differences, "; "))
}

// schemaTarget is the schema text document of the set. It is the target compared with the database.
func schemaTarget(m *runtimemodel.Model) (*dbspec.Document, error) {
	manifest, diagnostics := dbspec.ManifestOf(m.Documents)
	if len(diagnostics) > 0 {
		return nil, &ir.Error{Code: CodeSchemaInvalid, Msg: runtimemodel.DiagnosticsError(diagnostics)}
	}
	target, _, diagnostics := dbspec.Parse(manifest.SchemaText, externalTexts(m))
	if len(diagnostics) > 0 {
		return nil, &ir.Error{Code: CodeSchemaInvalid, Msg: runtimemodel.DiagnosticsError(diagnostics)}
	}
	return target, nil
}

func externalErr(differences []string) error {
	return configErr("the tables that the set uses from external documents differ from the database: %s", strings.Join(differences, "; "))
}

// externalTexts returns the external document texts of the set for each document name. It is used when parsing the use
// lines of the schema text.
func externalTexts(m *runtimemodel.Model) map[string]string {
	out := map[string]string{}
	for _, d := range m.Documents {
		if d.External {
			out[d.Name] = dbspec.Emit(d)
		}
	}
	return out
}

// sqliteWithoutForeignKeys turns off foreign keys on one connection, runs fn in a BEGIN IMMEDIATE
// transaction, and commits only when the foreign key check returns no rows; then it turns foreign keys back on
// (the SQLite table rebuild in docs/spec/plans.md "Apply").
// A connection that cannot turn foreign keys back on is closed rather than returned to the pool.
func sqliteWithoutForeignKeys(d *DB, fn func(ctx context.Context, r runner) error) (err error) {
	ctx := d.ctx
	conn, err := d.sql.Conn(ctx)
	if err != nil {
		return mapDriverErr(err)
	}
	restored := false
	defer func() {
		if !restored {
			// A connection whose foreign keys may have been turned off is discarded.
			err = errors.Join(err, conn.Raw(func(any) error { return driver.ErrBadConn }))
		}
		if closeErr := conn.Close(); closeErr != nil && !errors.Is(closeErr, driver.ErrBadConn) {
			err = errors.Join(err, mapDriverErr(closeErr))
		}
	}()
	outside := runner{d: d, q: conn}
	if _, err := outside.exec(ctx, KindUtility, nil, "PRAGMA foreign_keys = OFF"); err != nil {
		return err
	}
	inside := runner{d: d, q: conn, tx: d.nextTransaction()}
	if _, err := inside.exec(ctx, KindBegin, nil, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	err = fn(ctx, inside)
	if err == nil {
		var broken int
		if err = inside.scan(ctx, KindSchema, nil, "SELECT COUNT(*) FROM pragma_foreign_key_check", nil, &broken); err == nil && broken > 0 {
			err = &ir.Error{Code: CodeInternal, Msg: fmt.Sprintf("the rebuilt tables break %d foreign keys", broken)}
		}
	}
	if err != nil {
		if _, rollbackErr := inside.exec(ctx, KindRollback, nil, "ROLLBACK"); rollbackErr != nil {
			err = rollbackFailed(err, rollbackErr)
		}
	} else {
		_, err = inside.exec(ctx, KindCommit, nil, "COMMIT")
	}
	if _, onErr := outside.exec(ctx, KindUtility, nil, "PRAGMA foreign_keys = ON"); onErr != nil {
		return errors.Join(err, onErr)
	}
	restored = true
	return err
}

func (s *SchemaUtils) exists(query string, args ...any) (bool, error) {
	if err := s.u.db.unsupportedOnMarkdown("schema inspection"); err != nil {
		return false, err
	}
	var found bool
	err := s.u.read(func(ctx context.Context, r runner) error {
		return r.scan(ctx, KindSchema, nil, query, args, &found)
	})
	return found, err
}

// Exists reports whether a schema exists.
func (s *SchemaUtils) Exists(name string) (bool, error) {
	if !validKey(name) {
		return false, configErr("schema name %q is invalid", name)
	}
	switch s.u.db.driver {
	case "postgres":
		return s.exists("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = $1)", name)
	case "mysql":
		return s.exists("SELECT EXISTS(SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?)", name)
	default:
		return s.exists("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name LIKE ? ESCAPE '\\')", strings.ReplaceAll(name, "_", `\_`)+`\_\_%`)
	}
}

// Installed reports whether a table of a schema exists.
func (s *SchemaUtils) Installed(name, table string) (bool, error) {
	if !validKey(name) || !validKey(table) {
		return false, configErr("schema and table names are required")
	}
	switch s.u.db.driver {
	case "postgres":
		return s.exists("SELECT to_regclass($1) IS NOT NULL", name+"."+table)
	case "mysql":
		return s.exists("SELECT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?)", name, table)
	default:
		return s.exists("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?)", name+"__"+table)
	}
}

// Empty reports whether the database holds no user content. On PostgreSQL a
// schema other than public, information_schema and the pg_ schemas is content
// even without objects, and so is a table, partitioned table, view,
// materialized view or foreign table in public. On MySQL a table or view of the
// connected database is content, and on SQLite a table or view other than the
// sqlite_ and orm__ tables is content.
func (s *SchemaUtils) Empty() (bool, error) {
	switch s.u.db.driver {
	case "postgres":
		return s.exists(`SELECT NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema' AND (n.nspname <> 'public' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'v', 'm', 'f'))))`)
	case "mysql":
		return s.exists("SELECT NOT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE())")
	default:
		return s.exists(`SELECT NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name NOT LIKE 'orm\_\_%' ESCAPE '\')`)
	}
}

// PrivilegeUtils changes and inspects table privileges (PostgreSQL only).
type PrivilegeUtils struct{ u *Utils }

// Privileges returns the privilege utilities.
func (u *Utils) Privileges() *PrivilegeUtils { return &PrivilegeUtils{u: u} }

// TablePrivileges describes the privileges of the current user on a table.
type TablePrivileges struct {
	Insert   bool
	Select   bool
	Update   bool
	Delete   bool
	Truncate bool
}

func (p *PrivilegeUtils) table(table string) (string, error) {
	if p.u.db.driver != "postgres" {
		return "", &ir.Error{Code: CodeCapabilityUnsupported, Msg: "table privileges are supported only by postgres"}
	}
	parts := strings.Split(table, ".")
	if len(parts) != 2 || !validKey(parts[0]) || !validKey(parts[1]) {
		return "", configErr("a qualified table name is required")
	}
	return quoteIdentifier("postgres", parts[0]) + "." + quoteIdentifier("postgres", parts[1]), nil
}

func role(name string) (string, error) {
	if !validKey(name) {
		return "", configErr("role %q is invalid", name)
	}
	return quoteIdentifier("postgres", name), nil
}

// GrantTable grants schema usage and SELECT, INSERT, UPDATE, DELETE on a table.
func (p *PrivilegeUtils) GrantTable(table, roleName string) error {
	qualified, err := p.table(table)
	if err != nil {
		return err
	}
	r, err := role(roleName)
	if err != nil {
		return err
	}
	schemaName := qualified[:strings.Index(qualified, ".")]
	return p.u.run(func(t *txConn) error {
		for _, statement := range []string{
			"GRANT USAGE ON SCHEMA " + schemaName + " TO " + r,
			"GRANT SELECT, INSERT, UPDATE, DELETE ON " + qualified + " TO " + r,
		} {
			if _, err := t.run().exec(t.ctx, KindUtility, []string{table}, statement); err != nil {
				return err
			}
		}
		return nil
	})
}

// RevokeTable revokes one privilege on a table.
func (p *PrivilegeUtils) RevokeTable(table, privilege, roleName string) error {
	qualified, err := p.table(table)
	if err != nil {
		return err
	}
	r, err := role(roleName)
	if err != nil {
		return err
	}
	privilege = strings.ToUpper(strings.TrimSpace(privilege))
	if !slices.Contains([]string{"SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"}, privilege) {
		return configErr("unsupported table privilege %q", privilege)
	}
	return p.u.run(func(t *txConn) error {
		_, err := t.run().exec(t.ctx, KindUtility, []string{table}, "REVOKE "+privilege+" ON "+qualified+" FROM "+r)
		return err
	})
}

// InspectTable reports the privileges of the current user on a table.
func (p *PrivilegeUtils) InspectTable(table string) (TablePrivileges, error) {
	qualified, err := p.table(table)
	if err != nil {
		return TablePrivileges{}, err
	}
	var out TablePrivileges
	err = p.u.read(func(ctx context.Context, r runner) error {
		return r.scan(ctx, KindUtility, []string{table}, "SELECT has_table_privilege(current_user, $1, 'INSERT'), has_table_privilege(current_user, $1, 'SELECT'), has_table_privilege(current_user, $1, 'UPDATE'), has_table_privilege(current_user, $1, 'DELETE'), has_table_privilege(current_user, $1, 'TRUNCATE')", []any{qualified},
			&out.Insert, &out.Select, &out.Update, &out.Delete, &out.Truncate)
	})
	return out, err
}

// AESUtils reports and rotates AES key versions.
type AESUtils struct{ u *Utils }

// Aes returns the AES utilities.
func (u *Utils) Aes() *AESUtils { return &AESUtils{u: u} }

// AESRotationStatus reports row counts by stored key version.
type AESRotationStatus struct {
	Current  int32
	Total    int64
	Pending  int64
	Versions map[int32]int64
}

type aesSpec struct {
	table   string
	keys    []string
	version string
	columns []aesColumn
}

type aesColumn struct {
	name   string
	styles []string
}

func (a *AESUtils) spec(m Model) (*aesSpec, error) {
	if err := a.u.db.unsupportedOnMarkdown("aes rotation"); err != nil {
		return nil, err
	}
	if m == nil {
		return nil, configErr("aes requires a model")
	}
	c := m.Orm_()
	ent, err := c.entityModel(a.u.db)
	if err != nil {
		return nil, err
	}
	spec := &aesSpec{table: ent.Table, keys: ent.PK, version: ent.AESVersion}
	for _, col := range ent.Fields {
		if col.Encrypted() {
			var host []string
			for _, s := range col.Codec {
				if s == "aes" || s == "hex" {
					host = append(host, s)
				}
			}
			spec.columns = append(spec.columns, aesColumn{name: col.Name, styles: host})
		}
	}
	if spec.version == "" || len(spec.columns) == 0 {
		return nil, configErr("entity %s has no AES columns with a key version", c.ent.Name)
	}
	return spec, nil
}

// Status reads the key version of every row of the model table.
func (a *AESUtils) Status(m Model, keyring AESKeyring) (AESRotationStatus, error) {
	status := AESRotationStatus{Current: keyring.current, Versions: map[int32]int64{}}
	spec, err := a.spec(m)
	if err != nil {
		return status, err
	}
	d := a.u.db
	version := quoteIdentifier(d.driver, spec.version)
	query := "SELECT " + version + ", COUNT(*) FROM " + quoteIdentifier(d.driver, spec.table) + " GROUP BY " + version + " ORDER BY " + version
	err = a.u.read(func(ctx context.Context, r runner) error {
		return r.rows(ctx, KindUtility, []string{spec.table}, query, nil, func(scan func(...any) error) error {
			var raw cell
			var count int64
			if err := scan(&raw, &count); err != nil {
				return mapDriverErr(err)
			}
			stored, err := rowVersion(raw.v)
			if err != nil {
				return err
			}
			status.Versions[stored] = count
			status.Total += count
			if stored != status.Current {
				status.Pending += count
			}
			return nil
		})
	})
	return status, err
}

// Rotate re-encrypts every AES column of every row that is not at the current
// key version, in one transaction, and returns the number of rotated rows.
func (a *AESUtils) Rotate(m Model, keyring AESKeyring) (int, error) {
	spec, err := a.spec(m)
	if err != nil {
		return 0, err
	}
	d := a.u.db
	q := func(name string) string { return quoteIdentifier(d.driver, name) }
	columns := make([]string, 0, len(spec.keys)+1+len(spec.columns))
	for _, k := range spec.keys {
		columns = append(columns, q(k))
	}
	columns = append(columns, q(spec.version))
	for _, c := range spec.columns {
		columns = append(columns, q(c.name))
	}
	selectSQL := "SELECT " + strings.Join(columns, ", ") + " FROM " + q(spec.table) + " WHERE " + q(spec.version) + " <> " + a.u.ph(1) + " ORDER BY " + strings.Join(columns[:len(spec.keys)], ", ") + " LIMIT 1000"
	sets := make([]string, 0, len(spec.columns)+1)
	for i, c := range spec.columns {
		sets = append(sets, q(c.name)+" = "+a.u.ph(i+1))
	}
	sets = append(sets, q(spec.version)+" = "+a.u.ph(len(spec.columns)+1))
	where := make([]string, 0, len(spec.keys)+1)
	for i, k := range spec.keys {
		where = append(where, q(k)+" = "+a.u.ph(len(spec.columns)+2+i))
	}
	where = append(where, q(spec.version)+" = "+a.u.ph(len(spec.columns)+2+len(spec.keys)))
	updateSQL := "UPDATE " + q(spec.table) + " SET " + strings.Join(sets, ", ") + " WHERE " + strings.Join(where, " AND ")
	rotated := 0
	err = a.u.run(func(t *txConn) error {
		rotated = 0
		rotationColumns := make([]AESRotationColumn, len(spec.columns))
		for i, c := range spec.columns {
			rotationColumns[i] = AESRotationColumn{Name: c.name, Styles: c.styles}
		}
		for {
			var batch []map[string]any
			err := t.run().rows(t.ctx, KindUtility, []string{spec.table}, selectSQL, []any{keyring.current}, func(scan func(...any) error) error {
				cells := make([]cell, len(columns))
				dest := make([]any, len(columns))
				for i := range cells {
					dest[i] = &cells[i]
				}
				if err := scan(dest...); err != nil {
					return mapDriverErr(err)
				}
				row := map[string]any{}
				for i, k := range spec.keys {
					row[k] = cells[i].v
				}
				row[spec.version] = cells[len(spec.keys)].v
				for i, c := range spec.columns {
					row[c.name] = cells[len(spec.keys)+1+i].v
				}
				batch = append(batch, row)
				return nil
			})
			if err != nil {
				return err
			}
			if len(batch) == 0 {
				return nil
			}
			for _, before := range batch {
				version, err := rowVersion(before[spec.version])
				if err != nil {
					return err
				}
				before[spec.version] = version
				after, err := RotateAESRow(before, spec.version, rotationColumns, keyring.current, keyring)
				if err != nil {
					return err
				}
				args := make([]any, 0, len(spec.columns)+len(spec.keys)+2)
				for _, c := range spec.columns {
					args = append(args, after[c.name])
				}
				args = append(args, keyring.current)
				for _, k := range spec.keys {
					args = append(args, before[k])
				}
				args = append(args, version)
				res, err := t.run().exec(t.ctx, KindUtility, []string{spec.table}, updateSQL, args...)
				if err != nil {
					return err
				}
				if n, err := res.RowsAffected(); err != nil || n != 1 {
					return TransactionConflict(fmt.Sprintf("aes rotation of %s changed %d rows", spec.table, n))
				}
				rotated++
			}
		}
	})
	return rotated, err
}

// AESRotationColumn names one AES column and its host stages.
type AESRotationColumn struct {
	Name   string
	Styles []string
}
