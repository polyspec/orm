package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/generator"
)

// setsCmd generates or checks every entry of a models file in one run, in the
// order the scans need (generator.GenerateSets). An entry is the argument list
// of one gen run, one per line; blank lines and lines that start with # are
// skipped.
//
//	orm-gen sets [--check] <models file>
func setsCmd(args []string) {
	fs := flag.NewFlagSet("sets", flag.ExitOnError)
	check := fs.Bool("check", false, "compare the generated files with their outputs without writing")
	if err := fs.Parse(args); err != nil || fs.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: orm-gen sets [--check] <models file>")
		os.Exit(2)
	}
	sets, err := readSets(fs.Arg(0))
	if err != nil {
		fail(err)
	}
	var lines []string
	if *check {
		lines, err = generator.CheckSets(sets)
	} else {
		err = generator.GenerateSets(sets)
	}
	var scanned *generator.ScannedSourceError
	if err != nil && !errors.As(err, &scanned) {
		fail(err)
	}
	if *check {
		reportCheck(lines)
	} else {
		for _, set := range sets {
			fmt.Printf("orm-gen: %d entities → %s (go)\n", len(set.Model.Order), set.OutputDir)
		}
	}
	if scanned != nil {
		fmt.Fprintf(os.Stderr, "orm-gen: %v\n", err)
		os.Exit(3)
	}
}

// readSets reads the entries of a models file: each entry is parsed with the
// flags of gen and its set file is loaded, so every error is reported before
// anything is written.
func readSets(path string) ([]generator.Options, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var sets []generator.Options
	for i, text := range strings.Split(string(raw), "\n") {
		text = strings.TrimSpace(text)
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		set, err := parseEntry(strings.Fields(text))
		if err != nil {
			return nil, fmt.Errorf("%s:%d: %w", path, i+1, err)
		}
		sets = append(sets, set)
	}
	return sets, nil
}

// parseEntry parses the argument list of one entry as gen does.
func parseEntry(args []string) (generator.Options, error) {
	fs := flag.NewFlagSet("entry", flag.ContinueOnError)
	set := fs.String("set", "", "set file dbspec-set.json of the document set")
	out := fs.String("out", "", "output directory")
	var scan stringList
	fs.Var(&scan, "scan", "Go package pattern whose model calls are generated (repeatable)")
	if err := fs.Parse(args); err != nil {
		return generator.Options{}, err
	}
	if *set == "" || *out == "" {
		return generator.Options{}, errors.New("an entry needs --set and --out")
	}
	m, err := runtimemodel.LoadSetFile(*set)
	var invalid *runtimemodel.SetLoadError
	if errors.As(err, &invalid) {
		return generator.Options{}, fmt.Errorf("set file %s: %v", *set, invalid.Problems)
	}
	if err != nil {
		return generator.Options{}, err
	}
	return generator.Options{Model: m, OutputDir: *out, Scan: scan}, nil
}
