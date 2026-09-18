package orm

import (
	"fmt"
	"math"
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
		return nil, fmt.Errorf("aes key version %d is not declared", version)
	}
	return hostDecode(raw, styles, key)
}

// NewAESKeyring validates a non-empty key for every declared version and a
// current version that is present in the key list.
func NewAESKeyring(keys map[int32]string, current int32) (AESKeyring, error) {
	copyKeys := make(map[int32]string, len(keys))
	for version, key := range keys {
		if version < 1 || key == "" {
			return AESKeyring{}, fmt.Errorf("aes key version %d has an empty key or is invalid", version)
		}
		copyKeys[version] = key
	}
	if current < 1 || copyKeys[current] == "" {
		return AESKeyring{}, fmt.Errorf("aes current version %d is not declared", current)
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
	oldVersion, err := rowVersion(row[versionColumn])
	if err != nil {
		return nil, err
	}
	oldKey, ok := keyring.keys[oldVersion]
	if !ok {
		return nil, fmt.Errorf("aes key version %d is not declared", oldVersion)
	}
	newKey, ok := keyring.keys[targetVersion]
	if !ok {
		return nil, fmt.Errorf("aes target version %d is not declared", targetVersion)
	}
	out := make(map[string]any, len(row)+1)
	for name, value := range row {
		out[name] = value
	}
	for _, column := range columns {
		value, exists := row[column.Name]
		if !exists {
			return nil, fmt.Errorf("aes column %s is missing", column.Name)
		}
		plain, err := hostDecode(value, column.Styles, oldKey)
		if err != nil {
			return nil, fmt.Errorf("aes column %s: %w", column.Name, err)
		}
		encoded, err := HostEncode(plain, column.Styles, newKey)
		if err != nil {
			return nil, fmt.Errorf("aes column %s: %w", column.Name, err)
		}
		out[column.Name] = encoded
	}
	out[versionColumn] = targetVersion
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

func rowVersion(value any) (int32, error) {
	var version int64
	switch v := value.(type) {
	case int:
		version = int64(v)
	case int8:
		version = int64(v)
	case int16:
		version = int64(v)
	case int32:
		version = int64(v)
	case int64:
		version = v
	case uint:
		if uint64(v) > math.MaxInt32 {
			return 0, fmt.Errorf("aes version %d is out of range", v)
		}
		version = int64(v)
	case uint8:
		version = int64(v)
	case uint16:
		version = int64(v)
	case uint32:
		version = int64(v)
	case uint64:
		if v > math.MaxInt32 {
			return 0, fmt.Errorf("aes version %d is out of range", v)
		}
		version = int64(v)
	case string:
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("aes version %q is not an integer", v)
		}
		version = n
	default:
		return 0, fmt.Errorf("aes version has type %T", value)
	}
	if version < 1 || version > math.MaxInt32 {
		return 0, fmt.Errorf("aes version %d is out of range", version)
	}
	return int32(version), nil
}
