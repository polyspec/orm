//go:build featurecoverage

package orm_test

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/internal/testcase"
)

// aesInput은 authenticated_encryption fixture case의 input이다.
type aesInput struct {
	Key         string `json:"key"`
	EnvelopeHex string `json:"envelope_hex"`
	Plain       string `json:"plain"`
}

// aesExpected는 authenticated_encryption fixture case의 expected다.
type aesExpected struct {
	Plain         string `json:"plain"`
	Error         string `json:"error"`
	PrefixHex     string `json:"prefix_hex"`
	EnvelopeBytes int    `json:"envelope_bytes"`
	Index         string `json:"index"`
}

// aesCase는 fixture case의 input과 expected를 읽는다.
func aesCase(t *testing.T, id, operation string) (aesInput, aesExpected) {
	t.Helper()
	c := featureFixture(t, "authenticated_encryption", id, operation)
	var input aesInput
	var expected aesExpected
	decodeFixture(t, c.Input, &input)
	decodeFixture(t, c.Expected, &expected)
	return input, expected
}

// decryptFixture는 input의 envelope를 input key로 연다.
func decryptFixture(t *testing.T, input aesInput) ([]byte, error) {
	t.Helper()
	envelope, err := hex.DecodeString(input.EnvelopeHex)
	if err != nil {
		t.Fatal(err)
	}
	return orm.AESDecrypt(envelope, input.Key)
}

// TestCoverageAesEnvelopeDecrypt는 기록된 v2 envelope를 연다.
func TestCoverageAesEnvelopeDecrypt(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	input, expected := aesCase(t, "aes_envelope_decrypt", "aes_decrypt")
	plain, err := decryptFixture(t, input)
	if err != nil || expected.Plain == "" || string(plain) != expected.Plain {
		t.Fatalf("decrypt = %q, %v; want %q", plain, err, expected.Plain)
	}
}

// TestCoverageAesRoundTrip는 암호화한 envelope의 prefix와 길이를 확인하고 다시 연다.
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

// TestCoverageAesTamperRejected는 바뀐 envelope를 거부한다.
func TestCoverageAesTamperRejected(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	input, expected := aesCase(t, "aes_tamper_rejected", "aes_decrypt")
	plain, err := decryptFixture(t, input)
	if expected.Error == "" || orm.ErrorCode(err) != expected.Error {
		t.Fatalf("decrypt = %q, %v; want %s", plain, err, expected.Error)
	}
}

// TestCoverageAesWrongKeyRejected는 다른 key의 envelope를 거부한다.
func TestCoverageAesWrongKeyRejected(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	input, expected := aesCase(t, "aes_wrong_key_rejected", "aes_decrypt")
	plain, err := decryptFixture(t, input)
	if expected.Error == "" || orm.ErrorCode(err) != expected.Error {
		t.Fatalf("decrypt = %q, %v; want %s", plain, err, expected.Error)
	}
}

// TestCoverageBlindIndexVector는 blind index가 기록된 값인지 확인한다.
func TestCoverageBlindIndexVector(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	input, expected := aesCase(t, "blind_index_vector", "blind_index")
	index, err := orm.BlindIndex(input.Plain, input.Key)
	if err != nil || expected.Index == "" || index != expected.Index {
		t.Fatalf("blind index = %s, %v; want %s", index, err, expected.Index)
	}
}
