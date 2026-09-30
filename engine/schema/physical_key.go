package schema

import "errors"

// PhysicalKey preserves a decoded primary/unique constraint, not SQL authority.
type PhysicalKey struct{ value map[string]any }

func PhysicalKeyFromValue(value map[string]any) (*PhysicalKey, error) {
	record, err := physicalObject(value, "id", "name", "tableId", "kind", "columns", "indexId", "deferrable", "initiallyDeferred", "nullsDistinct", "withoutOverlaps", "comment", "options")
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
	kind, err := v.text(record["kind"], 1, 16)
	if err != nil {
		return nil, err
	}
	if kind != "primary" && kind != "unique" {
		return nil, errors.New("SCHEMA_INVALID")
	}
	if _, err = v.ids(record["columns"]); err != nil {
		return nil, err
	}
	if record["indexId"] != nil {
		if _, err = v.id(record["indexId"]); err != nil {
			return nil, err
		}
	}
	for _, field := range []string{"deferrable", "initiallyDeferred", "nullsDistinct", "withoutOverlaps"} {
		if record[field] != nil {
			if _, ok := record[field].(bool); !ok {
				return nil, errors.New("SCHEMA_INVALID")
			}
		}
	}
	if record["initiallyDeferred"] == true && record["deferrable"] != true {
		return nil, errors.New("SCHEMA_INVALID")
	}
	if kind == "primary" && record["nullsDistinct"] != nil {
		return nil, errors.New("SCHEMA_INVALID")
	}
	if _, err = v.text(record["comment"], 0, 8192); err != nil {
		return nil, err
	}
	if err = v.options(record["options"]); err != nil {
		return nil, err
	}
	return &PhysicalKey{value: clonePhysicalValue(record).(map[string]any)}, nil
}

func (key *PhysicalKey) Value() map[string]any { return clonePhysicalValue(key.value).(map[string]any) }
