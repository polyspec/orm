package orm

import "testing"

func FuzzDecodeCiphertext(f *testing.F) {
	f.Add([]byte{})
	f.Add([]byte("ORM-AES2"))
	f.Add([]byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9})
	f.Fuzz(func(t *testing.T, input []byte) {
		_, _ = hostDecode(input, []string{"aes"}, "fuzz-key")
	})
}
