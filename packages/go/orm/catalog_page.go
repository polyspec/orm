package orm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
)

// CatalogResult is the typed result of a table page: its columns in physical order and its rows.
type CatalogResult struct {
	Columns []CatalogColumn
	Rows    [][]any
}

// CatalogTablePage is one bounded page of a table in primary-key order. HasMore reports one row beyond the page, found
// by a sentinel row; it is not a total count. A page is not authorization for a row change.
type CatalogTablePage struct {
	Metadata CatalogTableMetadata
	Result   CatalogResult
	Limit    int
	Offset   int64
	OrderBy  []string
	HasMore  bool
}

// Column returns the value that row holds in the named column of the page. It returns nil when the page has no column of
// that name; a caller that needs to tell the two apart checks Metadata.Columns first.
func (p CatalogTablePage) Column(row []any, name string) any {
	for i, column := range p.Metadata.Columns {
		if column.Name == name && i < len(row) {
			return row[i]
		}
	}
	return nil
}

// TablePage reads one bounded page of an explicitly qualified table in a fresh read-only session. It orders by the
// declared primary key; a table without one has no defined order. The descriptor must be the same before and after
// the read.
func (c *CatalogConnection) TablePage(ctx context.Context, table CatalogTableRef, limit int, offset int64) (CatalogTablePage, error) {
	if err := catalogValidateTable(table); err != nil {
		return CatalogTablePage{}, err
	}
	if limit < 1 || limit > 1000 || offset < 0 || offset > 1000000 {
		return CatalogTablePage{}, catalogErr("TABLE_PAGE_INVALID", "limit requires 1..1000 and offset 0..1000000")
	}
	return catalogRead(ctx, c, func(s *catalogSession) (CatalogTablePage, error) {
		metadata, err := s.describe(table)
		if err != nil {
			return CatalogTablePage{}, err
		}
		if len(metadata.Columns) == 0 {
			return CatalogTablePage{}, catalogErr("TABLE_PAGE_UNSUPPORTED", "relation has no selectable columns")
		}
		columns := make([]string, len(metadata.Columns))
		for i, column := range metadata.Columns {
			columns[i] = catalogQuote(column.Name, c.dialect)
		}
		query := "SELECT " + strings.Join(columns, ",") + " FROM " + catalogQualified(table, c.dialect)
		if len(metadata.PrimaryKey) > 0 {
			query += " ORDER BY " + catalogQuoteList(metadata.PrimaryKey, c.dialect)
		}
		// One extra row is the sentinel that reports HasMore.
		query += " LIMIT " + strconv.Itoa(limit+1) + " OFFSET " + strconv.FormatInt(offset, 10)
		raw, err := s.queryRaw(query, nil, limit+1, catalogPageBytes)
		if err != nil {
			return CatalogTablePage{}, err
		}
		if err := catalogSameNames(raw.names, metadata.Columns); err != nil {
			return CatalogTablePage{}, err
		}
		after, err := s.describe(table)
		if err != nil {
			return CatalogTablePage{}, err
		}
		if !sameDescriptor(after, metadata) {
			return CatalogTablePage{}, catalogErr(catalogCodePageChanged, "descriptor changed during read")
		}
		rows, err := catalogConvert(raw, catalogNativeTypes(metadata))
		if err != nil {
			return CatalogTablePage{}, err
		}
		hasMore := len(rows) > limit
		if hasMore {
			rows = rows[:limit]
		}
		return CatalogTablePage{
			Metadata: metadata,
			Result:   CatalogResult{Columns: slices.Clone(metadata.Columns), Rows: rows},
			Limit:    limit,
			Offset:   offset,
			OrderBy:  slices.Clone(metadata.PrimaryKey),
			HasMore:  hasMore,
		}, nil
	})
}

// catalogQuoteList quotes each identifier and joins them with commas.
func catalogQuoteList(names []string, dialect string) string {
	quoted := make([]string, len(names))
	for i, name := range names {
		quoted[i] = catalogQuote(name, dialect)
	}
	return strings.Join(quoted, ",")
}

// CatalogRowSnapshot is one checked original row: its descriptor, its cells, the positions of its primary-key cells and a
// SHA-256 revision of the descriptor and the cells. It is not a write authorization; a change re-reads the row by its
// keys inside its own transaction and compares it with the snapshot.
type CatalogRowSnapshot struct {
	metadata   CatalogTableMetadata
	cells      []any
	keyIndexes []int
	revision   string
}

// Revision is the SHA-256 revision of the descriptor and the cells of the snapshot, in lowercase hexadecimal.
func (r CatalogRowSnapshot) Revision() string { return r.revision }

// CatalogSnapshotFromPage captures the row at index of a page. The table must have a reliable row identity, and the page
// must be a page of that table as TablePage reads it.
func CatalogSnapshotFromPage(page CatalogTablePage, index int) (CatalogRowSnapshot, error) {
	if err := catalogValidateTable(page.Metadata.Table); err != nil {
		return CatalogRowSnapshot{}, catalogErr("ROW_SNAPSHOT_INVALID", "invalid original row or descriptor: %v", err)
	}
	if page.Limit < 1 || page.Limit > 1000 || page.Offset < 0 || page.Offset > 1000000 {
		return CatalogRowSnapshot{}, catalogErr("ROW_SNAPSHOT_INVALID", "invalid page bounds")
	}
	rows := page.Result.Rows
	if len(rows) > page.Limit || (page.HasMore && len(rows) != page.Limit) || !slices.Equal(page.OrderBy, page.Metadata.PrimaryKey) {
		return CatalogRowSnapshot{}, catalogErr("ROW_SNAPSHOT_INVALID", "page rows or order do not match its bounds")
	}
	keyIndexes, err := catalogDescriptor(page.Metadata)
	if err != nil {
		return CatalogRowSnapshot{}, err
	}
	if len(page.Result.Columns) != len(page.Metadata.Columns) {
		return CatalogRowSnapshot{}, catalogErr("ROW_SNAPSHOT_INVALID", "projection differs from descriptor")
	}
	for i, column := range page.Result.Columns {
		if column.Name != page.Metadata.Columns[i].Name {
			return CatalogRowSnapshot{}, catalogErr("ROW_SNAPSHOT_INVALID", "projection differs from descriptor")
		}
	}
	if index < 0 || index >= len(rows) {
		return CatalogRowSnapshot{}, catalogErr("ROW_SNAPSHOT_INVALID", "row index %d outside the page", index)
	}
	cells := slices.Clone(rows[index])
	if err := catalogCheckCells(page.Metadata, cells); err != nil {
		return CatalogRowSnapshot{}, err
	}
	revision, err := catalogRevision(page.Metadata, cells)
	if err != nil {
		return CatalogRowSnapshot{}, err
	}
	return CatalogRowSnapshot{metadata: page.Metadata, cells: cells, keyIndexes: keyIndexes, revision: revision}, nil
}

// catalogDescriptor checks that a descriptor has a reliable row identity and returns the column index of each primary-key
// column in constraint order.
func catalogDescriptor(metadata CatalogTableMetadata) ([]int, error) {
	invalid := func(reason string) error {
		return catalogErr("ROW_SNAPSHOT_INVALID", "invalid original row or descriptor: %s", reason)
	}
	if metadata.Kind != CatalogKindTable && metadata.Kind != CatalogKindPartitioned {
		return nil, invalid("the relation is not a table")
	}
	if !metadata.ReliableRowIdentity || len(metadata.PrimaryKey) == 0 || len(metadata.Columns) == 0 || len(metadata.Columns) > 2048 {
		return nil, invalid("no reliable row identity")
	}
	names := map[string]bool{}
	for _, column := range metadata.Columns {
		if err := catalogCheckName(column.Name); err != nil {
			return nil, invalid(err.Error())
		}
		if names[column.Name] || strings.ContainsRune(column.NativeType, 0) {
			return nil, invalid("duplicate column or invalid native type")
		}
		names[column.Name] = true
	}
	keys := map[string]bool{}
	indexes := make([]int, 0, len(metadata.PrimaryKey))
	for _, key := range metadata.PrimaryKey {
		if keys[key] {
			return nil, invalid("duplicate key column")
		}
		keys[key] = true
		index := slices.IndexFunc(metadata.Columns, func(column CatalogColumn) bool { return column.Name == key })
		if index < 0 || metadata.Columns[index].Nullable {
			return nil, invalid("key column is missing or nullable")
		}
		indexes = append(indexes, index)
	}
	return indexes, nil
}

// catalogCheckCells checks a row against its descriptor: one cell per column, no NULL in a non-null column and only
// supported values.
func catalogCheckCells(metadata CatalogTableMetadata, cells []any) error {
	if len(cells) != len(metadata.Columns) {
		return catalogErr("ROW_SNAPSHOT_INVALID", "row has %d cells for %d columns", len(cells), len(metadata.Columns))
	}
	for i, cell := range cells {
		if cell == nil && !metadata.Columns[i].Nullable {
			return catalogErr("ROW_SNAPSHOT_INVALID", "NULL in non-null column %q", metadata.Columns[i].Name)
		}
		if _, err := catalogCellKey(cell); err != nil {
			return err
		}
	}
	return nil
}

// catalogCellKey is the canonical text of one cell: its type and its exact value. Two cells are equal exactly when their
// keys are equal, so a float compares by its bits and a time by its UTC instant.
func catalogCellKey(cell any) (string, error) {
	switch v := cell.(type) {
	case nil:
		return "n", nil
	case bool:
		if v {
			return "b1", nil
		}
		return "b0", nil
	case int64:
		return "i" + strconv.FormatInt(v, 10), nil
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return "", catalogErr("ROW_SNAPSHOT_INVALID", "non-finite float cell")
		}
		return "f" + strconv.FormatUint(math.Float64bits(v), 16), nil
	case string:
		return "s" + strconv.Itoa(len(v)) + ":" + v, nil
	case []byte:
		return "x" + hex.EncodeToString(v), nil
	case time.Time:
		return "t" + v.UTC().Format(time.RFC3339Nano), nil
	default:
		return "", catalogErr("ROW_SNAPSHOT_INVALID", "unsupported cell type %T", cell)
	}
}

// catalogRevision is the SHA-256 revision of a descriptor and a row, bounded by catalogSnapshotBytes.
func catalogRevision(metadata CatalogTableMetadata, cells []any) (string, error) {
	header, err := json.Marshal(struct {
		Tag      string
		Metadata CatalogTableMetadata
	}{Tag: "orm-catalog-row-v1", Metadata: metadata})
	if err != nil {
		return "", catalogErr("ROW_SNAPSHOT_INVALID", "descriptor encoding: %v", err)
	}
	var encoded strings.Builder
	encoded.Write(header)
	for _, cell := range cells {
		key, err := catalogCellKey(cell)
		if err != nil {
			return "", err
		}
		encoded.WriteString(strconv.Itoa(len(key)))
		encoded.WriteByte(':')
		encoded.WriteString(key)
	}
	if encoded.Len() > catalogSnapshotBytes {
		return "", catalogErr("ROW_SNAPSHOT_LIMIT", "original row encoding exceeds its budget")
	}
	sum := sha256.Sum256([]byte(encoded.String()))
	return hex.EncodeToString(sum[:]), nil
}

// catalogSameRow reports whether two rows hold equal cells.
func catalogSameRow(a, b []any) (bool, error) {
	if len(a) != len(b) {
		return false, nil
	}
	for i := range a {
		ka, err := catalogCellKey(a[i])
		if err != nil {
			return false, err
		}
		kb, err := catalogCellKey(b[i])
		if err != nil {
			return false, err
		}
		if ka != kb {
			return false, nil
		}
	}
	return true, nil
}

// valid reports a snapshot that was not captured by CatalogSnapshotFromPage.
func (r CatalogRowSnapshot) valid() error {
	if len(r.keyIndexes) == 0 || len(r.cells) != len(r.metadata.Columns) {
		return catalogErr("ROW_SNAPSHOT_INVALID", "the snapshot was not captured by CatalogSnapshotFromPage")
	}
	return nil
}

// keys returns the primary-key cells of the snapshot in constraint order.
func (r CatalogRowSnapshot) keys() []any {
	keys := make([]any, len(r.keyIndexes))
	for i, index := range r.keyIndexes {
		keys[i] = r.cells[index]
	}
	return keys
}
