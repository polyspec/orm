package orm

import (
	"database/sql"
	"strings"
)

func catalogExecSingleInsert(s *catalogSession, query string, args []any) (sql.Result, error) {
	result, err := s.conn.ExecContext(s.ctx, query, args...)
	if err != nil {
		return nil, mapDriverErrContext(err, s.ctx)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, mapDriverErr(err)
	}
	if affected != 1 {
		return nil, catalogErr(catalogCodeRowWrite, "expected exactly one inserted row, got %d", affected)
	}
	return result, nil
}

func catalogValidateInsertedRow(
	metadata CatalogTableMetadata,
	row []any,
	changes []catalogChange,
	keyIndexes []int,
) ([]any, error) {
	if err := catalogCheckCells(metadata, row); err != nil {
		return nil, err
	}
	if _, err := catalogRevision(metadata, row); err != nil {
		return nil, err
	}
	if err := catalogVerifyInsertedValues(row, changes); err != nil {
		return nil, err
	}
	return catalogInsertedKeys(row, keyIndexes)
}

// catalogInsertReturningKeys performs an insert whose primary-key components are supplied by the database, then reads
// their exact values from the same statement on SQLite and PostgreSQL.
func catalogInsertReturningKeys(
	s *catalogSession,
	metadata CatalogTableMetadata,
	query string,
	args []any,
	changes []catalogChange,
	keyIndexes []int,
	dialect string,
) ([]any, error) {
	returning := query + " RETURNING " + catalogSelectList(metadata, dialect)
	rows, err := catalogReadRows(s, metadata, returning, args)
	if err != nil {
		return nil, err
	}
	if len(rows) != 1 {
		return nil, catalogErr(catalogCodeRowWrite, "expected exactly one returned insert row, got %d", len(rows))
	}
	return catalogValidateInsertedRow(metadata, rows[0], changes, keyIndexes)
}

// catalogInsertLocator identifies a MySQL row with the assigned input values when an expression default cannot be read
// through DEFAULT(column) or an insert acknowledgement. It never evaluates or guesses the default expression.
type catalogInsertLocator struct {
	query string
	args  []any
}

func newCatalogInsertLocator(metadata CatalogTableMetadata, changes []catalogChange) (*catalogInsertLocator, error) {
	predicates := make([]string, 0, len(changes))
	args := make([]any, 0, len(changes))
	for _, change := range changes {
		column := catalogQuote(metadata.Columns[change.index].Name, "mysql")
		if change.value == nil {
			predicates = append(predicates, column+" IS NULL")
		} else {
			predicates = append(predicates, column+"=?")
			args = append(args, change.value)
		}
	}
	predicate := "1=1"
	if len(predicates) != 0 {
		predicate = strings.Join(predicates, " AND ")
	}
	query := "SELECT " + catalogColumnList(metadata, "mysql") + " FROM " + catalogQualified(metadata.Table, "mysql") +
		" WHERE " + predicate + " LIMIT 2 FOR UPDATE"
	return &catalogInsertLocator{query: query, args: args}, nil
}

func (locator *catalogInsertLocator) read(s *catalogSession, metadata CatalogTableMetadata) ([][]any, error) {
	return catalogReadRows(s, metadata, locator.query, locator.args)
}

func (locator *catalogInsertLocator) requireAbsent(s *catalogSession, metadata CatalogTableMetadata) error {
	rows, err := locator.read(s, metadata)
	if err != nil {
		return err
	}
	if len(rows) != 0 {
		return catalogErr(catalogCodeRowAmbiguous, "generated identity locator already matches rows")
	}
	return nil
}

func (locator *catalogInsertLocator) insertAndReadKeys(
	s *catalogSession,
	metadata CatalogTableMetadata,
	query string,
	args []any,
	changes []catalogChange,
	keyIndexes []int,
) ([]any, error) {
	if _, err := catalogExecSingleInsert(s, query, args); err != nil {
		return nil, err
	}
	rows, err := locator.read(s, metadata)
	if err != nil {
		return nil, err
	}
	if len(rows) != 1 {
		return nil, catalogErr(catalogCodeRowAmbiguous, "expected exactly one inserted locator row")
	}
	return catalogValidateInsertedRow(metadata, rows[0], changes, keyIndexes)
}

// catalogMySQLInsertKeys uses the native insert acknowledgement for automatic keys and DEFAULT(column) for omitted
// literal defaults, then verifies and returns the row read under its generated key.
func catalogMySQLInsertKeys(
	s *catalogSession,
	metadata CatalogTableMetadata,
	query string,
	args []any,
	changes []catalogChange,
	keyIndexes []int,
	omittedKeys []int,
	omittedAutomaticKeys []int,
) ([]any, error) {
	result, err := catalogExecSingleInsert(s, query, args)
	if err != nil {
		return nil, err
	}
	var identity int64
	if len(omittedAutomaticKeys) != 0 {
		identity, err = result.LastInsertId()
		if err != nil {
			return nil, mapDriverErr(err)
		}
		if identity <= 0 {
			return nil, catalogErr(catalogCodeRowWrite, "insert acknowledgement did not return a positive generated identity")
		}
	}
	omitted := make(map[int]bool, len(omittedKeys))
	for _, keyIndex := range omittedKeys {
		omitted[keyIndex] = true
	}
	predicates := make([]string, len(metadata.PrimaryKey))
	keyArgs := make([]any, 0, len(metadata.PrimaryKey))
	for keyIndex, columnIndex := range keyIndexes {
		column := metadata.Columns[columnIndex]
		quoted := catalogQuote(column.Name, "mysql")
		var value any
		if !omitted[keyIndex] {
			for _, change := range changes {
				if change.index == columnIndex {
					value = change.value
					break
				}
			}
			predicates[keyIndex] = quoted + "=?"
			keyArgs = append(keyArgs, value)
		} else if column.AutomaticKey {
			predicates[keyIndex] = quoted + "=?"
			keyArgs = append(keyArgs, identity)
		} else if column.DefaultExpression != nil && !column.ExpressionDefault {
			predicates[keyIndex] = quoted + "=DEFAULT(" + quoted + ")"
		} else {
			return nil, catalogErr(catalogCodeInsertUnsupported, "unsupported generated MySQL key %q", column.Name)
		}
	}
	lookup := "SELECT " + catalogColumnList(metadata, "mysql") + " FROM " + catalogQualified(metadata.Table, "mysql") +
		" WHERE " + strings.Join(predicates, " AND ") + " LIMIT 2 FOR UPDATE"
	rows, err := catalogReadRows(s, metadata, lookup, keyArgs)
	if err != nil {
		return nil, err
	}
	if len(rows) != 1 {
		return nil, catalogErr(catalogCodeRowWrite, "expected exactly one inserted generated-key row, got %d", len(rows))
	}
	return catalogValidateInsertedRow(metadata, rows[0], changes, keyIndexes)
}

func catalogVerifyInsertedValues(row []any, changes []catalogChange) error {
	for _, change := range changes {
		if change.index >= len(row) {
			return catalogErr(catalogCodeRowWrite, "inserted row lacks assigned column")
		}
		same, err := catalogSameCell(row[change.index], change.value)
		if err != nil {
			return err
		}
		if !same {
			return catalogErr(catalogCodeRowWrite, "inserted value of column index %d differs", change.index)
		}
	}
	return nil
}

func catalogInsertedKeys(row []any, keyIndexes []int) ([]any, error) {
	keys := make([]any, len(keyIndexes))
	for i, columnIndex := range keyIndexes {
		if columnIndex >= len(row) {
			return nil, catalogErr(catalogCodeRowWrite, "inserted row lacks primary-key column")
		}
		keys[i] = row[columnIndex]
		if keys[i] == nil {
			return nil, catalogErr(catalogCodeRowWrite, "inserted primary-key column is NULL")
		}
	}
	return keys, nil
}
