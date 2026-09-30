package schema

import "errors"

type PhysicalForeignKey struct{ value map[string]any }

func PhysicalForeignKeyFromValue(value map[string]any) (*PhysicalForeignKey, error) {
	record, err := physicalObject(value, "id", "name", "tableId", "columns", "target", "onDelete", "onUpdate", "match", "deferrable", "initiallyDeferred", "comment", "options")
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
	local, err := v.ids(record["columns"])
	if err != nil {
		return nil, err
	}
	target, err := physicalObject(record["target"], "tableId", "columns")
	if err != nil {
		return nil, err
	}
	if _, err = v.id(target["tableId"]); err != nil {
		return nil, err
	}
	remote, err := v.ids(target["columns"])
	if err != nil || len(local) != len(remote) {
		return nil, errors.New("SCHEMA_INVALID")
	}
	for _, field := range []string{"onDelete", "onUpdate"} {
		action, e := v.text(record[field], 1, 16)
		if e != nil {
			return nil, e
		}
		switch action {
		case "noAction", "restrict", "cascade", "setNull", "setDefault", "unspecified":
		default:
			return nil, errors.New("SCHEMA_INVALID")
		}
	}
	match, err := v.text(record["match"], 1, 16)
	if err != nil {
		return nil, err
	}
	switch match {
	case "simple", "full", "partial", "unspecified":
	default:
		return nil, errors.New("SCHEMA_INVALID")
	}
	for _, field := range []string{"deferrable", "initiallyDeferred"} {
		if record[field] != nil {
			if _, ok := record[field].(bool); !ok {
				return nil, errors.New("SCHEMA_INVALID")
			}
		}
	}
	if record["initiallyDeferred"] == true && record["deferrable"] != true {
		return nil, errors.New("SCHEMA_INVALID")
	}
	if _, err = v.text(record["comment"], 0, 8192); err != nil {
		return nil, err
	}
	if err = v.options(record["options"]); err != nil {
		return nil, err
	}
	return &PhysicalForeignKey{value: clonePhysicalValue(record).(map[string]any)}, nil
}
func (fk *PhysicalForeignKey) Value() map[string]any {
	return clonePhysicalValue(fk.value).(map[string]any)
}
