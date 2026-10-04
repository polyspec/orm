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

	"github.com/polyspec/orm/engine/dbspec"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/runtimemodel"
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
		if !(r == '.' || r == '_' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9') || i == 0 && r == '.' {
			return false
		}
	}
	return true
}

// Lock takes a named lock that is released when the transaction ends.
func (u *Utils) Lock(key string) error {
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

// releaseLocks는 transaction이 끝나기 전에 MySQL named lock을 푼다. named lock은
// COMMIT과 ROLLBACK 뒤에도 connection에 남으므로 실패한 해제와 1이 아닌
// RELEASE_LOCK 결과(lock을 갖고 있지 않음)를 모두 오류로 돌려준다. 한 번 시도한
// lock은 다시 풀지 않는다.
func (t *txConn) releaseLocks() error {
	locks := t.locks
	t.locks = nil
	var errs []error
	for _, key := range locks {
		var released sql.NullInt64
		if err := t.run().scan(t.ctx, KindUtility, nil, "SELECT RELEASE_LOCK(?)", []any{key}, &released); err != nil {
			errs = append(errs, err)
			continue
		}
		if !released.Valid || released.Int64 != 1 {
			errs = append(errs, configErr("lock %s was not held at transaction end", key))
		}
	}
	return errors.Join(errs...)
}

// SetLocal은 transaction-local 값을 정한다. PostgreSQL은 set_config, MySQL은
// user variable에 쓰고 SQLite는 transaction 안에만 둔다.
func (u *Utils) SetLocal(key, value string) error {
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

// clearLocals는 transaction이 끝나기 전에 MySQL session variable을 지운다.
// MySQL user variable은 COMMIT과 ROLLBACK 뒤에도 connection에 남으므로
// (mysql.context.user_variable_session_scope) 실패한 reset은 오류로 돌려준다.
// 한 번 시도한 값은 다시 지우지 않는다.
func (t *txConn) clearLocals() error {
	locals := t.locals
	t.locals = nil
	if t.db.driver != "mysql" {
		return nil
	}
	var errs []error
	// 값을 지우는 statement는 key 순서로 보낸다.
	for _, key := range slices.Sorted(maps.Keys(locals)) {
		if _, err := t.run().exec(t.ctx, KindUtility, nil, "SET @`orm."+key+"` = NULL"); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// Local returns a value set with SetLocal; NO_ROWS when it is missing.
func (u *Utils) Local(key string) (string, error) {
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

// Register는 generated schema의 set을 이 연결에 등록한다. database를 읽거나 쓰지 않는다:
// manifest text가 선언한 hash로 hash되는지 확인하고(아니면 CONFIG) runtime model로 set을
// 등록할 뿐이다. 같은 set을 다시 등록하면 아무것도 바꾸지 않는다. database가 set과 같은지는
// Install과 AddTablesAndColumns가 설치와 upgrade 때 확인하며, 요청마다 연 연결에도
// Register가 statement 없이 set을 등록한다(docs/schema.md "Schema registration").
func (s *SchemaUtils) Register(schema *Schema) error {
	return s.u.db.register(schema)
}

// Install은 generated schema의 document set을 이 연결의 dialect로 render해
// 적용하고, database가 set과 같은지 확인한 뒤 그 set을 이 연결에 등록한다. manifest
// text가 선언한 hash로 hash되지 않으면 어떤 statement보다 먼저 CONFIG다. 연결의
// database를 introspect해, 외부 문서에서 쓰는 table이 외부 문서와 다르면 CONFIG다. set이
// 소유한 table이 하나도 없으면 모두 만들고, 모두 있으면 아무것도 만들지 않으며, 일부만
// 있으면 CONFIG다. 그다음 database를 다시 읽어 set이 소유한 table을 set과 비교하고, 차이가
// 있으면 그 차이를 모두 담은 CONFIG다(docs/schema.md "Schema installation").
// PostgreSQL과 SQLite는 진행 중인 transaction이나 새 transaction에서 적용하므로 실패한
// install은 아무것도 남기지 않는다. MySQL은 schema statement를 암묵적으로 commit하므로
// transaction 밖에서 적용하고 안에서는 CONFIG다.
func (s *SchemaUtils) Install(schema *Schema) error {
	d := s.u.db
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

// AddTablesAndColumns는 설치한 document set을 generated schema의 새 version으로
// 더해서만 올린다(docs/schema.md "Adding tables and columns"). 연결의 database를
// introspect해 database에 있는 set의 table을 set과 비교하고, database에 없는 set의
// table을 index, foreign key, check, trigger와 함께 만들며, 있는 table에 빠진 column
// 가운데 null이거나 default가 있는 column을 더한다. dbspec.AddTablesAndColumnsSteps의
// plan step을 실행하므로 바뀐 table의 audit trigger도 새 column을 기록하도록 바뀐다.
// 다른 set의 table은 그대로 두며 set을 등록하지 않는다. 외부 문서에서 쓰는 table이
// database와 다르면 어떤 statement보다 먼저 CONFIG다. 다른 차이는 어떤 statement보다
// 먼저 SCHEMA_DIFFERS다. manifest text가 선언한 hash로 hash되지 않으면 먼저 CONFIG다.
// PostgreSQL은 진행 중인 transaction이나 새 transaction에서 적용한다. MySQL은 schema
// statement를 암묵적으로 commit하고, SQLite는 foreign key를 끈 채 table을 다시 만들어
// column을 더하는데 foreign key 설정은 transaction 안에서 바뀌지 않으므로, 둘 다
// transaction 밖에서 적용하고 안에서는 CONFIG다. 만든 table은 "table", 더한 column은
// "table.column"으로 table 이름, column 순서로 돌려준다.
func (s *SchemaUtils) AddTablesAndColumns(schema *Schema) ([]string, error) {
	d := s.u.db
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
			return &ir.Error{Code: CodeSchemaDiffers, Msg: "the existing tables of the document set differ beyond missing tables and missing columns that are null or have a default: " + strings.Join(differences, "; ")}
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
		// step을 실행한 database가 set과 같은지 다시 읽어 확인한다.
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

// introspectSet은 연결의 database를 introspect하고, set이 외부 문서에서 쓰는 table이
// 외부 문서와 다르면 CONFIG다(docs/dbspec.md "External documents").
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

// setDiffers는 database가 set과 다를 때 그 차이를 모두 담은 CONFIG다.
func setDiffers(differences []string) error {
	if len(differences) == 0 {
		return nil
	}
	return configErr("the database differs from the document set: %s", strings.Join(differences, "; "))
}

// schemaTarget은 set의 schema text 문서다. database와 비교하는 대상이다.
func schemaTarget(m *runtimemodel.Model) (*dbspec.Document, error) {
	manifest, diagnostics := dbspec.ManifestOf(m.Documents)
	if len(diagnostics) > 0 {
		return nil, &ir.Error{Code: CodeSchemaInvalid, Msg: runtimemodel.DiagnosticsError(diagnostics)}
	}
	target, diagnostics := dbspec.Parse(manifest.SchemaText, externalTexts(m))
	if len(diagnostics) > 0 {
		return nil, &ir.Error{Code: CodeSchemaInvalid, Msg: runtimemodel.DiagnosticsError(diagnostics)}
	}
	return target, nil
}

func externalErr(differences []string) error {
	return configErr("the tables that the set uses from external documents differ from the database: %s", strings.Join(differences, "; "))
}

// externalTexts는 set의 외부 문서 text를 문서 이름마다 돌려준다. schema text의 use
// 줄을 parse할 때 쓴다.
func externalTexts(m *runtimemodel.Model) map[string]string {
	out := map[string]string{}
	for _, d := range m.Documents {
		if d.External {
			out[d.Name] = dbspec.Emit(d)
		}
	}
	return out
}

// sqliteWithoutForeignKeys는 연결 하나에서 foreign key를 끄고 BEGIN IMMEDIATE
// transaction으로 fn을 실행한 뒤 foreign key 검사가 row를 돌려주지 않을 때만
// commit하고 foreign key를 다시 켠다(docs/plans.md "Apply"의 SQLite 다시 만들기).
// foreign key를 다시 켜지 못한 연결은 pool에 돌려주지 않고 닫는다.
func sqliteWithoutForeignKeys(d *DB, fn func(ctx context.Context, r runner) error) (err error) {
	ctx := d.ctx
	conn, err := d.sql.Conn(ctx)
	if err != nil {
		return mapDriverErr(err)
	}
	restored := false
	defer func() {
		if !restored {
			// foreign key가 꺼졌을 수 있는 연결은 버린다.
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
		return r.scan(ctx, KindUtility, []string{table}, `SELECT has_table_privilege(current_user, $1, 'INSERT'), has_table_privilege(current_user, $1, 'SELECT'),
 has_table_privilege(current_user, $1, 'UPDATE'), has_table_privilege(current_user, $1, 'DELETE'), has_table_privilege(current_user, $1, 'TRUNCATE')`, []any{qualified},
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
