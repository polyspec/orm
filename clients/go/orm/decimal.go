package orm

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/polyspec/orm/engine/ir"
)

// NormalizeDecimal validates a decimal field value and pads it to the declared scale.
func NormalizeDecimal(input string, precision, scale int) (string, error) {
	fail := func(reason string) (string, error) {
		return "", &ir.Error{Code: CodeCodecEncode, Msg: fmt.Sprintf("decimal %q: %s", input, reason)}
	}
	if precision < 1 || precision > 18 || scale < 0 || scale > precision {
		return fail("invalid precision or scale")
	}
	if input == "" {
		return fail("empty value")
	}
	negative := false
	if input[0] == '-' || input[0] == '+' {
		negative = input[0] == '-'
		input = input[1:]
	}
	parts := strings.Split(input, ".")
	if len(parts) > 2 || parts[0] == "" || (len(parts) == 2 && parts[1] == "") {
		return fail("invalid text")
	}
	for _, part := range parts {
		for i := 0; i < len(part); i++ {
			if part[i] < '0' || part[i] > '9' {
				return fail("invalid text")
			}
		}
	}
	whole := strings.TrimLeft(parts[0], "0")
	if whole == "" {
		whole = "0"
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
	}
	if len(fraction) > scale {
		return fail("fraction exceeds scale")
	}
	wholeDigits := len(whole)
	if whole == "0" {
		wholeDigits = 0
	}
	if wholeDigits+scale > precision {
		return fail("value exceeds precision")
	}
	fraction += strings.Repeat("0", scale-len(fraction))
	if whole == "0" && strings.Trim(fraction, "0") == "" {
		negative = false
	}
	if negative {
		whole = "-" + whole
	}
	if scale == 0 {
		return whole, nil
	}
	return whole + "." + fraction, nil
}

// DecimalScaledInt converts a validated decimal to SQLite's exact integer cell.
func DecimalScaledInt(input string, precision, scale int) (int64, error) {
	canonical, err := NormalizeDecimal(input, precision, scale)
	if err != nil {
		return 0, err
	}
	digits := strings.Replace(canonical, ".", "", 1)
	n, err := strconv.ParseInt(digits, 10, 64)
	if err != nil {
		return 0, codecErr(CodeCodecEncode, "decimal %q exceeds scaled integer range: %v", input, err)
	}
	return n, nil
}

// DecimalFromScaledInt returns the exact decimal text stored by SQLite.
func DecimalFromScaledInt(raw any, precision, scale int) (string, error) {
	n, ok := raw.(int64)
	if !ok {
		return "", codecErr(CodeCodecDecode, "decimal scaled cell is %T, expected int64", raw)
	}
	negative := n < 0
	if negative {
		n = -n
	}
	digits := strconv.FormatInt(n, 10)
	if scale > 0 {
		for len(digits) <= scale {
			digits = "0" + digits
		}
		digits = digits[:len(digits)-scale] + "." + digits[len(digits)-scale:]
	}
	if negative {
		digits = "-" + digits
	}
	canonical, err := NormalizeDecimal(digits, precision, scale)
	if err != nil {
		return "", codecErr(CodeCodecDecode, "invalid scaled decimal cell %d: %v", raw, err)
	}
	return canonical, nil
}

// DecodeDecimal decodes a generated decimal field from an exact database cell.
func (c *Core) DecodeDecimal(raw any, precision, scale int) (string, error) {
	if _, ok := raw.(int64); ok {
		return DecimalFromScaledInt(raw, precision, scale)
	}
	text, err := AsString(raw)
	if err != nil {
		return "", err
	}
	canonical, err := NormalizeDecimal(text, precision, scale)
	if err != nil {
		return "", codecErr(CodeCodecDecode, "invalid decimal cell %q: %v", text, err)
	}
	return canonical, nil
}
