package schema

import (
	"errors"
	"math"
	"reflect"
)

// PhysicalIndex preserves a decoded index; it grants no SQL authority.
type PhysicalIndex struct{ value map[string]any }

func PhysicalIndexFromValue(value map[string]any) (*PhysicalIndex, error) {
	record, err := physicalObject(value, "id", "name", "tableId", "unique", "methodSql", "terms", "include", "predicateSql", "nullsDistinct", "visible", "comment", "options")
	if err != nil {
		return nil, err
	}
	v := physicalRecordValidator{}
	for _, field := range []string{"id", "tableId"} {
		if _, err = v.id(record[field]); err != nil {
			return nil, err
		}
	}
	if record["name"] != nil {
		name, e := v.text(record["name"], 1, 1024)
		if e != nil {
			return nil, e
		}
		if _, e = NewPhysicalIdentity(nil, nil, name, nil); e != nil {
			return nil, e
		}
	}
	if _, ok := record["unique"].(bool); !ok {
		return nil, errors.New("SCHEMA_INVALID")
	}
	for _, field := range []string{"nullsDistinct", "visible"} {
		if record[field] != nil {
			if _, ok := record[field].(bool); !ok {
				return nil, errors.New("SCHEMA_INVALID")
			}
		}
	}
	if err = physicalIndexOptionalText(&v, record["methodSql"], 128); err != nil {
		return nil, err
	}
	if err = physicalIndexOptionalText(&v, record["predicateSql"], 16384); err != nil {
		return nil, err
	}
	terms, ok := record["terms"].([]any)
	if !ok || len(terms) < 1 || len(terms) > 64 {
		return nil, errors.New("SCHEMA_INVALID")
	}
	for _, value := range terms {
		if err = physicalIndexTerm(&v, value); err != nil {
			return nil, err
		}
	}
	included, ok := record["include"].([]any)
	if !ok || included == nil || len(included) > 64 {
		return nil, errors.New("SCHEMA_INVALID")
	}
	seen := map[string]bool{}
	for _, value := range included {
		id, e := v.id(value)
		if e != nil || seen[id] {
			return nil, errors.New("SCHEMA_INVALID")
		}
		seen[id] = true
	}
	if _, err = v.text(record["comment"], 0, 8192); err != nil {
		return nil, err
	}
	if err = v.options(record["options"]); err != nil {
		return nil, err
	}
	return &PhysicalIndex{value: clonePhysicalValue(record).(map[string]any)}, nil
}

func physicalIndexOptionalText(v *physicalRecordValidator, value any, max int) error {
	if value == nil {
		return nil
	}
	_, err := v.text(value, 1, max)
	return err
}

func physicalIndexTerm(v *physicalRecordValidator, value any) error {
	term, err := physicalObject(value, "source", "order", "nulls", "collationSql", "operatorClassSql", "prefixLength")
	if err != nil {
		return err
	}
	source, ok := term["source"].(map[string]any)
	if !ok {
		return errors.New("SCHEMA_INVALID")
	}
	kind, err := v.text(source["kind"], 1, 16)
	if err != nil {
		return err
	}
	switch kind {
	case "column":
		if _, err = physicalObject(source, "kind", "columnId"); err != nil {
			return err
		}
		if _, err = v.id(source["columnId"]); err != nil {
			return err
		}
	case "expression":
		if _, err = physicalObject(source, "kind", "sql"); err != nil {
			return err
		}
		if _, err = v.text(source["sql"], 1, 16384); err != nil {
			return err
		}
	default:
		return errors.New("SCHEMA_INVALID")
	}
	order, err := v.text(term["order"], 1, 16)
	if err != nil {
		return err
	}
	if order != "asc" && order != "desc" && order != "unspecified" {
		return errors.New("SCHEMA_INVALID")
	}
	nulls, err := v.text(term["nulls"], 1, 16)
	if err != nil {
		return err
	}
	if nulls != "first" && nulls != "last" && nulls != "unspecified" {
		return errors.New("SCHEMA_INVALID")
	}
	if err = physicalIndexOptionalText(v, term["collationSql"], 1024); err != nil {
		return err
	}
	if err = physicalIndexOptionalText(v, term["operatorClassSql"], 4096); err != nil {
		return err
	}
	if term["prefixLength"] != nil && (kind != "column" || !physicalIndexPrefix(term["prefixLength"])) {
		return errors.New("SCHEMA_INVALID")
	}
	return nil
}

func physicalIndexPrefix(value any) bool {
	number := reflect.ValueOf(value)
	switch number.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return number.Int() >= 1 && number.Int() <= 2147483647
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return number.Uint() >= 1 && number.Uint() <= 2147483647
	case reflect.Float32, reflect.Float64:
		n := number.Float()
		return n >= 1 && n <= 2147483647 && math.Trunc(n) == n
	default:
		return false
	}
}

func (index *PhysicalIndex) Value() map[string]any {
	return clonePhysicalValue(index.value).(map[string]any)
}
