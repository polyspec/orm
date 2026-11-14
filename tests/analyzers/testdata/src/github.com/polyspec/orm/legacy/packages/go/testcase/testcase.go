// Package testcase stands for legacy/packages/go/testcase in the tests of the analyzers.
package testcase

import "testing"

type Case struct{}

func Start(t testing.TB) *Case { return nil }
func Of(t testing.TB) *Case    { return nil }
func Group(t testing.TB)       {}
func Run(name string, work func(c *Case) error) error {
	return nil
}
func Warn(string) {}
