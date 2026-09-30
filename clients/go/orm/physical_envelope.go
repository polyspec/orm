package orm

import "github.com/polyspec/orm/engine/schema"

// PhysicalEnvelope locates source only; its body has not been validated.
type PhysicalEnvelope = schema.PhysicalEnvelope
type PhysicalEnvelopeError = schema.PhysicalEnvelopeError

func LocatePhysicalEnvelope(source []byte) (PhysicalEnvelope, error) {
	return schema.LocatePhysicalEnvelope(source)
}
