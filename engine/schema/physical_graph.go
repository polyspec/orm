package schema

import "fmt"

// PhysicalGraph owns detached physical nodes and resolved FK memberships.
// It is not a complete physical schema or permission to execute SQL.
type PhysicalGraph struct{ value map[string]any }
type PhysicalGraphError struct{ path string }

func (e *PhysicalGraphError) Error() string { return "SCHEMA_INVALID" }
func (e *PhysicalGraphError) Path() string  { return e.path }
func graphError(path string) error          { return &PhysicalGraphError{path: path} }
func graphList(value any, max, min int, path string) ([]any, error) {
	list, ok := value.([]any)
	if !ok || list == nil || len(list) < min || len(list) > max {
		return nil, graphError(path)
	}
	return list, nil
}

// Only bounded-depth, validated records may be passed here.
func graphStringBytes(value any) int {
	switch value := value.(type) {
	case string:
		return len(value)
	case []any:
		total := 0
		for _, v := range value {
			total += graphStringBytes(v)
		}
		return total
	case map[string]any:
		total := 0
		for _, v := range value {
			total += graphStringBytes(v)
		}
		return total
	}
	return 0
}
func PhysicalGraphFromValue(value map[string]any) (*PhysicalGraph, error) {
	root, err := physicalObject(value, "version", "dialect", "dialectVersion", "tables", "foreignKeys")
	if err != nil {
		return nil, graphError("")
	}
	validVersion := false
	switch version := root["version"].(type) {
	case float64:
		validVersion = version == 1
	case int:
		validVersion = version == 1
	}
	if !validVersion {
		return nil, graphError("/version")
	}
	dialect, ok := root["dialect"].(string)
	if !ok || !(dialect == "mysql" || dialect == "postgres" || dialect == "sqlite") {
		return nil, graphError("/dialect")
	}
	validator := physicalRecordValidator{}
	dialectVersion, err := validator.text(root["dialectVersion"], 1, 128)
	if err != nil {
		return nil, graphError("/dialectVersion")
	}
	inputs, err := graphList(root["tables"], 4096, 0, "/tables")
	if err != nil {
		return nil, err
	}
	fkInputs, err := graphList(root["foreignKeys"], 20000, 0, "/foreignKeys")
	if err != nil {
		return nil, err
	}
	ids, identities, tableIDs := map[string]bool{}, map[string]bool{}, map[string]bool{}
	owners := map[string]string{}
	bytes, columnsCount := len(dialect)+len(dialectVersion), 0
	reserve := func(id, path string) error {
		if ids[id] {
			return graphError(path)
		}
		ids[id] = true
		return nil
	}
	budget := func(record any, path string) error {
		bytes += graphStringBytes(record)
		if bytes > 16*1024*1024 {
			return graphError(path)
		}
		return nil
	}
	tables := make([]any, len(inputs))
	for index, input := range inputs {
		path := fmt.Sprintf("/tables/%d", index)
		table, e := physicalObject(input, "id", "identity", "columns", "comment", "options")
		if e != nil {
			return nil, graphError(path)
		}
		v := physicalRecordValidator{}
		id, e := v.id(table["id"])
		if e != nil {
			return nil, graphError(path + "/id")
		}
		if e = reserve(id, path+"/id"); e != nil {
			return nil, e
		}
		parts, ok := table["identity"].([]any)
		if !ok || len(parts) != 4 || parts[3] != nil {
			return nil, graphError(path + "/identity")
		}
		var names [4]*string
		for i, part := range parts {
			if part != nil {
				text, ok := part.(string)
				if !ok {
					return nil, graphError(path + "/identity")
				}
				names[i] = &text
			}
		}
		if names[2] == nil {
			return nil, graphError(path + "/identity")
		}
		identity, e := NewPhysicalIdentity(names[0], names[1], *names[2], nil)
		if e != nil || identities[identity.Key()] {
			return nil, graphError(path + "/identity")
		}
		identities[identity.Key()] = true
		tableIDs[id] = true
		columnInputs, e := graphList(table["columns"], 4096, 1, path+"/columns")
		if e != nil {
			return nil, e
		}
		columnsCount += len(columnInputs)
		if columnsCount > 120000 {
			return nil, graphError(path + "/columns")
		}
		columns := make([]any, len(columnInputs))
		columnNames := map[string]bool{}
		for j, input := range columnInputs {
			columnPath := fmt.Sprintf("%s/columns/%d", path, j)
			object, ok := input.(map[string]any)
			if !ok {
				return nil, graphError(columnPath)
			}
			column, e := PhysicalColumnFromValue(object)
			if e != nil {
				return nil, graphError(columnPath)
			}
			columnID, name := column.value["id"].(string), column.value["name"].(string)
			if e = reserve(columnID, columnPath+"/id"); e != nil {
				return nil, e
			}
			if columnNames[name] {
				return nil, graphError(columnPath + "/name")
			}
			columnNames[name] = true
			owners[columnID] = id
			if e = budget(column.value, columnPath); e != nil {
				return nil, e
			}
			columns[j] = column.value
		}
		comment, e := v.text(table["comment"], 0, 8192)
		if e != nil {
			return nil, graphError(path + "/comment")
		}
		if e = v.options(table["options"]); e != nil {
			return nil, graphError(path + "/options")
		}
		metadata := map[string]any{"id": id, "identity": clonePhysicalValue(parts), "comment": comment, "options": clonePhysicalValue(table["options"])}
		if graphStringBytes(metadata) > 65536 {
			return nil, graphError(path)
		}
		if e = budget(metadata, path); e != nil {
			return nil, e
		}
		metadata["columns"] = columns
		tables[index] = metadata
	}
	fks := make([]any, len(fkInputs))
	constraintNames := map[string]map[string]bool{}
	for index, input := range fkInputs {
		path := fmt.Sprintf("/foreignKeys/%d", index)
		object, ok := input.(map[string]any)
		if !ok {
			return nil, graphError(path)
		}
		record, e := PhysicalForeignKeyFromValue(object)
		if e != nil {
			return nil, graphError(path)
		}
		fk := record.value
		id, tableID := fk["id"].(string), fk["tableId"].(string)
		target := fk["target"].(map[string]any)
		targetID := target["tableId"].(string)
		if e = reserve(id, path+"/id"); e != nil {
			return nil, e
		}
		if !tableIDs[tableID] {
			return nil, graphError(path + "/tableId")
		}
		if !tableIDs[targetID] {
			return nil, graphError(path + "/target/tableId")
		}
		local, remote := fk["columns"].([]any), target["columns"].([]any)
		for j, column := range local {
			if owners[column.(string)] != tableID {
				return nil, graphError(fmt.Sprintf("%s/columns/%d", path, j))
			}
			if owners[remote[j].(string)] != targetID {
				return nil, graphError(fmt.Sprintf("%s/target/columns/%d", path, j))
			}
		}
		if name, ok := fk["name"].(string); ok {
			if constraintNames[tableID] == nil {
				constraintNames[tableID] = map[string]bool{}
			}
			if constraintNames[tableID][name] {
				return nil, graphError(path + "/name")
			}
			constraintNames[tableID][name] = true
		}
		if e = budget(fk, path); e != nil {
			return nil, e
		}
		fks[index] = fk
	}
	return &PhysicalGraph{value: map[string]any{"version": root["version"], "dialect": dialect, "dialectVersion": dialectVersion, "tables": tables, "foreignKeys": fks}}, nil
}
func (graph *PhysicalGraph) Value() map[string]any {
	return clonePhysicalValue(graph.value).(map[string]any)
}
