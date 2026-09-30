package schema

import (
	"errors"
)

// PhysicalColumn is structural data only, not SQL execution permission.
type PhysicalColumn struct{ value map[string]any }

func PhysicalColumnFromValue(value map[string]any) (*PhysicalColumn, error) {
	object, err := physicalObject(value, "id", "name", "typeSql", "nullable", "default", "generation", "comment", "options")
	if err != nil {
		return nil, err
	}
	validator := physicalRecordValidator{}
	id, err := validator.text(object["id"], 1, 128)
	if err != nil || !physicalStableID(id) {
		return nil, errors.New("SCHEMA_INVALID")
	}
	name, err := validator.text(object["name"], 1, 1024)
	if err != nil {
		return nil, err
	}
	if _, err = NewPhysicalIdentity(nil, nil, name, nil); err != nil {
		return nil, err
	}
	if _, err = validator.text(object["typeSql"], 1, 4096); err != nil {
		return nil, err
	}
	if _, ok := object["nullable"].(bool); !ok {
		return nil, errors.New("SCHEMA_INVALID")
	}
	if _, err = validator.text(object["comment"], 0, 8192); err != nil {
		return nil, err
	}
	def, ok := object["default"].(map[string]any)
	if !ok {
		return nil, errors.New("SCHEMA_INVALID")
	}
	kind, err := validator.text(def["kind"], 1, 16)
	if err != nil {
		return nil, err
	}
	switch kind {
	case "absent", "null":
		if _, err = physicalObject(def, "kind"); err != nil {
			return nil, err
		}
	case "literal", "expression":
		if _, err = physicalObject(def, "kind", "sql"); err != nil {
			return nil, err
		}
		if _, err = validator.text(def["sql"], 1, 16384); err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("SCHEMA_INVALID")
	}
	generation, ok := object["generation"].(map[string]any)
	if !ok {
		return nil, errors.New("SCHEMA_INVALID")
	}
	kind, err = validator.text(generation["kind"], 1, 16)
	if err != nil {
		return nil, err
	}
	switch kind {
	case "none":
		if _, err = physicalObject(generation, "kind"); err != nil {
			return nil, err
		}
	case "identity":
		if _, err = physicalObject(generation, "kind", "sql"); err != nil {
			return nil, err
		}
		if _, err = validator.text(generation["sql"], 1, 16384); err != nil {
			return nil, err
		}
	case "computed":
		if _, err = physicalObject(generation, "kind", "sql", "storage"); err != nil {
			return nil, err
		}
		if _, err = validator.text(generation["sql"], 1, 16384); err != nil {
			return nil, err
		}
		storage, e := validator.text(generation["storage"], 1, 16)
		if e != nil || !(storage == "stored" || storage == "virtual" || storage == "unspecified") {
			return nil, errors.New("SCHEMA_INVALID")
		}
	default:
		return nil, errors.New("SCHEMA_INVALID")
	}
	if err = validator.options(object["options"]); err != nil {
		return nil, err
	}
	return &PhysicalColumn{value: clonePhysicalValue(object).(map[string]any)}, nil
}
func (column *PhysicalColumn) Value() map[string]any {
	return clonePhysicalValue(column.value).(map[string]any)
}
