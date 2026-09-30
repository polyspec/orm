package orm

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPhysicalGraphLimits(t *testing.T) {
	started := time.Now()
	t.Log("RUN physical_graph_limits")
	defer func() {
		t.Logf("DONE physical_graph_limits %s", time.Since(started))
		if time.Since(started) > 15*time.Second {
			t.Fatal("graph deadline exceeded")
		}
	}()
	data, err := os.ReadFile("../../../contracts/fixtures/physical_graphs.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Base   map[string]any `json:"base"`
		Limits []struct {
			ID           string `json:"id"`
			Tables       int    `json:"tables"`
			Columns      int    `json:"columns"`
			FKs          int    `json:"foreignKeys"`
			CommentBytes int    `json:"commentBytes"`
			Error        string `json:"error"`
		} `json:"limits"`
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Limits) != 5 {
		t.Fatal("missing limit vectors")
	}
	for _, limit := range fixture.Limits {
		t.Run(limit.ID, func(t *testing.T) {
			tables := make([]any, limit.Tables)
			comment := strings.Repeat("x", limit.CommentBytes)
			for i := range tables {
				columns := make([]any, limit.Columns)
				for j := range columns {
					columns[j] = map[string]any{"id": fmt.Sprintf("c-%d-%d", i, j), "name": fmt.Sprintf("Column.%d", j), "typeSql": "INTEGER", "nullable": false, "default": map[string]any{"kind": "absent"}, "generation": map[string]any{"kind": "none"}, "comment": comment, "options": []any{}}
				}
				tables[i] = map[string]any{"id": fmt.Sprintf("t-%d", i), "identity": []any{nil, "main", fmt.Sprintf("Table.%d", i), nil}, "columns": columns, "comment": "child\ncomment", "options": []any{}}
			}
			fks := make([]any, limit.FKs)
			for i := range fks {
				fks[i] = fixture.Base["foreignKeys"].([]any)[0]
			}
			value := map[string]any{"version": float64(1), "dialect": "sqlite", "dialectVersion": "3.50.0", "tables": tables, "foreignKeys": fks}
			_, err := PhysicalGraphFromValue(value)
			var located *PhysicalGraphError
			if !errors.As(err, &located) || located.Path() != limit.Error {
				t.Fatalf("expected %s: %v", limit.Error, err)
			}
		})
	}
}
