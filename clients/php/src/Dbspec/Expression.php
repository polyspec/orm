<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * Parses a check expression of the neutral set and writes its canonical text.
 * The tokens follow the opening parenthesis of `check <name> (`; the
 * expression ends with the matching parenthesis, which ends the line.
 */
final class Expression
{
    private const COMPARISONS = ['=' => true, '<>' => true, '<' => true, '<=' => true, '>' => true, '>=' => true];
    private const KEYWORDS = ['and' => true, 'or' => true, 'not' => true, 'in' => true, 'between' => true, 'is' => true, 'null' => true, 'true' => true, 'false' => true];

    private int $at = 0;
    /** @var list<string> */
    private array $out = [];
    /** @var list<array{0:string,1:int,2:int,3:string}> [rule, line, column, message] */
    private array $errors = [];

    /**
     * @param list<array{0:string,1:int}> $tokens [text, column]
     * @param array<string, mixed> $columns names of the table's columns
     * @param array<string, string> $actionColumns column => foreign key with `cascade` or `set_null`
     */
    private function __construct(
        private readonly array $tokens,
        private readonly int $line,
        private readonly int $endColumn,
        private readonly array $columns,
        private readonly array $actionColumns,
    ) {
    }

    /**
     * @return array{0: ?string, 1: list<array{0:string,1:int,2:int,3:string}>} canonical text or null, and errors
     */
    public static function parse(array $tokens, int $line, int $endColumn, array $columns, array $actionColumns): array
    {
        $parser = new self($tokens, $line, $endColumn, $columns, $actionColumns);
        try {
            $parser->disjunction();
            $parser->expect(')');
            array_pop($parser->out);
            if ($parser->at < count($tokens)) {
                $parser->fail('a check expression ends with its closing parenthesis');
            }
        } catch (ExpressionFailure) {
            return [null, $parser->errors];
        }
        $text = '';
        foreach ($parser->out as $i => $token) {
            if ($i > 0 && $parser->out[$i - 1] !== '(' && $token !== ')' && $token !== ',') {
                $text .= ' ';
            }
            $text .= $token;
        }
        return [$parser->errors === [] ? $text : null, $parser->errors];
    }

    private function peek(int $ahead = 0): ?string
    {
        return $this->tokens[$this->at + $ahead][0] ?? null;
    }

    private function take(): string
    {
        $token = $this->tokens[$this->at][0];
        $this->at++;
        $this->out[] = $token;
        return $token;
    }

    private function expect(string $token): void
    {
        if ($this->peek() !== $token) {
            $this->fail("expected `$token`");
        }
        $this->take();
    }

    /** Records an error at the current token (or the line end) and stops the expression. */
    private function fail(string $message): never
    {
        $column = $this->tokens[$this->at][1] ?? $this->endColumn;
        $found = $this->tokens[$this->at][0] ?? 'the line end';
        $this->errors[] = ['check', $this->line, $column, "$message, found `$found`"];
        throw new ExpressionFailure();
    }

    private function disjunction(): void
    {
        $this->conjunction();
        while ($this->peek() === 'or') {
            $this->take();
            $this->conjunction();
        }
    }

    private function conjunction(): void
    {
        $this->negation();
        while ($this->peek() === 'and') {
            $this->take();
            $this->negation();
        }
    }

    private function negation(): void
    {
        if ($this->peek() === 'not') {
            $this->take();
            $this->negation();
            return;
        }
        $this->predicate();
    }

    private function predicate(): void
    {
        $this->additive();
        $next = $this->peek();
        if ($next !== null && isset(self::COMPARISONS[$next])) {
            $this->take();
            $this->additive();
            return;
        }
        if ($next === 'not' && ($this->peek(1) === 'in' || $this->peek(1) === 'between')) {
            $this->take();
            $next = $this->peek();
        }
        if ($next === 'in') {
            $this->take();
            $this->expect('(');
            $this->literal();
            while ($this->peek() === ',') {
                $this->take();
                $this->literal();
            }
            $this->expect(')');
        } elseif ($next === 'between') {
            $this->take();
            $this->additive();
            $this->expect('and');
            $this->additive();
        } elseif ($next === 'is') {
            $this->take();
            if ($this->peek() === 'not') {
                $this->take();
            }
            $this->expect('null');
        }
    }

    private function additive(): void
    {
        $this->multiplicative();
        while ($this->peek() === '+' || $this->peek() === '-') {
            $this->take();
            $this->multiplicative();
        }
    }

    private function multiplicative(): void
    {
        $this->primary();
        while ($this->peek() === '*' || $this->peek() === '/') {
            $this->take();
            $this->primary();
        }
    }

    private function primary(): void
    {
        $token = $this->peek();
        if ($token === '(') {
            $this->take();
            $this->disjunction();
            $this->expect(')');
            return;
        }
        if ($token !== null && preg_match('/^[A-Za-z0-9_]+$/D', $token) && !ctype_digit($token)) {
            $next = $this->peek(1);
            if ($next === '(') {
                $this->fail('a check expression has no functions');
            }
            if (!isset(self::KEYWORDS[$token]) || isset($this->columns[$token])) {
                [, $column] = $this->tokens[$this->at];
                if (!isset($this->columns[$token])) {
                    $this->errors[] = ['check', $this->line, $column, "`$token` is not a column of the table"];
                } elseif (isset($this->actionColumns[$token])) {
                    $this->errors[] = ['check', $this->line, $column, "`$token` is a column of foreign key `{$this->actionColumns[$token]}` with cascade or set_null"];
                }
                $this->take();
                return;
            }
        }
        $this->literal();
    }

    /** A literal: a number, possibly negative, a string, true, false or null. */
    private function literal(): void
    {
        $token = $this->peek();
        if ($token === 'true' || $token === 'false' || $token === 'null') {
            $this->take();
            return;
        }
        if ($token === '-' && isset($this->tokens[$this->at + 1]) && $this->tokens[$this->at + 1][1] === $this->tokens[$this->at][1] + 1) {
            $number = Literal::checkNumber('-' . $this->tokens[$this->at + 1][0]);
            if ($number !== null) {
                $this->at += 2;
                $this->out[] = $number;
                return;
            }
        }
        if ($token !== null) {
            $number = Literal::checkNumber($token);
            if ($number !== null) {
                $this->at++;
                $this->out[] = $number;
                return;
            }
            $string = Literal::stringValue($token);
            if ($string !== null) {
                $this->at++;
                $this->out[] = Literal::quote($string);
                return;
            }
        }
        $this->fail('expected a column, a literal or `(`');
    }
}
