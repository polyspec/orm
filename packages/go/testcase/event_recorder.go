package testcase

// EventRecorder collects typed events from a callback-based source.
type EventRecorder[T any] struct {
	events []T
}

// NewEventRecorder creates an empty recorder for a test's event subscription.
func NewEventRecorder[T any]() *EventRecorder[T] {
	return &EventRecorder[T]{}
}

// Record appends one event and is suitable as an event subscription callback.
func (r *EventRecorder[T]) Record(event T) error {
	r.events = append(r.events, event)
	return nil
}

// Events returns the events recorded so far.
func (r *EventRecorder[T]) Events() []T {
	return r.events
}

// Reset clears the recorded events without changing the subscribed callback.
func (r *EventRecorder[T]) Reset() {
	r.events = nil
}
