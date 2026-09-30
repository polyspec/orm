package schema

import "errors"

// PhysicalCheck preserves a decoded constraint; it grants no SQL authority.
type PhysicalCheck struct{ value map[string]any }

func PhysicalCheckFromValue(value map[string]any) (*PhysicalCheck, error) {
	record, err := physicalObject(value, "id", "name", "tableId", "expressionSql", "enforced", "validated", "comment", "options")
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
	if _, err = v.text(record["expressionSql"], 1, 16384); err != nil {
		return nil, err
	}
	for _, field := range []string{"enforced", "validated"} {
		if record[field] != nil {
			if _, ok := record[field].(bool); !ok {
				return nil, errors.New("SCHEMA_INVALID")
			}
		}
	}
	if _, err = v.text(record["comment"], 0, 8192); err != nil {
		return nil, err
	}
	if err = v.options(record["options"]); err != nil {
		return nil, err
	}
	return &PhysicalCheck{value: clonePhysicalValue(record).(map[string]any)}, nil
}

func (check *PhysicalCheck) Value() map[string]any {
	return clonePhysicalValue(check.value).(map[string]any)
}
