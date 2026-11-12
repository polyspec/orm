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
	"net/netip"
	"strings"
	"sync"
	"unicode/utf8"
)

var aesV2Prefix = []byte("ORM-AES2\x00")

// AESEncrypt returns the authenticated v2 envelope used by every client.
func AESEncrypt(plain []byte, key string) ([]byte, error) {
	gcm, err := aesGCM(key, CodeCodecEncode, "aes: the encryption failed")
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, codecCause(CodeCodecEncode, "aes: the encryption failed", err)
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
	gcm, err := aesGCM(key, CodeCodecDecode, "aes: authentication failed")
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
		return nil, codecCause(CodeCodecDecode, "aes: authentication failed", err)
	}
	return plain, nil
}

// aesCiphers caches the AEAD of each key; an AEAD is safe for concurrent use.
var aesCiphers sync.Map

// aesGCM is the AEAD of key. A failure of the cipher library is the error of the rule of the call, code and text, with the
// failure as its cause (COD-71): aes-encrypt on write and aes-auth on read.
func aesGCM(key, code, text string) (cipher.AEAD, error) {
	if v, ok := aesCiphers.Load(key); ok {
		aead, ok := v.(cipher.AEAD)
		if !ok {
			return nil, internalErr("cached AES cipher holds %T, not cipher.AEAD", v)
		}
		return aead, nil
	}
	block, err := aes.NewCipher(aesV2Key(key))
	if err != nil {
		return nil, codecCause(code, text, err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, codecCause(code, text, err)
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
	if b, ok := v.([]byte); ok && b == nil {
		return "", nil
	}
	if key == "" {
		return "", codecErr(CodeConfig, "secret blind_index not configured")
	}
	var plain []byte
	switch x := v.(type) {
	case string:
		if !utf8.ValidString(x) {
			return "", codecErr(CodeCodecEncode, "blind index input is not a sequence of Unicode scalar values")
		}
		plain = []byte(x)
	case []byte:
		plain = x
	default:
		return "", codecErr(CodeCodecEncode, "blind index input must be text or bytes")
	}
	h := hmac.New(sha256.New, []byte(key))
	_, _ = h.Write(plain)
	return hex.EncodeToString(h.Sum(nil)), nil
}

// packIP is MySQL INET6_ATON: 4 bytes for an IPv4 address and 16 for an IPv6 address, an IPv4-mapped address (::ffff:a.b.c.d)
// included (docs/spec/codec.md COD-38).
func packIP(s string) ([]byte, error) {
	// The exact text only: white space around the address, and a zone, is CODEC_ENCODE (docs/spec/codec.md).
	ip, err := netip.ParseAddr(s)
	if err != nil || ip.Zone() != "" {
		return nil, codecErr(CodeCodecEncode, "ip: the text is not an address")
	}
	return ip.AsSlice(), nil
}

// unpackIP is the text of a packed address: dotted decimal for 4 bytes, the RFC 5952 text for 16, which writes an
// IPv4-mapped address as ::ffff:a.b.c.d (section 5), as MySQL INET6_NTOA does.
func unpackIP(b []byte) (string, error) {
	ip, ok := netip.AddrFromSlice(b)
	if !ok {
		return "", codecErr(CodeCodecDecode, "ip: the cell is not 4 or 16 packed bytes")
	}
	return ip.String(), nil
}

// HostEncode applies the executor-side stages of a bound value in write order.
func HostEncode(v any, styles []string, aesKey string) (any, error) {
	if len(styles) == 0 {
		return nil, codecErr(CodeCodecEncode, "host style list is empty")
	}
	if err := checkHostStyles(styles); err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	var cur []byte
	switch x := v.(type) {
	case string:
		if !utf8.ValidString(x) {
			return nil, codecErr(CodeCodecEncode, "host input is not a sequence of Unicode scalar values")
		}
		cur = []byte(x)
	case []byte:
		if x == nil {
			return nil, nil
		}
		cur = x
	default:
		return nil, codecErr(CodeCodecEncode, "host input must be text or bytes")
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
		default:
			// checkHostStyles leaves ip as the only other style.
			if cur, err = packIP(string(cur)); err != nil {
				return nil, err
			}
		}
	}
	if last := styles[len(styles)-1]; last == "hex" {
		return string(cur), nil
	}
	return cur, nil
}

// HostDecode undoes HostEncode on a read cell: styles are the host stages in
// write order, applied in reverse. A list without aes needs no key. A cell
// decodes only in the form HostEncode writes; anything else, surrounding white
// space included, is CODEC_DECODE (docs/spec/codec.md).
func HostDecode(raw any, styles []string, aesKey string) (any, error) {
	if err := checkHostStyles(styles); err != nil {
		return nil, err
	}
	var cur []byte
	switch x := raw.(type) {
	case nil:
		return nil, nil
	case string:
		cur = []byte(x)
	case []byte:
		cur = x
	default:
		return nil, codecErr(CodeCodecDecode, "cell is not bytes")
	}
	for i := len(styles) - 1; i >= 0; i-- {
		var err error
		switch styles[i] {
		case "hex":
			// The encoder writes only uppercase hex, so lowercase, which hex.DecodeString accepts, is refused too; every client
			// states the one text of COD-39.
			if len(cur)%2 != 0 || bytes.ContainsFunc(cur, func(r rune) bool { return (r < '0' || r > '9') && (r < 'A' || r > 'F') }) {
				return nil, codecErr(CodeCodecDecode, "hex: odd length or non-hex input")
			}
			if cur, err = hex.DecodeString(string(cur)); err != nil {
				return nil, codecErr(CodeCodecDecode, "hex: odd length or non-hex input")
			}
		case "aes":
			if aesKey == "" {
				return nil, codecErr(CodeConfig, "secret aes not configured")
			}
			if cur, err = AESDecrypt(cur, aesKey); err != nil {
				return nil, err
			}
		default:
			// checkHostStyles leaves ip as the only other style.
			s, err := unpackIP(cur)
			if err != nil {
				return nil, err
			}
			return s, nil
		}
	}
	return string(cur), nil
}

// checkHostStyles refuses a style other than aes, hex and ip before the value or the cell is read (host-style).
func checkHostStyles(styles []string) error {
	for _, st := range styles {
		switch st {
		case "aes", "hex", "ip":
		default:
			return codecErr(CodeCodecUnsupported, "host style %s", st)
		}
	}
	return nil
}

// splitHost separates the executor codec stages (docs/spec/codec.md) from the
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
