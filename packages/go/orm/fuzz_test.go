package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

func FuzzDecodeCiphertext(f *testing.F) {
	testcase.Start(f, testcase.Compute)
	f.Add([]byte{})
	f.Add([]byte("ORM-AES2"))
	f.Add([]byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9})
	f.Fuzz(func(t *testing.T, input []byte) {
		_, _ = HostDecode(input, []string{"aes"}, "fuzz-key")
	})
}
