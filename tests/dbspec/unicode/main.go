// Command unicode writes the table the dbspec lexer uses to classify Unicode letters and digits. The table comes from the data that Go's unicode package holds
// for its Unicode version. As in isWordRune of engine/dbspec, a code point is a word rune when unicode.IsLetter or unicode.IsDigit is true.
// The C extension, PHP, TypeScript, Rust, and Python read this table and do not rely on a runtime
// that has its own Unicode data.
//
// Usage: go run ./tests/dbspec/unicode [-write]
// Without -write, it checks that the three generated files match the table, and fails if they differ. Fix the generator, not the table.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

// lastCodePoint is the last code point in Unicode.
const lastCodePoint = 0x10FFFF

// span is the closed range [lo, hi] of word runes.
type span struct{ lo, hi rune }

// output is the repository file (relative to the repository root) that receives the table, and the function that builds its content.
type output struct {
	path   string
	render func(version string, spans []span) []byte
}

var outputs = []output{
	{"packages/php-ext/src/unicode_word.h", renderC},
	{"packages/rust/schema/src/dbspec/unicode_word.rs", renderRust},
	{"packages/python/src/polyspec/orm/dbspec/unicode_word.py", renderPython},
	{"packages/php/src/Dbspec/UnicodeWord.php", renderPHP},
	{"packages/ts/src/dbspec/unicode_word.ts", renderTS},
}

func main() { os.Exit(run()) }

func run() int {
	write := flag.Bool("write", false, "write the tables into the repository instead of checking them")
	root := flag.String("root", ".", "repository root that the output paths are relative to")
	flag.Parse()
	spans := wordSpans()
	for _, o := range outputs {
		path := filepath.Join(*root, filepath.FromSlash(o.path))
		want := o.render(unicode.Version, spans)
		if *write {
			if err := os.WriteFile(path, want, 0o644); err != nil {
				fmt.Fprintf(os.Stderr, "unicode: %v; check the path and rerun go run ./tests/dbspec/unicode -write\n", err)
				return 1
			}
			continue
		}
		got, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "unicode: %v; run go run ./tests/dbspec/unicode -write to create %s\n", err, o.path)
			return 1
		}
		if !bytes.Equal(got, want) {
			fmt.Fprintf(os.Stderr, "unicode: %s differs from the table of Unicode %s; run go run ./tests/dbspec/unicode -write\n", o.path, unicode.Version)
			return 1
		}
	}
	return 0
}

// isWordRune is the classification that isWordRune in engine/dbspec/lex.go uses for non-ASCII.
func isWordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }

// wordSpans scans all code points and returns the maximal word-rune ranges in ascending order.
func wordSpans() []span {
	var out []span
	for r := rune(0); r <= lastCodePoint; r++ {
		if !isWordRune(r) {
			continue
		}
		if n := len(out); n > 0 && out[n-1].hi+1 == r {
			out[n-1].hi = r
		} else {
			out = append(out, span{r, r})
		}
	}
	return out
}

// header is the description of the generated file. It writes it as a comment, prefixing each line.
func header(version string) []string {
	return []string{
		"생성 파일이다. Unicode " + version + "의 word rune 표다.",
		"unicode.IsLetter 또는 unicode.IsDigit이 참인 code point의 닫힌 구간이며 오름차순이고 서로 겹치지 않는다.",
		"`go run ./tests/dbspec/unicode -write`가 쓴다. 직접 고치지 않는다.",
	}
}

// comment prefixes each header line.
func comment(prefix string, version string) string {
	var b strings.Builder
	for _, line := range header(version) {
		b.WriteString(prefix + line + "\n")
	}
	return b.String()
}

func renderC(version string, spans []span) []byte {
	var b strings.Builder
	b.WriteString("/*\n")
	for _, line := range header(version) {
		b.WriteString(" * " + line + "\n")
	}
	b.WriteString(" */\n")
	b.WriteString("#ifndef POLYSPEC_UNICODE_WORD_H\n#define POLYSPEC_UNICODE_WORD_H\n\n")
	b.WriteString("#include <stddef.h>\n#include <stdbool.h>\n#include <stdint.h>\n\n")
	b.WriteString("static const uint32_t unicode_word_ranges[][2] = {\n")
	for _, s := range spans {
		fmt.Fprintf(&b, "    {0x%04X, 0x%04X},\n", s.lo, s.hi)
	}
	b.WriteString("};\n\n")
	b.WriteString("/* unicode_word_rune은 cp가 word rune이면 참이다. 표를 이진 탐색한다. */\n")
	b.WriteString("static inline bool unicode_word_rune(uint32_t cp)\n{\n")
	b.WriteString("    size_t lo = 0;\n    size_t hi = sizeof unicode_word_ranges / sizeof unicode_word_ranges[0];\n")
	b.WriteString("    while (lo < hi) {\n        size_t mid = lo + (hi - lo) / 2;\n")
	b.WriteString("        if (cp < unicode_word_ranges[mid][0]) {\n            hi = mid;\n")
	b.WriteString("        } else if (cp > unicode_word_ranges[mid][1]) {\n            lo = mid + 1;\n")
	b.WriteString("        } else {\n            return true;\n        }\n    }\n    return false;\n}\n\n")
	b.WriteString("#endif\n")
	return []byte(b.String())
}

func renderRust(version string, spans []span) []byte {
	var b strings.Builder
	b.WriteString(comment("//! ", version))
	b.WriteString("\nuse std::cmp::Ordering;\n\n")
	b.WriteString("/// Go의 unicode 표가 담은 word rune 구간이다.\n")
	b.WriteString("#[rustfmt::skip]\nconst WORD_RANGES: &[(u32, u32)] = &[\n")
	for _, s := range spans {
		fmt.Fprintf(&b, "    (0x%04X, 0x%04X),\n", s.lo, s.hi)
	}
	b.WriteString("];\n\n")
	b.WriteString("/// Whether `c` is a letter or a digit of Go's unicode tables (isWordRune of engine/dbspec).\n")
	b.WriteString("pub(crate) fn is_word_rune(c: char) -> bool {\n")
	b.WriteString("    let cp = c as u32;\n")
	b.WriteString("    WORD_RANGES\n        .binary_search_by(|&(lo, hi)| {\n")
	b.WriteString("            if hi < cp {\n                Ordering::Less\n            } else if lo > cp {\n                Ordering::Greater\n            } else {\n                Ordering::Equal\n            }\n        })\n        .is_ok()\n}\n\n")
	b.WriteString("#[cfg(test)]\nmod tests {\n    use super::*;\n    use std::time::Duration;\n\n")
	b.WriteString("    /// 모든 code point에서 이진 탐색이 구간을 표시한 bitmap과 같다.\n")
	b.WriteString("    #[test]\n    fn binary_search_agrees_with_the_ranges_for_every_code_point() {\n")
	b.WriteString("        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::wall_for_cpu(Duration::from_secs(10)));\n")
	b.WriteString("        let mut listed = vec![false; 0x110000];\n")
	b.WriteString("        for &(lo, hi) in WORD_RANGES {\n            for cp in lo..=hi {\n                listed[cp as usize] = true;\n            }\n        }\n")
	b.WriteString("        for cp in 0..=0x10FFFFu32 {\n            let Some(c) = char::from_u32(cp) else { continue };\n")
	b.WriteString("            assert_eq!(is_word_rune(c), listed[cp as usize], \"code point {cp:#X}\");\n        }\n    }\n}\n")
	return []byte(b.String())
}

func renderPython(version string, spans []span) []byte {
	var b strings.Builder
	b.WriteString(comment("# ", version))
	b.WriteString("#\n# unicodedata는 interpreter마다 Unicode 버전이 달라서 이 표로 분류한다.\n")
	b.WriteString("import bisect\n\n")
	b.WriteString("# (lo, hi)는 word rune의 닫힌 구간이다.\nWORD_RANGES = (\n")
	for _, s := range spans {
		fmt.Fprintf(&b, "    (0x%04X, 0x%04X),\n", s.lo, s.hi)
	}
	b.WriteString(")\n\n_STARTS = tuple(lo for lo, _ in WORD_RANGES)\n\n\n")
	b.WriteString("def _is_word_rune_code_point(cp: int) -> bool:\n")
	b.WriteString("    \"\"\"cp가 Go의 isWordRune과 같이 Unicode 글자나 숫자이면 참이다.\"\"\"\n")
	b.WriteString("    i = bisect.bisect_right(_STARTS, cp) - 1\n")
	b.WriteString("    return i >= 0 and cp <= WORD_RANGES[i][1]\n")
	return []byte(b.String())
}

// renderPHP writes the UnicodeWord class of the PHP client. contains finds a code point in the table by binary search.
func renderPHP(version string, spans []span) []byte {
	var b strings.Builder
	b.WriteString("<?php\n")
	b.WriteString(comment("// ", version))
	b.WriteString("declare(strict_types=1);\n\nnamespace Polyspec\\Orm\\Dbspec;\n\n")
	b.WriteString("/**\n * Go의 unicode 표가 담은 word rune 표다. 이 파일은 생성되며 직접 고치지 않는다.\n * @internal\n */\n")
	b.WriteString("final class UnicodeWord\n{\n")
	b.WriteString("    /** word rune의 닫힌 구간 [lo, hi]의 목록이며 오름차순이다. */\n")
	b.WriteString("    public const RANGES = [\n")
	for _, s := range spans {
		fmt.Fprintf(&b, "        [0x%04X, 0x%04X],\n", s.lo, s.hi)
	}
	b.WriteString("    ];\n\n")
	b.WriteString("    /** cp가 표의 word rune이면 참이다. `_`와 `.`은 표에 없으며 Parser가 따로 본다. */\n")
	b.WriteString("    public static function contains(int $cp): bool\n    {\n")
	b.WriteString("        $lo = 0;\n        $hi = count(self::RANGES);\n")
	b.WriteString("        while ($lo < $hi) {\n            $mid = intdiv($lo + $hi, 2);\n")
	b.WriteString("            [$first, $last] = self::RANGES[$mid];\n")
	b.WriteString("            if ($cp < $first) {\n                $hi = $mid;\n")
	b.WriteString("            } elseif ($cp > $last) {\n                $lo = $mid + 1;\n")
	b.WriteString("            } else {\n                return true;\n            }\n        }\n        return false;\n    }\n}\n")
	return []byte(b.String())
}

// renderTS writes the unicode_word.ts of the TypeScript client. containsWordRune finds a code point in the table by binary search.
func renderTS(version string, spans []span) []byte {
	var b strings.Builder
	b.WriteString(comment("// ", version))
	b.WriteString("\nimport { present } from '../present.js';\n")
	b.WriteString("\n/** Go의 unicode 표가 담은 word rune의 닫힌 구간 [lo, hi]이며 오름차순이다. */\n")
	b.WriteString("export const WORD_RANGES: ReadonlyArray<readonly [number, number]> = [\n")
	for _, s := range spans {
		fmt.Fprintf(&b, "  [0x%04X, 0x%04X],\n", s.lo, s.hi)
	}
	b.WriteString("];\n\n")
	b.WriteString("/** cp가 표의 word rune이면 참이다. `_`와 `.`은 표에 없으며 parse.ts가 따로 본다. */\n")
	b.WriteString("export function containsWordRune(cp: number): boolean {\n")
	b.WriteString("  let lo = 0;\n  let hi = WORD_RANGES.length;\n")
	b.WriteString("  while (lo < hi) {\n    const mid = (lo + hi) >>> 1;\n")
	b.WriteString("    const [first, last] = present(WORD_RANGES[mid], 'WORD_RANGES[mid]');\n")
	b.WriteString("    if (cp < first) hi = mid;\n    else if (cp > last) lo = mid + 1;\n    else return true;\n  }\n")
	b.WriteString("  return false;\n}\n")
	return []byte(b.String())
}
