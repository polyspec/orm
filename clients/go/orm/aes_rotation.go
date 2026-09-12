package orm

import (
	"fmt"
	"sort"
)

// AESKeyring stores the keys that can decode persisted AES values. Versions
// are explicit so a rotation can read one row with its stored version and
// write every AES column with one target version.
type AESKeyring struct {
	keys    map[int32]string
	current int32
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

// AESRotationColumn identifies one stored AES column and its host stages. The
// list normally contains ["aes"] or ["aes", "hex"].
type AESRotationColumn struct {
	Name   string
	Styles []string
}

func rowVersion(value any) (int32, error) {
	switch v := value.(type) {
	case int:
		return int32(v), nil
	case int8:
		return int32(v), nil
	case int16:
		return int32(v), nil
	case int32:
		return v, nil
	case int64:
		return int32(v), nil
	case uint:
		return int32(v), nil
	case uint8:
		return int32(v), nil
	case uint16:
		return int32(v), nil
	case uint32:
		return int32(v), nil
	case uint64:
		return int32(v), nil
	default:
		return 0, fmt.Errorf("aes version has type %T", value)
	}
}
