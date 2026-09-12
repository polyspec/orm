package main

import (
	"fmt"
	"github.com/polyspec/orm/engine/schema"
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
func checkOwners(lang string, symbols Symbols, owners []Owner, s *schema.Manifest) []string {
	var failures []string
	for _, o := range owners {
		n, ok := o.Native[lang]
		if !ok {
			failures = append(failures, o.ID+": missing owner mapping "+lang)
			continue
		}
		entities := []string{""}
		if o.For == "entity" {
			entities = s.Order
		}
		for _, e := range entities {
			symbol := strings.ReplaceAll(strings.ReplaceAll(n.Symbol, "{entity}", e), "{Entity}", pascal(e))
			if _, ok := symbols[symbol]; !ok {
				failures = append(failures, lang+"/"+o.ID+": missing owner "+symbol)
				continue
			}
			prefix := symbol + "#field."
			if lang == "php" {
				prefix = symbol + "::$"
			}
			expected, actual := Symbols{}, Symbols{}
			fieldName := func(name string) string {
				if lang == "go" {
					return pascal(name)
				}
				if lang == "rust" && strings.Contains(" as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while async await dyn ", " "+name+" ") {
					return name + "_"
				}
				return name
			}
			for _, f := range n.Fields {
				switch f {
				case "{columns}":
					for _, c := range s.Entities[e].Columns {
						expected[fieldName(c.Name)] = "field"
					}
				case "{relations}":
					for _, r := range s.Entities[e].Relations {
						name := fieldName(r.Name)
						if lang == "rust" {
							name += "_"
						}
						expected[name] = "field"
					}
				default:
					expected[f] = "field"
				}
			}
			for k := range symbols {
				if strings.HasPrefix(k, prefix) {
					actual[strings.TrimPrefix(k, prefix)] = "field"
				}
			}
			for _, d := range differences(expected, actual) {
				failures = append(failures, fmt.Sprintf("%s/%s (%s): %s", lang, o.ID, e, d))
			}
		}
	}
	return failures
}
