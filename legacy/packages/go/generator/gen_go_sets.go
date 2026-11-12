package generator

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"golang.org/x/tools/go/packages"
)

// GenerateSets generates every set in an order that no set's scan needs a model
// of a set that is not generated yet. A set whose scanned packages import
// (directly or through other packages) the output package of another set is
// generated after that set; the other sets keep the order they are listed in.
// A cycle between sets has no such order and is refused, and the error names
// the sets of the cycle. The order of the list therefore does not matter.
// The first failed generation stops the run, as Generate does.
func GenerateSets(sets []Options) error {
	for _, set := range sets {
		if err := set.validate(); err != nil {
			return err
		}
	}
	order, err := setOrder(sets)
	if err != nil {
		return err
	}
	for _, i := range order {
		if err := Generate(sets[i]); err != nil {
			return err
		}
	}
	return nil
}

// setOrder returns the indexes of sets in a generation order: each set after
// every set whose output its scanned packages import.
func setOrder(sets []Options) ([]int, error) {
	outputs := make([]string, len(sets))
	byOutput := map[string]int{}
	for i, set := range sets {
		path, err := importPathOfDir(set.OutputDir)
		if err != nil {
			return nil, err
		}
		outputs[i] = path
		byOutput[path] = i
	}
	// needs[i] holds the sets whose output the scanned packages of set i import.
	needs := make([]map[int]bool, len(sets))
	for i, set := range sets {
		needs[i] = map[int]bool{}
		if len(set.Scan) == 0 {
			continue
		}
		imports, err := scannedImports(set.Scan)
		if err != nil {
			return nil, fmt.Errorf("scan of %s: %w", set.OutputDir, err)
		}
		for path := range imports {
			if j, ok := byOutput[path]; ok && j != i {
				needs[i][j] = true
			}
		}
	}
	done := make([]bool, len(sets))
	var order []int
	for len(order) < len(sets) {
		progress := false
		for i := range sets {
			if done[i] || !allDone(needs[i], done) {
				continue
			}
			done[i] = true
			order = append(order, i)
			progress = true
			break
		}
		if !progress {
			var cycle []string
			for i := range sets {
				if !done[i] {
					cycle = append(cycle, sets[i].OutputDir)
				}
			}
			return nil, fmt.Errorf("the sets have no generation order: each scans the output of another in %s", strings.Join(cycle, ", "))
		}
	}
	return order, nil
}

// allDone reports whether every set in needs is generated.
func allDone(needs map[int]bool, done []bool) bool {
	for j := range needs {
		if !done[j] {
			return false
		}
	}
	return true
}

// scannedImports returns the import paths of the packages that the scan
// patterns load and of every package they depend on, under the default build
// and under every build configuration that the scan loads for a file the
// default build ignores (configFor, as the scan does).
func scannedImports(patterns []string) (map[string]bool, error) {
	dir, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	paths := map[string]bool{}
	configs := []scanConfig{{}}
	for i := 0; i < len(configs); i++ {
		pkgs, err := packages.Load(&packages.Config{
			Mode:       packages.NeedName | packages.NeedFiles | packages.NeedImports | packages.NeedDeps,
			Dir:        dir,
			Tests:      true,
			BuildFlags: configs[i].buildFlags(),
			Env:        configs[i].env(),
		}, patterns...)
		if err != nil {
			return nil, err
		}
		seen := map[*packages.Package]bool{}
		var visit func(p *packages.Package)
		visit = func(p *packages.Package) {
			if seen[p] {
				return
			}
			seen[p] = true
			for path, dep := range p.Imports {
				paths[path] = true
				visit(dep)
			}
		}
		for _, p := range pkgs {
			visit(p)
			if i > 0 {
				continue
			}
			for _, ignored := range p.IgnoredFiles {
				config, ok := configFor(ignored)
				if ok && !slices.Contains(configs, config) {
					configs = append(configs, config)
				}
			}
		}
	}
	return paths, nil
}

// importPathOfDir returns the import path of dir, which may not exist yet: the
// path is the module path of its nearest existing ancestor plus the rest of the
// directory's path under the module root.
func importPathOfDir(dir string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	existing := filepath.Dir(abs)
	for {
		if info, statErr := os.Stat(existing); statErr == nil && info.IsDir() {
			break
		}
		next := filepath.Dir(existing)
		if next == existing {
			return "", fmt.Errorf("no existing parent of %s", abs)
		}
		existing = next
	}
	// go list -m prints every module of the workspace; the module of dir is the
	// one whose directory is the longest prefix of dir.
	cmd := exec.Command("go", "list", "-m", "-f", "{{.Path}}\t{{.Dir}}")
	cmd.Dir = existing
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("go list -m in %s: %w", existing, err)
	}
	bestPath, bestDir := "", ""
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.SplitN(line, "\t", 2)
		if len(fields) != 2 {
			continue
		}
		within := abs == fields[1] || strings.HasPrefix(abs, fields[1]+string(filepath.Separator))
		if within && len(fields[1]) > len(bestDir) {
			bestPath, bestDir = fields[0], fields[1]
		}
	}
	if bestDir == "" {
		return "", fmt.Errorf("%s is outside every module of the workspace", abs)
	}
	rel, err := filepath.Rel(bestDir, abs)
	if err != nil {
		return "", err
	}
	return bestPath + "/" + filepath.ToSlash(rel), nil
}

// CheckSets checks every set like Check, in the order GenerateSets uses, and
// returns the lines of every set's differences, each prefixed by its output
// directory.
func CheckSets(sets []Options) ([]string, error) {
	for _, set := range sets {
		if err := set.validate(); err != nil {
			return nil, err
		}
	}
	order, err := setOrder(sets)
	if err != nil {
		return nil, err
	}
	var lines []string
	for _, i := range order {
		setLines, err := Check(sets[i])
		for _, line := range setLines {
			lines = append(lines, sets[i].OutputDir+": "+line)
		}
		if err != nil {
			return lines, err
		}
	}
	return lines, nil
}
