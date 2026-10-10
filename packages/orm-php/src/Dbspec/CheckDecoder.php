<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * dialect catalog 의 check 식을 dbspec predicate text 로 읽는다
 * (docs/dialects.md "Introspection", "Checks"). literal 은 그것이 만나는
 * column 의 값으로 읽는다. 읽을 수 없는 식은 CheckDecodeFailure 다.
 *
 * operand node 는 ['node' => 'operand', 'kind' => column|number|string|bool,
 * 'text' => ...], predicate node 는 ['node' => 'predicate', 'op' => and|or|
 * compare|in|null, ...] 이다.
 *
 * @internal
 */
final class CheckDecoder
{
    /** @var list<array{0: string, 1: string}> kind 와 text: ident, word, number, string, op, punct */
    private array $tokens = [];
    private int $i = 0;

    /** @param array<string, ColumnType> $columns table 의 column type */
    private function __construct(private readonly string $dialect, private readonly array $columns)
    {
    }

    /**
     * @param array<string, ColumnType> $columns
     * @throws CheckDecodeFailure
     */
    public static function decode(string $dialect, string $text, array $columns): string
    {
        if ($dialect === 'mysql') {
            $text = self::unescapeMysqlClause($text);
        }
        if ($dialect === 'postgres') {
            if (!str_starts_with($text, 'CHECK ')) {
                throw new CheckDecodeFailure("constraint definition \"$text\" does not start with CHECK");
            }
            $text = substr($text, strlen('CHECK '));
        }
        $d = new self($dialect, $columns);
        $d->tokens = self::tokens($dialect, $text);
        $node = $d->expression();
        if ($d->i !== count($d->tokens)) {
            throw new CheckDecodeFailure("unexpected \"{$d->tokens[$d->i][1]}\"");
        }
        if ($node['node'] !== 'predicate') {
            throw new CheckDecodeFailure('an operand alone is not a predicate');
        }
        return $d->write($node);
    }

    /** CHECK_CLAUSE 가 문자열 literal 에 더한 두 번째 escape 를 푼다: `\\` 는 `\`, `\'` 는 `'` 가 된다. */
    private static function unescapeMysqlClause(string $text): string
    {
        $out = '';
        $n = strlen($text);
        for ($i = 0; $i < $n; $i++) {
            if ($text[$i] === '\\' && $i + 1 < $n && ($text[$i + 1] === '\\' || $text[$i + 1] === "'")) {
                $out .= $text[$i + 1];
                $i++;
                continue;
            }
            $out .= $text[$i];
        }
        return $out;
    }

    /** @return list<array{0: string, 1: string}> */
    private static function tokens(string $dialect, string $text): array
    {
        $out = [];
        $n = strlen($text);
        $i = 0;
        while ($i < $n) {
            $ch = $text[$i];
            $rest = substr($text, $i, 2);
            if ($ch === ' ') {
                $i++;
            } elseif ($ch === '`' || $ch === '"') {
                $j = strpos($text, $ch, $i + 1);
                if ($j === false) {
                    throw new CheckDecodeFailure('unclosed identifier');
                }
                $out[] = ['ident', substr($text, $i + 1, $j - $i - 1)];
                $i = $j + 1;
            } elseif ($ch === "'") {
                [$value, $length] = self::sqlString($dialect, substr($text, $i));
                $out[] = ['string', $value];
                $i += $length;
            } elseif (ctype_digit($ch)) {
                $j = $i;
                while ($j < $n && (ctype_digit($text[$j]) || $text[$j] === '.')) {
                    $j++;
                }
                $out[] = ['number', substr($text, $i, $j - $i)];
                $i = $j;
            } elseif ($ch === '_' || self::isAsciiLetter($ch)) {
                $j = $i;
                while ($j < $n && ($text[$j] === '_' || self::isAsciiLetter($text[$j]) || ctype_digit($text[$j]))) {
                    $j++;
                }
                $word = substr($text, $i, $j - $i);
                // MySQL 문자열 앞의 character set introducer 는 값이 아니다.
                if ($dialect === 'mysql' && str_starts_with($word, '_') && $j < $n && $text[$j] === "'") {
                    $i = $j;
                    continue;
                }
                $out[] = ['word', $word];
                $i = $j;
            } elseif ($rest === '::' || $rest === '<>' || $rest === '<=' || $rest === '>=') {
                $out[] = ['op', $rest];
                $i += 2;
            } elseif ($ch === '=' || $ch === '<' || $ch === '>' || $ch === '-') {
                $out[] = ['op', $ch];
                $i++;
            } elseif ($ch === '(' || $ch === ')' || $ch === ',' || $ch === '[' || $ch === ']') {
                $out[] = ['punct', $ch];
                $i++;
            } else {
                throw new CheckDecodeFailure("unexpected character \"$ch\"");
            }
        }
        return $out;
    }

    /**
     * ASCII 영문자 한 바이트인지 본다. Go 의 checkTokens 와 같은 범위다. ctype_alpha 와
     * ctype_alnum 은 LC_CTYPE 과 libc 에 따라 0x80 이상의 바이트도 글자로 보므로 쓰지 않는다.
     */
    private static function isAsciiLetter(string $ch): bool
    {
        $o = ord($ch);
        return ($o >= 0x61 && $o <= 0x7A) || ($o >= 0x41 && $o <= 0x5A);
    }

    /**
     * text 앞의 문자열 literal 을 읽어 값과 길이를 돌려준다. PostgreSQL 과
     * SQLite 는 '' 만 escape 이고, MySQL 은 backslash escape 도 쓴다.
     *
     * @return array{0: string, 1: int}
     */
    private static function sqlString(string $dialect, string $text): array
    {
        $out = '';
        $n = strlen($text);
        for ($i = 1; $i < $n; $i++) {
            $ch = $text[$i];
            if ($ch === "'" && $i + 1 < $n && $text[$i + 1] === "'") {
                $out .= "'";
                $i++;
            } elseif ($ch === "'") {
                return [$out, $i + 1];
            } elseif ($ch === '\\' && $dialect === 'mysql' && $i + 1 < $n) {
                $i++;
                $out .= match ($text[$i]) {
                    '0' => "\0",
                    'b' => "\x08",
                    'n' => "\n",
                    'r' => "\r",
                    't' => "\t",
                    'Z' => "\x1a",
                    default => $text[$i],
                };
            } else {
                $out .= $ch;
            }
        }
        throw new CheckDecodeFailure('unclosed string literal');
    }

    /** @return array{0: string, 1: string} */
    private function peek(): array
    {
        return $this->tokens[$this->i] ?? ['', ''];
    }

    private function word(string $text): bool
    {
        [$kind, $value] = $this->peek();
        if ($kind === 'word' && strcasecmp($value, $text) === 0) {
            $this->i++;
            return true;
        }
        return false;
    }

    private function punct(string $text): bool
    {
        if ($this->peek() === ['punct', $text]) {
            $this->i++;
            return true;
        }
        return false;
    }

    private function expect(string $text): void
    {
        if (!$this->punct($text)) {
            throw new CheckDecodeFailure("expected \"$text\" at token {$this->i}");
        }
    }

    private static function operandNode(string $kind, string $text): array
    {
        return ['node' => 'operand', 'kind' => $kind, 'text' => $text];
    }

    private function expression(): array
    {
        $left = $this->conjunction();
        while ($this->word('or')) {
            $left = ['node' => 'predicate', 'op' => 'or', 'left' => $left, 'right' => $this->conjunction()];
        }
        return $left;
    }

    private function conjunction(): array
    {
        $left = $this->predicate();
        while ($this->word('and')) {
            $left = ['node' => 'predicate', 'op' => 'and', 'left' => $left, 'right' => $this->predicate()];
        }
        return $left;
    }

    /** 괄호로 묶인 식이나 operand 로 시작하는 predicate 하나를 읽는다. */
    private function predicate(): array
    {
        $left = $this->term();
        if ($left['node'] !== 'operand') {
            return $left;
        }
        [$kind, $text] = $this->peek();
        if ($kind === 'op' && in_array($text, ['=', '<>', '<', '<=', '>', '>='], true)) {
            $this->i++;
            if ($this->word('any') || $this->word('all')) {
                $list = $this->arrayLiterals();
                return match ($text) {
                    '=' => ['node' => 'predicate', 'op' => 'in', 'left' => $left, 'list' => $list, 'negated' => false],
                    '<>' => ['node' => 'predicate', 'op' => 'in', 'left' => $left, 'list' => $list, 'negated' => true],
                    default => throw new CheckDecodeFailure("$text with ANY or ALL"),
                };
            }
            $right = $this->term();
            if ($right['node'] !== 'operand') {
                throw new CheckDecodeFailure('a comparison with a predicate');
            }
            return ['node' => 'predicate', 'op' => 'compare', 'left' => $left, 'right' => $right, 'operator' => $text];
        }
        if ($this->word('is')) {
            $negated = $this->word('not');
            if (!$this->word('null')) {
                throw new CheckDecodeFailure('expected null after is');
            }
            return ['node' => 'predicate', 'op' => 'null', 'left' => $left, 'negated' => $negated];
        }
        if ($this->word('not')) {
            if (!$this->word('in')) {
                throw new CheckDecodeFailure('not outside not in');
            }
            return ['node' => 'predicate', 'op' => 'in', 'left' => $left, 'list' => $this->literalList(), 'negated' => true];
        }
        if ($this->word('in')) {
            return ['node' => 'predicate', 'op' => 'in', 'left' => $left, 'list' => $this->literalList(), 'negated' => false];
        }
        return $left;
    }

    /** 괄호 식이나 operand 와 그 뒤의 cast 를 읽는다. 괄호 안이 operand 하나면 operand 다. */
    private function term(): array
    {
        if ($this->punct('(')) {
            $node = $this->expression();
            $this->expect(')');
        } else {
            $node = $this->operand();
        }
        while ($this->peek() === ['op', '::']) {
            $this->i++;
            $typeName = $this->castType();
            if ($node['node'] !== 'operand') {
                throw new CheckDecodeFailure('a cast of a predicate');
            }
            if ($node['kind'] === 'string' && in_array($typeName, ['smallint', 'integer', 'bigint', 'numeric', 'double precision', 'real'], true)) {
                $node['kind'] = 'number';
            }
        }
        return $node;
    }

    /** `::` 뒤의 type 이름을 읽는다: 단어들과 (n), []. */
    private function castType(): string
    {
        $words = [];
        while (true) {
            [$kind, $text] = $this->peek();
            if ($kind === 'word' && !in_array(strtolower($text), ['and', 'or', 'is', 'not', 'in'], true)) {
                $words[] = $text;
                $this->i++;
            } elseif ($kind === 'punct' && $text === '[' && ($this->tokens[$this->i + 1][1] ?? null) === ']') {
                $this->i += 2;
            } else {
                return implode(' ', $words);
            }
        }
    }

    private function operand(): array
    {
        [$kind, $text] = $this->peek();
        if ($kind === 'ident') {
            $this->i++;
            return self::operandNode('column', $text);
        }
        if ($kind === 'number' || $kind === 'string') {
            $this->i++;
            return self::operandNode($kind, $text);
        }
        if ($kind === 'op' && $text === '-') {
            $this->i++;
            $parenthesized = $this->punct('(');
            [$nextKind, $next] = $this->peek();
            if ($nextKind !== 'number') {
                throw new CheckDecodeFailure($parenthesized ? 'expected a number after -(' : 'expected a number after -');
            }
            $this->i++;
            if ($parenthesized) {
                $this->expect(')');
            }
            return self::operandNode('number', "-$next");
        }
        if ($kind === 'word' && (strcasecmp($text, 'true') === 0 || strcasecmp($text, 'false') === 0)) {
            $this->i++;
            return self::operandNode('bool', strtolower($text));
        }
        if ($kind === 'word') {
            $this->i++;
            return self::operandNode('column', $text);
        }
        throw new CheckDecodeFailure("unexpected \"$text\"");
    }

    /** in 뒤의 (a, b, ...) 를 읽는다. */
    private function literalList(): array
    {
        $this->expect('(');
        $out = [];
        while (true) {
            $node = $this->term();
            if ($node['node'] !== 'operand' || $node['kind'] === 'column') {
                throw new CheckDecodeFailure('an in list holds literals only');
            }
            $out[] = $node;
            if ($this->punct(')')) {
                return $out;
            }
            $this->expect(',');
        }
    }

    /** PostgreSQL 의 ANY 나 ALL 뒤의 (ARRAY[...]) 또는 ((ARRAY[...])::type[]) 를 읽는다. */
    private function arrayLiterals(): array
    {
        $this->expect('(');
        $wrapped = $this->punct('(');
        if (!$this->word('array')) {
            throw new CheckDecodeFailure('expected ARRAY');
        }
        $this->expect('[');
        $out = [];
        while (true) {
            $node = $this->term();
            if ($node['node'] !== 'operand' || $node['kind'] === 'column') {
                throw new CheckDecodeFailure('an array holds literals only');
            }
            $out[] = $node;
            if ($this->punct(']')) {
                break;
            }
            $this->expect(',');
        }
        if ($wrapped) {
            $this->expect(')');
            if ($this->peek()[1] === '::') {
                $this->i++;
                $this->castType();
            }
        }
        $this->expect(')');
        return $out;
    }

    /** predicate 를 dbspec text 로 쓴다. 괄호는 필요한 곳보다 많아도 되며 canonical form 은 parse 가 정한다. */
    private function write(array $p): string
    {
        switch ($p['op']) {
            case 'and':
            case 'or':
                return '(' . $this->side($p['left']) . " {$p['op']} " . $this->side($p['right']) . ')';
            case 'compare':
                $type = $this->typeOf($p['left'], $p['right']);
                return $this->operandText($p['left'], $type) . " {$p['operator']} " . $this->operandText($p['right'], $type);
            case 'in':
                $type = $this->typeOf($p['left'], null);
                $items = array_map(fn(array $item): string => $this->operandText($item, $type), $p['list']);
                return $this->operandText($p['left'], $type) . ($p['negated'] ? ' not in (' : ' in (') . implode(', ', $items) . ')';
            case 'null':
                return $this->operandText($p['left'], null) . ($p['negated'] ? ' is not null' : ' is null');
        }
        throw new CheckDecodeFailure("unknown predicate {$p['op']}");
    }

    private function side(array $node): string
    {
        if ($node['node'] !== 'predicate') {
            throw new CheckDecodeFailure('an operand alone is not a predicate');
        }
        return $this->write($node);
    }

    private function typeOf(array $a, ?array $b): ?ColumnType
    {
        foreach ([$a, $b] as $o) {
            if ($o !== null && $o['kind'] === 'column') {
                return $this->columns[$o['text']] ?? null;
            }
        }
        return null;
    }

    /** operand 를 dbspec 표기로 쓴다. bool column 의 1 과 0 은 true 와 false, SQLite decimal 의 정수는 scale 을 나눈 값이다. */
    private function operandText(array $o, ?ColumnType $type): string
    {
        switch ($o['kind']) {
            case 'column':
                if (!isset($this->columns[$o['text']])) {
                    throw new CheckDecodeFailure("unknown column {$o['text']}");
                }
                return $o['text'];
            case 'string':
                return Literal::quote($o['text']);
            case 'bool':
                return $o['text'];
        }
        if ($type?->name === 'bool' && $o['text'] === '1') {
            return 'true';
        }
        if ($type?->name === 'bool' && $o['text'] === '0') {
            return 'false';
        }
        if ($type?->name === 'decimal' && $this->dialect === 'sqlite') {
            return Catalog::unscaledDecimal($o['text'], $type->parameters[1]);
        }
        return $o['text'];
    }
}
