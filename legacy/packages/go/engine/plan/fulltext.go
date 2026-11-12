package plan

import "strings"

// FulltextBoolean is the transform fulltext_boolean (DIA-6): the search text of a MySQL boolean-mode match. It splits the
// value on whitespace, removes the MySQL boolean operator characters from each term and drops the terms that are empty,
// prefixes every term with +, suffixes the last term with *, and joins the terms with single spaces. A value with no term
// is "", which the executor refuses with IR_INVALID.
func FulltextBoolean(s string) string {
	var terms []string
	for _, field := range strings.Fields(s) {
		term := strings.Map(func(r rune) rune {
			if strings.ContainsRune(`+-<>()~*"@`, r) {
				return -1
			}
			return r
		}, field)
		if term != "" {
			terms = append(terms, "+"+term)
		}
	}
	if len(terms) == 0 {
		return ""
	}
	terms[len(terms)-1] += "*"
	return strings.Join(terms, " ")
}
