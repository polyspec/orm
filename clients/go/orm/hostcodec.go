package orm

// Host-side stages for styles that require executor processing. AES uses the
// authenticated v2 envelope; hex and ip use the common byte representation.

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"strings"
	"sync"
)

var aesV2Prefix = []byte("ORM-AES2\x00")

// AESEncrypt returns the authenticated v2 envelope used by every client.
func AESEncrypt(plain []byte, key string) ([]byte, error) {
	gcm, err := aesGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("aes: nonce generation: %w", err)
	}
	out := append([]byte{}, aesV2Prefix...)
	out = append(out, nonce...)
	out = append(out, gcm.Seal(nil, nonce, plain, aesV2Prefix)...)
	return out, nil
}

// AESDecrypt authenticates and decrypts a v2 envelope.
func AESDecrypt(ciphertext []byte, key string) ([]byte, error) {
	if len(ciphertext) < len(aesV2Prefix) || !bytes.HasPrefix(ciphertext, aesV2Prefix) {
		return nil, codecErr(CodeCodecDecode, "aes: unsupported ciphertext format")
	}
	gcm, err := aesGCM(key)
	if err != nil {
		return nil, err
	}
	start := len(aesV2Prefix)
	if len(ciphertext) < start+gcm.NonceSize()+gcm.Overhead() {
		return nil, codecErr(CodeCodecDecode, "aes: truncated v2 envelope")
	}
	nonce := ciphertext[start : start+gcm.NonceSize()]
	plain, err := gcm.Open(nil, nonce, ciphertext[start+gcm.NonceSize():], aesV2Prefix)
	if err != nil {
		return nil, codecErr(CodeCodecDecode, "aes: authentication failed")
	}
	return plain, nil
}

// aesCiphers caches the AEAD of each key; an AEAD is safe for concurrent use.
var aesCiphers sync.Map

func aesGCM(key string) (cipher.AEAD, error) {
	if v, ok := aesCiphers.Load(key); ok {
		return v.(cipher.AEAD), nil
	}
	block, err := aes.NewCipher(aesV2Key(key))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	aesCiphers.Store(key, gcm)
	return gcm, nil
}

func aesV2Key(key string) []byte {
	h := sha256.New()
	h.Write([]byte("polyspec/orm/aes-256-gcm/v2\x00"))
	h.Write([]byte(key))
	return h.Sum(nil)
}

// BlindIndex returns the stable lowercase HMAC-SHA256 index for plaintext.
// The blind-index key is independent from the rotating AES key.
func BlindIndex(v any, key string) (string, error) {
	if v == nil {
		return "", nil
	}
	if key == "" {
		return "", codecErr(CodeConfig, "secret blind_index not configured")
	}
	var plain []byte
	switch x := v.(type) {
	case string:
		plain = []byte(x)
	case []byte:
		plain = x
	default:
		plain = []byte(fmt.Sprint(x))
	}
	h := hmac.New(sha256.New, []byte(key))
	_, _ = h.Write(plain)
	return hex.EncodeToString(h.Sum(nil)), nil
}

// packIP is INET6_ATON: 4 bytes for IPv4, 16 for IPv6.
func packIP(s string) ([]byte, error) {
	ip := net.ParseIP(strings.TrimSpace(s))
	if ip == nil {
		return nil, codecErr(CodeCodecEncode, "ip: %q is not an address", s)
	}
	if v4 := ip.To4(); v4 != nil {
		return []byte(v4), nil
	}
	return []byte(ip.To16()), nil
}

// unpackIP is INET6_NTOA.
func unpackIP(b []byte) (string, error) {
	switch len(b) {
	case 4, 16:
		return net.IP(b).String(), nil
	}
	return "", codecErr(CodeCodecDecode, "ip: %d packed bytes", len(b))
}

// HostEncode applies the executor-side stages of a bound value in write order
// (also used by bench/seedaes to fill AES columns in database fixtures).
func HostEncode(v any, styles []string, aesKey string) (any, error) {
	if v == nil {
		return nil, nil
	}
	var cur []byte
	switch x := v.(type) {
	case string:
		cur = []byte(x)
	case []byte:
		cur = x
	default:
		cur = []byte(fmt.Sprint(x))
	}
	for _, st := range styles {
		var err error
		switch st {
		case "aes":
			if aesKey == "" {
				return nil, codecErr(CodeConfig, "secret aes not configured")
			}
			if cur, err = AESEncrypt(cur, aesKey); err != nil {
				return nil, err
			}
		case "hex":
			cur = []byte(strings.ToUpper(hex.EncodeToString(cur)))
		case "ip":
			if cur, err = packIP(string(cur)); err != nil {
				return nil, err
			}
		default:
			return nil, codecErr(CodeCodecUnsupported, "host style %s", st)
		}
	}
	if last := styles[len(styles)-1]; last == "hex" {
		return string(cur), nil
	}
	return cur, nil
}

// hostDecode undoes hostEncode on a read cell (styles in write order, applied in reverse).
func hostDecode(raw any, styles []string, aesKey string) (any, error) {
	var cur []byte
	switch x := raw.(type) {
	case nil:
		return nil, nil
	case string:
		cur = []byte(x)
	case []byte:
		cur = x
	default:
		return nil, codecErr(CodeCodecDecode, "cell is %T, not bytes", raw)
	}
	for i := len(styles) - 1; i >= 0; i-- {
		var err error
		switch styles[i] {
		case "hex":
			if cur, err = hex.DecodeString(strings.TrimSpace(string(cur))); err != nil {
				return nil, codecErr(CodeCodecDecode, "hex: %v", err)
			}
		case "aes":
			if aesKey == "" {
				return nil, codecErr(CodeConfig, "secret aes not configured")
			}
			if cur, err = AESDecrypt(cur, aesKey); err != nil {
				return nil, err
			}
		case "ip":
			s, err := unpackIP(cur)
			if err != nil {
				return nil, err
			}
			return s, nil
		default:
			return nil, codecErr(CodeCodecUnsupported, "host style %s", styles[i])
		}
	}
	return string(cur), nil
}

// splitHost separates the executor codec stages (docs/codec.md) from the
// host stages a dialect left to us (aes/hex/ip); read order is codec after host.
func splitHost(styles []string) (codec, host []string) {
	for _, s := range styles {
		if s == "aes" || s == "hex" || s == "ip" {
			host = append(host, s)
		} else {
			codec = append(codec, s)
		}
	}
	return codec, host
}
