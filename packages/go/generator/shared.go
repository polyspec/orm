package generator

import (
	"strings"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
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

// clientStyles is the stage among field codecs that creates styled values. aes, hex, and ip
// are omitted because they keep the string value as is.
func clientStyles(c *runtimemodel.Field) []string {
	var out []string
	for _, s := range c.Codec {
		if s != "aes" && s != "hex" && s != "ip" {
			out = append(out, s)
		}
	}
	return out
}
