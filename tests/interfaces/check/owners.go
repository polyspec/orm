package main

import (
	"fmt"
	"strings"
)

type Owner struct {
	ID     string `json:"id"`
	For    string `json:"for"`
	Native map[string]struct {
		Symbol string   `json:"symbol"`
		Fields []string `json:"fields"`
	} `json:"native"`
}

// A source inventory can be re-recorded; common owner layouts cannot gain a
// private controller/cache/connection field without an explicit contract edit.
// owner는 한 symbol을 가리키며(`once`), 그 field 목록은 contract에 적힌 그대로다.
func checkOwners(lang string, symbols Symbols, owners []Owner) []string {
	var failures []string
	for _, o := range owners {
		if o.For != "once" {
			failures = append(failures, o.ID+": unknown owner expansion "+o.For)
			continue
		}
		n, ok := o.Native[lang]
		if !ok {
			failures = append(failures, o.ID+": missing owner mapping "+lang)
			continue
		}
		if _, ok := symbols[n.Symbol]; !ok {
			failures = append(failures, lang+"/"+o.ID+": missing owner "+n.Symbol)
			continue
		}
		prefix := n.Symbol + "#field."
		if lang == "php" {
			prefix = n.Symbol + "::$"
		}
		expected, actual := Symbols{}, Symbols{}
		for _, f := range n.Fields {
			expected[f] = "field"
		}
		for k := range symbols {
			if strings.HasPrefix(k, prefix) {
				actual[strings.TrimPrefix(k, prefix)] = "field"
			}
		}
		for _, d := range differences(expected, actual) {
			failures = append(failures, fmt.Sprintf("%s/%s: %s", lang, o.ID, d))
		}
	}
	return failures
}
