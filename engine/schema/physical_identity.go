package schema

import (
	"encoding/hex"
	"errors"
	"strings"
	"unicode/utf8"
)

// PhysicalIdentity preserves qualified database names independently of model
// identifier rules. Components cannot be changed through input/output aliases.
type PhysicalIdentity struct {
	parts [4]*string
	key   string
}

func NewPhysicalIdentity(catalog, namespace *string, table string, column *string) (PhysicalIdentity, error) {
	identity := PhysicalIdentity{}
	tokens := make([]string, 4)
	for i, part := range [4]*string{catalog, namespace, &table, column} {
		if part == nil {
			tokens[i] = "-"
			continue
		}
		if len(*part) == 0 || len(*part) > 1024 || !utf8.ValidString(*part) {
			return PhysicalIdentity{}, errors.New("SCHEMA_INVALID")
		}
		for _, r := range *part {
			if r < 32 || r == 127 {
				return PhysicalIdentity{}, errors.New("SCHEMA_INVALID")
			}
		}
		copyPart := *part
		identity.parts[i] = &copyPart
		tokens[i] = hex.EncodeToString([]byte(copyPart))
	}
	identity.key = "p1:" + strings.Join(tokens, ".")
	return identity, nil
}

func (identity PhysicalIdentity) Key() string { return identity.key }
func (identity PhysicalIdentity) Parts() [4]*string {
	var result [4]*string
	for i, part := range identity.parts {
		if part != nil {
			copyPart := *part
			result[i] = &copyPart
		}
	}
	return result
}
