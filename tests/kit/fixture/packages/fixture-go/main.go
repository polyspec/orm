package fixture

import "github.com/google/uuid"

// ID returns the zero identifier, so that the module uses its dependency.
func ID() uuid.UUID { return uuid.Nil }
