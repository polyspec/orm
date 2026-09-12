package main

import (
	"os"
	"testing"
)

func TestAnnounceReady(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	announceReady(int(write.Fd()), "http://127.0.0.1:1234")
	buffer := make([]byte, 64)
	n, err := read.Read(buffer)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(buffer[:n]); got != "http://127.0.0.1:1234\n" {
		t.Fatalf("ready message=%q", got)
	}
}
