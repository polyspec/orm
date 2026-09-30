package schema

import (
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// PhysicalDisplay is reversible display text, never a physical identifier.
func PhysicalDisplay(text string) string {
	var out strings.Builder
	for _, c := range text {
		if c < 32 || c == 127 || c == '␛' || strings.ContainsRune("\"\\<>&#`%[]{}", c) {
			fmt.Fprintf(&out, "␛%04x", c)
		} else {
			out.WriteRune(c)
		}
	}
	return out.String()
}

var displayEscape = regexp.MustCompile(`␛([0-9a-f]{4})`)

func RestorePhysicalDisplay(text string) string {
	return displayEscape.ReplaceAllStringFunc(text, func(s string) string {
		n, _ := strconv.ParseInt(strings.TrimPrefix(s, "␛"), 16, 32)
		return string(rune(n))
	})
}
func projectionAlias(prefix, id string) string { return prefix + hex.EncodeToString([]byte(id)) }
func physicalProjection(graph *PhysicalGraph, yield func(string) bool) {
	if !yield("%% Multiplicity and identifying status are unverified display conventions.") {
		return
	}
	quote := PhysicalDisplay("\"")
	for _, item := range graph.value["tables"].([]any) {
		table := item.(map[string]any)
		parts := table["identity"].([]any)
		labels := make([]string, 3)
		for i, part := range parts[:3] {
			if part == nil {
				labels[i] = "null"
			} else {
				labels[i] = quote + PhysicalDisplay(part.(string)) + quote
			}
		}
		label := PhysicalDisplay("[") + strings.Join(labels, ",") + PhysicalDisplay("]")
		if !yield("    " + projectionAlias("T_", table["id"].(string)) + "[\"" + label + "\"] {") {
			return
		}
		for _, item := range table["columns"].([]any) {
			column := item.(map[string]any)
			if !yield("        physical " + projectionAlias("C_", column["id"].(string)) + " \"" + PhysicalDisplay(column["name"].(string)) + " | " + PhysicalDisplay(column["typeSql"].(string)) + "\"") {
				return
			}
		}
		if !yield("    }") {
			return
		}
	}
	for _, item := range graph.value["foreignKeys"].([]any) {
		fk := item.(map[string]any)
		target := fk["target"].(map[string]any)
		local, remote := fk["columns"].([]any), target["columns"].([]any)
		pairs := make([]string, len(local))
		for i, c := range local {
			pairs[i] = c.(string) + "->" + remote[i].(string)
		}
		if !yield("%% FK " + fk["id"].(string) + " " + strings.Join(pairs, ",")) {
			return
		}
		if !yield("    " + projectionAlias("T_", fk["tableId"].(string)) + " }o..o{ " + projectionAlias("T_", target["tableId"].(string)) + " : \"unverified FK " + fk["id"].(string) + "\"") {
			return
		}
	}
}
