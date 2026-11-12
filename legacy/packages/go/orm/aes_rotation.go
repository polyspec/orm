package orm

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// AESKeyring stores the keys that can decode persisted AES values. Versions
// are explicit so a rotation can read one row with its stored version and
// write every AES column with one target version.
type AESKeyring struct {
	keys    map[int32]string
	current int32
}

// aesKeyring builds the keyring of the connection configuration once.
func (d *DB) aesKeyring() (AESKeyring, error) {
	d.m.keyringOnce.Do(func() {
		keys := d.cfg.AESKeys
		if len(keys) == 0 && d.cfg.AESKey != "" {
			keys = map[int32]string{d.cfg.AESVersion: d.cfg.AESKey}
		}
		d.m.keyring, d.m.keyringErr = NewAESKeyring(keys, d.cfg.AESVersion)
	})
	return d.m.keyring, d.m.keyringErr
}

// HostDecodeVersioned decodes an AES value with the row's stored version.
func HostDecodeVersioned(raw any, styles []string, version int32, keyring AESKeyring) (any, error) {
	key, ok := keyring.keys[version]
	if !ok {
		return nil, configErr("aes version is not declared")
	}
	return HostDecode(raw, styles, key)
}

// NewAESKeyring validates a non-empty key for every declared version and a
// current version that is present in the key list.
func NewAESKeyring(keys map[int32]string, current int32) (AESKeyring, error) {
	copyKeys := make(map[int32]string, len(keys))
	for version, key := range keys {
		if version < 1 || key == "" {
			return AESKeyring{}, configErr("aes key list holds an invalid version or an empty key")
		}
		copyKeys[version] = key
	}
	if current < 1 || copyKeys[current] == "" {
		return AESKeyring{}, configErr("aes current version is not declared")
	}
	return AESKeyring{keys: copyKeys, current: current}, nil
}

// CurrentAESVersion returns the target version used by new writes.
func (k AESKeyring) CurrentAESVersion() int32 { return k.current }

// AESVersions returns declared versions in deterministic order.
func (k AESKeyring) AESVersions() []int32 {
	out := make([]int32, 0, len(k.keys))
	for version := range k.keys {
		out = append(out, version)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// RotateAESRow returns a copy with every AES column re-encrypted. The input
// row is unchanged until all columns decode and encode successfully. A caller
// must persist the returned columns and version in one database transaction.
func RotateAESRow(row map[string]any, versionColumn string, columns []AESRotationColumn, targetVersion int32, keyring AESKeyring) (map[string]any, error) {
	if _, ok := row[versionColumn]; !ok {
		return nil, internalErr("aes version column %s is missing", versionColumn)
	}
	out := make(map[string]any, len(row)+1)
	for name, value := range row {
		out[name] = value
	}
	var oldKey, newKey string
	keysRead := false
	for _, column := range columns {
		value, exists := row[column.Name]
		if !exists {
			return nil, internalErr("aes column %s is missing", column.Name)
		}
		// A NULL AES value has no stored bytes to re-encrypt: it is left as it is, and no version is read (COD-44).
		if value == nil {
			continue
		}
		if !keysRead {
			oldVersion, err := rowVersion(row[versionColumn])
			if err != nil {
				return nil, err
			}
			var ok bool
			if oldKey, ok = keyring.keys[oldVersion]; !ok {
				return nil, configErr("aes version is not declared")
			}
			if newKey, ok = keyring.keys[targetVersion]; !ok {
				return nil, configErr("aes version is not declared")
			}
			keysRead = true
		}
		// A refusal of a stage is its own text with no entity and column, as every client states it (COD-47).
		plain, err := HostDecode(value, column.Styles, oldKey)
		if err != nil {
			return nil, err
		}
		encoded, err := HostEncode(plain, column.Styles, newKey)
		if err != nil {
			return nil, err
		}
		out[column.Name] = encoded
	}
	if keysRead {
		out[versionColumn] = targetVersion
	}
	return out, nil
}

func quoteIdentifier(driver, value string) string {
	if value == "" || strings.ContainsAny(value, "\x00\"`.;'") {
		panic("invalid generated SQL identifier")
	}
	if driver == "mysql" {
		return "`" + value + "`"
	}
	return "\"" + value + "\""
}

// rowVersion reads the key version that a stored row holds: a positive 32-bit integer, as an integer, a float with no
// fraction, or its decimal digits. Any other value is CODEC_DECODE with one text in every client, which names no value;
// it is never coerced (COD-44).
func rowVersion(value any) (int32, error) {
	refused := codecErr(CodeCodecDecode, "aes version is not a positive 32-bit integer")
	var version int64
	switch v := value.(type) {
	case int64:
		version = v
	case int32:
		version = int64(v)
	case int:
		version = int64(v)
	case uint64:
		if v > math.MaxInt32 {
			return 0, refused
		}
		version = int64(v)
	case float64:
		if math.Trunc(v) != v || v < 1 || v > math.MaxInt32 {
			return 0, refused
		}
		version = int64(v)
	case string, []byte:
		text := cellString(v)
		if !versionDigits.MatchString(text) {
			return 0, refused
		}
		n, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return 0, refused
		}
		version = n
	default:
		return 0, refused
	}
	if version < 1 || version > math.MaxInt32 {
		return 0, refused
	}
	return int32(version), nil
}

// versionDigits is the decimal text of a stored key version.
var versionDigits = regexp.MustCompile(`^[0-9]+$`)
