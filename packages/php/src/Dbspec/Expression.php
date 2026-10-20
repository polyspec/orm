<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * Reads a check predicate, checks its operand types and writes its canonical text.
 * The predicate is read first: a token outside the predicate forms, or a
 * literal where the forms need a column, stops it with one diagnostic and its
 * columns are not checked. A predicate that reads completely reports its
 * first column or type diagnostic in source order.
 * The tokens follow the opening parenthesis of `check <name> (`; the
 * predicate ends with the matching parenthesis, which ends the line.
 * The tree has no parentheses; emission writes only the parentheses that an `or` inside `and` requires;
 * it writes only those.
 *
 * @internal
 */
final class Expression
{
    private const COMPARISONS = ['=' => true, '<>' => true, '<' => true, '<=' => true, '>' => true, '>=' => true];
    private const ORDERINGS = ['<' => true, '<=' => true, '>' => true, '>=' => true];
    private const ARITHMETIC = ['+' => true, '-' => true, '*' => true, '/' => true];
    private const KEYWORDS = ['and' => true, 'or' => true, 'not' => true, 'in' => true, 'between' => true, 'is' => true, 'null' => true, 'true' => true, 'false' => true];

    private int $at = 0;
    /** @var array<int, string> index in the line => class of the tokens the predicate read (docs/spec/dbspec.md "Syntax analysis") */
    private array $marks = [];
    /** @var list<string> The text of the literal; type checking turns it into canonical form. */
    private array $literals = [];
    /** @var list<array{0:string,1:int,2:int,3:string}> [rule, line, column, message] */
    private array $errors = [];
    /**
     * Predicate read in source order. An operand is
     * ['column', name, column, ?Column] or ['literal', text, column, literal index], and
     * if the name is not a column of the table, Column is null.
     * A predicate is ['compare', left, [operator, column], right],
     * ['in', operand, list, negated], ['null', operand, negated], and the tree joins these
     * with ['and' | 'or', left, right].
     *
     * @var list<array>
     */
    private array $predicates = [];
    /** @var list<string> Column names that the parsed predicate reads */
    private array $refs = [];

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
     * @return array{0: ?string, 1: list<array{0:string,1:int,2:int,3:string}>, 2: list<string>, 3: array<int, string>} The canonical text or null; the errors; the column names the check reads (an empty list on failure); the class of each token read (index in the line => class)
     */
    public static function parse(array $tokens, int $line, int $endColumn, array $columns, array $actionColumns): array
    {
        $parser = new self($tokens, $line, $endColumn, $columns, $actionColumns);
        try {
            $tree = $parser->disjunction();
            $parser->expect(')');
            if ($parser->at < count($tokens)) {
                $parser->fail('a check predicate ends with its closing parenthesis');
            }
        } catch (ExpressionFailure) {
            return [null, $parser->errors, [], $parser->marks];
        }
        $parser->checkTypes();
        if ($parser->errors !== []) {
            return [null, $parser->errors, [], $parser->marks];
        }
        return [$parser->text($tree), [], array_values(array_unique($parser->refs)), $parser->marks];
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

    private function expect(string $token, string $class = ''): void
    {
        if ($this->peek() !== $token) {
            $this->fail("expected `$token`");
        }
        if ($class !== '') {
            $this->take($class);
        } else {
            $this->at++;
        }
    }

    /** Consumes the current token and records its class for its index in the line. */
    private function take(string $class): void
    {
        $this->marks[$this->tokens[$this->at][2]] = $class;
        $this->at++;
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

    private function disjunction(): array
    {
        $left = $this->conjunction();
        while ($this->peek() === 'or') {
            $this->take('keyword');
            $left = ['or', $left, $this->conjunction()];
        }
        return $left;
    }

    private function conjunction(): array
    {
        $left = $this->group();
        while ($this->peek() === 'and') {
            $this->take('keyword');
            $left = ['and', $left, $this->group()];
        }
        return $left;
    }

    /** Parentheses only group a predicate and leave no node; emission writes the parentheses that precedence needs. */
    private function group(): array
    {
        if ($this->peek() === '(') {
            $this->at++;
            $inner = $this->disjunction();
            $this->expect(')');
            return $inner;
        }
        return $this->predicate();
    }

    private function predicate(): array
    {
        $left = $this->operand();
        $next = $this->peek();
        if ($next !== null && isset(self::COMPARISONS[$next])) {
            $operator = [$next, $this->position()];
            $this->at++;
            $right = $this->operand();
            if ($left[0] === 'literal' && $right[0] === 'literal') {
                $this->failAt($left[2], "a comparison needs a column operand, found `{$left[1]}` $next `{$right[1]}`");
            }
            return $this->predicates[] = ['compare', $left, $operator, $right];
        }
        $negated = $next === 'not' && $this->peek(1) === 'in';
        if ($negated) {
            $this->requireColumn($left, 'in');
            $this->take('keyword');
            $next = $this->peek();
        }
        if ($next === 'in') {
            $this->requireColumn($left, 'in');
            $this->take('keyword');
            $this->expect('(');
            $list = [$this->literal()];
            while ($this->peek() === ',') {
                $this->at++;
                $list[] = $this->literal();
            }
            $this->expect(')');
            return $this->predicates[] = ['in', $left, $list, $negated];
        }
        if ($next === 'is') {
            $this->requireColumn($left, 'is');
            $this->take('keyword');
            $isNot = $this->peek() === 'not';
            if ($isNot) {
                $this->take('keyword');
            }
            $this->expect('null', 'keyword');
            return $this->predicates[] = ['null', $left, $isNot];
        }
        // Operands not followed by a comparison, in, or is: if followed by and, or, ), or end, report at the operand;
        // otherwise report at the following token.
        if ($next !== null && $next !== 'and' && $next !== 'or' && $next !== ')') {
            $this->fail("`$next` is not allowed here");
        }
        $this->failAt($left[2], "`{$left[1]}` alone is not a predicate");
    }

    /** `in` and `is` take a column on the left. */
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
        if ($token !== null && Parser::isWord($token) && !ctype_digit($token) && preg_match('/^[0-9]+\.[0-9]+$/D', $token) !== 1) {
            if ($this->peek(1) === '(') {
                $this->fail('a check has no functions');
            }
            if (!isset(self::KEYWORDS[$token])) {
                $operand = ['column', $token, $this->position(), $this->columns[$token] ?? null];
                $this->refs[] = $token;
                $this->take('name');
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
            $this->take('keyword');
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
        $this->literals[] = $text;
        return ['literal', $text, $column, count($this->literals) - 1];
    }

    /** Canonical text: only an `or` inside an `and` is wrapped in parentheses. */
    private function text(array $node): string
    {
        switch ($node[0]) {
            case 'and':
            case 'or':
                $sides = [];
                foreach ([$node[1], $node[2]] as $side) {
                    $text = $this->text($side);
                    $sides[] = $node[0] === 'and' && $side[0] === 'or' ? "($text)" : $text;
                }
                return implode(" {$node[0]} ", $sides);
            case 'compare':
                return $this->operandText($node[1]) . " {$node[2][0]} " . $this->operandText($node[3]);
            case 'in':
                $list = array_map(fn (array $literal): string => $this->operandText($literal), $node[2]);
                return $this->operandText($node[1]) . ($node[3] ? ' not' : '') . ' in (' . implode(', ', $list) . ')';
            default:
                return $this->operandText($node[1]) . ($node[2] ? ' is not null' : ' is null');
        }
    }

    private function operandText(array $operand): string
    {
        return $operand[0] === 'column' ? $operand[1] : $this->literals[$operand[3]];
    }

    /** Checks the operand types of the predicates and reports the first diagnostic in source order. */
    private function checkTypes(): void
    {
        /** @var list<array{0:int,1:string,2?:string}> $found [column, message, rule] */
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
                case 'null':
                    $this->usable($predicate[1], $found);
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
        $this->errors[] = [$first[2] ?? 'check', $this->line, $first[0], $first[1]];
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
     * @param list<array{0:int,1:string,2?:string}> $found
     */
    private function usable(array $operand, array &$found): bool
    {
        if ($operand[0] === 'literal') {
            return true;
        }
        [, $name, $at, $column] = $operand;
        if ($column === null) {
            // Go's ref: a malformed reference reports its name rule and is not resolved.
            if (Parser::validName($name)) {
                $found[] = [$at, "`$name` is not a column of the table"];
            } elseif (preg_match('/^[a-z][a-z0-9_]*$/D', $name) === 1 && !in_array($name, Parser::RESERVED, true)) {
                $found[] = [$at, "name `$name` is longer than 63 bytes", 'name.length'];
            } else {
                $found[] = [$at, "name `$name` does not match [a-z][a-z0-9_]* or is a reserved word", 'name.format'];
            }
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
     * @param list<array{0:int,1:string,2?:string}> $found
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
        $this->literals[$literal[3]] = $canonical;
    }

    /** Whether two column types meet, by the table that the IR validator also reads. */
    private static function columnsMeet(ColumnType $a, ColumnType $b): bool
    {
        return self::meetKind($a) === self::meetKind($b);
    }

    private static function meetKind(ColumnType $t): string
    {
        return Meet::kind($t->name, $t->name === 'decimal' ? $t->parameters[1] : 0, in_array($t->name, ['decimal', 'time', 'datetime'], true) ? $t->parameters[0] : 0);
    }
}
