package generator

import (
	"strings"

	"github.com/polyspec/orm/engine/runtimemodel"
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

// clientStyles는 field codec 중 styled value를 만드는 stage다. aes, hex, ip는
// string 값을 그대로 두므로 빠진다.
func clientStyles(c *runtimemodel.Field) []string {
	var out []string
	for _, s := range c.Codec {
		if s != "aes" && s != "hex" && s != "ip" {
			out = append(out, s)
		}
	}
	return out
}
