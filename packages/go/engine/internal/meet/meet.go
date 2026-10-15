// Package meet holds the one table of which two columns compare alike on the three databases. dbspec's check
// validation and the IR validator both read it, so the two cannot drift (docs/dbspec.md "Checks").
package meet

import "fmt"

// classes maps a type to its class where several types share one: integers meet integers, and varchar meets text.
var classes = map[string]string{"i16": "integer", "i32": "integer", "i64": "integer", "varchar": "string", "text": "string"}

// Kind is the class of a column type: two columns meet when their kinds are equal. A decimal carries its scale and a
// time or datetime its precision, since a different scale or precision compares differently; every other type is its
// own class.
func Kind(typ string, scale, precision int) string {
	if c, ok := classes[typ]; ok {
		return c
	}
	switch typ {
	case "decimal":
		return fmt.Sprintf("decimal scale %d", scale)
	case "time", "datetime":
		return fmt.Sprintf("%s precision %d", typ, precision)
	}
	return typ
}
