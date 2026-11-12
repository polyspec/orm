package orm_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// A test of newWaiter, the lock-wait helper that the cancellation tests use to time a cancel.

// TestNewWaiterIgnoresSessionsThatAlreadyWaited pins the race that cancelled the context of a case before its
// statement ran: a session left waiting by an earlier case is not the statement of this case.
func TestNewWaiterIgnoresSessionsThatAlreadyWaited(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	if newWaiter([]int64{7}, []int64{7}) {
		t.Fatal("a session that waited before counts as the statement of this case")
	}
	if newWaiter(nil, nil) {
		t.Fatal("no session waits, yet a waiter was found")
	}
	if !newWaiter([]int64{7}, []int64{7, 9}) || !newWaiter(nil, []int64{3}) {
		t.Fatal("a session that started to wait was not found")
	}
}
