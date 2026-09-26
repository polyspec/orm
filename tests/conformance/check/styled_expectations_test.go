package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteCycleExpectationsUseTaggedStyledValues(t *testing.T) {
	for _, file := range []string{"vectors.json", "vectors.postgres.json", "vectors.sqlite.json"} {
		t.Run(file, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("..", file))
			if err != nil {
				t.Fatal(err)
			}
			var document struct {
				Vectors []struct {
					Name   string `json:"name"`
					Expect struct {
						Result any `json:"result"`
					} `json:"expect"`
				} `json:"vectors"`
			}
			if err := json.Unmarshal(data, &document); err != nil {
				t.Fatal(err)
			}
			found := false
			for _, vector := range document.Vectors {
				if vector.Name != "write_cycle" {
					continue
				}
				found = true
				result, ok := vector.Expect.Result.(map[string]any)
				if !ok {
					t.Fatal("write_cycle result is absent")
				}
				for _, rowName := range []string{"created", "updated"} {
					row, ok := result[rowName].(map[string]any)
					if !ok {
						t.Fatalf("%s result is absent", rowName)
					}
					for _, column := range []string{"json_setting", "serialize_data"} {
						styled, ok := row[column].(map[string]any)
						if !ok || len(styled) != 2 || styled["kind"] != "value" || styled["value"] == nil {
							t.Fatalf("%s.%s does not use the declared styled value: %v", rowName, column, row[column])
						}
					}
				}
			}
			if !found {
				t.Fatal("write_cycle expectation is absent")
			}
		})
	}
}
