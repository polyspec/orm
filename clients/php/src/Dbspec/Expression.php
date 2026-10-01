<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * Reads a check predicate, checks its operand types and writes its canonical text.
 * The predicate is read first: a token outside the predicate forms, or a
 * literal where the forms need a column, stops it with one diagnostic and its
 * columns are not checked. A predicate that reads completely reports its
 * first column or type diagnostic in source order.
 * The tokens follow the opening parenthesis of `check <name> (`; the
 * predicate ends with the matching parenthesis, which ends the line.
 */
final class Expression
{
    private const COMPARISONS = ['=' => true, '<>' => true, '<' => true, '<=' => true, '>' => true, '>=' => true];
    private const ORDERINGS = ['<' => true, '<=' => true, '>' => true, '>=' => true];
    private const ARITHMETIC = ['+' => true, '-' => true, '*' => true, '/' => true];
    private const KEYWORDS = ['and' => true, 'or' => true, 'not' => true, 'in' => true, 'between' => true, 'is' => true, 'null' => true, 'true' => true, 'false' => true];
    private const TEXT = ['varchar' => true, 'text' => true];

    private int $at = 0;
    /** @var list<string> */
    private array $out = [];
    /** @var list<array{0:string,1:int,2:int,3:string}> [rule, line, column, message] */
    private array $errors = [];
    /**
     * The predicates read, in source order. An operand is
     * ['column', name, column, ?Column] or ['literal', text, column, output index];
     * the Column is null for a name that is not a column of the table.
     *
     * @var list<array>
     */
    private array $predicates = [];

    /**
     * @param list<array{0:string,1:int}> $tokens [text, column]
     * @param array<string, Column> $columns the table's columns
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
                $parser->fail('a check predicate ends with its closing parenthesis');
            }
        } catch (ExpressionFailure) {
            return [null, $parser->errors];
        }
        $parser->checkTypes();
        if ($parser->errors !== []) {
            return [null, $parser->errors];
        }
        $text = '';
        foreach ($parser->out as $i => $token) {
            if ($i > 0 && $parser->out[$i - 1] !== '(' && $token !== ')' && $token !== ',') {
                $text .= ' ';
            }
            $text .= $token;
        }
        return [$text, []];
    }

    private function peek(int $ahead = 0): ?string
    {
        return $this->tokens[$this->at + $ahead][0] ?? null;
    }

    /** The column of the current token, or the line end. */
    private function position(): int
    {
        return $this->tokens[$this->at][1] ?? $this->endColumn;
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

    /** Records a reading error at the current token (or the line end) and stops the predicate. */
    private function fail(string $message): never
    {
        $found = $this->tokens[$this->at][0] ?? 'the line end';
        if (isset(self::ARITHMETIC[$found])) {
            $message = 'a check has no arithmetic, and a minus applies only to a number literal';
        }
        $this->failAt($this->position(), "$message, found `$found`");
    }

    private function failAt(int $column, string $message): never
    {
        $this->errors[] = ['check', $this->line, $column, $message];
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
        if ($this->peek() === '(') {
            $this->take();
            $this->disjunction();
            $this->expect(')');
            return;
        }
        $this->predicate();
    }

    private function predicate(): void
    {
        $left = $this->operand();
        $next = $this->peek();
        if ($next !== null && isset(self::COMPARISONS[$next])) {
            $operator = [$next, $this->position()];
            $this->take();
            $right = $this->operand();
            if ($left[0] === 'literal' && $right[0] === 'literal') {
                $this->failAt($left[2], "a comparison needs a column operand, found `{$left[1]}` $next `{$right[1]}`");
            }
            $this->predicates[] = ['compare', $left, $operator, $right];
            return;
        }
        if ($next === 'not' && ($this->peek(1) === 'in' || $this->peek(1) === 'between')) {
            $this->requireColumn($left, $this->peek(1));
            $this->take();
            $next = $this->peek();
        }
        if ($next === 'in') {
            $this->requireColumn($left, 'in');
            $this->take();
            $this->expect('(');
            $list = [$this->literal()];
            while ($this->peek() === ',') {
                $this->take();
                $list[] = $this->literal();
            }
            $this->expect(')');
            $this->predicates[] = ['in', $left, $list];
        } elseif ($next === 'between') {
            $this->requireColumn($left, 'between');
            $between = $this->position();
            $this->take();
            $low = $this->literal();
            $this->expect('and');
            $this->predicates[] = ['between', $left, $between, $low, $this->literal()];
        } elseif ($next === 'is') {
            $this->requireColumn($left, 'is');
            $this->take();
            if ($this->peek() === 'not') {
                $this->take();
            }
            $this->expect('null');
            $this->predicates[] = ['null', $left];
        } elseif ($left[0] === 'literal') {
            // A literal followed by a token outside the forms reports that token.
            if ($next !== null && $next !== 'and' && $next !== 'or' && $next !== ')') {
                $this->fail("`$next` is not allowed here");
            }
            $this->failAt($left[2], "a literal alone is not a predicate, found `{$left[1]}`");
        } else {
            $this->predicates[] = ['alone', $left];
        }
    }

    /** `in`, `between` and `is` take a column on their left. */
    private function requireColumn(array $operand, string $keyword): void
    {
        if ($operand[0] === 'literal') {
            $this->failAt($operand[2], "`$keyword` takes a column on its left, found `{$operand[1]}`");
        }
    }

    /** A column of the table or a literal. */
    private function operand(): array
    {
        $token = $this->peek();
        if ($token !== null && preg_match('/^[A-Za-z0-9_]+$/D', $token) && !ctype_digit($token)) {
            if ($this->peek(1) === '(') {
                $this->fail('a check has no functions');
            }
            if (!isset(self::KEYWORDS[$token]) || isset($this->columns[$token])) {
                $operand = ['column', $token, $this->position(), $this->columns[$token] ?? null];
                $this->take();
                return $operand;
            }
        }
        return $this->literal();
    }

    /** A literal: a number, possibly negative, a string, true or false. */
    private function literal(): array
    {
        $token = $this->peek();
        $column = $this->position();
        if ($token === 'null') {
            $this->fail('a check has no null literal; `is null` tests for null');
        }
        $text = null;
        if ($token === 'true' || $token === 'false') {
            $text = $token;
            $this->at++;
        } elseif ($token === '-' && isset($this->tokens[$this->at + 1]) && $this->tokens[$this->at + 1][1] === $column + 1 && Literal::number('-' . $this->tokens[$this->at + 1][0]) !== null) {
            $text = '-' . $this->tokens[$this->at + 1][0];
            $this->at += 2;
        } elseif ($token !== null && (Literal::number($token) !== null || Literal::stringValue($token) !== null)) {
            $text = $token;
            $this->at++;
        }
        if ($text === null) {
            $this->fail('expected a column, a literal or `(`');
        }
        $this->out[] = $text;
        return ['literal', $text, $column, count($this->out) - 1];
    }

    /** Checks the operand types of the predicates and reports the first diagnostic in source order. */
    private function checkTypes(): void
    {
        /** @var list<array{0:int,1:string}> $found [column, message] */
        $found = [];
        foreach ($this->predicates as $predicate) {
            switch ($predicate[0]) {
                case 'compare':
                    [, $left, [$operator, $at], $right] = $predicate;
                    if (isset(self::ORDERINGS[$operator]) && ($this->isBool($left) || $this->isBool($right))) {
                        $found[] = [$at, "a bool operand takes only =, <> and in, found `$operator`"];
                    }
                    $this->meet($left, $right, $found);
                    break;
                case 'in':
                    if ($this->usable($predicate[1], $found)) {
                        foreach ($predicate[2] as $literal) {
                            $this->meet($predicate[1], $literal, $found);
                        }
                    }
                    break;
                case 'between':
                    if ($this->isBool($predicate[1])) {
                        $found[] = [$predicate[2], 'a bool operand takes only =, <> and in, found `between`'];
                    }
                    if ($this->usable($predicate[1], $found)) {
                        $this->meet($predicate[1], $predicate[3], $found);
                        $this->meet($predicate[1], $predicate[4], $found);
                    }
                    break;
                case 'null':
                    $this->usable($predicate[1], $found);
                    break;
                case 'alone':
                    if (!$this->usable($predicate[1], $found)) {
                        break;
                    }
                    $type = $predicate[1][3]->type->name;
                    if ($type !== 'bool') {
                        $found[] = [$predicate[1][2], "a column alone is a predicate only when it is bool, `{$predicate[1][1]}` is {$predicate[1][3]->type->text()}"];
                    }
                    break;
            }
        }
        if ($found === []) {
            return;
        }
        $first = $found[0];
        foreach ($found as $candidate) {
            if ($candidate[0] < $first[0]) {
                $first = $candidate;
            }
        }
        $this->errors[] = ['check', $this->line, $first[0], $first[1]];
    }

    /** A bool column or a `true` or `false` literal. */
    private function isBool(array $operand): bool
    {
        return $operand[0] === 'column' ? $operand[3]?->type->name === 'bool' : $operand[1] === 'true' || $operand[1] === 'false';
    }

    /**
     * Whether a literal, or a column whose type can meet another operand.
     * Records an unknown column, a column of a `cascade` or `set_null` foreign
     * key and a bytes column; a column whose own line failed reports nothing.
     *
     * @param list<array{0:int,1:string}> $found
     */
    private function usable(array $operand, array &$found): bool
    {
        if ($operand[0] === 'literal') {
            return true;
        }
        [, $name, $at, $column] = $operand;
        if ($column === null) {
            $found[] = [$at, "`$name` is not a column of the table"];
            return false;
        }
        if (isset($this->actionColumns[$name])) {
            $found[] = [$at, "`$name` is a column of foreign key `{$this->actionColumns[$name]}` with cascade or set_null"];
            return false;
        }
        if ($column->type->name === 'bytes') {
            $found[] = [$at, "`$name` is a bytes column, which a check cannot use"];
            return false;
        }
        return $column->type->name !== 'invalid';
    }

    /**
     * Two columns meet by type; a literal meets a column when it is a default
     * of the column's type, and then takes that default's canonical form.
     * The later operand carries a column mismatch; the literal carries a literal one.
     *
     * @param list<array{0:int,1:string}> $found
     */
    private function meet(array $left, array $right, array &$found): void
    {
        $leftUsable = $this->usable($left, $found);
        if (!$this->usable($right, $found) || !$leftUsable) {
            return;
        }
        if ($left[0] === 'column' && $right[0] === 'column') {
            $a = $left[3]->type;
            $b = $right[3]->type;
            if (!self::columnsMeet($a, $b)) {
                $found[] = [$right[2], "`{$right[1]}` of {$b->text()} does not meet `{$left[1]}` of {$a->text()}"];
            }
            return;
        }
        [$column, $literal] = $left[0] === 'column' ? [$left, $right] : [$right, $left];
        $type = $column[3]->type;
        // A text column takes the varchar form without a length limit.
        $literalType = $type->name === 'text' ? new ColumnType('varchar', [PHP_INT_MAX]) : $type;
        [$canonical, $problem] = Literal::columnDefault($literalType, $literal[1]);
        if ($problem !== null) {
            $found[] = [$literal[2], "`{$literal[1]}` does not meet `{$column[1]}` of {$type->text()}: $problem"];
            return;
        }
        $this->out[$literal[3]] = $canonical;
    }

    private static function columnsMeet(ColumnType $a, ColumnType $b): bool
    {
        if ($a->isInteger() || $b->isInteger()) {
            return $a->isInteger() && $b->isInteger();
        }
        if (isset(self::TEXT[$a->name]) || isset(self::TEXT[$b->name])) {
            return isset(self::TEXT[$a->name]) && isset(self::TEXT[$b->name]);
        }
        return match ($a->name) {
            'decimal' => $b->name === 'decimal' && $a->parameters[1] === $b->parameters[1],
            default => $a->name === $b->name && $a->parameters === $b->parameters,
        };
    }
}
