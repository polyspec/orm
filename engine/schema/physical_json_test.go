package schema

import (
	"strings"
	"testing"
	"time"
)

func TestPhysicalJSONPreflightBounds(t *testing.T) {
	for _, c := range []struct {
		id, text string
		ok       bool
	}{
		{"byte-limit", strings.Repeat(" ", physicalJSONBytes-1) + "0", true},
		{"byte-excess", strings.Repeat(" ", physicalJSONBytes) + "0", false},
		{"depth-limit", strings.Repeat("[", 16) + "0" + strings.Repeat("]", 16), true},
		{"depth-excess", strings.Repeat("[", 17) + "0" + strings.Repeat("]", 17), false},
		{"node-limit", "[" + strings.Repeat("0,", 2999998) + "0]", true},
		{"node-excess", "[" + strings.Repeat("0,", 2999999) + "0]", false},
	} {
		t.Run(c.id, func(t *testing.T) {
			start := time.Now()
			t.Log("RUN", c.id)
			_, err := decodePhysicalJSON([]byte(c.text))
			if (err == nil) != c.ok {
				t.Fatalf("wrong limit result: %v", err)
			}
			t.Logf("PASS %s %s", c.id, time.Since(start))
			if time.Since(start) > 15*time.Second {
				t.Fatal("deadline exceeded")
			}
		})
	}
}
