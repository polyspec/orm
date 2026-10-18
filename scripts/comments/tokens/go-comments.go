// Command go-comments prints the comment tokens of Go source files, which go/scanner reads in ScanComments mode.
// The file paths come one per line on standard input, because go run takes trailing .go arguments as sources.
// The output is one JSON array per path, in input order; each entry holds the line, the byte column and the
// text of one comment token, and a block comment keeps its newlines in text.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"go/scanner"
	"go/token"
	"os"
	"strings"
)

type comment struct {
	Line int    `json:"line"`
	Col  int    `json:"col"`
	Text string `json:"text"`
}

func main() {
	var paths []string
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		if line := strings.TrimSpace(in.Text()); line != "" {
			paths = append(paths, line)
		}
	}
	if err := in.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "go-comments: reading the path list:", err)
		os.Exit(1)
	}
	out := make([][]comment, 0, len(paths))
	failed := false
	for _, path := range paths {
		comments, err := commentsOf(path)
		if err != nil {
			fmt.Fprintln(os.Stderr, "go-comments:", err)
			failed = true
		}
		out = append(out, comments)
	}
	if failed {
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "go-comments: writing the output:", err)
		os.Exit(1)
	}
}

// commentsOf scans one file and returns its comment tokens, or the scanner errors that stop it.
func commentsOf(path string) ([]comment, error) {
	src, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	fset := token.NewFileSet()
	file := fset.AddFile(path, -1, len(src))
	var errs []string
	var s scanner.Scanner
	s.Init(file, src, func(pos token.Position, msg string) {
		errs = append(errs, fmt.Sprintf("%s: %s", pos, msg))
	}, scanner.ScanComments)
	comments := []comment{}
	for {
		pos, tok, lit := s.Scan()
		if tok == token.EOF {
			break
		}
		if tok == token.COMMENT {
			p := fset.Position(pos)
			comments = append(comments, comment{Line: p.Line, Col: p.Column, Text: lit})
		}
	}
	if len(errs) > 0 {
		return comments, fmt.Errorf("%s does not scan: %s", path, strings.Join(errs, "; "))
	}
	return comments, nil
}
