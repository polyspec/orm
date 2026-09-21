package orm

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/schema"
	"github.com/polyspec/orm/internal/ormgen"
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

// read executes fn on the active transaction or the connection.
func (u *Utils) read(fn func(ctx context.Context, q querier) error) error {
	if t := activeFor(u.db); t != nil {
		return fn(t.ctx, t.tx)
	}
	return fn(u.db.ctx, u.db.sql)
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
		if err := t.tx.QueryRowContext(t.ctx, "SELECT GET_LOCK(?, 50)", key).Scan(&got); err != nil {
			return mapDriverErr(err)
		}
		if !got.Valid || got.Int64 != 1 {
			return TransactionConflict("lock " + key + " was not acquired")
		}
		t.locks = append(t.locks, key)
	case "postgres":
		if _, err := t.tx.ExecContext(t.ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", key); err != nil {
			return mapDriverErr(err)
		}
	default:
		return acquireSQLiteRowLock(t.ctx, t, "update")
	}
	return nil
}

// releaseLocks releases MySQL named locks before the transaction ends.
func (t *txConn) releaseLocks() {
	for _, key := range t.locks {
		_, _ = t.tx.ExecContext(t.ctx, "SELECT RELEASE_LOCK(?)", key)
	}
	t.locks = nil
}

// SetLocal sets a transaction-local value.
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
		if _, err := t.tx.ExecContext(t.ctx, "SELECT set_config($1, $2, true)", key, value); err != nil {
			return mapDriverErr(err)
		}
	case "mysql":
		if _, err := t.tx.ExecContext(t.ctx, "SET @`orm."+key+"` = ?", value); err != nil {
			return mapDriverErr(err)
		}
	default:
		if _, err := t.tx.ExecContext(t.ctx, `CREATE TABLE IF NOT EXISTS "orm__context" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`); err != nil {
			return mapDriverErr(err)
		}
		if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO "orm__context" ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"`, key, value); err != nil {
			return mapDriverErr(err)
		}
		t.contextRow = true
	}
	if t.locals == nil {
		t.locals = map[string]string{}
	}
	t.locals[key] = value
	return nil
}

// clearLocals resets MySQL session variables before the transaction ends.
func (t *txConn) clearLocals() {
	if t.db.driver != "mysql" {
		return
	}
	for key := range t.locals {
		_, _ = t.tx.ExecContext(t.ctx, "SET @`orm."+key+"` = NULL")
	}
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

// Install installs the canonical schema manifest and registers it with the
// connection. PostgreSQL and SQLite apply it in the active transaction or in a
// new one; MySQL commits schema statements implicitly, so it applies them
// outside a transaction and returns CONFIG inside one.
func (s *SchemaUtils) Install(manifestJSON []byte) error {
	d := s.u.db
	manifest, err := schema.Load(manifestJSON)
	if err != nil {
		return configErr("invalid schema manifest: %v", err)
	}
	compiled, err := engine.New(manifest, d.driver)
	if err != nil {
		return configErr("compile schema: %v", err)
	}
	ddl, err := ormgen.RenderCreateDDL(manifest, d.driver)
	if err != nil {
		return configErr("render schema: %v", err)
	}
	statements := ormgen.SplitSQL(ddl)
	if len(statements) == 0 {
		return configErr("schema manifest produced no statements")
	}
	apply := func(ctx context.Context, q querier) error {
		for _, statement := range statements {
			if _, err := q.ExecContext(ctx, statement); err != nil {
				return mapDriverErr(err)
			}
		}
		return nil
	}
	if d.driver == "mysql" {
		if activeFor(d) != nil {
			return configErr("MySQL commits schema statements implicitly; install outside a transaction")
		}
		err = apply(d.ctx, d.sql)
	} else {
		err = s.u.run(func(t *txConn) error { return apply(t.ctx, t.tx) })
	}
	if err != nil {
		return err
	}
	d.m.engineMu.Lock()
	d.engines[manifest.SchemaHash] = compiled
	d.m.engineMu.Unlock()
	return RegisterEngine(compiled)
}

func (s *SchemaUtils) exists(query string, args ...any) (bool, error) {
	var found bool
	err := s.u.read(func(ctx context.Context, q querier) error {
		return mapDriverErr(q.QueryRowContext(ctx, query, args...).Scan(&found))
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

// Empty reports whether the database has no user tables.
func (s *SchemaUtils) Empty() (bool, error) {
	switch s.u.db.driver {
	case "postgres":
		return s.exists(`SELECT NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'p', 'v', 'm', 'f'))`)
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
			if _, err := t.tx.ExecContext(t.ctx, statement); err != nil {
				return mapDriverErr(err)
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
		_, err := t.tx.ExecContext(t.ctx, "REVOKE "+privilege+" ON "+qualified+" FROM "+r)
		return mapDriverErr(err)
	})
}

// InspectTable reports the privileges of the current user on a table.
func (p *PrivilegeUtils) InspectTable(table string) (TablePrivileges, error) {
	qualified, err := p.table(table)
	if err != nil {
		return TablePrivileges{}, err
	}
	var out TablePrivileges
	err = p.u.read(func(ctx context.Context, q querier) error {
		return mapDriverErr(q.QueryRowContext(ctx, `SELECT has_table_privilege(current_user, $1, 'INSERT'), has_table_privilege(current_user, $1, 'SELECT'),
 has_table_privilege(current_user, $1, 'UPDATE'), has_table_privilege(current_user, $1, 'DELETE'), has_table_privilege(current_user, $1, 'TRUNCATE')`, qualified).
			Scan(&out.Insert, &out.Select, &out.Update, &out.Delete, &out.Truncate))
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
	ent := c.entitySchema(a.u.db)
	if ent == nil {
		return nil, configErr("entity %s is not registered for the connection", c.ent.Name)
	}
	spec := &aesSpec{table: ent.Table, keys: ent.PK, version: ent.AESVersion}
	for _, col := range ent.Columns {
		if slices.Contains(col.Styles, "aes") {
			var host []string
			for _, s := range col.Styles {
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
	err = a.u.read(func(ctx context.Context, q querier) error {
		rows, err := q.QueryContext(ctx, query)
		if err != nil {
			return mapDriverErr(err)
		}
		defer rows.Close()
		for rows.Next() {
			var raw cell
			var count int64
			if err := rows.Scan(&raw, &count); err != nil {
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
		}
		return mapDriverErr(rows.Err())
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
			rows, err := t.tx.QueryContext(t.ctx, selectSQL, keyring.current)
			if err != nil {
				return mapDriverErr(err)
			}
			var batch []map[string]any
			for rows.Next() {
				cells := make([]cell, len(columns))
				dest := make([]any, len(columns))
				for i := range cells {
					dest[i] = &cells[i]
				}
				if err := rows.Scan(dest...); err != nil {
					rows.Close()
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
			}
			if err := rows.Close(); err != nil {
				return mapDriverErr(err)
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
				res, err := t.tx.ExecContext(t.ctx, updateSQL, args...)
				if err != nil {
					return mapDriverErr(err)
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
