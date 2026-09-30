package schema

import "fmt"

// Root list bounds and table/column ownership must already be validated.
func resolvePhysicalGraphRecords(root map[string]any, ids, tableIDs map[string]bool, owners map[string]string, names map[string]map[string]bool, budget func(any, string) error) (map[string][]any, error) {
	register := func(record map[string]any, path string, namespace map[string]map[string]bool) error {
		id, tableID := record["id"].(string), record["tableId"].(string)
		if ids[id] {
			return graphError(path + "/id")
		}
		ids[id] = true
		if !tableIDs[tableID] {
			return graphError(path + "/tableId")
		}
		if name, ok := record["name"].(string); ok {
			if namespace[tableID] == nil {
				namespace[tableID] = map[string]bool{}
			}
			if namespace[tableID][name] {
				return graphError(path + "/name")
			}
			namespace[tableID][name] = true
		}
		return nil
	}
	result := map[string][]any{}
	indices := map[string]map[string]any{}
	indexNames := map[string]map[string]bool{}
	result["indices"] = make([]any, len(root["indices"].([]any)))
	for i, input := range root["indices"].([]any) {
		path := fmt.Sprintf("/indices/%d", i)
		object, ok := input.(map[string]any)
		if !ok {
			return nil, graphError(path)
		}
		index, err := PhysicalIndexFromValue(object)
		if err != nil {
			return nil, graphError(path)
		}
		record := index.value
		if err = register(record, path, indexNames); err != nil {
			return nil, err
		}
		tableID := record["tableId"].(string)
		for j, item := range record["terms"].([]any) {
			source := item.(map[string]any)["source"].(map[string]any)
			if source["kind"] == "column" && owners[source["columnId"].(string)] != tableID {
				return nil, graphError(fmt.Sprintf("%s/terms/%d/source/columnId", path, j))
			}
		}
		for j, column := range record["include"].([]any) {
			if owners[column.(string)] != tableID {
				return nil, graphError(fmt.Sprintf("%s/include/%d", path, j))
			}
		}
		if err = budget(record, path); err != nil {
			return nil, err
		}
		indices[record["id"].(string)] = record
		result["indices"][i] = record
	}
	primary, linked := map[string]bool{}, map[string]bool{}
	result["keys"] = make([]any, len(root["keys"].([]any)))
	for i, input := range root["keys"].([]any) {
		path := fmt.Sprintf("/keys/%d", i)
		object, ok := input.(map[string]any)
		if !ok {
			return nil, graphError(path)
		}
		key, err := PhysicalKeyFromValue(object)
		if err != nil {
			return nil, graphError(path)
		}
		record := key.value
		if err = register(record, path, names); err != nil {
			return nil, err
		}
		tableID := record["tableId"].(string)
		for j, column := range record["columns"].([]any) {
			if owners[column.(string)] != tableID {
				return nil, graphError(fmt.Sprintf("%s/columns/%d", path, j))
			}
		}
		if record["kind"] == "primary" {
			if primary[tableID] {
				return nil, graphError(path + "/kind")
			}
			primary[tableID] = true
		}
		if indexID, ok := record["indexId"].(string); ok {
			index := indices[indexID]
			if index == nil || linked[indexID] || !physicalGraphIndexMatchesKey(index, record) {
				return nil, graphError(path + "/indexId")
			}
			linked[indexID] = true
		}
		if err = budget(record, path); err != nil {
			return nil, err
		}
		result["keys"][i] = record
	}
	result["checks"] = make([]any, len(root["checks"].([]any)))
	for i, input := range root["checks"].([]any) {
		path := fmt.Sprintf("/checks/%d", i)
		object, ok := input.(map[string]any)
		if !ok {
			return nil, graphError(path)
		}
		check, err := PhysicalCheckFromValue(object)
		if err != nil {
			return nil, graphError(path)
		}
		record := check.value
		if err = register(record, path, names); err != nil {
			return nil, err
		}
		if err = budget(record, path); err != nil {
			return nil, err
		}
		result["checks"][i] = record
	}
	return result, nil
}

func physicalGraphIndexMatchesKey(index, key map[string]any) bool {
	if index["tableId"] != key["tableId"] || index["predicateSql"] != nil || (key["withoutOverlaps"] != true && index["unique"] != true) {
		return false
	}
	terms, columns := index["terms"].([]any), key["columns"].([]any)
	if len(terms) != len(columns) {
		return false
	}
	for i, term := range terms {
		source := term.(map[string]any)["source"].(map[string]any)
		if source["kind"] != "column" || source["columnId"] != columns[i] {
			return false
		}
	}
	return key["nullsDistinct"] == nil || index["nullsDistinct"] == nil || key["nullsDistinct"] == index["nullsDistinct"]
}
