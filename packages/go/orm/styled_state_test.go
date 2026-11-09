package orm

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: COD-20, COD-73.
func TestStyledColumnStateFixture(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	data, err := os.ReadFile("../../../contracts/fixtures/styled_column_states.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			ID         string         `json:"id"`
			Style      string         `json:"style"`
			StoredText *string        `json:"stored_text"`
			Output     map[string]any `json:"output"`
			Input      map[string]any `json:"input"`
			Getter     map[string]any `json:"getter"`
			Nullable   bool           `json:"nullable"`
			WriteText  *string        `json:"write_text"`
			Error      string         `json:"error"`
			Message    string         `json:"message"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		switch c.ID {
		case "unselected":
			// A styled value that the row did not select refuses to be read.
			t.Run(c.ID, func(t *testing.T) {
				if _, err := json.Marshal(StyledValue{}); ErrorCode(err) != c.Error {
					t.Fatalf("unselected value error = %v; want %s", err, c.Error)
				}
				if err := ColumnUnselected("payload"); ErrorCode(err) != c.Error {
					t.Fatalf("unselected column error = %v; want %s", err, c.Error)
				}
			})
			continue
		case "nonnull_sql_null":
			// SQL NULL written to a column that is not nullable is refused with the name of the column (COD-73).
			t.Run(c.ID, func(t *testing.T) {
				_, err := NormalizeStyled("payload", codecStages([]string{c.Style}), false, SqlNull())
				if want := c.Error + ": payload does not accept SQL NULL"; err == nil || err.Error() != want {
					t.Fatalf("non-null SQL NULL error = %v; want %s", err, want)
				}
			})
			continue
		}
		if strings.HasPrefix(c.ID, "setter_") {
			// The setter encodes its input by the codec stages of its column and fails with the whole text of the first
			// rule that the input meets, or keeps the value that the getter returns (COD-73).
			t.Run(c.ID+"/setter", func(t *testing.T) {
				var styled StyledValue
				switch c.Input["kind"] {
				case "sql-null":
					styled = SqlNull()
				case "value":
					styled = Value(c.Input["value"])
				default:
					t.Fatalf("unknown fixture input kind %v", c.Input["kind"])
				}
				got, err := NormalizeStyled("payload", codecStages([]string{c.Style}), c.Nullable, styled)
				if c.Message != "" {
					if err == nil || err.Error() != c.Message {
						t.Fatalf("setter error = %v; want %s", err, c.Message)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				gotJSON, err := json.Marshal(got)
				if err != nil {
					t.Fatal(err)
				}
				wantJSON, err := json.Marshal(c.Getter)
				if err != nil {
					t.Fatal(err)
				}
				if string(gotJSON) != string(wantJSON) {
					t.Fatalf("getter = %s; want %s", gotJSON, wantJSON)
				}
			})
			if c.StoredText == nil {
				continue
			}
		}
		t.Run(c.ID, func(t *testing.T) {
			var raw any
			if c.StoredText != nil {
				raw = *c.StoredText
			}
			got, err := Decode(codecStages([]string{c.Style}), raw)
			if c.Error != "" {
				if err == nil || !strings.Contains(err.Error(), c.Error) {
					t.Fatalf("decode error = %v; want %s", err, c.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.Kind() != c.Output["kind"] {
				t.Fatalf("kind = %s, want %v", got.Kind(), c.Output["kind"])
			}
			actualJSON, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			wantJSON, err := json.Marshal(c.Output)
			if err != nil {
				t.Fatal(err)
			}
			if string(actualJSON) != string(wantJSON) {
				t.Fatalf("output = %s; want %s", actualJSON, wantJSON)
			}
			encoded, err := Encode(codecStages([]string{c.Style}), got)
			if err != nil {
				t.Fatal(err)
			}
			if c.Style == "yaml" && c.Output["kind"] == "value" {
				if encoded == nil {
					t.Fatal("YAML value null encoded as SQL NULL")
				}
			} else if c.WriteText == nil {
				if encoded != nil {
					t.Fatalf("encoded = %v; want SQL NULL", encoded)
				}
			} else if encoded != *c.WriteText {
				t.Fatalf("encoded = %v; want %q", encoded, *c.WriteText)
			}
		})
	}
}
