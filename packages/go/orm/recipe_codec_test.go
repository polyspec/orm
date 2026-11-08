package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/internal/recipe"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestRecipeCodecNone runs the codec recipe, tests/codec/codec.json, without a database (FCV-3).
// Requirements: COD-3, COD-4, COD-5, COD-6, COD-8, COD-9, COD-10, COD-11, COD-12, COD-13, COD-14, COD-16, COD-20, COD-28,
// COD-29, COD-30, COD-31, COD-33, COD-34, COD-35, COD-36, COD-37, COD-38, COD-39, COD-40, PLN-15.
func TestRecipeCodecNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/codec/codec.json", recipe.None)
}

// TestRecipeCodecIntegerBeyondI64None runs tests/codec/codec-integer-beyond-i64.json: an integer beyond i64 is refused (COD-62).
func TestRecipeCodecIntegerBeyondI64None(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/codec/codec-integer-beyond-i64.json", recipe.None)
}

// TestRecipeCodecBytesValueNone runs tests/codec/codec-bytes-value.json: bytes are not a codec value (COD-63).
func TestRecipeCodecBytesValueNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/codec/codec-bytes-value.json", recipe.None)
}

// TestRecipeCodecNonFiniteValueNone runs tests/codec/codec-non-finite-value.json: a float that is not finite is refused (COD-70).
func TestRecipeCodecNonFiniteValueNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/codec/codec-non-finite-value.json", recipe.None)
}

// TestRecipeCodecJsonDepthNone runs tests/codec/codec-json-depth.json: a value nested deeper than 256 levels is refused (COD-70).
func TestRecipeCodecJsonDepthNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/codec/codec-json-depth.json", recipe.None)
}

// TestRecipeCodecRawTextNone runs tests/codec/codec-raw-text.json: a string whose bytes are not UTF-8 is refused (COD-64, COD-70).
func TestRecipeCodecRawTextNone(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	recipe.Run(t, "../../../tests/codec/codec-raw-text.json", recipe.None)
}
