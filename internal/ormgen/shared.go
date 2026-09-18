package ormgen

import (
	"strings"

	"github.com/polyspec/orm/engine/schema"
)

func pascal(s string) string {
	var b strings.Builder
	up := true
	for _, r := range s {
		if r == '_' {
			up = true
			continue
		}
		if up {
			b.WriteString(strings.ToUpper(string(r)))
			up = false
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// appStyles is the part of a column's style stack the executor handles (aes/hex/ip stay in SQL).
func appStyles(c *schema.Col) []string {
	var out []string
	for _, s := range c.Styles {
		if s != "aes" && s != "hex" && s != "ip" {
			out = append(out, s)
		}
	}
	return out
}
