package model

import (
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
)

func TestGeneratedAssignmentRejectsInvalidValues(t *testing.T) {
	m := Author()
	if _, err := m.assign("seq", int64(7)); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		column string
		value  any
	}{
		{"seq", "bad"},
		{"seq", nil},
		{"aes_key_version", int64(1 << 32)},
		{"is_close", "perhaps"},
		{"start_dt", "bad date"},
		{"name", nil},
		{"price", "bad"},
		{"description", 123},
		{"ip", []byte{0xff}},
		{"ip", nil},
	} {
		_, err := m.assign(tc.column, tc.value)
		if tc.column == "ip" && tc.value == nil {
			if err != nil || m.fIp != nil {
				t.Errorf("nullable ip: %v", err)
			}
			continue
		}
		if code := orm.ErrorCode(err); code != orm.CodeCodecDecode {
			t.Errorf("%s value %#v returned code %q", tc.column, tc.value, code)
		}
	}
	if m.fSeq != 7 {
		t.Fatalf("failed assignment changed seq to %d", m.fSeq)
	}
	if got, err := m.assign("is_close", "1"); !got || err != nil || !m.fIsClose {
		t.Fatalf("valid bool assignment: %v, %v, %v", got, err, m.fIsClose)
	}
	if got, err := m.assign("not_a_column", 1); got || err != nil {
		t.Fatalf("unknown column: %v, %v", got, err)
	}
}
