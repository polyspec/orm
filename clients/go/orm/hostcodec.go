package orm

// Host-side stages for the styles a dialect cannot apply in SQL
// (docs/dialects.md): aes (MySQL-compatible AES_ENCRYPT), hex (upper-case),
// ip (INET6_ATON packing). MySQL never reaches these; PostgreSQL uses them
// for aes/hex, SQLite for all three.

import (
	"crypto/aes"
	"encoding/hex"
	"fmt"
	"net"
	"strings"
)

// mysqlKeyFold reproduces MySQL's AES key derivation for aes-128-ecb: the key
// bytes are XOR-folded into a 16-byte block.
func mysqlKeyFold(key string) []byte {
	k := make([]byte, 16)
	for i := 0; i < len(key); i++ {
		k[i%16] ^= key[i]
	}
	return k
}

// AESEncrypt is HEX-free AES_ENCRYPT(plain, key): AES-128-ECB with PKCS7 padding.
func AESEncrypt(plain []byte, key string) ([]byte, error) {
	block, err := aes.NewCipher(mysqlKeyFold(key))
	if err != nil {
		return nil, err
	}
	pad := 16 - len(plain)%16
	buf := make([]byte, len(plain)+pad)
	copy(buf, plain)
	for i := len(plain); i < len(buf); i++ {
		buf[i] = byte(pad)
	}
	for i := 0; i < len(buf); i += 16 {
		block.Encrypt(buf[i:i+16], buf[i:i+16])
	}
	return buf, nil
}

// AESDecrypt is AES_DECRYPT(cipher, key); a wrong key or corrupt data is CODEC_DECODE.
func AESDecrypt(cipher []byte, key string) ([]byte, error) {
	if len(cipher) == 0 || len(cipher)%16 != 0 {
		return nil, codecErr(CodeCodecDecode, "aes: ciphertext length %d", len(cipher))
	}
	block, err := aes.NewCipher(mysqlKeyFold(key))
	if err != nil {
		return nil, err
	}
	buf := make([]byte, len(cipher))
	for i := 0; i < len(buf); i += 16 {
		block.Decrypt(buf[i:i+16], cipher[i:i+16])
	}
	pad := int(buf[len(buf)-1])
	if pad < 1 || pad > 16 || pad > len(buf) {
		return nil, codecErr(CodeCodecDecode, "aes: bad padding")
	}
	for _, b := range buf[len(buf)-pad:] {
		if int(b) != pad {
			return nil, codecErr(CodeCodecDecode, "aes: bad padding")
		}
	}
	return buf[:len(buf)-pad], nil
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
// (also used by bench/seedaes to fill aes columns on databases without AES_ENCRYPT).
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
