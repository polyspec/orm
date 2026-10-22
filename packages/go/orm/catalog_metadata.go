package orm

import (
	"context"
	"reflect"
	"slices"
	"strings"
)

// CatalogTableRef names a table by its namespace (the schema, or the database of MySQL) and its name.
type CatalogTableRef struct {
	Namespace string
	Name      string
}

// CatalogTableKind is the native relation kind of a table reference.
type CatalogTableKind string

// The relation kinds of the catalog connection; a kind outside them fails explicitly.
const (
	CatalogKindTable            CatalogTableKind = "table"
	CatalogKindPartitioned      CatalogTableKind = "partitioned"
	CatalogKindView             CatalogTableKind = "view"
	CatalogKindMaterializedView CatalogTableKind = "materialized_view"
	CatalogKindForeign          CatalogTableKind = "foreign"
	CatalogKindVirtual          CatalogTableKind = "virtual"
	CatalogKindShadow           CatalogTableKind = "shadow"
)

// CatalogColumn is one column of a table in physical order. DefaultExpression is nil when the column has no default.
type CatalogColumn struct {
	Name              string
	NativeType        string
	Nullable          bool
	Generated         bool
	AutomaticKey      bool
	DefaultExpression *string
	ExpressionDefault bool
}

// CatalogTableMetadata describes a table: its kind, its columns, its primary key in constraint order and whether that key
// is a reliable row identity. A descriptor is not authorization for a row change.
type CatalogTableMetadata struct {
	Table               CatalogTableRef
	Kind                CatalogTableKind
	Columns             []CatalogColumn
	PrimaryKey          []string
	ReliableRowIdentity bool
}

// DescribeTable reads the metadata of an explicitly qualified table in a read-only session.
func (c *CatalogConnection) DescribeTable(ctx context.Context, table CatalogTableRef) (CatalogTableMetadata, error) {
	return catalogRead(ctx, c, func(s *catalogSession) (CatalogTableMetadata, error) {
		return s.describe(table)
	})
}

// catalogKindSQL selects the native kind of a relation by its namespace and name.
var catalogKindSQL = map[string]string{
	"mysql":    "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",
	"postgres": "SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2",
	"sqlite":   "SELECT type FROM pragma_table_list WHERE schema=? AND name=?",
}

// catalogColumnsSQL selects the columns of a relation, in physical order: name, native type, nullable, generated,
// primary-key ordinal, automatic key, default expression and whether the default is an expression.
var catalogColumnsSQL = map[string]string{
	"mysql":    "SELECT c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE='YES',(c.GENERATION_EXPRESSION IS NOT NULL AND c.GENERATION_EXPRESSION<>''),COALESCE(pk.ORDINAL_POSITION,0),(c.EXTRA LIKE '%auto_increment%'),c.COLUMN_DEFAULT,(c.EXTRA LIKE '%DEFAULT_GENERATED%') FROM information_schema.COLUMNS c LEFT JOIN information_schema.KEY_COLUMN_USAGE pk ON pk.CONSTRAINT_SCHEMA=c.TABLE_SCHEMA AND pk.TABLE_NAME=c.TABLE_NAME AND pk.COLUMN_NAME=c.COLUMN_NAME AND pk.CONSTRAINT_NAME='PRIMARY' WHERE c.TABLE_SCHEMA=? AND c.TABLE_NAME=? ORDER BY c.ORDINAL_POSITION",
	"postgres": "SELECT a.attname::text,format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,(a.attgenerated<>'' OR a.attidentity='a'),COALESCE(k.ord,0),(a.attidentity<>''),pg_get_expr(d.adbin,d.adrelid),(d.adbin IS NOT NULL) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,ord) ON k.attnum=a.attnum WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",
	"sqlite":   `SELECT name,type,NOT "notnull",hidden<>0,pk,0,dflt_value,(dflt_value IS NOT NULL) FROM pragma_table_xinfo(?,?) ORDER BY cid`,
}

// catalogValidateTable checks the names of a table reference.
func catalogValidateTable(ref CatalogTableRef) error {
	if err := catalogCheckName(ref.Namespace); err != nil {
		return err
	}
	return catalogCheckName(ref.Name)
}

// describe reads the metadata of a table inside the session. Callers that need a stable descriptor describe it again
// inside the same session and compare the two.
func (s *catalogSession) describe(ref CatalogTableRef) (CatalogTableMetadata, error) {
	if err := catalogValidateTable(ref); err != nil {
		return CatalogTableMetadata{}, err
	}
	if s.dialect == "sqlite" && ref.Namespace != "main" {
		return CatalogTableMetadata{}, catalogErr("TABLE_NAMESPACE_UNSUPPORTED", "SQLite requires main")
	}
	kindRaw, err := s.queryRaw(catalogKindSQL[s.dialect], []any{ref.Namespace, ref.Name}, 2, catalogMetadataBytes)
	if err != nil {
		return CatalogTableMetadata{}, err
	}
	kindRows, err := catalogConvert(kindRaw, kindRaw.types)
	if err != nil {
		return CatalogTableMetadata{}, err
	}
	if len(kindRows) == 0 {
		return CatalogTableMetadata{}, catalogErr("TABLE_NOT_FOUND", "%s.%s", ref.Namespace, ref.Name)
	}
	if len(kindRows) != 1 || len(kindRows[0]) != 1 {
		return CatalogTableMetadata{}, catalogErr(catalogCodeMetadata, "ambiguous relation")
	}
	nativeKind, err := catalogText(kindRows[0][0])
	if err != nil {
		return CatalogTableMetadata{}, err
	}
	kind, err := catalogKind(s.dialect, nativeKind)
	if err != nil {
		return CatalogTableMetadata{}, err
	}

	// SQLite table-valued pragmas take the table name first and the schema second.
	args := []any{ref.Namespace, ref.Name}
	if s.dialect == "sqlite" {
		args = []any{ref.Name, ref.Namespace}
	}
	raw, err := s.queryRaw(catalogColumnsSQL[s.dialect], args, catalogMetadataRows, catalogMetadataBytes)
	if err != nil {
		return CatalogTableMetadata{}, err
	}
	rows, err := catalogConvert(raw, raw.types)
	if err != nil {
		return CatalogTableMetadata{}, err
	}

	type keyPosition struct {
		ordinal int64
		index   int
	}
	var columns []CatalogColumn
	var keys []keyPosition
	for _, row := range rows {
		if len(row) != 8 {
			return CatalogTableMetadata{}, catalogErr(catalogCodeMetadata, "column shape of %d values", len(row))
		}
		column, err := catalogColumnRow(row)
		if err != nil {
			return CatalogTableMetadata{}, err
		}
		for _, existing := range columns {
			if existing.Name == column.Name {
				return CatalogTableMetadata{}, catalogErr(catalogCodeMetadata, "duplicate column %q", column.Name)
			}
		}
		ordinal, err := catalogInt(row[4])
		if err != nil {
			return CatalogTableMetadata{}, err
		}
		if ordinal < 0 {
			return CatalogTableMetadata{}, catalogErr(catalogCodeMetadata, "negative key ordinal")
		}
		if ordinal > 0 {
			keys = append(keys, keyPosition{ordinal: ordinal, index: len(columns)})
		}
		columns = append(columns, column)
	}
	slices.SortFunc(keys, func(a, b keyPosition) int { return int(a.ordinal - b.ordinal) })
	for i, key := range keys {
		if key.ordinal != int64(i+1) {
			return CatalogTableMetadata{}, catalogErr(catalogCodeMetadata, "key order")
		}
	}

	// A SQLite INTEGER primary key without a separate primary-key index is the rowid alias: never NULL, generated by the database.
	if s.dialect == "sqlite" && kind == CatalogKindTable && len(keys) == 1 && strings.EqualFold(columns[keys[0].index].NativeType, "INTEGER") {
		indexRaw, err := s.queryRaw("SELECT count(*) FROM pragma_index_list(?,?) WHERE origin='pk'", args, 1, catalogMetadataBytes)
		if err != nil {
			return CatalogTableMetadata{}, err
		}
		indexRows, err := catalogConvert(indexRaw, indexRaw.types)
		if err != nil {
			return CatalogTableMetadata{}, err
		}
		if len(indexRows) != 1 || len(indexRows[0]) != 1 {
			return CatalogTableMetadata{}, catalogErr(catalogCodeMetadata, "primary index count")
		}
		count, err := catalogInt(indexRows[0][0])
		if err != nil {
			return CatalogTableMetadata{}, err
		}
		if count == 0 {
			columns[keys[0].index].Nullable = false
			columns[keys[0].index].AutomaticKey = true
		}
	}

	reliable := (kind == CatalogKindTable || kind == CatalogKindPartitioned) && len(keys) > 0
	primaryKey := make([]string, 0, len(keys))
	for _, key := range keys {
		column := columns[key.index]
		if column.Nullable {
			reliable = false
		}
		primaryKey = append(primaryKey, column.Name)
	}
	return CatalogTableMetadata{Table: ref, Kind: kind, Columns: columns, PrimaryKey: primaryKey, ReliableRowIdentity: reliable}, nil
}

// catalogKind maps the native relation kind of a dialect to its catalog kind. A MySQL SYSTEM VIEW is a view.
func catalogKind(dialect, native string) (CatalogTableKind, error) {
	switch {
	case dialect == "mysql" && native == "BASE TABLE", dialect == "postgres" && native == "r", dialect == "sqlite" && native == "table":
		return CatalogKindTable, nil
	case dialect == "mysql" && (native == "VIEW" || native == "SYSTEM VIEW"), dialect == "postgres" && native == "v", dialect == "sqlite" && native == "view":
		return CatalogKindView, nil
	case dialect == "postgres" && native == "p":
		return CatalogKindPartitioned, nil
	case dialect == "postgres" && native == "m":
		return CatalogKindMaterializedView, nil
	case dialect == "postgres" && native == "f":
		return CatalogKindForeign, nil
	case dialect == "sqlite" && native == "virtual":
		return CatalogKindVirtual, nil
	case dialect == "sqlite" && native == "shadow":
		return CatalogKindShadow, nil
	}
	return "", catalogErr("TABLE_KIND_UNSUPPORTED", "relation kind %q of %s", native, dialect)
}

// catalogColumnRow converts one row of the column query.
func catalogColumnRow(row []any) (CatalogColumn, error) {
	name, err := catalogText(row[0])
	if err != nil {
		return CatalogColumn{}, err
	}
	if err := catalogCheckName(name); err != nil {
		return CatalogColumn{}, err
	}
	native, err := catalogText(row[1])
	if err != nil {
		return CatalogColumn{}, err
	}
	nullable, err := catalogBool(row[2])
	if err != nil {
		return CatalogColumn{}, err
	}
	generated, err := catalogBool(row[3])
	if err != nil {
		return CatalogColumn{}, err
	}
	automatic, err := catalogBool(row[5])
	if err != nil {
		return CatalogColumn{}, err
	}
	expression, err := catalogBool(row[7])
	if err != nil {
		return CatalogColumn{}, err
	}
	column := CatalogColumn{Name: name, NativeType: native, Nullable: nullable, Generated: generated, AutomaticKey: automatic, ExpressionDefault: expression}
	switch value := row[6].(type) {
	case nil:
	case string:
		column.DefaultExpression = &value
	default:
		return CatalogColumn{}, catalogErr(catalogCodeMetadata, "default expression of column %q is %T", name, row[6])
	}
	return column, nil
}

// catalogText reads a text value of a metadata row.
func catalogText(value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", catalogErr(catalogCodeMetadata, "expected text, got %T", value)
	}
	return text, nil
}

// catalogBool reads a boolean of a metadata row: a native boolean, or integer 0 or 1.
func catalogBool(value any) (bool, error) {
	switch v := value.(type) {
	case bool:
		return v, nil
	case int64:
		if v == 0 || v == 1 {
			return v == 1, nil
		}
	}
	return false, catalogErr(catalogCodeMetadata, "expected a boolean, got %v", value)
}

// catalogInt reads an integer of a metadata row.
func catalogInt(value any) (int64, error) {
	n, ok := value.(int64)
	if !ok {
		return 0, catalogErr(catalogCodeMetadata, "expected an integer, got %T", value)
	}
	return n, nil
}

// catalogSameNames checks that the names of a prepared result are the names of the descriptor, in order.
func catalogSameNames(names []string, columns []CatalogColumn) error {
	if len(names) != len(columns) {
		return catalogErr(catalogCodePageChanged, "prepared columns differ from descriptor")
	}
	for i, column := range columns {
		if names[i] != column.Name {
			return catalogErr(catalogCodePageChanged, "prepared columns differ from descriptor")
		}
	}
	return nil
}

// catalogNativeTypes lists the native type of each column of a descriptor.
func catalogNativeTypes(metadata CatalogTableMetadata) []string {
	types := make([]string, len(metadata.Columns))
	for i, column := range metadata.Columns {
		types[i] = column.NativeType
	}
	return types
}

// sameDescriptor reports whether two descriptors are equal.
func sameDescriptor(a, b CatalogTableMetadata) bool { return reflect.DeepEqual(a, b) }
