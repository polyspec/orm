package orm

import (
	"context"
	"slices"
	"strings"
)

// CatalogAssignment is one named column value of a row change.
type CatalogAssignment struct {
	Name  string
	Value any
}

// CatalogMutationResult is the row that a change left in the table, re-read by its keys inside the change's transaction.
type CatalogMutationResult struct {
	Columns []string
	Rows    [][]any
}

// catalogChange is one checked assignment: the index of its column and its normalized value.
type catalogChange struct {
	index int
	value any
}

// catalogChanges checks named assignments against a descriptor and returns them in the order given. Unknown, duplicate
// and generated columns, a NULL in a non-null column and unsupported values fail before any statement runs.
func catalogChanges(metadata CatalogTableMetadata, values []CatalogAssignment, code string) ([]catalogChange, error) {
	if len(values) == 0 || len(values) > len(metadata.Columns) {
		return nil, catalogErr(code, "invalid column assignments")
	}
	params := make([]any, len(values))
	for i, assignment := range values {
		params[i] = assignment.Value
	}
	normalized, err := catalogParams(params)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	changes := make([]catalogChange, 0, len(values))
	for i, assignment := range values {
		index := slices.IndexFunc(metadata.Columns, func(column CatalogColumn) bool { return column.Name == assignment.Name })
		if index < 0 {
			return nil, catalogErr(code, "unknown column %q", assignment.Name)
		}
		column := metadata.Columns[index]
		if seen[column.Name] {
			return nil, catalogErr(code, "duplicate column %q", column.Name)
		}
		if column.Generated {
			return nil, catalogErr(code, "generated column %q is not writable", column.Name)
		}
		if normalized[i] == nil && !column.Nullable {
			return nil, catalogErr(code, "NULL in non-null column %q", column.Name)
		}
		seen[column.Name] = true
		changes = append(changes, catalogChange{index: index, value: normalized[i]})
	}
	return changes, nil
}

// catalogColumnList is the quoted column list of a descriptor, in physical order.
func catalogColumnList(metadata CatalogTableMetadata, dialect string) string {
	names := make([]string, len(metadata.Columns))
	for i, column := range metadata.Columns {
		names[i] = column.Name
	}
	return catalogQuoteList(names, dialect)
}

// catalogKeyPredicate is the predicate of the primary key: each key column equals its placeholder, numbered from start.
func catalogKeyPredicate(metadata CatalogTableMetadata, dialect string, start int) string {
	parts := make([]string, len(metadata.PrimaryKey))
	for i, name := range metadata.PrimaryKey {
		parts[i] = catalogQuote(name, dialect) + "=" + catalogPlaceholder(start+i, dialect)
	}
	return strings.Join(parts, " AND ")
}

// lookup reads the rows that match the primary key of a descriptor, at most two. A lock takes FOR UPDATE on the server
// that supports it; SQLite's writable transaction already holds the database write lock.
func (s *catalogSession) lookup(metadata CatalogTableMetadata, keys []any, lock bool) ([][]any, error) {
	suffix := ""
	if lock && s.dialect != "sqlite" {
		suffix = " FOR UPDATE"
	}
	query := "SELECT " + catalogColumnList(metadata, s.dialect) + " FROM " + catalogQualified(metadata.Table, s.dialect) +
		" WHERE " + catalogKeyPredicate(metadata, s.dialect, 1) + " LIMIT 2" + suffix
	raw, err := s.queryRaw(query, keys, 2, catalogPageBytes)
	if err != nil {
		return nil, err
	}
	if err := catalogSameNames(raw.names, metadata.Columns); err != nil {
		return nil, err
	}
	return catalogConvert(raw, catalogNativeTypes(metadata))
}

// InsertRow inserts one row with explicit primary-key values inside a writable transaction. It rejects an existing key,
// writes with bound parameters, requires exactly one affected row and re-reads the row by its key before it commits.
// Every supplied value must read back exactly. Automatic and expression-default keys are not supported and fail when
// the key is not given.
func (c *CatalogConnection) InsertRow(ctx context.Context, declared CatalogTableMetadata, values []CatalogAssignment) (CatalogMutationResult, error) {
	keyIndexes, err := catalogDescriptor(declared)
	if err != nil {
		return CatalogMutationResult{}, err
	}
	changes, err := catalogChanges(declared, values, "ROW_INSERT_INVALID")
	if err != nil {
		return CatalogMutationResult{}, err
	}
	provided := map[int]any{}
	for _, change := range changes {
		provided[change.index] = change.value
	}
	keys := make([]any, len(keyIndexes))
	for i, index := range keyIndexes {
		value, ok := provided[index]
		if !ok {
			return CatalogMutationResult{}, catalogErr("ROW_INSERT_INVALID", "explicit primary-key value of %q is required", declared.Columns[index].Name)
		}
		keys[i] = value
	}
	return catalogWrite(ctx, c, func(s *catalogSession) (CatalogMutationResult, error) {
		if c.dialect == "postgres" {
			// The lock that an INSERT takes, held before the schema check so that no DDL changes the table in between.
			if _, err := s.exec("LOCK TABLE "+catalogQualified(declared.Table, c.dialect)+" IN ROW EXCLUSIVE MODE", nil); err != nil {
				return CatalogMutationResult{}, err
			}
		}
		existing, err := s.lookup(declared, keys, true)
		if err != nil {
			return CatalogMutationResult{}, err
		}
		if len(existing) != 0 {
			return CatalogMutationResult{}, catalogErr(catalogCodeRowConflict, "insertion key already exists")
		}
		descriptor, err := s.describe(declared.Table)
		if err != nil {
			return CatalogMutationResult{}, err
		}
		if !sameDescriptor(descriptor, declared) {
			return CatalogMutationResult{}, catalogErr(catalogCodeRowSchema, "insertion descriptor changed")
		}
		if c.dialect == "mysql" {
			if err := s.mysqlSafety(descriptor); err != nil {
				return CatalogMutationResult{}, err
			}
		}
		names := make([]string, len(changes))
		placeholders := make([]string, len(changes))
		args := make([]any, len(changes))
		for i, change := range changes {
			names[i] = catalogQuote(descriptor.Columns[change.index].Name, c.dialect)
			placeholders[i] = catalogPlaceholder(i+1, c.dialect)
			args[i] = change.value
		}
		query := "INSERT INTO " + catalogQualified(descriptor.Table, c.dialect) + " (" + strings.Join(names, ",") + ") VALUES (" +
			strings.Join(placeholders, ",") + ")"
		affected, err := s.exec(query, args)
		if err != nil {
			return CatalogMutationResult{}, err
		}
		if affected != 1 {
			return CatalogMutationResult{}, catalogErr(catalogCodeRowWrite, "expected exactly one inserted row, got %d", affected)
		}
		after, err := s.lookup(descriptor, keys, false)
		if err != nil {
			return CatalogMutationResult{}, err
		}
		if len(after) != 1 {
			return CatalogMutationResult{}, catalogErr(catalogCodeRowWrite, "expected exactly one inserted row")
		}
		afterDescriptor, err := s.describe(declared.Table)
		if err != nil {
			return CatalogMutationResult{}, err
		}
		if !sameDescriptor(afterDescriptor, descriptor) {
			return CatalogMutationResult{}, catalogErr(catalogCodeRowSchema, "insertion descriptor changed")
		}
		for _, change := range changes {
			same, err := catalogSameCell(after[0][change.index], change.value)
			if err != nil {
				return CatalogMutationResult{}, err
			}
			if !same {
				return CatalogMutationResult{}, catalogErr(catalogCodeRowWrite, "stored inserted values of %q differ", descriptor.Columns[change.index].Name)
			}
		}
		return CatalogMutationResult{Columns: columnNames(descriptor), Rows: after}, nil
	})
}

// UpdateRow updates the row of an original snapshot. Inside the transaction it re-reads the row by its original keys,
// locks it, compares it with the snapshot and then writes. After the write it re-reads the row by its resulting keys and
// requires every ordinary column to hold the value that was written. A failed check rolls back.
func (c *CatalogConnection) UpdateRow(ctx context.Context, original CatalogRowSnapshot, values []CatalogAssignment) (CatalogMutationResult, error) {
	if err := original.valid(); err != nil {
		return CatalogMutationResult{}, err
	}
	changes, err := catalogChanges(original.metadata, values, "ROW_UPDATE_INVALID")
	if err != nil {
		return CatalogMutationResult{}, err
	}
	updated := slices.Clone(original.cells)
	for _, change := range changes {
		updated[change.index] = change.value
	}
	if err := catalogCheckCells(original.metadata, updated); err != nil {
		return CatalogMutationResult{}, catalogErr("ROW_UPDATE_INVALID", "invalid updated row: %v", err)
	}
	if _, err := catalogRevision(original.metadata, updated); err != nil {
		return CatalogMutationResult{}, catalogErr("ROW_UPDATE_LIMIT", "updated row budget exceeded: %v", err)
	}
	keys := original.keys()
	return catalogWrite(ctx, c, func(s *catalogSession) (CatalogMutationResult, error) {
		current, err := s.lookup(original.metadata, keys, true)
		if err != nil {
			return CatalogMutationResult{}, err
		}
		descriptor, err := s.describe(original.metadata.Table)
		if err != nil {
			return CatalogMutationResult{}, err
		}
		if !sameDescriptor(descriptor, original.metadata) {
			return CatalogMutationResult{}, catalogErr(catalogCodeRowSchema, "original descriptor changed")
		}
		if err := catalogCheckCurrent(current, original.cells); err != nil {
			return CatalogMutationResult{}, err
		}
		if c.dialect == "mysql" {
			if err := s.mysqlSafety(descriptor); err != nil {
				return CatalogMutationResult{}, err
			}
		}
		sets := make([]string, len(changes))
		args := make([]any, 0, len(changes)+len(keys))
		for i, change := range changes {
			sets[i] = catalogQuote(descriptor.Columns[change.index].Name, c.dialect) + "=" + catalogPlaceholder(i+1, c.dialect)
			args = append(args, change.value)
		}
		args = append(args, keys...)
		query := "UPDATE " + catalogQualified(descriptor.Table, c.dialect) + " SET " + strings.Join(sets, ",") +
			" WHERE " + catalogKeyPredicate(descriptor, c.dialect, len(changes)+1)
		affected, err := s.exec(query, args)
		if err != nil {
			return CatalogMutationResult{}, err
		}
		// MySQL reports zero for an update that changes nothing; the re-read below is the authority there.
		if affected > 1 || (affected == 0 && c.dialect != "mysql") {
			return CatalogMutationResult{}, catalogErr(catalogCodeRowWrite, "unexpected affected row count %d", affected)
		}
		newKeys := make([]any, len(original.keyIndexes))
		for i, index := range original.keyIndexes {
			newKeys[i] = updated[index]
		}
		after, err := s.lookup(descriptor, newKeys, false)
		if err != nil {
			return CatalogMutationResult{}, err
		}
		if len(after) != 1 {
			return CatalogMutationResult{}, catalogErr(catalogCodeRowWrite, "expected exactly one updated row, got %d", len(after))
		}
		afterDescriptor, err := s.describe(original.metadata.Table)
		if err != nil {
			return CatalogMutationResult{}, err
		}
		if !sameDescriptor(afterDescriptor, descriptor) {
			return CatalogMutationResult{}, catalogErr(catalogCodeRowSchema, "original descriptor changed")
		}
		for i, column := range descriptor.Columns {
			if column.Generated {
				// A generated column may be recomputed by the database.
				continue
			}
			same, err := catalogSameCell(after[0][i], updated[i])
			if err != nil {
				return CatalogMutationResult{}, err
			}
			if !same {
				return CatalogMutationResult{}, catalogErr(catalogCodeRowWrite, "stored ordinary values of %q differ", column.Name)
			}
		}
		return CatalogMutationResult{Columns: columnNames(descriptor), Rows: after}, nil
	})
}

// DeleteRow deletes the row of an original snapshot. Inside the transaction it locks and compares the row, requires exactly
// one affected row and verifies that no row remains under the key. It returns the number of rows deleted.
func (c *CatalogConnection) DeleteRow(ctx context.Context, original CatalogRowSnapshot) (int64, error) {
	if err := original.valid(); err != nil {
		return 0, err
	}
	keys := original.keys()
	return catalogWrite(ctx, c, func(s *catalogSession) (int64, error) {
		current, err := s.lookup(original.metadata, keys, true)
		if err != nil {
			return 0, err
		}
		descriptor, err := s.describe(original.metadata.Table)
		if err != nil {
			return 0, err
		}
		if !sameDescriptor(descriptor, original.metadata) {
			return 0, catalogErr(catalogCodeRowSchema, "original descriptor changed")
		}
		if err := catalogCheckCurrent(current, original.cells); err != nil {
			return 0, err
		}
		if c.dialect == "mysql" {
			if err := s.mysqlSafety(descriptor); err != nil {
				return 0, err
			}
		}
		query := "DELETE FROM " + catalogQualified(descriptor.Table, c.dialect) + " WHERE " + catalogKeyPredicate(descriptor, c.dialect, 1)
		affected, err := s.exec(query, keys)
		if err != nil {
			return 0, err
		}
		if affected != 1 {
			return 0, catalogErr(catalogCodeRowWrite, "expected exactly one deleted row, got %d", affected)
		}
		after, err := s.lookup(descriptor, keys, false)
		if err != nil {
			return 0, err
		}
		if len(after) != 0 {
			return 0, catalogErr(catalogCodeRowWrite, "deleted row remains")
		}
		afterDescriptor, err := s.describe(original.metadata.Table)
		if err != nil {
			return 0, err
		}
		if !sameDescriptor(afterDescriptor, descriptor) {
			return 0, catalogErr(catalogCodeRowSchema, "original descriptor changed")
		}
		return affected, nil
	})
}

// catalogCheckCurrent compares the rows that a key read returned with the original cells of a snapshot.
func catalogCheckCurrent(current [][]any, original []any) error {
	switch len(current) {
	case 0:
		return catalogErr(catalogCodeRowConflict, "original row is missing")
	case 1:
	default:
		return catalogErr(catalogCodeRowAmbiguous, "key selected multiple rows")
	}
	same, err := catalogSameRow(current[0], original)
	if err != nil {
		return err
	}
	if !same {
		return catalogErr(catalogCodeRowConflict, "original values changed")
	}
	return nil
}

// catalogSameCell reports whether two cells are equal by type and exact value.
func catalogSameCell(a, b any) (bool, error) {
	return catalogSameRow([]any{a}, []any{b})
}

// columnNames lists the column names of a descriptor.
func columnNames(metadata CatalogTableMetadata) []string {
	names := make([]string, len(metadata.Columns))
	for i, column := range metadata.Columns {
		names[i] = column.Name
	}
	return names
}

// mysqlSafety refuses a MySQL row change unless the server, the account and the table are verified: partial revokes are
// off, the account holds TRIGGER on the table, the table is InnoDB and it has no triggers (mutation.rs, mysql_safety).
func (s *catalogSession) mysqlSafety(metadata CatalogTableMetadata) error {
	unsupported := func(reason string) error { return catalogErr(catalogCodeRowUnsupport, "%s", reason) }
	partial, err := s.queryRaw("SELECT CAST(@@GLOBAL.partial_revokes AS SIGNED)", nil, 1, 4096)
	if err != nil {
		return err
	}
	partialRows, err := catalogConvert(partial, partial.types)
	if err != nil {
		return err
	}
	if len(partialRows) != 1 || partialRows[0][0] != int64(0) {
		return unsupported("MySQL partial-revoke visibility requires verification")
	}

	account, err := s.queryRaw("SELECT CURRENT_USER()", nil, 1, 4096)
	if err != nil {
		return err
	}
	accountRows, err := catalogConvert(account, account.types)
	if err != nil {
		return err
	}
	if len(accountRows) != 1 {
		return unsupported("unverifiable MySQL account")
	}
	text, ok := accountRows[0][0].(string)
	at := strings.LastIndexByte(text, '@')
	if !ok || at < 0 {
		return unsupported("unverifiable MySQL account")
	}
	grantee := "'" + text[:at] + "'@'" + text[at+1:] + "'"

	grants, err := s.queryRaw(
		"SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=? AND PRIVILEGE_TYPE='TRIGGER' "+
			"UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND PRIVILEGE_TYPE='TRIGGER' "+
			"UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=? AND TABLE_SCHEMA=? AND TABLE_NAME=? AND PRIVILEGE_TYPE='TRIGGER'",
		[]any{grantee, grantee, metadata.Table.Namespace, grantee, metadata.Table.Namespace, metadata.Table.Name}, 16, 4096)
	if err != nil {
		return err
	}
	grantRows, err := catalogConvert(grants, grants.types)
	if err != nil {
		return err
	}
	trigger := false
	for _, row := range grantRows {
		if len(row) == 1 && row[0] == "TRIGGER" {
			trigger = true
		}
	}
	if !trigger {
		return unsupported("MySQL trigger visibility is unverified")
	}

	engine, err := s.queryRaw("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",
		[]any{metadata.Table.Namespace, metadata.Table.Name}, 2, 4096)
	if err != nil {
		return err
	}
	engineRows, err := catalogConvert(engine, engine.types)
	if err != nil {
		return err
	}
	if len(engineRows) != 1 || len(engineRows[0]) != 1 {
		return unsupported("MySQL requires InnoDB")
	}
	if name, ok := engineRows[0][0].(string); !ok || !strings.EqualFold(name, "InnoDB") {
		return unsupported("MySQL requires InnoDB")
	}

	triggers, err := s.queryRaw("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=? LIMIT 1",
		[]any{metadata.Table.Namespace, metadata.Table.Name}, 1, 4096)
	if err != nil {
		return err
	}
	if len(triggers.rows) != 0 {
		return unsupported("MySQL triggers require effect verification")
	}
	return nil
}
