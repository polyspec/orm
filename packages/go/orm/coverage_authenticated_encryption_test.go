//go:build featurecoverage

package orm_test

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
)

// aesInput is the input of an authenticated_encryption fixture case.
type aesInput struct {
	Key         string `json:"key"`
	EnvelopeHex string `json:"envelope_hex"`
	Plain       string `json:"plain"`
}

// aesExpected is the expected value of an authenticated_encryption fixture case.
type aesExpected struct {
	Plain         string `json:"plain"`
	Error         string `json:"error"`
	PrefixHex     string `json:"prefix_hex"`
	EnvelopeBytes int    `json:"envelope_bytes"`
	Index         string `json:"index"`
}

// aesCase reads the input and expected values of a fixture case.
func aesCase(t *testing.T, id, operation string) (aesInput, aesExpected) {
	t.Helper()
	c := featureFixture(t, "authenticated_encryption", id, operation)
	var input aesInput
	var expected aesExpected
	decodeFixture(t, c.Input, &input)
	decodeFixture(t, c.Expected, &expected)
	return input, expected
}

// decryptFixture opens the input's envelope with the input key.
func decryptFixture(t *testing.T, input aesInput) ([]byte, error) {
	t.Helper()
	envelope, err := hex.DecodeString(input.EnvelopeHex)
	if err != nil {
		t.Fatal(err)
	}
	return orm.AESDecrypt(envelope, input.Key)
}

// TestCoverageAesEnvelopeDecrypt opens the recorded v2 envelope.
func TestCoverageAesEnvelopeDecrypt(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	input, expected := aesCase(t, "aes_envelope_decrypt", "aes_decrypt")
	plain, err := decryptFixture(t, input)
	if err != nil || expected.Plain == "" || string(plain) != expected.Plain {
		t.Fatalf("decrypt = %q, %v; want %q", plain, err, expected.Plain)
	}
}

// TestCoverageAesRoundTrip checks the prefix and length of the encrypted envelope and opens it again.
func TestCoverageAesRoundTrip(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	input, expected := aesCase(t, "aes_round_trip", "aes_encrypt_decrypt")
	envelope, err := orm.AESEncrypt([]byte(input.Plain), input.Key)
	if err != nil {
		t.Fatal(err)
	}
	prefix, err := hex.DecodeString(expected.PrefixHex)
	if err != nil {
		t.Fatal(err)
	}
	if len(prefix) == 0 || !bytes.HasPrefix(envelope, prefix) || len(envelope) != expected.EnvelopeBytes {
		t.Fatalf("envelope %x has %d bytes, want prefix %s and %d bytes", envelope, len(envelope), expected.PrefixHex, expected.EnvelopeBytes)
	}
	plain, err := orm.AESDecrypt(envelope, input.Key)
	if err != nil || expected.Plain == "" || string(plain) != expected.Plain {
		t.Fatalf("decrypt = %q, %v; want %q", plain, err, expected.Plain)
	}
}

// TestCoverageAesTamperRejected rejects a modified envelope.
func TestCoverageAesTamperRejected(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	aesRejected(t, "aes_tamper_rejected")
}

// TestCoverageAesWrongKeyRejected rejects an envelope with a different key.
func TestCoverageAesWrongKeyRejected(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	aesRejected(t, "aes_wrong_key_rejected")
}

// TestCoverageBlindIndexVector checks that the blind index matches the recorded value.
func TestCoverageBlindIndexVector(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	input, expected := aesCase(t, "blind_index_vector", "blind_index")
	index, err := orm.BlindIndex(input.Plain, input.Key)
	if err != nil || expected.Index == "" || index != expected.Index {
		t.Fatalf("blind index = %s, %v; want %s", index, err, expected.Index)
	}
}

// TestCoverageAuthenticatedEncryption runs every case of contracts/fixtures/authenticated_encryption.json as a subtest named by its id,
// with the test of that case, so the parity check runs the suite under its case ids.
func TestCoverageAuthenticatedEncryption(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	runFixtureCases(t, "authenticated_encryption", map[string]func(*testing.T){
		"aes_envelope_decrypt":   TestCoverageAesEnvelopeDecrypt,
		"aes_round_trip":         TestCoverageAesRoundTrip,
		"aes_tamper_rejected":    TestCoverageAesTamperRejected,
		"aes_wrong_key_rejected": TestCoverageAesWrongKeyRejected,
		"blind_index_vector":     TestCoverageBlindIndexVector,
	})
}

// aesRejected checks that the decryption case id is rejected with the error its
// fixture expects.
func aesRejected(t *testing.T, id string) {
	t.Helper()
	input, expected := aesCase(t, id, "aes_decrypt")
	plain, err := decryptFixture(t, input)
	if expected.Error == "" || orm.ErrorCode(err) != expected.Error {
		t.Fatalf("decrypt = %q, %v; want %s", plain, err, expected.Error)
	}
}
