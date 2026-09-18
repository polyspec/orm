package ormgen

import (
	"bufio"
	gobuild "go/build"
	"go/build/constraint"
	"os"
	"slices"
	"sort"
	"strings"
)

// scanConfig is one build configuration the scan loads: the default one, or
// the tags and platform that select files the default build ignores.
type scanConfig struct {
	tags   string
	goos   string
	goarch string
}

func (c scanConfig) buildFlags() []string {
	if c.tags == "" {
		return nil
	}
	return []string{"-tags=" + c.tags}
}

func (c scanConfig) env() []string {
	if c.goos == "" && c.goarch == "" {
		return nil
	}
	env := append(os.Environ(), "CGO_ENABLED=0")
	if c.goos != "" {
		env = append(env, "GOOS="+c.goos)
	}
	if c.goarch != "" {
		env = append(env, "GOARCH="+c.goarch)
	}
	return env
}

var (
	knownGOOS = []string{"aix", "android", "darwin", "dragonfly", "freebsd", "hurd", "illumos", "ios", "js", "linux", "netbsd", "openbsd", "plan9", "solaris", "wasip1", "windows", "zos"}
	unixGOOS  = []string{"aix", "android", "darwin", "dragonfly", "freebsd", "hurd", "illumos", "ios", "linux", "netbsd", "openbsd", "solaris"}
	knownArch = []string{"386", "amd64", "arm", "arm64", "loong64", "mips", "mipsle", "mips64", "mips64le", "ppc64", "ppc64le", "riscv64", "s390x", "wasm"}
)

// fileConstraint reads the //go:build line of a Go file.
func fileConstraint(path string) (constraint.Expr, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	lines := bufio.NewScanner(f)
	for lines.Scan() {
		line := strings.TrimSpace(lines.Text())
		if line == "" || strings.HasPrefix(line, "//") && !constraint.IsGoBuild(line) {
			continue
		}
		if !constraint.IsGoBuild(line) {
			return nil, false
		}
		expr, err := constraint.Parse(line)
		return expr, err == nil
	}
	return nil, false
}

// configFor finds a build configuration that includes a file the default
// build ignores. Custom tags are tried in every combination; GOOS and GOARCH
// names select the platform.
func configFor(path string) (scanConfig, bool) {
	if !strings.HasSuffix(path, ".go") {
		return scanConfig{}, false
	}
	expr, ok := fileConstraint(path)
	if !ok {
		return scanConfig{}, false
	}
	var custom, oses, arches []string
	var walk func(constraint.Expr)
	walk = func(e constraint.Expr) {
		switch x := e.(type) {
		case *constraint.TagExpr:
			switch {
			case slices.Contains(knownGOOS, x.Tag):
				oses = appendUnique(oses, x.Tag)
			case slices.Contains(knownArch, x.Tag):
				arches = appendUnique(arches, x.Tag)
			case x.Tag == "unix" || x.Tag == "gc" || x.Tag == "gccgo" || x.Tag == "cgo" || slices.Contains(gobuild.Default.ReleaseTags, x.Tag) || strings.HasPrefix(x.Tag, "go1."):
			default:
				custom = appendUnique(custom, x.Tag)
			}
		case *constraint.NotExpr:
			walk(x.X)
		case *constraint.AndExpr:
			walk(x.X)
			walk(x.Y)
		case *constraint.OrExpr:
			walk(x.X)
			walk(x.Y)
		}
	}
	walk(expr)
	if len(custom) > 12 {
		return scanConfig{}, false
	}
	sort.Strings(custom)
	osChoices := append([]string{""}, oses...)
	archChoices := append([]string{""}, arches...)
	for _, goos := range osChoices {
		for _, goarch := range archChoices {
			for mask := 0; mask < 1<<len(custom); mask++ {
				var tags []string
				for i, tag := range custom {
					if mask&(1<<i) != 0 {
						tags = append(tags, tag)
					}
				}
				platformOS, platformArch := gobuild.Default.GOOS, gobuild.Default.GOARCH
				if goos != "" {
					platformOS = goos
				}
				if goarch != "" {
					platformArch = goarch
				}
				cross := goos != "" || goarch != ""
				ok := expr.Eval(func(tag string) bool {
					switch {
					case slices.Contains(tags, tag):
						return true
					case slices.Contains(knownGOOS, tag):
						return tag == platformOS
					case slices.Contains(knownArch, tag):
						return tag == platformArch
					case tag == "unix":
						return slices.Contains(unixGOOS, platformOS)
					case tag == "gc":
						return true
					case tag == "cgo":
						return gobuild.Default.CgoEnabled && !cross
					}
					return slices.Contains(gobuild.Default.ReleaseTags, tag)
				})
				if ok {
					return scanConfig{tags: strings.Join(tags, ","), goos: goos, goarch: goarch}, true
				}
			}
		}
	}
	return scanConfig{}, false
}

func appendUnique(values []string, value string) []string {
	if slices.Contains(values, value) {
		return values
	}
	return append(values, value)
}
