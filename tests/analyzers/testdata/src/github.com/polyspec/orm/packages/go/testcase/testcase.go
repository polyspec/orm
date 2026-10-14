// Package testcase stands for packages/go/testcase in the tests of the analyzers.
package testcase

import (
	"testing"
	"time"
)

type Case struct{}

func Start(t testing.TB, deadline time.Duration) *Case { return nil }
func Of(t testing.TB) *Case                            { return nil }
func Group(t testing.TB)                               {}
func Run(name string, deadline time.Duration, work func(c *Case) error) error {
	return nil
}
func Warn(string) {}
