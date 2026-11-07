package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/testcase"
)

func TestRotateAESRowDoesNotReturnPartialResult(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	keys := mustAESKeyring(t, map[int32]string{1: "old", 2: "new"}, 2)
	row := map[string]any{"aes_key_version": int32(1), "aes_hex_email": "not-hex"}
	if _, err := RotateAESRow(row, "aes_key_version", []AESRotationColumn{{Name: "aes_hex_email", Styles: []string{"aes", "hex"}}}, 2, keys); err == nil {
		t.Fatal("invalid ciphertext was accepted")
	}
	if row["aes_key_version"] != int32(1) {
		t.Fatal("input row was changed")
	}
}

// Requirements: COD-55 (FCV-2: a rotation row without a selected column, an input that no recipe value can hold, stays native). The keyring constructor refuses an empty key and an undeclared current version with CONFIG.
func TestAESVersionCodesAreTheSameInEveryClient(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	keys := mustAESKeyring(t, map[int32]string{1: "old", 2: "new"}, 2)
	cols := []AESRotationColumn{{Name: "aes_hex_email", Styles: []string{"aes", "hex"}}}
	row := func(version any) map[string]any {
		return map[string]any{"aes_key_version": version, "aes_hex_email": "00"}
	}
	cases := []struct {
		name string
		err  func() error
		code string
	}{
		{"empty key", func() error { _, err := NewAESKeyring(map[int32]string{1: ""}, 1); return err }, CodeConfig},
		{"current version undeclared", func() error { _, err := NewAESKeyring(map[int32]string{1: "k"}, 2); return err }, CodeConfig},
		{"AES column missing from rotation row", func() error {
			r := row(int32(1))
			delete(r, "aes_hex_email")
			_, err := RotateAESRow(r, "aes_key_version", cols, 2, keys)
			return err
		}, CodeInternal},
		{"version column missing from rotation row", func() error {
			r := row(int32(1))
			delete(r, "aes_key_version")
			_, err := RotateAESRow(r, "aes_key_version", cols, 2, keys)
			return err
		}, CodeInternal},
	}
	for _, c := range cases {
		if got := ErrorCode(c.err()); got != c.code {
			t.Errorf("%s: code = %q, want %s", c.name, got, c.code)
		}
	}
}

// assertAESRowDecodeIsInternal decodes a row of one AES email cell with the plan step and scan of the case and
// requires the INTERNAL code: what names the plan defect of the case.
func assertAESRowDecodeIsInternal(t *testing.T, step *plan.Step, si *scanInfo, what string) {
	t.Helper()
	enc, err := HostEncode("email@example.test", []string{"aes", "hex"}, "k")
	if err != nil {
		t.Fatal(err)
	}
	err = decodeSelectedRow([]any{enc}, si, step, mustAESKeyring(t, map[int32]string{1: "k"}, 1))
	if got := ErrorCode(err); got != CodeInternal {
		t.Fatalf("%s: code = %q, want %s (err %v)", what, got, CodeInternal, err)
	}
}

// Requirements: COD-56.
// FCV-2: the case builds a read plan without its version column, an input that no recipe value can hold; it stays native.
func TestAESReadWithoutVersionColumnIsInternal(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	step := &plan.Step{Assemble: &plan.Assemble{Entity: "user", Columns: []plan.OutCol{{Index: 0, Name: "aes_hex_email", Type: "string"}}}}
	si := &scanInfo{styled: []styledScanCol{{index: 0, name: "aes_hex_email", host: []string{"aes", "hex"}, asm: step.Assemble}}}
	assertAESRowDecodeIsInternal(t, step, si, "plan without a version column")
}

// Requirements: COD-48.
// FCV-2: the case builds a selected row without its version cell, an input that no recipe value can hold; it stays native.
func TestAESReadRowWithoutVersionCellIsInternal(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	step, si := aesReadStep()
	assertAESRowDecodeIsInternal(t, step, si, "selected AES row without its version cell")
}

// aesReadStep is the step of an assembly with an AES column at index 0 and its version column at index 1.
func aesReadStep() (*plan.Step, *scanInfo) {
	at := 1
	step := &plan.Step{Assemble: &plan.Assemble{Entity: "user", AESVersion: &at, Columns: []plan.OutCol{
		{Index: 0, Name: "aes_hex_email", Type: "string"},
		{Index: 1, Name: "aes_key_version", Type: "int"},
	}}}
	si := &scanInfo{styled: []styledScanCol{{index: 0, name: "aes_hex_email", host: []string{"aes", "hex"}, asm: step.Assemble}}}
	return step, si
}

func mustAESKeyring(t *testing.T, keys map[int32]string, current int32) AESKeyring {
	t.Helper()
	keyring, err := NewAESKeyring(keys, current)
	if err != nil {
		t.Fatal(err)
	}
	return keyring
}

// HostDecodeVersioned is an API of Go alone (FCV-2).
// Requirements: COD-6.
func TestHostAESDecodesByStoredVersion(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	oldValue, err := HostEncode("old@example.test", []string{"aes"}, "old-key")
	if err != nil {
		t.Fatal(err)
	}
	keyring, err := NewAESKeyring(map[int32]string{1: "old-key", 2: "new-key"}, 2)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := HostDecodeVersioned(oldValue, []string{"aes"}, 1, keyring)
	if err != nil || decoded != "old@example.test" {
		t.Fatalf("versioned decode = %#v, %v", decoded, err)
	}
	if _, err := HostDecodeVersioned(oldValue, []string{"aes"}, 2, keyring); err == nil {
		t.Fatal("wrong stored version was accepted")
	}
}
