// ormgen check --lang php <dir>: what a PHP codebase uses that the compatibility
// layer (docs/dsl.md §6) must translate. A report, not a linter: counts per
// token family, the files that open/close '(' tokens across models, and expr
// fragments with backtick column names (docs/checklist.md T4.7).
package ormgen

import (
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/polyspec/orm/engine/schema"
)

type checkFamily struct {
	Name string
	Re   *regexp.Regexp
}

var phpFamilies = []checkFamily{
	{"predicate and*/or*/condition*", regexp.MustCompile(`->(?:and|or|condition)[A-Z]\w*\(`)},
	{"op-first (gt/lt/ge/le/ne/lk/in/between/isNull…)", regexp.MustCompile(`->(?:and|or|condition)(?:Gt|Lt|Ge|Le|Ne|Lk|Lb|In|Nin|Between|IsNull|NotNull|Fulltext)[A-Z]\w*\(`)},
	{"relation/relations", regexp.MustCompile(`->relations?\(`)},
	{"match<A>With<B>", regexp.MustCompile(`->match[A-Z]\w*With[A-Z]\w*\(`)},
	{"join/leftJoin", regexp.MustCompile(`->(?:left)?[jJ]oin[A-Z]\w*\(`)},
	{"alias*", regexp.MustCompile(`->alias\w*\(`)},
	{"keyName*/fetchKey", regexp.MustCompile(`->(?:keyName\w*|fetchKey)\(`)},
	{"parentNode", regexp.MustCompile(`->parentNode\(`)},
	{"groupLimit", regexp.MustCompile(`->groupLimit\(`)},
	{"possible*", regexp.MustCompile(`->possible[A-Z]\w*\(`)},
	{"addColumn*/addAllColumns/removeColumn*", regexp.MustCompile(`->(?:addColumn\w*|addAllColumns|removeAllColumns|removeColumn\w*)\(`)},
	{"compound getBy*/getsBy*", regexp.MustCompile(`->gets?By[A-Z]\w*And[A-Z]\w*\(`)},
	{"getCount/getsCount terminals", regexp.MustCompile(`->gets?Count\(`)},
	{"compound getCountBy* terminals", regexp.MustCompile(`->getCountBy[A-Z]\w*And[A-Z]\w*\(`)},
	{"paren tokens and('(') / condition(')')", regexp.MustCompile(`->(?:and|or|condition)\(\s*'[()]'\s*\)`)},
	{"brace-call syntax ->{'condition(…)'}", regexp.MustCompile(`->\{'[^']*\('`)},
	{"raw fragments (condition with SQL text)", regexp.MustCompile(`->(?:and|or|condition)\(\s*'[^']*[=<>]`)},
	{"delete(true)/deleteLock", regexp.MustCompile(`->(?:delete\(\s*true\s*\)|deleteLock\()`)},
	{"duplication (upsert)", regexp.MustCompile(`->duplication\(`)},
	{"plus*/minus*", regexp.MustCompile(`->(?:plus|minus)[A-Z]\w*\(`)},
	{"setRaw*", regexp.MustCompile(`->setRaw[A-Z]\w*\(`)},
	{"Model::$debug", regexp.MustCompile(`Model::\$debug`)},
}

func checkCmd(args []string) {
	flagSet := flag.NewFlagSet("check", flag.ExitOnError)
	lang := flagSet.String("lang", "php", "php")
	top := flagSet.Int("top", 10, "files to list per family")
	var dirs []string
	var flags []string
	for i := 0; i < len(args); i++ {
		if strings.HasPrefix(args[i], "-") {
			flags = append(flags, args[i])
			if !strings.Contains(args[i], "=") && i+1 < len(args) {
				flags = append(flags, args[i+1])
				i++
			}
		} else {
			dirs = append(dirs, args[i])
		}
	}
	schemaPath := flagSet.String("schema", "schema/schema.json", "schema.json (--lang go)")
	flagSet.Parse(flags)
	if len(dirs) == 0 || (*lang != "php" && *lang != "go") {
		fmt.Fprintln(os.Stderr, "usage: ormgen check --lang php|go [--top n] [--schema schema/schema.json] <dir>...")
		os.Exit(2)
	}
	if *lang == "go" {
		js, err := os.ReadFile(*schemaPath)
		if err != nil {
			fail(err)
		}
		m, err := schema.Load(js)
		if err != nil {
			fail(err)
		}
		os.Exit(checkGo(m, dirs))
	}
	counts := map[string]int{}
	perFile := map[string]map[string]int{}
	files := 0
	var parenCross []string
	for _, dir := range dirs {
		err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".php") || strings.Contains(path, "/vendor/") {
				return nil
			}
			src, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			files++
			text := string(src)
			for _, f := range phpFamilies {
				n := len(f.Re.FindAllStringIndex(text, -1))
				if n == 0 {
					continue
				}
				counts[f.Name] += n
				if perFile[f.Name] == nil {
					perFile[f.Name] = map[string]int{}
				}
				perFile[f.Name][path] += n
			}
			if parenAcrossModels(text) {
				parenCross = append(parenCross, path)
			}
			return nil
		})
		if err != nil {
			fail(err)
		}
	}
	fmt.Printf("ormgen check (php): %d files\n\n", files)
	for _, f := range phpFamilies {
		fmt.Printf("%6d  %s\n", counts[f.Name], f.Name)
	}
	if *top > 0 {
		for _, f := range phpFamilies {
			pf := perFile[f.Name]
			if len(pf) == 0 {
				continue
			}
			type kv struct {
				k string
				v int
			}
			var list []kv
			for k, v := range pf {
				list = append(list, kv{k, v})
			}
			sort.Slice(list, func(i, j int) bool { return list[i].v > list[j].v || list[i].v == list[j].v && list[i].k < list[j].k })
			fmt.Printf("\n## %s (%d files)\n", f.Name, len(pf))
			for i, e := range list {
				if i >= *top {
					break
				}
				fmt.Printf("  %4d  %s\n", e.v, e.k)
			}
		}
	}
	if len(parenCross) > 0 {
		sort.Strings(parenCross)
		fmt.Printf("\n## '(' opened in one model and closed in another — PAREN_ACROSS_MODELS candidates (%d files)\n", len(parenCross))
		for _, p := range parenCross {
			fmt.Println("  " + p)
		}
	}
}

var (
	reParenOpen  = regexp.MustCompile(`->(?:and|or|condition)\(\s*'\('\s*\)`)
	reParenClose = regexp.MustCompile(`->(?:and|or|condition)\(\s*'\)'\s*\)`)
	reNewModel   = regexp.MustCompile(`\(new\s+[A-Z]\w*`)
)

// parenAcrossModels flags a statement (up to ';') whose paren tokens do not
// balance within the model chain they were opened in: a '(' token followed by
// a `(new Model` before its ')' token.
func parenAcrossModels(text string) bool {
	for _, stmt := range strings.Split(text, ";") {
		opens := reParenOpen.FindAllStringIndex(stmt, -1)
		if len(opens) == 0 {
			continue
		}
		closes := reParenClose.FindAllStringIndex(stmt, -1)
		news := reNewModel.FindAllStringIndex(stmt, -1)
		for i, o := range opens {
			if i >= len(closes) {
				return true
			}
			for _, n := range news {
				if n[0] > o[1] && n[0] < closes[i][0] {
					return true
				}
			}
		}
	}
	return false
}
