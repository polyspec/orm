package orm

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
)

// AESKeyring stores the keys that can decode persisted AES values. Versions
// are explicit so a rotation can read one row with its stored version and
// write every AES column with one target version.
type AESKeyring struct {
	keys    map[int32]string
	current int32
}

// NewAESKeyring validates a non-empty key for every declared version and a
// current version that is present in the key list.
func NewAESKeyring(keys map[int32]string, current int32) (AESKeyring, error) {
	copyKeys := make(map[int32]string, len(keys))
	for version, key := range keys {
		if version < 1 || key == "" {
			return AESKeyring{}, fmt.Errorf("aes key version %d has an empty key or is invalid", version)
		}
		copyKeys[version] = key
	}
	if current < 1 || copyKeys[current] == "" {
		return AESKeyring{}, fmt.Errorf("aes current version %d is not declared", current)
	}
	return AESKeyring{keys: copyKeys, current: current}, nil
}

// CurrentAESVersion returns the target version used by new writes.
func (k AESKeyring) CurrentAESVersion() int32 { return k.current }

// AESVersions returns declared versions in deterministic order.
func (k AESKeyring) AESVersions() []int32 {
	out := make([]int32, 0, len(k.keys))
	for version := range k.keys {
		out = append(out, version)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// RotateAESRow returns a copy with every AES column re-encrypted. The input
// row is unchanged until all columns decode and encode successfully. A caller
// must persist the returned columns and version in one database transaction.
func RotateAESRow(row map[string]any, versionColumn string, columns []AESRotationColumn, targetVersion int32, keyring AESKeyring) (map[string]any, error) {
	oldVersion, err := rowVersion(row[versionColumn])
	if err != nil {
		return nil, err
	}
	oldKey, ok := keyring.keys[oldVersion]
	if !ok {
		return nil, fmt.Errorf("aes key version %d is not declared", oldVersion)
	}
	newKey, ok := keyring.keys[targetVersion]
	if !ok {
		return nil, fmt.Errorf("aes target version %d is not declared", targetVersion)
	}
	out := make(map[string]any, len(row)+1)
	for name, value := range row {
		out[name] = value
	}
	for _, column := range columns {
		value, exists := row[column.Name]
		if !exists {
			return nil, fmt.Errorf("aes column %s is missing", column.Name)
		}
		plain, err := hostDecode(value, column.Styles, oldKey)
		if err != nil {
			return nil, fmt.Errorf("aes column %s: %w", column.Name, err)
		}
		encoded, err := HostEncode(plain, column.Styles, newKey)
		if err != nil {
			return nil, fmt.Errorf("aes column %s: %w", column.Name, err)
		}
		out[column.Name] = encoded
	}
	out[versionColumn] = targetVersion
	return out, nil
}

// AESRotationColumn identifies one stored AES column and its host stages. The
// list normally contains ["aes"] or ["aes", "hex"].
type AESRotationColumn struct {
	Name   string
	Styles []string
}

// AESRotationSpec contains only schema-derived identifiers. Callers must use
// the generated specification for an entity; arbitrary SQL identifiers are
// rejected by quoteIdentifier.
type AESRotationSpec struct {
	Table         string
	PrimaryKey    string
	VersionColumn string
	Columns       []AESRotationColumn
}

// RotateAESRows reads and updates every row in one transaction. Each UPDATE
// writes every AES column and the version column together, and includes the
// old version in its predicate. A decode, encode, scan, conflict, or driver
// error rolls back all updates.
func (d *DB) RotateAESRows(ctx context.Context, ex Exec, spec AESRotationSpec, targetVersion int32, keyring AESKeyring) (int, error) {
	if d == nil || ex == nil {
		return 0, fmt.Errorf("aes rotation requires a database and executor")
	}
	if spec.Table == "" || spec.PrimaryKey == "" || spec.VersionColumn == "" || len(spec.Columns) == 0 {
		return 0, fmt.Errorf("aes rotation specification is incomplete")
	}
	for _, column := range spec.Columns {
		if column.Name == "" || len(column.Styles) == 0 {
			return 0, fmt.Errorf("aes rotation column is incomplete")
		}
	}
	attemptCount := 0
	err := InTx(ctx, ex, func(txEx Exec) error {
		attemptCount = 0
		rows, err := d.rotationQuery(ctx, txEx, spec)
		if err != nil {
			return err
		}
		defer rows.Close()
		selectColumns := 2 + len(spec.Columns)
		values := make([]any, selectColumns)
		dest := make([]any, selectColumns)
		for i := range values {
			dest[i] = &values[i]
		}
		for rows.Next() {
			if err := rows.Scan(dest...); err != nil {
				return err
			}
			row := map[string]any{spec.PrimaryKey: values[0], spec.VersionColumn: values[1]}
			for i, column := range spec.Columns {
				row[column.Name] = values[i+2]
			}
			rotated, err := RotateAESRow(row, spec.VersionColumn, spec.Columns, targetVersion, keyring)
			if err != nil {
				return err
			}
			if err := d.rotationUpdate(ctx, txEx, spec, row, rotated); err != nil {
				return err
			}
			attemptCount++
		}
		return rows.Err()
	})
	if err != nil {
		return 0, err
	}
	return attemptCount, nil
}

func (d *DB) rotationQuery(ctx context.Context, ex Exec, spec AESRotationSpec) (*sql.Rows, error) {
	columns := []string{quoteIdentifier(d.driver, spec.PrimaryKey), quoteIdentifier(d.driver, spec.VersionColumn)}
	for _, column := range spec.Columns {
		columns = append(columns, quoteIdentifier(d.driver, column.Name))
	}
	query := "SELECT " + strings.Join(columns, ", ") + " FROM " + quoteIdentifier(d.driver, spec.Table) + " ORDER BY " + quoteIdentifier(d.driver, spec.PrimaryKey)
	if tx, ok := ex.(*Tx); ok {
		return tx.tx.QueryContext(ctx, query)
	}
	return d.SQL.QueryContext(ctx, query)
}

func (d *DB) rotationUpdate(ctx context.Context, ex Exec, spec AESRotationSpec, before, after map[string]any) error {
	sets := make([]string, 0, len(spec.Columns)+1)
	args := make([]any, 0, len(spec.Columns)+3)
	for _, column := range spec.Columns {
		sets = append(sets, quoteIdentifier(d.driver, column.Name)+" = "+d.rotationPlaceholder(len(args)+1))
		args = append(args, after[column.Name])
	}
	sets = append(sets, quoteIdentifier(d.driver, spec.VersionColumn)+" = "+d.rotationPlaceholder(len(args)+1))
	args = append(args, after[spec.VersionColumn])
	where := quoteIdentifier(d.driver, spec.PrimaryKey) + " = " + d.rotationPlaceholder(len(args)+1)
	args = append(args, before[spec.PrimaryKey])
	where += " AND " + quoteIdentifier(d.driver, spec.VersionColumn) + " = " + d.rotationPlaceholder(len(args)+1)
	args = append(args, before[spec.VersionColumn])
	query := "UPDATE " + quoteIdentifier(d.driver, spec.Table) + " SET " + strings.Join(sets, ", ") + " WHERE " + where
	var result sql.Result
	var err error
	if tx, ok := ex.(*Tx); ok {
		result, err = tx.tx.ExecContext(ctx, query, args...)
	} else {
		result, err = d.SQL.ExecContext(ctx, query, args...)
	}
	if err != nil {
		return mapDriverErr(err)
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return err
		}
		return fmt.Errorf("aes rotation update matched %d rows", affected)
	}
	return nil
}

func (d *DB) rotationPlaceholder(position int) string {
	if d.driver == "postgres" {
		return fmt.Sprintf("$%d", position)
	}
	return "?"
}

func quoteIdentifier(driver, value string) string {
	if value == "" || strings.ContainsAny(value, "\x00\"`.;'") {
		panic("invalid generated SQL identifier")
	}
	if driver == "mysql" {
		return "`" + value + "`"
	}
	return "\"" + value + "\""
}

func rowVersion(value any) (int32, error) {
	switch v := value.(type) {
	case int:
		return int32(v), nil
	case int8:
		return int32(v), nil
	case int16:
		return int32(v), nil
	case int32:
		return v, nil
	case int64:
		return int32(v), nil
	case uint:
		return int32(v), nil
	case uint8:
		return int32(v), nil
	case uint16:
		return int32(v), nil
	case uint32:
		return int32(v), nil
	case uint64:
		return int32(v), nil
	default:
		return 0, fmt.Errorf("aes version has type %T", value)
	}
}
