<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * Reads a dialect catalog check expression as dbspec predicate text
 * (docs/spec/dialects.md "Introspection", "Checks"). A literal is read as the value of the column
 * it meets. An expression that cannot be read is a CheckDecodeFailure.
 *
 * operand node is ['node' => 'operand', 'kind' => column|number|string|bool,
 * 'text' => ...], and predicate node is ['node' => 'predicate', 'op' => and|or|
 * compare|in|null, ...].
 *
 * @internal
 */
final class CheckDecoder
{
    /** @var list<array{0: string, 1: string}> kind and text: ident, word, number, string, op, punct */
    private array $tokens = [];
    private int $i = 0;

    /** @param array<string, ColumnType> $columns The column types of the table */
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

    /** Undoes the second escape that CHECK_CLAUSE adds to a string literal: `\\` becomes `\`, and `\'` becomes `'`. */
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
                // The character set introducer in front of a MySQL string is not a value.
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
     * Checks whether it is one ASCII letter byte, the same range as checkTokens in Go. ctype_alpha and
     * ctype_alnum are not used, since they count bytes 0x80 and above as letters depending on LC_CTYPE and libc.
     */
    private static function isAsciiLetter(string $ch): bool
    {
        $o = ord($ch);
        return ($o >= 0x61 && $o <= 0x7A) || ($o >= 0x41 && $o <= 0x5A);
    }

    /**
     * Reads the string literal at the start of the text, and returns its value and length. PostgreSQL and
     * SQLite escape only '', while MySQL also uses backslash escapes.
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

    /** Reads one predicate that starts with a parenthesized expression or an operand. */
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
            return ['node' => 'predicate', 'op' => 'in', 'left' => $left,
                'list' => $this->literalList(), 'negated' => true];
        }
        if ($this->word('in')) {
            return ['node' => 'predicate', 'op' => 'in', 'left' => $left,
                'list' => $this->literalList(), 'negated' => false];
        }
        return $left;
    }

    /**
     * Reads a parenthesized expression or an operand and the cast after it. If the inside of the
     * parentheses is one operand, it is that operand.
     */
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
            if ($node['kind'] === 'string' && in_array($typeName, [
                'smallint', 'integer', 'bigint', 'numeric', 'double precision', 'real'
            ], true)) {
                $node['kind'] = 'number';
            }
        }
        return $node;
    }

    /** Reads the type name after `::`: words and (n), []. */
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
                throw new CheckDecodeFailure($parenthesized
                    ? 'expected a number after -('
                    : 'expected a number after -');
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

    /** Reads the (a, b, ...) after in. */
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

    /** Reads the (ARRAY[...]) or ((ARRAY[...])::type[]) after PostgreSQL's ANY or ALL. */
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

    /** Writes a predicate as dbspec text. Parentheses may be more than needed; parse decides the canonical form. */
    private function write(array $p): string
    {
        switch ($p['op']) {
            case 'and':
            case 'or':
                return '(' . $this->side($p['left']) . " {$p['op']} " . $this->side($p['right']) . ')';
            case 'compare':
                $type = $this->typeOf($p['left'], $p['right']);
                return $this->operandText($p['left'], $type) . " {$p['operator']} "
                    . $this->operandText($p['right'], $type);
            case 'in':
                $type = $this->typeOf($p['left'], null);
                $items = array_map(fn(array $item): string => $this->operandText($item, $type), $p['list']);
                return $this->operandText($p['left'], $type)
                    . ($p['negated'] ? ' not in (' : ' in (') . implode(', ', $items) . ')';
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

    /**
     * Writes an operand in dbspec notation. A bool column's 1 and 0 become true and false; a SQLite decimal
     * integer is the value divided by the scale.
     */
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
