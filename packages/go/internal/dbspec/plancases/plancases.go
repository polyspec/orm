// Package plancases reads the cases of tests/dbspec/plan-cases.json, the recipe of the plan cases, and their physical
// data in tests/dbspec/plans-physical.json, which the dbspec apply tool and the physical dialect tests share.
package plancases

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Case is one case of plan-cases.json: its id, the document lines of its source (nil if the case has no source, which
// is the empty schema), the lines of its plan, and the steps of each dialect (the expect of its dbspec.plan_steps step).
type Case struct {
	ID     string
	Source []string
	Plan   []string
	Steps  map[string]json.RawMessage
	// Changes are the expect changes of the dbspec.diff step: each [kind, table, name].
	Changes [][3]string
}

// Physical is the database data of one case of plans-physical.json: the before steps run before the plan steps, and
// the after steps run after them. Each is an array of DDL steps (tests/dbspec/ddl.json).
type Physical struct {
	Before json.RawMessage `json:"before"`
	After  json.RawMessage `json:"after"`
}

// recipe is the part of plan-cases.json that Parse reads.
type recipe struct {
	Cases []struct {
		ID    string `json:"id"`
		Steps []struct {
			Op      string                     `json:"op"`
			Lines   []string                   `json:"lines"`
			Dialect string                     `json:"dialect"`
			Expect  map[string]json.RawMessage `json:"expect"`
		} `json:"steps"`
	} `json:"cases"`
}

// Parse reads the cases of the plan-cases.json text raw. The source of a case is the lines of its dbspec.parse step, and
// its plan is the lines of its dbspec.parse_plan step; a case with no dbspec.parse step has the empty schema as its source.
// Its steps are the expect of each dbspec.plan_steps step, keyed by dialect, whose expect is the database none.
func Parse(raw []byte) ([]Case, error) {
	var r recipe
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	cases := make([]Case, 0, len(r.Cases))
	for _, rc := range r.Cases {
		c := Case{ID: rc.ID, Steps: map[string]json.RawMessage{}}
		hasPlan := false
		for _, s := range rc.Steps {
			switch s.Op {
			case "dbspec.parse":
				if c.Source == nil {
					c.Source = s.Lines
				}
			case "dbspec.parse_plan":
				if !hasPlan {
					c.Plan = s.Lines
					hasPlan = true
				}
			case "dbspec.diff":
				changes, ok := s.Expect["none"]
				if !ok {
					return nil, fmt.Errorf("case %s: dbspec.diff has no expect for none", rc.ID)
				}
				var outcome struct {
					Changes [][3]string `json:"changes"`
				}
				if err := json.Unmarshal(changes, &outcome); err != nil {
					return nil, fmt.Errorf("case %s: %w", rc.ID, err)
				}
				c.Changes = outcome.Changes
			case "dbspec.plan_steps":
				steps, ok := s.Expect["none"]
				if !ok {
					return nil, fmt.Errorf("case %s: dbspec.plan_steps has no expect for none", rc.ID)
				}
				var outcome struct {
					Steps json.RawMessage `json:"steps"`
				}
				if err := json.Unmarshal(steps, &outcome); err != nil {
					return nil, fmt.Errorf("case %s: %w", rc.ID, err)
				}
				c.Steps[s.Dialect] = outcome.Steps
			}
		}
		if !hasPlan {
			return nil, fmt.Errorf("case %s has no dbspec.parse_plan step", rc.ID)
		}
		cases = append(cases, c)
	}
	return cases, nil
}

// Read reads the cases of the plan-cases.json beside the plans.json at plansPath.
func Read(plansPath string) ([]Case, error) {
	raw, err := os.ReadFile(CasesPath(plansPath))
	if err != nil {
		return nil, err
	}
	return Parse(raw)
}

// CasesPath is the plan-cases.json beside the plans.json at plansPath.
func CasesPath(plansPath string) string {
	return filepath.Join(filepath.Dir(plansPath), "plan-cases.json")
}

// ParsePhysical reads the physical records of the plans-physical.json text raw, keyed by case id.
func ParsePhysical(raw []byte) (map[string]Physical, error) {
	var file struct {
		Cases map[string]Physical `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, err
	}
	return file.Cases, nil
}
