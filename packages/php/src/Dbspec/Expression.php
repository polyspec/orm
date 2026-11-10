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
    private const KEYWORDS = [
        'and' => true, 'or' => true, 'not' => true, 'in' => true, 'between' => true, 'is' => true,
        'null' => true, 'true' => true, 'false' => true
    ];

    /** Whether a token is a dbspec predicate keyword. */
    public static function isKeyword(string $token): bool
    {
        return isset(self::KEYWORDS[$token]);
    }

    /** Whether a token compares two check operands. */
    public static function isComparison(string $token): bool
    {
        return isset(self::COMPARISONS[$token]);
    }

    private int $at = 0;
    /**
     * @var array<int, string> index in the line => class of the tokens the predicate read
     *     (docs/spec/dbspec.md "Syntax analysis")
     */
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
     * @param list<array{0:string,1:int,2:int}> $tokens [text, column, index in the line], without the closing
     *     parenthesis of the check
     * @param array<string, Column> $columns the table's columns
     * @param array<string, string> $actionColumns column => foreign key with `cascade` or `set_null`
     * @param array<string, true> $failed the names of the table's column lines that failed
     */
    private function __construct(
        private readonly array $tokens,
        private readonly int $line,
        private readonly int $endColumn,
        private readonly array $columns,
        private readonly array $actionColumns,
        private readonly string $table,
        private readonly array $failed,
    ) {
    }

    /**
     * Reads the tokens after `(` of a check, the last of them the closing parenthesis, as Go's parseExpression does.
     *
     * @param array<string, true> $failed
     * @return array{0: ?string, 1: list<array{0:string,1:int,2:int,3:string}>, 2: list<string>,
     *     3: array<int, string>} The canonical text or null; the errors; the column names the check reads
     *     (an empty list on failure); the class of each token read (index in the line => class)
     */
    public static function parse(
        array $tokens,
        int $line,
        int $endColumn,
        array $columns,
        array $actionColumns,
        string $table = '',
        array $failed = [],
    ): array {
        $parser = new self(array_slice($tokens, 0, -1), $line, $endColumn, $columns, $actionColumns, $table, $failed);
        try {
            $tree = $parser->disjunction();
            if ($parser->at < count($parser->tokens)) {
                $parser->fail('is not allowed here');
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

    /** Consumes the current token and records its class for its index in the line. */
    private function take(string $class): void
    {
        $this->marks[$this->tokens[$this->at][2]] = $class;
        $this->at++;
    }

    /** Go's word: consumes the keyword when it comes next. */
    private function word(string $text): bool
    {
        if ($this->peek() === $text) {
            $this->take('keyword');
            return true;
        }
        return false;
    }

    private function punct(string $text): bool
    {
        if ($this->peek() === $text) {
            $this->at++;
            return true;
        }
        return false;
    }

    /** Go's fail: `<token> <reason> in a check expression` at the current token, or the end of the expression. */
    private function fail(string $reason): never
    {
        $token = $this->tokens[$this->at] ?? null;
        if ($token === null) {
            $this->failAt($this->endColumn, 'check expression ends early');
        }
        $this->failAt($token[1], Parser::describe($token[0]) . " $reason in a check expression");
    }

    /** Go's literalAt: a literal where the predicate forms need a column. */
    private function literalAt(array $literal, string $reason): never
    {
        $this->failAt($literal[2], Parser::describe($literal[1]) . " $reason");
    }

    private function failAt(int $column, string $message): never
    {
        $this->errors[] = ['check', $this->line, $column, $message];
        throw new ExpressionFailure();
    }

    private function disjunction(): array
    {
        $left = $this->conjunction();
        while ($this->word('or')) {
            $left = ['or', $left, $this->conjunction()];
        }
        return $left;
    }

    private function conjunction(): array
    {
        $left = $this->predicate();
        while ($this->word('and')) {
            $left = ['and', $left, $this->predicate()];
        }
        return $left;
    }

    /** One predicate form; parentheses only group and leave no node (emission writes those precedence needs). */
    private function predicate(): array
    {
        if ($this->punct('(')) {
            $inner = $this->disjunction();
            if (!$this->punct(')')) {
                $this->fail('is not allowed here; expected )');
            }
            return $inner;
        }
        $left = $this->operand();
        $next = $this->peek();
        if ($next === null) {
            $this->alone($left);
        }
        if (self::isComparison($next)) {
            $operator = [$next, $this->tokens[$this->at][1]];
            $this->at++;
            $right = $this->operand();
            if ($left[0] === 'literal' && $right[0] === 'literal') {
                $this->literalAt($left, 'is compared with a literal; a comparison needs a column');
            }
            return $this->predicates[] = ['compare', $left, $operator, $right];
        }
        $notIn = $next === 'not' && $this->peek(1) === 'in';
        if ($left[0] === 'literal' && ($next === 'is' || $next === 'in' || $notIn)) {
            $this->literalAt($left, 'is not a column');
        }
        if ($next === 'is') {
            $this->take('keyword');
            $negated = $this->word('not');
            if (!$this->word('null')) {
                $this->fail('is not allowed here; expected null');
            }
            return $this->predicates[] = ['null', $left, $negated];
        }
        if ($notIn) {
            $this->take('keyword');
        }
        if ($this->word('in')) {
            if (!$this->punct('(')) {
                $this->fail('is not allowed here; expected (');
            }
            $list = [];
            for (;;) {
                $literal = $this->literal();
                if ($literal === null) {
                    $this->fail('is not a literal');
                }
                $list[] = $literal;
                if ($this->punct(')')) {
                    return $this->predicates[] = ['in', $left, $list, $notIn];
                }
                if (!$this->punct(',')) {
                    $this->fail('is not allowed here; expected , or )');
                }
            }
        }
        $this->alone($left);
    }

    /**
     * An operand not followed by a comparison, in or is: before and, or, `)` or the end it is reported at the
     * operand, elsewhere at the token that follows.
     */
    private function alone(array $operand): never
    {
        $next = $this->peek();
        if ($next !== null && $next !== 'and' && $next !== 'or' && $next !== ')') {
            $this->fail('is not allowed here');
        }
        $this->failAt($operand[2], Parser::describe($operand[1]) . ' alone is not a predicate');
    }

    /** A literal or a column; arithmetic, functions and the null literal are no operands. */
    private function operand(): array
    {
        $literal = $this->literal();
        if ($literal !== null) {
            return $literal;
        }
        $token = $this->tokens[$this->at] ?? null;
        if ($token === null) {
            $this->fail('');
        }
        if (!Parser::isWord($token[0]) || Parser::isNumber($token[0]) || self::isKeyword($token[0])) {
            $this->fail('is not allowed here');
        }
        if ($this->peek(1) === '(') {
            $this->fail('is a function; check predicates have no functions');
        }
        $operand = ['column', $token[0], $token[1], $this->columns[$token[0]] ?? null];
        $this->refs[] = $token[0];
        $this->take('name');
        return $operand;
    }

    /** A literal: a number with an optional `-` before it, a string, true or false; null when none comes next. */
    private function literal(): ?array
    {
        $token = $this->tokens[$this->at] ?? null;
        if ($token === null) {
            return null;
        }
        $text = null;
        $column = $token[1];
        if (Parser::isNumber($token[0])) {
            $text = $token[0];
            $this->at++;
        } elseif ($token[0] === '-' && Parser::isNumber($this->peek(1) ?? '')) {
            $text = '-' . $this->peek(1);
            $this->at += 2;
        } elseif (Literal::stringValue($token[0]) !== null) {
            $text = $token[0];
            $this->at++;
        } elseif ($token[0] === 'true' || $token[0] === 'false') {
            $text = $token[0];
            $this->take('keyword');
        }
        if ($text === null) {
            return null;
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

    /**
     * Checks the operand types of the predicates as Go's checkTyper and reports the first diagnostic in source
     * order: by column, then by the rule order.
     */
    private function checkTypes(): void
    {
        /** @var list<array{0:int,1:string,2:string}> $found [column, message, rule] */
        $found = [];
        foreach ($this->predicates as $predicate) {
            switch ($predicate[0]) {
                case 'compare':
                    [, $left, [$operator, $at], $right] = $predicate;
                    $lc = $left[0] === 'column' ? $this->column($left, $found) : null;
                    $rc = $right[0] === 'column' ? $this->column($right, $found) : null;
                    if (($left[0] === 'column' && $lc === null) || ($right[0] === 'column' && $rc === null)) {
                        break;
                    }
                    $typed = $lc ?? $rc;
                    if (
                        isset(self::ORDERINGS[$operator])
                        && ($typed->type->name === 'bool' || self::isBool($left) || self::isBool($right))
                    ) {
                        $found[] = [$at, "$operator does not order bool values", 'check'];
                    }
                    if ($lc !== null && $rc !== null) {
                        if (!self::columnsMeet($lc->type, $rc->type)) {
                            $found[] = [$right[2], 'column ' . Parser::quoted($right[1])
                                . " is {$rc->type->text()} and does not meet {$lc->type->text()}", 'check'];
                        }
                    } elseif ($lc !== null) {
                        $this->literalOf($right, $lc->type, $found);
                    } else {
                        $this->literalOf($left, $rc->type, $found);
                    }
                    break;
                case 'in':
                    $column = $this->column($predicate[1], $found);
                    if ($column !== null) {
                        foreach ($predicate[2] as $literal) {
                            $this->literalOf($literal, $column->type, $found);
                        }
                    }
                    break;
                case 'null':
                    $this->column($predicate[1], $found);
                    break;
            }
        }
        if ($found === []) {
            return;
        }
        $rank = ['name.format' => 0, 'name.length' => 1, 'check' => 2];
        $order = array_keys($found);
        usort($order, static fn(int $a, int $b): int => [$found[$a][0], $rank[$found[$a][2]], $a]
            <=> [$found[$b][0], $rank[$found[$b][2]], $b]);
        $first = $found[$order[0]];
        $this->errors[] = [$first[2], $this->line, $first[0], $first[1]];
    }

    /** The literal true or false. */
    private static function isBool(array $operand): bool
    {
        return $operand[0] === 'literal' && ($operand[1] === 'true' || $operand[1] === 'false');
    }

    /**
     * Go's checkTyper column: the column of an operand whose type can take part in the predicate, or null. Records a
     * malformed name, an unknown column, a column of a `cascade` or `set_null` foreign key and a bytes column; a
     * column whose own line failed reports nothing.
     *
     * @param list<array{0:int,1:string,2:string}> $found
     */
    private function column(array $operand, array &$found): ?Column
    {
        [, $name, $at, $column] = $operand;
        if (!Parser::validName($name)) {
            if (preg_match('/^[a-z][a-z0-9_]*$/D', $name) !== 1 || in_array($name, Parser::RESERVED, true)) {
                $found[] = [$at, Parser::formatMessage($name), 'name.format'];
            }
            if (strlen($name) > 63) {
                $found[] = [$at, Parser::lengthMessage($name), 'name.length'];
            }
            return null;
        }
        if ($column === null) {
            if (!isset($this->failed[$name])) {
                $found[] = [$at, 'column ' . Parser::quoted($name) . ' is not a column of table '
                    . Parser::quoted($this->table), 'check'];
            }
            return null;
        }
        if (isset($this->actionColumns[$name])) {
            $found[] = [$at, 'column ' . Parser::quoted($name) . ' belongs to a foreign key with cascade or set_null',
                'check'];
            return null;
        }
        if ($column->type->name === 'invalid') {
            return null;
        }
        if ($column->type->name === 'bytes') {
            $found[] = [$at, 'bytes column ' . Parser::quoted($name) . ' cannot be part of a check', 'check'];
            return null;
        }
        return $column;
    }

    /**
     * A literal meets a column when it is a default of the column's type, and then takes that default's canonical
     * form; a text column takes the varchar form without a length limit.
     *
     * @param list<array{0:int,1:string,2:string}> $found
     */
    private function literalOf(array $literal, ColumnType $type, array &$found): void
    {
        $literalType = $type->name === 'text' ? new ColumnType('varchar', [PHP_INT_MAX]) : $type;
        [$canonical, $problem] = Literal::columnDefault($literalType, $literal[1]);
        if ($problem !== null) {
            $found[] = [$literal[2], Parser::describe($literal[1]) . " is not a {$type->text()} value", 'check'];
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
        return Meet::kind(
            $t->name,
            $t->name === 'decimal' ? $t->parameters[1] : 0,
            in_array($t->name, ['decimal', 'time', 'datetime'], true) ? $t->parameters[0] : 0
        );
    }
}
