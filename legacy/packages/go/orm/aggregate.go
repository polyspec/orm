package orm

import (
	"errors"
	"math"
	"math/big"
	"strconv"
	"strings"

	"github.com/go-sql-driver/mysql"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
)

// avgScaleExtra is the number of decimal places that the average of an exact column keeps beyond the scale of the column
// (DSL-161).
const avgScaleExtra = 16

// aggregateMessage is the text of every refused sum or average scalar in every client (DSL-66).
const aggregateMessage = "aggregate scalar is not a finite number"

// aggregateRefusal is the CODEC_DECODE of a sum or average scalar that is not a finite binary64 number (DSL-66).
func aggregateRefusal() error { return &ir.Error{Code: CodeCodecDecode, Msg: aggregateMessage} }

// aggregateFloat is the binary64 value of the sum cell of an f64 column (DSL-66).
func aggregateFloat(v any) (float64, error) {
	f, err := AsFloat64(v)
	if err != nil {
		return 0, aggregateRefusal()
	}
	return f, nil
}

// avgCells are the two cells of an average statement: the sum of the values and their count (DSL-161).
type avgCells struct {
	sum, count any
}

// exactAggregate reports whether the sum and the average of the column are exact (DSL-161): an integer or a decimal column.
func exactAggregate(field *runtimemodel.Field) bool {
	switch field.Type {
	case "i16", "i32", "i64", "decimal":
		return true
	}
	return false
}

// splitSum reports whether the planner splits the sum of the column into the sums of its four 16-bit parts and the cell
// that reports a value that is not an integer: an exact column on SQLite and on markdown, which runs SQLite (DIA-218).
func splitSum(driver string, field *runtimemodel.Field) bool {
	return (driver == "sqlite" || driver == "markdown") && exactAggregate(field)
}

// splitCells is the number of cells of a split sum: the four sums of the 16-bit parts and the cell that reports a value that
// is not an integer (DIA-218).
const splitCells = 5

// nonInteger is the sum of a column that holds a value that is not an integer (DIA-218), which the reader of the sum refuses
// by the name and the type of its column.
type nonInteger struct{}

// nonIntegerRefusal is the CODEC_DECODE of the sum of a column that holds a value which its type does not hold: a value that
// is not an integer, or a decimal of more fraction digits than the scale of the column (DIA-218, DSL-66).
func nonIntegerRefusal(column, columnType string, scale int) error {
	if columnType == "decimal" {
		return &ir.Error{Code: CodeCodecDecode, Msg: "column " + column + " holds a value that is not a decimal of scale " + strconv.Itoa(scale)}
	}
	return &ir.Error{Code: CodeCodecDecode, Msg: "column " + column + " holds a value that is not an integer"}
}

// splitSumValue is the exact integer ((p3 × 2^16 + p2) × 2^16 + p1) × 2^16 + p0 of the cells of a split sum, nonInteger when
// its last cell reports a value that is not an integer, and nil when every part is SQL NULL, the sum of no value (DIA-218).
func splitSumValue(parts []any, flag any) (any, error) {
	if flag != nil {
		n, ok := flag.(int64)
		if !ok {
			return nil, aggregateRefusal()
		}
		if n != 0 {
			return nonInteger{}, nil
		}
	}
	sum := new(big.Int)
	none := true
	for _, part := range parts {
		sum.Lsh(sum, 16)
		if part == nil {
			continue
		}
		n, ok := part.(int64)
		if !ok {
			return nil, aggregateRefusal()
		}
		none = false
		sum.Add(sum, big.NewInt(n))
	}
	if none {
		return nil, nil
	}
	return sum, nil
}

// sumCell is the sum of a sum or an average statement: its one cell, or the exact integer of the cells of a split sum
// (DIA-218); SQL NULL, the sum of no value, stays nil.
func sumCell(cells []cell) (any, error) {
	if len(cells) == 1 {
		return cells[0].v, nil
	}
	if len(cells) != splitCells {
		return nil, internalErr("a split sum reads %d cells, not %d", len(cells), splitCells)
	}
	parts := make([]any, 0, splitCells-1)
	for _, c := range cells[:splitCells-1] {
		parts = append(parts, c.v)
	}
	return splitSumValue(parts, cells[splitCells-1].v)
}

// exactSum reads the sum cell of the exact column field as its sign and the digits of the sum times 10^scale: an integer
// cell, or the integer of a split sum (DIA-218), is that integer (SQLite and markdown store a decimal so, DIA-25), a text cell
// is a decimal of at most scale fraction digits. A sum that holds a value which the type of the column does not hold, which
// the split sum reports and the text of MySQL and PostgreSQL shows by more fraction digits, is refused by its column.
func exactSum(field *runtimemodel.Field, raw any) (bool, string, error) {
	scale := field.Scale
	if _, ok := raw.(nonInteger); ok {
		return false, "", nonIntegerRefusal(field.Name, field.Type, scale)
	}
	if n, ok := raw.(*big.Int); ok {
		return n.Sign() < 0, new(big.Int).Abs(n).String(), nil
	}
	if n, ok := raw.(int64); ok {
		digits := strconv.FormatInt(n, 10)
		if n < 0 {
			return true, digits[1:], nil
		}
		return false, digits, nil
	}
	text, ok := raw.(string)
	if b, isBytes := raw.([]byte); isBytes {
		text, ok = string(b), true
	}
	if !ok {
		return false, "", aggregateRefusal()
	}
	negative := strings.HasPrefix(text, "-")
	if negative {
		text = text[1:]
	}
	whole, fraction, dot := strings.Cut(text, ".")
	if whole == "" || !allDigits(whole) || !allDigits(fraction) || (dot && fraction == "") {
		return false, "", aggregateRefusal()
	}
	if len(fraction) > scale {
		return false, "", nonIntegerRefusal(field.Name, field.Type, scale)
	}
	digits := strings.TrimLeft(whole+fraction+strings.Repeat("0", scale-len(fraction)), "0")
	if digits == "" {
		return false, "0", nil
	}
	return negative, digits, nil
}

func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// nearestBinary64 converts the exact decimal sign digits × 10^-scale to the nearest binary64 value, ties to even; a value
// beyond the finite range is CODEC_DECODE (DSL-66).
func nearestBinary64(negative bool, digits string, scale int) (float64, error) {
	text := digits + "e-" + strconv.Itoa(scale)
	if negative && strings.Trim(digits, "0") != "" {
		text = "-" + text
	}
	f, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return 0, aggregateRefusal()
	}
	return f, nil
}

// sumValue is the result of getSum for the sum cell v of the column field (DSL-66, DSL-161).
func sumValue(field *runtimemodel.Field, v any) (float64, error) {
	if !exactAggregate(field) {
		return aggregateFloat(v)
	}
	negative, digits, err := exactSum(field, v)
	if err != nil {
		return 0, err
	}
	return nearestBinary64(negative, digits, field.Scale)
}

// avgValue is the result of getAvg for the sum and the count of the values of the column field: null for no value; for an
// exact column the exact sum divided by the count, rounded half away from zero to avgScaleExtra places beyond the scale of
// the column, and then converted once (DSL-66, DSL-161); for an f64 column the binary64 sum divided by the count, which is the
// AVG of every database.
func avgValue(field *runtimemodel.Field, cells avgCells) (*float64, error) {
	count, err := AsInt64(cells.count)
	if err != nil {
		return nil, aggregateRefusal()
	}
	if count == 0 {
		return nil, nil
	}
	if count < 0 || cells.sum == nil {
		return nil, aggregateRefusal()
	}
	if !exactAggregate(field) {
		sum, err := aggregateFloat(cells.sum)
		if err != nil {
			return nil, err
		}
		f := sum / float64(count)
		return &f, nil
	}
	negative, digits, err := exactSum(field, cells.sum)
	if err != nil {
		return nil, err
	}
	n, _ := new(big.Int).SetString(digits, 10)
	// The quotient with one place more than the stated scale: its last digit decides the rounding half away from zero.
	n.Mul(n, new(big.Int).Exp(big.NewInt(10), big.NewInt(avgScaleExtra+1), nil))
	n.Quo(n, big.NewInt(count))
	q, last := new(big.Int).QuoRem(n, big.NewInt(10), new(big.Int))
	if last.Int64() >= 5 {
		q.Add(q, big.NewInt(1))
	}
	f, err := nearestBinary64(negative, q.String(), field.Scale+avgScaleExtra)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

// aggregateRangeErr is the error of a sum or average statement: PostgreSQL refuses an f64 sum beyond the finite range with
// SQLSTATE 22003, and MySQL refuses it so through the planned addition of 0, which is the nonfinite scalar that the other
// databases return, so it is CODEC_DECODE with the text of that scalar and the driver error as its cause (DIA-216).
func aggregateRangeErr(err error) error {
	var state interface{ SQLState() string }
	var my *mysql.MySQLError
	if (errors.As(err, &state) && state.SQLState() == "22003") || (errors.As(err, &my) && string(my.SQLState[:]) == "22003") {
		return &ir.Error{Code: CodeCodecDecode, Msg: aggregateMessage, Cause: err}
	}
	return err
}
