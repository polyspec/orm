//go:build physical

package dialects

import "strings"

func clientRunnerEnvironment(base []string, overrides map[string]string) []string {
	result := make([]string, 0, len(base)+len(overrides))
	for _, value := range base {
		name, _, _ := strings.Cut(value, "=")
		if _, replaced := overrides[name]; !replaced {
			result = append(result, value)
		}
	}
	for name, value := range overrides {
		result = append(result, name+"="+value)
	}
	return result
}
