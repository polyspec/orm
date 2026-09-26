package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"go.yaml.in/yaml/v3"
)

func readErrorCatalog(root string) (map[string]bool, error) {
	b, err := os.ReadFile(filepath.Join(root, "docs/errors.yaml"))
	if err != nil {
		return nil, err
	}
	var document struct {
		Codes []struct {
			Code string `yaml:"code"`
		} `yaml:"codes"`
	}
	if err := yaml.Unmarshal(b, &document); err != nil {
		return nil, err
	}
	if len(document.Codes) == 0 {
		return nil, fmt.Errorf("error catalog has no codes")
	}
	valid := regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
	codes := make(map[string]bool, len(document.Codes))
	for _, entry := range document.Codes {
		if !valid.MatchString(entry.Code) || codes[entry.Code] {
			return nil, fmt.Errorf("invalid or duplicate error code %q", entry.Code)
		}
		codes[entry.Code] = true
	}
	return codes, nil
}

func checkErrorLabels(codes map[string]bool, rules []Rule, sequences []Sequence) []string {
	var failures []string
	for _, rule := range rules {
		seen := map[string]bool{}
		for _, label := range rule.Errors {
			if seen[label] {
				failures = append(failures, rule.ID+": duplicate error "+label)
			}
			seen[label] = true
			if !codes[label] && label != "driver error" && label != "driver or codec error" {
				failures = append(failures, rule.ID+": unknown error "+label)
			}
		}
	}
	found := false
	for _, sequence := range sequences {
		if sequence.ID != "errors" {
			continue
		}
		if found {
			failures = append(failures, "duplicate errors state sequence")
		}
		found = true
		values, ok := sequence.Expected.([]any)
		if !ok || len(values) == 0 {
			failures = append(failures, "errors state sequence requires a nonempty code list")
			continue
		}
		for index, value := range values {
			code, ok := value.(string)
			if !ok || !codes[code] {
				failures = append(failures, fmt.Sprintf("errors state sequence item %d is not a declared code", index))
			}
		}
	}
	if !found {
		failures = append(failures, "missing errors state sequence")
	}
	return failures
}
