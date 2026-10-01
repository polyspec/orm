<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * Reads one dbspec document line by line and validates it (docs/dbspec.md).
 * Rules local to a line are checked on the line, rules of a whole table when
 * its block closes, and rules across tables (foreign key targets and audit
 * history tables) after the last line. Every diagnostic carries the line and
 * column, in Unicode code points, of its token. Diagnostics are ordered by
 * line, column and the order of RULES; an encoding, header or limit error
 * stops parsing and is reported after the diagnostics found before it.
 *
 * @internal Use Dbspec::parse.
 */
final class Parser
{
    private const TOKEN = "/[0-9]+\\.[0-9]+|[A-Za-z0-9_]+|'(?:[^']|'')*+'|<=|>=|<>|[^ ]/u";
    private const VALID_UTF8 = '/\A(?:[\x00-\x7F]|[\xC2-\xDF][\x80-\xBF]|\xE0[\xA0-\xBF][\x80-\xBF]|[\xE1-\xEC\xEE\xEF][\x80-\xBF]{2}|\xED[\x80-\x9F][\x80-\xBF]|\xF0[\x90-\xBF][\x80-\xBF]{2}|[\xF1-\xF3][\x80-\xBF]{3}|\xF4[\x80-\x8F][\x80-\xBF]{2})*+/';
    private const MAX_BYTES = 32 * 1024 * 1024;
    private const MAX_TABLES = 4096;
    private const MAX_COLUMNS = 120000;
    private const MAX_FOREIGN_KEYS = 20000;
    private const MAX_TABLE_COLUMNS = 1000;
    private const MAX_KEY_COLUMNS = 16;
    private const MAX_KEY_VARCHAR = 640;
    /** The rule table of docs/dbspec.md, in its order, which orders diagnostics at one position. */
    private const RULES = ['header', 'syntax', 'order', 'name.format', 'name.length', 'name.duplicate', 'type', 'column', 'key', 'foreign_key', 'check', 'setting', 'use', 'diagram', 'limit', 'encoding'];
    private const RESERVED = ['dbspec', 'use', 'table', 'diagram', 'primary', 'unique', 'index', 'foreign', 'check', 'settings', 'null', 'identity', 'default', 'true', 'false'];
    /** Codec stages that produce text; the others produce bytes. */
    private const TEXT_STAGES = ['hex', 'base64', 'ordered_json', 'yaml', 'serialize'];

    /** @var list<array{0:string,1:int,2:int,3:string}> [rule, line, column, message] */
    private array $diagnostics = [];
    private Document $document;

    /** @var array<string, array{table: ?Table, columns: array<string, Column>}> table name => definition; null for a table whose definition is unknown */
    private array $tables = [];
    /** @var array<string, true> index, unique key, foreign key and check names of the schema */
    private array $constraintNames = [];
    /** @var array<string, true> */
    private array $usedDocuments = [];
    /** @var array<string, true> */
    private array $diagramNames = [];
    /** @var array<string, true> tables of failed `use` lines: references to them report nothing more */
    private array $failedTables = [];
    /** @var array<string, true> table names of the used documents, which constraint names must differ from */
    private array $usedTableNames = [];
    /** @var array<int, true> lines that already hold a syntax diagnostic */
    private array $syntaxLines = [];
    /** @var array<string, ColumnType> */
    private array $types = [];
    private int $tableCount = 0;
    private int $columnCount = 0;
    private int $foreignKeyCount = 0;

    // The current line.
    private int $line = 0;
    private string $text = '';
    /** @var list<array{0:string,1:int}> [text, column] */
    private array $tokens = [];
    /** @var list<string> */
    private array $comments = [];

    // The open block.
    private string $state = 'top';
    private int $topPhase = 0;
    /** @var array{0:int,1:int} position of the open block's brace */
    private array $blockOpen = [0, 0];
    /** @var array{0:int,1:int} */
    private array $settingsOpen = [0, 0];
    private ?Table $table = null;
    /** @var array{0:int,1:int} */
    private array $tableName = [0, 0];
    private int $tablePhase = 0;
    /** @var array<string, Column> */
    private array $columns = [];
    /** @var array<string, true> columns whose type is invalid */
    private array $invalidTypes = [];
    /** @var list<array{0:string,1:int,2:int,3:bool}> [column, line, column of identity, already rejected] */
    private array $identities = [];
    /** @var list<array{0:ForeignKey,1:int,2:int,3:bool}> [foreign key, line, column of name, child columns known] */
    private array $tableForeignKeys = [];
    /** @var list<array{0:Check,1:int,2:list<array{0:string,1:int}>,3:int}> [check, line, tokens after `(`, end column] */
    private array $tableChecks = [];
    /** @var list<array{0:string,1:list<array{0:string,1:int}>,2:int,3:int}> [kind, argument tokens, line, keyword column] */
    private array $tableSettings = [];
    /** @var array<string, true> */
    private array $settingKeys = [];
    /** A primary key line of the table failed: its primary key columns are unknown. */
    private bool $failedPrimary = false;
    /** @var array<string, true> tables with a failed primary key, unique or index line: some key's columns are unknown */
    private array $failedKeyTables = [];
    private ?Diagram $diagram = null;
    /** @var array<string, true> */
    private array $diagramTables = [];

    /** @var list<array> foreign keys whose target is checked after the last line */
    private array $deferredForeignKeys = [];
    /** @var list<array> audit settings whose history table is checked after the last line */
    private array $deferredAudits = [];

    /**
     * @param array<string, string> $documents the declared document set
     * @param list<string> $using the documents whose `use` lines lead to this one, to find cycles
     * @param \ArrayObject<string, array{0: ?Document, 1: ?string}> $used used document => [document, reason it is unusable]
     */
    public function __construct(
        private readonly array $documents,
        private readonly array $using = [],
        private ?\ArrayObject $used = null,
    ) {
        $this->used ??= new \ArrayObject();
    }

    /** @return array{0: ?Document, 1: list<Diagnostic>} */
    public function run(string $source): array
    {
        $stop = null;
        try {
            $this->read($source);
        } catch (ParseStop) {
            $stop = array_pop($this->diagnostics);
        }
        if ($this->diagnostics === [] && $stop === null) {
            return [$this->document, []];
        }
        $rank = array_flip(self::RULES);
        $order = array_keys($this->diagnostics);
        usort($order, fn(int $a, int $b): int => [$this->diagnostics[$a][1], $this->diagnostics[$a][2], $rank[$this->diagnostics[$a][0]], $a] <=> [$this->diagnostics[$b][1], $this->diagnostics[$b][2], $rank[$this->diagnostics[$b][0]], $b]);
        $diagnostics = array_map(fn(int $i): Diagnostic => new Diagnostic(...$this->diagnostics[$i]), $order);
        if ($stop !== null) {
            $diagnostics[] = new Diagnostic(...$stop);
        }
        return [null, $diagnostics];
    }

    private function read(string $source): void
    {
        if (strlen($source) > self::MAX_BYTES) {
            $this->stop('limit', 1, 1, 'the document is larger than 32 MiB');
        }
        $this->checkEncoding($source);
        $lines = explode("\n", $source);
        if (end($lines) === '') {
            array_pop($lines);
        }
        if ($lines === []) {
            $this->stop('header', 1, 1, 'the first line is not `dbspec 1 <document>`');
        }
        foreach ($lines as $index => $text) {
            if ($text !== '' && $text[-1] === "\r") {
                $text = substr($text, 0, -1);
            }
            $this->line = $index + 1;
            $this->text = $text;
            if ($index === 0) {
                $this->tokenize();
                $this->header();
                continue;
            }
            $trimmed = ltrim($text, ' ');
            if ($trimmed === '') {
                continue;
            }
            if ($trimmed[0] === '#') {
                $this->comments[] = $trimmed;
                continue;
            }
            $this->tokenize();
            if ($this->tabLine()) {
                continue;
            }
            match ($this->state) {
                'top' => $this->topLine(),
                'table' => $this->tableLine(),
                'settings' => $this->settingsLine(),
                'diagram' => $this->diagramLine(),
            };
        }
        if ($this->state === 'settings') {
            $this->error('syntax', $this->settingsOpen[0], $this->settingsOpen[1], 'the settings block is not closed');
            $this->state = 'table';
        }
        if ($this->state === 'table') {
            $this->error('syntax', $this->blockOpen[0], $this->blockOpen[1], 'the table block is not closed');
            $this->closeTable();
        } elseif ($this->state === 'diagram') {
            $this->error('syntax', $this->blockOpen[0], $this->blockOpen[1], 'the diagram block is not closed');
        }
        $this->document->trailingComments = $this->takeComments();
        $this->checkForeignKeyTargets();
        $this->checkAuditHistories();
    }

    private function checkEncoding(string $source): void
    {
        $bad = null;
        if (str_starts_with($source, "\xEF\xBB\xBF")) {
            $this->stop('encoding', 1, 1, 'the document starts with a byte order mark');
        }
        if (!preg_match('//u', $source)) {
            preg_match(self::VALID_UTF8, $source, $m);
            $bad = [strlen($m[0]), 'the document is not valid UTF-8'];
        }
        if (preg_match('/\r(?!\n)/', $source, $m, PREG_OFFSET_CAPTURE) && ($bad === null || $m[0][1] < $bad[0])) {
            $bad = [$m[0][1], 'the document has a carriage return without a line feed'];
        }
        if ($bad !== null) {
            [$offset, $message] = $bad;
            $before = substr($source, 0, $offset);
            $newline = strrpos($before, "\n");
            $start = $newline === false ? 0 : $newline + 1;
            $this->stop('encoding', substr_count($source, "\n", 0, $offset) + 1, mb_strlen(substr($source, $start, $offset - $start), 'UTF-8') + 1, $message);
        }
    }

    // ---------------------------------------------------------------- lines

    private function tokenize(): void
    {
        preg_match_all(self::TOKEN, $this->text, $m, PREG_OFFSET_CAPTURE);
        $ascii = !preg_match('/[\x80-\xFF]/', $this->text);
        $tokens = [];
        foreach ($m[0] as [$token, $offset]) {
            $tokens[] = [$token, $ascii ? $offset + 1 : mb_strlen(substr($this->text, 0, $offset), 'UTF-8') + 1];
        }
        $this->tokens = $tokens;
    }

    /**
     * A tab is not a separator: the line is a `syntax` error and is not read
     * further. A column it would declare is known as failed, so references to
     * it report nothing more.
     */
    private function tabLine(): bool
    {
        foreach ($this->tokens as $i => [$token, $column]) {
            if ($token !== "\t") {
                continue;
            }
            $this->error('syntax', $this->line, $column, 'only the space character separates tokens');
            $words = array_values(array_filter($this->tokens, static fn(array $t): bool => $t[0] !== "\t"));
            $first = $words[0][0] ?? '';
            if ($this->state === 'table' && self::isWord($first)) {
                match ($first) {
                    'primary' => $this->failKey(true),
                    'unique', 'index' => $this->failKey(false),
                    'foreign', 'check', 'settings' => null,
                    default => $this->failColumn($first),
                };
            }
            return true;
        }
        return false;
    }

    /** Knows a column whose line failed, so that references to it report nothing more. */
    private function failColumn(string $name): void
    {
        if (!isset($this->columns[$name])) {
            $this->columns[$name] = new Column($name, new ColumnType('invalid'), false, false, null);
            $this->invalidTypes[$name] = true;
        }
    }

    /**
     * The header error points at the first character that departs from
     * `dbspec 1 <name>`, or one past the line end when a part is missing.
     * Everything before it is ASCII, so its byte offset is its column.
     */
    private function header(): void
    {
        $prefix = 'dbspec 1 ';
        $same = strspn($this->text ^ $prefix, "\0");
        if ($same < strlen($prefix)) {
            $this->stop('header', 1, min($same, strlen($this->text)) + 1, 'the first line is exactly `dbspec 1 <document>`');
        }
        $end = strlen($prefix) + strspn($this->text, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_', strlen($prefix));
        if ($end === strlen($prefix) || $end < strlen($this->text)) {
            $this->stop('header', 1, $end + 1, 'the first line is exactly `dbspec 1 <document>`');
        }
        $t = $this->tokens;
        $this->name($t[2]);
        $this->document = new Document($t[2][0]);
    }

    private function topLine(): void
    {
        $first = $this->tokens[0];
        switch ($first[0]) {
            case 'use':
                if ($this->topPhase > 0) {
                    $this->error('order', $this->line, $first[1], '`use` lines come before tables and diagrams');
                }
                $this->useLine();
                return;
            case 'table':
                if ($this->topPhase > 1) {
                    $this->error('order', $this->line, $first[1], 'tables come before diagrams');
                }
                $this->topPhase = max($this->topPhase, 1);
                $this->openTable();
                return;
            case 'diagram':
                $this->topPhase = 2;
                $this->openDiagram();
                return;
        }
        $this->error('syntax', $this->line, $first[1], "expected `use`, `table` or `diagram`, found `{$first[0]}`");
    }

    private function useLine(): void
    {
        $t = $this->tokens;
        $document = $this->wordAt(1);
        if ($document === null) {
            return;
        }
        if (!$this->expectAt(2, '{')) {
            return;
        }
        $tables = [];
        $i = 3;
        while (true) {
            $table = $this->wordAt($i);
            if ($table === null) {
                return;
            }
            $tables[] = $table;
            $i++;
            if (($t[$i][0] ?? null) === ',') {
                $i++;
                continue;
            }
            if (!$this->expectAt($i, '}')) {
                return;
            }
            break;
        }
        if (!$this->endAt($i + 1)) {
            return;
        }
        $name = $document[0];
        $this->document->uses[] = new UseLine($name, array_map(static fn(array $table): string => $table[0], $tables), $this->takeComments());
        $failed = function () use ($tables): void {
            foreach ($tables as [$table]) {
                $this->failedTables[$table] = true;
            }
        };
        if (!$this->name($document)) {
            $failed();
            return;
        }
        if (isset($this->usedDocuments[$name])) {
            $this->error('name.duplicate', $this->line, $document[1], "document `$name` is already used");
            $failed();
            return;
        }
        $this->usedDocuments[$name] = true;
        $used = null;
        $reason = null;
        if ($name === $this->document->name) {
            $reason = 'a document cannot use itself';
        } elseif (in_array($name, $this->using, true)) {
            $reason = 'use cycle: ' . implode(' -> ', [...$this->using, $this->document->name, $name]);
        } elseif (!array_key_exists($name, $this->documents)) {
            $reason = "document `$name` is not in the declared document set";
        } else {
            [$used, $reason] = $this->usedDocument($name);
        }
        if ($reason !== null) {
            $this->error('use', $this->line, $document[1], $reason);
            $failed();
            return;
        }
        $repeated = null;
        foreach ($used->tables as $definition) {
            $this->usedTableNames[$definition->name] = true;
            foreach ([$definition->uniqueKeys, $definition->indexes, $definition->foreignKeys, $definition->checks] as $constraints) {
                foreach ($constraints as $constraint) {
                    if (isset($this->constraintNames[$constraint->name])) {
                        $repeated ??= $constraint->name;
                    }
                    $this->constraintNames[$constraint->name] = true;
                }
            }
        }
        if ($repeated !== null) {
            $this->error('name.duplicate', $this->line, $document[1], "document `$name` repeats the constraint name `$repeated` of an earlier used document");
        }
        foreach ($tables as [$table, $column]) {
            if (!$this->name([$table, $column])) {
                $this->failedTables[$table] = true;
                continue;
            }
            if (isset($this->tables[$table])) {
                $this->error('name.duplicate', $this->line, $column, "table `$table` is already defined or used");
                continue;
            }
            $definition = null;
            foreach ($used->tables as $candidate) {
                if ($candidate->name === $table) {
                    $definition = $candidate;
                    break;
                }
            }
            if ($definition === null) {
                $this->error('use', $this->line, $column, "document `$name` does not define table `$table`");
                $this->failedTables[$table] = true;
                continue;
            }
            $this->tables[$table] = ['table' => $definition, 'columns' => self::columnMap($definition)];
        }
    }

    /**
     * Parses and validates a used document of the declared set once, with its own `use` lines.
     *
     * @return array{0: ?Document, 1: ?string} the document, or null and the reason it is unusable
     */
    private function usedDocument(string $name): array
    {
        if (isset($this->used[$name])) {
            return $this->used[$name];
        }
        [$document, $diagnostics] = (new self($this->documents, [...$this->using, $this->document->name], $this->used))->run($this->documents[$name]);
        if ($document === null) {
            $first = $diagnostics[0];
            $result = [null, "used document `$name` is invalid: {$first->line}:{$first->column} {$first->rule} {$first->message}"];
        } elseif ($document->name !== $name) {
            $result = [null, "the declared document `$name` is named `{$document->name}` in its header"];
        } else {
            $result = [$document, null];
        }
        return $this->used[$name] = $result;
    }

    private function openTable(): void
    {
        $t = $this->tokens;
        if (++$this->tableCount > self::MAX_TABLES) {
            $this->stop('limit', $this->line, $t[0][1], 'the document has more than ' . self::MAX_TABLES . ' tables');
        }
        $name = $t[1] ?? null;
        if ($name === null || !self::isWord($name[0])) {
            $this->error('syntax', $this->line, $name[1] ?? $this->endColumn(), 'expected a table name');
            $name = ['', $t[0][1]];
        } else {
            $this->name($name);
        }
        if ($this->expectAt(2, '{')) {
            $this->endAt(3);
        }
        $table = new Table($name[0], $this->takeComments());
        $this->document->tables[] = $table;
        if ($name[0] !== '') {
            if (isset($this->tables[$name[0]])) {
                $this->error('name.duplicate', $this->line, $name[1], "table `{$name[0]}` is already defined or used");
            } else {
                if (isset($this->constraintNames[$name[0]])) {
                    $this->error('name.duplicate', $this->line, $name[1], "table `{$name[0]}` is named like an index, key, foreign key or check");
                }
                $this->tables[$name[0]] = ['table' => $table, 'columns' => []];
            }
        }
        $this->state = 'table';
        $this->blockOpen = [$this->line, $t[2][1] ?? $t[0][1]];
        $this->table = $table;
        $this->tableName = [$this->line, $name[1]];
        $this->tablePhase = 0;
        $this->columns = [];
        $this->invalidTypes = [];
        $this->identities = [];
        $this->tableForeignKeys = [];
        $this->tableChecks = [];
        $this->tableSettings = [];
        $this->settingKeys = [];
        $this->failedPrimary = false;
    }

    private function tableLine(): void
    {
        $first = $this->tokens[0];
        switch ($first[0]) {
            case '}':
                $this->endAt(1);
                $this->table->closingComments = $this->takeComments();
                $this->closeTable();
                $this->state = 'top';
                return;
            case 'primary':
            case 'unique':
            case 'index':
            case 'foreign':
            case 'check':
                if ($this->tablePhase === 2) {
                    $this->error('order', $this->line, $first[1], 'key, index, foreign key and check lines come before the settings block');
                } else {
                    $this->tablePhase = 1;
                }
                match ($first[0]) {
                    'primary' => $this->primaryKeyLine(),
                    'unique', 'index' => $this->keyLine($first[0] === 'index'),
                    'foreign' => $this->foreignKeyLine(),
                    'check' => $this->checkLine(),
                };
                return;
            case 'settings':
                if ($this->tablePhase === 2) {
                    $this->error('order', $this->line, $first[1], 'a table has at most one settings block, after its other lines');
                }
                $this->tablePhase = 2;
                if ($this->expectAt(1, '{')) {
                    $this->endAt(2);
                }
                $settings = new Settings($this->takeComments());
                $this->table->settings ??= $settings;
                $this->settingsOpen = [$this->line, $this->tokens[1][1] ?? $first[1]];
                $this->state = 'settings';
                return;
        }
        if ($this->tablePhase > 0) {
            $this->error('order', $this->line, $first[1], 'column lines come before key, index, foreign key, check and settings lines');
        }
        $this->columnLine();
    }

    private function columnLine(): void
    {
        $t = $this->tokens;
        if (count($this->table->columns) + 1 > self::MAX_TABLE_COLUMNS) {
            $this->stop('limit', $this->line, $t[0][1], 'a table has more than ' . self::MAX_TABLE_COLUMNS . ' columns');
        }
        if (++$this->columnCount > self::MAX_COLUMNS) {
            $this->stop('limit', $this->line, $t[0][1], 'the document has more than ' . self::MAX_COLUMNS . ' columns');
        }
        $name = $this->wordAt(0);
        if ($name === null) {
            return;
        }
        $this->name($name);
        if (!isset($t[1])) {
            $this->error('syntax', $this->line, $this->endColumn(), 'expected a column type');
            $this->failColumn($name[0]);
            return;
        }
        [$type, $i] = $this->type(1);
        $nullable = false;
        $identity = null;
        $default = null;
        if (($t[$i][0] ?? null) === 'null') {
            $nullable = true;
            $i++;
        }
        if (($t[$i][0] ?? null) === 'identity') {
            $identity = $t[$i];
            $i++;
        }
        if (($t[$i][0] ?? null) === 'default') {
            $keyword = $t[$i];
            $value = $t[$i + 1] ?? null;
            if ($value === null) {
                $this->error('syntax', $this->line, $this->endColumn(), 'expected a default value');
                $i++;
            } elseif ($value[0] === '-' && isset($t[$i + 2]) && $t[$i + 2][1] === $value[1] + 1) {
                $default = [$keyword, ['-' . $t[$i + 2][0], $value[1]]];
                $i += 3;
            } else {
                $default = [$keyword, $value];
                $i += 2;
            }
        }
        if (isset($t[$i])) {
            $this->error('syntax', $this->line, $t[$i][1], "unexpected `{$t[$i][0]}` in a column line");
        }
        $rejected = false;
        if ($identity !== null) {
            if ($nullable) {
                $this->error('column', $this->line, $identity[1], 'an identity column cannot be null');
                $rejected = true;
            } elseif ($type !== null && $type->name !== 'i64') {
                $this->error('column', $this->line, $identity[1], 'an identity column has the type i64');
                $rejected = true;
            }
            if (!$rejected && $this->identities !== []) {
                $this->error('column', $this->line, $identity[1], 'a table has at most one identity column');
                $rejected = true;
            }
            $this->identities[] = [$name[0], $this->line, $identity[1], $rejected];
        }
        $canonical = null;
        if ($default !== null) {
            [$keyword, $value] = $default;
            if ($identity !== null) {
                $this->error('column', $this->line, $keyword[1], 'an identity column has no default');
            } elseif ($type !== null) {
                [$canonical, $problem] = Literal::columnDefault($type, $value[0]);
                if ($problem !== null) {
                    $this->error('column', $this->line, $type->name === 'text' || $type->name === 'bytes' ? $keyword[1] : $value[1], $problem);
                }
            }
        }
        $column = new Column($name[0], $type ?? new ColumnType('invalid'), $nullable, $identity !== null, $canonical, $this->takeComments());
        if (isset($this->columns[$name[0]])) {
            $this->error('name.duplicate', $this->line, $name[1], "column `{$name[0]}` is already defined");
        } else {
            $this->columns[$name[0]] = $column;
            if ($type === null) {
                $this->invalidTypes[$name[0]] = true;
            }
        }
        $this->table->columns[] = $column;
    }

    /**
     * Reads the type at token $i.
     *
     * @return array{0: ?ColumnType, 1: int} the type or null when it is invalid, and the next token
     */
    private function type(int $i): array
    {
        $t = $this->tokens;
        [$name, $column] = $t[$i];
        $parenthesis = ($t[$i + 1][0] ?? null) === '(';
        if (in_array($name, ColumnType::SIMPLE, true) && !$parenthesis) {
            return [$this->types[$name] ??= new ColumnType($name), $i + 1];
        }
        if (!isset(ColumnType::PARAMETERIZED[$name]) || !$parenthesis) {
            $this->error('type', $this->line, $column, match (true) {
                in_array($name, ColumnType::SIMPLE, true) => "type `$name` has no parameters",
                isset(ColumnType::PARAMETERIZED[$name]) => "type `$name` needs its parameters",
                default => "unknown type `$name`",
            });
            return [null, $parenthesis ? $this->skipParentheses($i + 1) : $i + 1];
        }
        $parameters = [];
        $j = $i + 2;
        $wellFormed = false;
        while (isset($t[$j]) && ctype_digit($t[$j][0])) {
            $parameters[] = strlen(ltrim($t[$j][0], '0')) > 6 ? PHP_INT_MAX : (int) $t[$j][0];
            $j++;
            if (($t[$j][0] ?? null) === ',') {
                $j++;
                continue;
            }
            $wellFormed = ($t[$j][0] ?? null) === ')';
            break;
        }
        if (!$wellFormed) {
            $this->error('type', $this->line, $column, "type `$name` has malformed parameters");
            return [null, $this->skipParentheses($i + 1)];
        }
        $j++;
        $valid = count($parameters) === ColumnType::PARAMETERIZED[$name] && match ($name) {
            'decimal' => $parameters[0] >= 1 && $parameters[0] <= 18 && $parameters[1] <= $parameters[0],
            'varchar' => $parameters[0] >= 1 && $parameters[0] <= 16383,
            'time', 'datetime' => $parameters[0] <= 6,
        };
        if (!$valid) {
            $this->error('type', $this->line, $column, match ($name) {
                'decimal' => 'decimal(p,s) needs 1 <= p <= 18 and 0 <= s <= p',
                'varchar' => 'varchar(n) needs 1 <= n <= 16383',
                default => "$name(p) needs 0 <= p <= 6",
            });
            return [null, $j];
        }
        $text = $name . '(' . implode(',', $parameters) . ')';
        return [$this->types[$text] ??= new ColumnType($name, $parameters), $j];
    }

    private function skipParentheses(int $i): int
    {
        $count = count($this->tokens);
        while ($i < $count && $this->tokens[$i][0] !== ')') {
            $i++;
        }
        return min($i + 1, $count);
    }

    private function primaryKeyLine(): void
    {
        $first = $this->tokens[0];
        if (!$this->expectAt(1, 'key')) {
            $this->failKey(true);
            return;
        }
        $list = $this->columnList(2, false);
        if ($list === null || !$this->endAt($list[1])) {
            $this->failKey(true);
            return;
        }
        if ($this->table->primaryKey !== null) {
            $this->error('key', $this->line, $first[1], 'a table has exactly one primary key');
            return;
        }
        $this->table->primaryKey = new PrimaryKey(array_map(static fn(array $c): string => $c[0], $list[0]), $this->takeComments());
        $this->checkKeyColumns($list[0], $first[1], true, 'primary key');
    }

    private function keyLine(bool $index): void
    {
        $name = $this->wordAt(1);
        if ($name === null) {
            $this->failKey(false);
            return;
        }
        $list = $this->columnList(2, $index);
        if ($list === null || !$this->endAt($list[1])) {
            $this->failKey(false);
            return;
        }
        $this->constraintName($name);
        $columns = array_map(static fn(array $c): string => $c[0], $list[0]);
        if ($index) {
            $this->table->indexes[] = new Index($name[0], array_map(static fn(array $c): IndexColumn => new IndexColumn($c[0], $c[2]), $list[0]), $this->takeComments());
        } else {
            $this->table->uniqueKeys[] = new UniqueKey($name[0], $columns, $this->takeComments());
        }
        $this->checkKeyColumns($list[0], $name[1], false, ($index ? 'index' : 'unique key') . " `{$name[0]}`");
    }

    /** Knows a key or index line that failed, so that rules depending on its columns report nothing. */
    private function failKey(bool $primary): void
    {
        $this->failedPrimary = $this->failedPrimary || $primary;
        $this->failedKeyTables[$this->table->name] = true;
    }

    /** @param list<array{0:string,1:int,2:bool}> $columns */
    private function checkKeyColumns(array $columns, int $at, bool $primary, string $what): void
    {
        $seen = [];
        $varchar = 0;
        foreach ($columns as [$name, $position]) {
            if (!$this->name([$name, $position])) {
                continue;
            }
            if (!isset($this->columns[$name])) {
                $this->error('key', $this->line, $position, "$what lists unknown column `$name`");
                continue;
            }
            if (isset($seen[$name])) {
                $this->error('key', $this->line, $position, "$what repeats column `$name`");
                continue;
            }
            $seen[$name] = true;
            $column = $this->columns[$name];
            if ($primary && $column->nullable) {
                $this->error('key', $this->line, $position, "primary key column `$name` is null");
            }
            if (isset($this->invalidTypes[$name])) {
                continue;
            }
            $type = $column->type;
            if ($type->name === 'text' || $type->name === 'bytes') {
                $this->error('key', $this->line, $position, "$what cannot hold the {$type->name} column `$name`");
            } elseif ($type->name === 'varchar') {
                $varchar += $type->parameters[0];
            }
        }
        if (count($columns) > self::MAX_KEY_COLUMNS) {
            $this->error('key', $this->line, $at, "$what lists more than " . self::MAX_KEY_COLUMNS . ' columns');
        }
        if ($varchar > self::MAX_KEY_VARCHAR) {
            $this->error('key', $this->line, $at, "$what totals $varchar varchar characters, more than " . self::MAX_KEY_VARCHAR);
        }
    }

    private function foreignKeyLine(): void
    {
        $t = $this->tokens;
        if (++$this->foreignKeyCount > self::MAX_FOREIGN_KEYS) {
            $this->stop('limit', $this->line, $t[0][1], 'the document has more than ' . self::MAX_FOREIGN_KEYS . ' foreign keys');
        }
        if (!$this->expectAt(1, 'key')) {
            return;
        }
        $name = $this->wordAt(2);
        if ($name === null) {
            return;
        }
        $children = $this->columnList(3, false);
        if ($children === null || !$this->expectAt($children[1], 'references')) {
            return;
        }
        $target = $this->wordAt($children[1] + 1);
        if ($target === null) {
            return;
        }
        $parents = $this->columnList($children[1] + 2, false);
        if ($parents === null) {
            return;
        }
        $i = $parents[1];
        $actions = ['delete' => 'restrict', 'update' => 'restrict'];
        foreach (['delete', 'update'] as $event) {
            if (($t[$i][0] ?? null) === 'on' && ($t[$i + 1][0] ?? null) === $event) {
                $action = $t[$i + 2] ?? null;
                if ($action === null || !in_array($action[0], ForeignKey::ACTIONS, true)) {
                    $this->error('syntax', $this->line, $action[1] ?? $this->endColumn(), 'expected `restrict`, `cascade` or `set_null`');
                    return;
                }
                $actions[$event] = $action[0];
                $i += 3;
            }
        }
        if (!$this->endAt($i)) {
            return;
        }
        $resolvable = $this->name($target);
        $this->constraintName($name);
        $foreignKey = new ForeignKey(
            $name[0],
            array_map(static fn(array $c): string => $c[0], $children[0]),
            $target[0],
            array_map(static fn(array $c): string => $c[0], $parents[0]),
            $actions['delete'],
            $actions['update'],
            $this->takeComments(),
        );
        $this->table->foreignKeys[] = $foreignKey;
        $known = true;
        $seen = [];
        foreach ($children[0] as [$column, $position]) {
            if (!$this->name([$column, $position])) {
                $known = false;
            } elseif (!isset($this->columns[$column])) {
                $this->error('foreign_key', $this->line, $position, "foreign key `{$name[0]}` lists unknown column `$column`");
                $known = false;
            } elseif (isset($seen[$column])) {
                $this->error('foreign_key', $this->line, $position, "foreign key `{$name[0]}` repeats column `$column`");
                $known = false;
            } elseif (isset($this->invalidTypes[$column])) {
                $known = false;
            }
            $seen[$column] = true;
        }
        $this->tableForeignKeys[] = [$foreignKey, $this->line, $name[1], $known];
        foreach ($parents[0] as [$column, $position]) {
            if (!$this->name([$column, $position])) {
                $resolvable = false;
            }
        }
        if ($resolvable) {
            $this->deferredForeignKeys[] = [$this->columns, $foreignKey, $this->line, $name[1], $target[1], $parents[0], $known];
        }
    }

    private function checkLine(): void
    {
        $name = $this->wordAt(1);
        if ($name === null || !$this->expectAt(2, '(')) {
            return;
        }
        $this->constraintName($name);
        $check = new Check($name[0], '', $this->takeComments());
        $this->table->checks[] = $check;
        $this->tableChecks[] = [$check, $this->line, array_slice($this->tokens, 3), $this->endColumn()];
    }

    private function settingsLine(): void
    {
        $t = $this->tokens;
        [$keyword, $at] = $t[0];
        if ($keyword === '}') {
            $this->endAt(1);
            $this->table->settings->closingComments = $this->takeComments();
            $this->state = 'table';
            return;
        }
        $arity = match ($keyword) {
            'entity', 'updated', 'soft_delete', 'aes_version' => [1, 1],
            'select' => [2, PHP_INT_MAX],
            'codec' => [2, PHP_INT_MAX],
            'blind_index' => [2, 2],
            'navigation' => [3, 3],
            'immutable' => [0, 0],
            'audit' => [8, 8],
            default => null,
        };
        if ($arity === null) {
            $this->error('setting', $this->line, $at, "unknown setting `$keyword`");
            return;
        }
        $arguments = array_slice($t, 1);
        foreach ($arguments as $i => $argument) {
            if (!self::isWord($argument[0])) {
                $this->error('syntax', $this->line, $argument[1], "unexpected `{$argument[0]}` in a setting");
                return;
            }
            if ($i >= $arity[1]) {
                $this->error('syntax', $this->line, $argument[1], "setting `$keyword` ends before `{$argument[0]}`");
                return;
            }
        }
        if (count($arguments) < $arity[0]) {
            $this->error('syntax', $this->line, $this->endColumn(), "setting `$keyword` needs more arguments");
            return;
        }
        $kind = $keyword;
        if ($keyword === 'select') {
            if ($arguments[0][0] !== 'explicit') {
                $this->error('syntax', $this->line, $arguments[0][1], 'expected `select explicit`');
                return;
            }
            $kind = 'select_explicit';
            $arguments = array_slice($arguments, 1);
        } elseif ($keyword === 'audit') {
            foreach (['into', 'operation', 'action', 'previous'] as $n => $word) {
                if ($arguments[2 * $n][0] !== $word) {
                    $this->error('syntax', $this->line, $arguments[2 * $n][1], "expected `$word`");
                    return;
                }
            }
            $arguments = [$arguments[1], $arguments[3], $arguments[5], $arguments[7]];
        }
        $perName = $kind === 'codec' || $kind === 'navigation' || $kind === 'blind_index';
        $key = $perName ? $kind . ' ' . $arguments[0][0] : $kind;
        if (isset($this->settingKeys[$key])) {
            $this->error('setting', $this->line, $at, $perName ? "setting `$kind` repeats for `{$arguments[0][0]}`" : "setting `$keyword` repeats");
            return;
        }
        $this->settingKeys[$key] = true;
        // Every argument is a name, except the stages of a codec.
        foreach ($kind === 'codec' ? [$arguments[0]] : $arguments as $argument) {
            $this->name($argument);
        }
        $this->table->settings->settings[] = new Setting($kind, array_map(static fn(array $a): string => $a[0], $arguments), $this->takeComments());
        $this->tableSettings[] = [$kind, $arguments, $this->line, $at];
    }

    private function openDiagram(): void
    {
        $t = $this->tokens;
        $name = $this->wordAt(1);
        $this->state = 'diagram';
        $this->blockOpen = [$this->line, $t[2][1] ?? $t[0][1]];
        $this->diagramTables = [];
        $this->diagram = new Diagram($name[0] ?? '', $this->takeComments());
        $this->document->diagrams[] = $this->diagram;
        if ($name === null) {
            return;
        }
        $this->name($name);
        if ($this->expectAt(2, '{')) {
            $this->endAt(3);
        }
        if (isset($this->diagramNames[$name[0]])) {
            $this->error('name.duplicate', $this->line, $name[1], "diagram `{$name[0]}` is already defined");
        }
        $this->diagramNames[$name[0]] = true;
    }

    private function diagramLine(): void
    {
        $t = $this->tokens;
        if ($t[0][0] === '}') {
            $this->endAt(1);
            $this->diagram->closingComments = $this->takeComments();
            $this->state = 'top';
            return;
        }
        $table = $this->wordAt(0);
        if ($table === null || !$this->expectAt(1, 'at')) {
            return;
        }
        $coordinates = [];
        $i = 2;
        for ($n = 0; $n < 2; $n++) {
            $token = $t[$i] ?? null;
            if ($token === null) {
                $this->error('syntax', $this->line, $this->endColumn(), 'expected a coordinate');
                return;
            }
            $text = $token[0];
            $i++;
            if ($text === '-' && isset($t[$i]) && $t[$i][1] === $token[1] + 1) {
                $text .= $t[$i][0];
                $i++;
            }
            $coordinates[] = [$text, $token[1]];
        }
        if (!$this->endAt($i)) {
            return;
        }
        $valid = $this->name($table);
        if (!$valid || (!isset($this->tables[$table[0]]) && isset($this->failedTables[$table[0]]))) {
            $valid = false;
        } elseif (!isset($this->tables[$table[0]])) {
            $this->error('diagram', $this->line, $table[1], "diagram names unknown table `{$table[0]}`");
            $valid = false;
        } elseif (isset($this->diagramTables[$table[0]])) {
            $this->error('diagram', $this->line, $table[1], "diagram places table `{$table[0]}` twice");
            $valid = false;
        }
        $this->diagramTables[$table[0]] = true;
        $values = [];
        foreach ($coordinates as [$text, $column]) {
            $integer = Literal::integer($text);
            $digits = ltrim((string) $integer, '-');
            if ($integer === null || strlen($digits) > 10 || (strlen($digits) === 10 && strcmp($digits, $integer[0] === '-' ? '2147483648' : '2147483647') > 0)) {
                $this->error('diagram', $this->line, $column, "coordinate `$text` is not an integer from -2147483648 to 2147483647");
                $valid = false;
                continue;
            }
            $values[] = (int) $integer;
        }
        if ($valid) {
            $this->diagram->placements[] = new Placement($table[0], $values[0], $values[1], $this->takeComments());
        }
    }

    // ------------------------------------------------------- table checks

    private function closeTable(): void
    {
        $table = $this->table;
        $primary = $table->primaryKey;
        if ($this->columns === []) {
            $this->error('column', $this->tableName[0], $this->tableName[1], "table `{$table->name}` has no column");
        }
        if ($primary === null && !$this->failedPrimary) {
            $this->error('key', $this->tableName[0], $this->tableName[1], "table `{$table->name}` has no primary key");
        }
        foreach ($this->identities as [$name, $line, $column, $rejected]) {
            if (!$rejected && !$this->failedPrimary && ($primary === null || $primary->columns !== [$name])) {
                $this->error('column', $line, $column, "identity column `$name` must be the only primary key column");
            }
        }
        $leading = $primary === null ? [] : [$primary->columns];
        foreach ($table->uniqueKeys as $unique) {
            $leading[] = $unique->columns;
        }
        foreach ($table->indexes as $index) {
            $leading[] = array_map(static fn(IndexColumn $c): string => $c->name, $index->columns);
        }
        $actionColumns = [];
        foreach ($this->tableForeignKeys as [$foreignKey, $line, $column, $known]) {
            if ($foreignKey->changesChildRows()) {
                foreach ($foreignKey->columns as $child) {
                    $actionColumns[$child] ??= $foreignKey->name;
                }
            }
            if (!$known) {
                continue;
            }
            $covered = false;
            foreach ($leading as $columns) {
                if (array_slice($columns, 0, count($foreignKey->columns)) === $foreignKey->columns) {
                    $covered = true;
                    break;
                }
            }
            if (!$covered && !isset($this->failedKeyTables[$table->name])) {
                $this->error('foreign_key', $line, $column, "foreign key `{$foreignKey->name}` needs an index or key whose leading columns are its columns");
            }
            if ($foreignKey->onDelete === 'set_null' || $foreignKey->onUpdate === 'set_null') {
                foreach ($foreignKey->columns as $child) {
                    if (!$this->columns[$child]->nullable) {
                        $this->error('foreign_key', $line, $column, "foreign key `{$foreignKey->name}` sets `$child` null but the column is not null");
                        break;
                    }
                }
            }
        }
        foreach ($this->tableChecks as [$check, $line, $tokens, $end]) {
            [$text, $errors] = Expression::parse($tokens, $line, $end, $this->columns, $actionColumns);
            foreach ($errors as $error) {
                $this->error(...$error);
            }
            $check->expression = $text ?? '';
        }
        $this->checkSettings($leading, $actionColumns !== []);
        if (isset($this->tables[$table->name]) && $this->tables[$table->name]['table'] === $table) {
            $this->tables[$table->name]['columns'] = $this->columns;
        }
        $this->table = null;
    }

    /** @param list<list<string>> $leading column lists of the table's keys and indexes */
    private function checkSettings(array $leading, bool $changedByForeignKeys): void
    {
        $kinds = [];
        $aes = [];
        foreach ($this->tableSettings as [$kind, $arguments]) {
            $kinds[$kind] = true;
            if ($kind === 'codec' && in_array('aes', array_map(static fn(array $a): string => $a[0], array_slice($arguments, 1)), true)) {
                $aes[$arguments[0][0]] = true;
            }
        }
        $singleColumnKeys = [];
        foreach ($this->table->uniqueKeys as $unique) {
            if (count($unique->columns) === 1) {
                $singleColumnKeys[$unique->columns[0]] = true;
            }
        }
        foreach ($this->table->indexes as $index) {
            if (count($index->columns) === 1) {
                $singleColumnKeys[$index->columns[0]->name] = true;
            }
        }
        foreach ($this->tableSettings as [$kind, $arguments, $line, $at]) {
            // A column reference: the column, or null after a diagnostic or a failed name or line.
            $column = function (array $token) use ($kind, $line): ?Column {
                if (!self::validName($token[0])) {
                    return null;
                }
                if (!isset($this->columns[$token[0]])) {
                    $this->error('setting', $line, $token[1], "setting `$kind` names unknown column `{$token[0]}`");
                    return null;
                }
                return isset($this->invalidTypes[$token[0]]) ? null : $this->columns[$token[0]];
            };
            switch ($kind) {
                case 'updated':
                case 'soft_delete':
                    $definition = $column($arguments[0]);
                    if ($definition !== null && ($definition->type->name !== 'datetime' || ($kind === 'soft_delete' && !$definition->nullable))) {
                        $this->error('setting', $line, $arguments[0][1], $kind === 'updated' ? 'setting `updated` needs a datetime column' : 'setting `soft_delete` needs a null datetime column');
                    }
                    break;
                case 'select_explicit':
                    $seen = [];
                    foreach ($arguments as $token) {
                        if (isset($seen[$token[0]])) {
                            $this->error('setting', $line, $token[1], "setting `select explicit` repeats `{$token[0]}`");
                            continue;
                        }
                        $seen[$token[0]] = true;
                        $column($token);
                    }
                    break;
                case 'codec':
                    $stages = array_slice($arguments, 1);
                    $known = true;
                    foreach ($stages as $n => $stage) {
                        if (!in_array($stage[0], Setting::CODEC_STAGES, true)) {
                            $this->error('setting', $line, $stage[1], "unknown codec stage `{$stage[0]}`");
                            $known = false;
                        } elseif ($stage[0] === 'ordered_json' && $n > 0) {
                            $this->error('setting', $line, $stage[1], '`ordered_json` is the first codec stage');
                        }
                    }
                    $definition = $column($arguments[0]);
                    if ($definition !== null && $known) {
                        $text = in_array(end($stages)[0], self::TEXT_STAGES, true);
                        $type = $definition->type->name;
                        if ($text ? $type !== 'varchar' && $type !== 'text' : $type !== 'bytes') {
                            $this->error('setting', $line, $arguments[0][1], 'the last codec stage `' . end($stages)[0] . '` needs ' . ($text ? 'a varchar or text' : 'a bytes') . ' column');
                        }
                    }
                    if (isset($aes[$arguments[0][0]]) && !isset($kinds['aes_version'])) {
                        $this->error('setting', $line, $at, 'a codec with `aes` needs the `aes_version` setting');
                    }
                    break;
                case 'aes_version':
                    if ($aes === []) {
                        $this->error('setting', $line, $at, 'setting `aes_version` needs a column with the `aes` codec');
                    }
                    $definition = $column($arguments[0]);
                    if ($definition !== null && (!$definition->type->isInteger() || $definition->nullable)) {
                        $this->error('setting', $line, $arguments[0][1], 'setting `aes_version` needs a non-null integer column');
                    }
                    break;
                case 'blind_index':
                    [$source, $target] = $arguments;
                    $encrypted = $column($source);
                    if (self::validName($source[0]) && isset($this->columns[$source[0]]) && !isset($aes[$source[0]])) {
                        $this->error('setting', $line, $source[1], "setting `blind_index` needs a column with the `aes` codec, not `{$source[0]}`");
                    }
                    $index = $column($target);
                    if ($index !== null) {
                        $type = $index->type;
                        if (!($type->name === 'varchar' && $type->parameters[0] >= 64)
                            || ($encrypted !== null && $encrypted->nullable !== $index->nullable)
                            || isset($aes[$target[0]])
                            || !isset($singleColumnKeys[$target[0]])) {
                            $this->error('setting', $line, $target[1], "blind index column `{$target[0]}` is a varchar(n >= 64) column with the AES column's nullability, not AES-encoded, and the only column of an index or unique key");
                        }
                    }
                    break;
                case 'navigation':
                    if (!self::validName($arguments[0][0])) {
                        break;
                    }
                    $found = false;
                    foreach ($this->table->foreignKeys as $foreignKey) {
                        $found = $found || $foreignKey->name === $arguments[0][0];
                    }
                    if (!$found) {
                        $this->error('setting', $line, $arguments[0][1], "setting `navigation` names unknown foreign key `{$arguments[0][0]}`");
                    }
                    break;
                case 'immutable':
                    if ($changedByForeignKeys) {
                        $this->error('setting', $line, $at, 'setting `immutable` is rejected on a child of a cascade or set_null foreign key');
                    }
                    break;
                case 'audit':
                    if (!isset($kinds['soft_delete'])) {
                        $this->error('setting', $line, $at, 'setting `audit` needs a `soft_delete` setting');
                    }
                    if ($changedByForeignKeys) {
                        $this->error('setting', $line, $at, 'setting `audit` is rejected on a child of a cascade or set_null foreign key');
                    }
                    $operation = $column($arguments[1]);
                    if ($operation !== null && ($operation->nullable || ($operation->type->name !== 'i64' && $operation->type->name !== 'uuid'))) {
                        $this->error('setting', $line, $arguments[1][1], 'the audit operation column is a non-null i64 or uuid column');
                    }
                    if (self::validName($arguments[0][0]) && self::validName($arguments[2][0]) && self::validName($arguments[3][0])) {
                        $this->deferredAudits[] = [$this->table, $this->columns, $arguments, $operation?->type, $line];
                    }
                    break;
            }
        }
    }

    // ------------------------------------------------------- cross-table checks

    private function checkForeignKeyTargets(): void
    {
        foreach ($this->deferredForeignKeys as [$columns, $foreignKey, $line, $at, $targetAt, $parents, $known]) {
            $target = $this->tables[$foreignKey->table] ?? null;
            if ($target === null && isset($this->failedTables[$foreignKey->table])) {
                continue;
            }
            if ($target === null) {
                $this->error('foreign_key', $line, $targetAt, "foreign key `{$foreignKey->name}` references unknown table `{$foreignKey->table}`");
                continue;
            }
            if ($target['table'] === null) {
                continue;
            }
            $targetColumns = $target['columns'];
            foreach ($parents as [$parent, $position]) {
                if (!isset($targetColumns[$parent])) {
                    $this->error('foreign_key', $line, $position, "table `{$foreignKey->table}` has no column `$parent`");
                    $known = false;
                }
            }
            if (!$known) {
                continue;
            }
            if (count($foreignKey->columns) !== count($foreignKey->referencedColumns)) {
                $this->error('foreign_key', $line, $at, "foreign key `{$foreignKey->name}` lists " . count($foreignKey->columns) . ' columns and references ' . count($foreignKey->referencedColumns));
                continue;
            }
            $keys = $target['table']->primaryKey === null ? [] : [$target['table']->primaryKey->columns];
            foreach ($target['table']->uniqueKeys as $unique) {
                $keys[] = $unique->columns;
            }
            if (!in_array($foreignKey->referencedColumns, $keys, true) && !isset($this->failedKeyTables[$foreignKey->table])) {
                $this->error('foreign_key', $line, $at, "foreign key `{$foreignKey->name}` references columns that are not the primary key or a unique key of `{$foreignKey->table}`");
            }
            foreach ($foreignKey->columns as $i => $child) {
                $parentType = $targetColumns[$foreignKey->referencedColumns[$i]]->type;
                if ($parentType->name !== 'invalid' && $columns[$child]->type !== $parentType && $columns[$child]->type->text() !== $parentType->text()) {
                    $this->error('foreign_key', $line, $at, "foreign key `{$foreignKey->name}` column `$child` is {$columns[$child]->type->text()} but `{$foreignKey->referencedColumns[$i]}` is {$parentType->text()}");
                    break;
                }
            }
        }
    }

    private function checkAuditHistories(): void
    {
        foreach ($this->deferredAudits as [$audited, $columns, $arguments, $operationType, $line]) {
            [$historyToken, , $actionToken, $previousToken] = $arguments;
            $entry = $this->tables[$historyToken[0]] ?? null;
            if ($entry === null && isset($this->failedTables[$historyToken[0]])) {
                continue;
            }
            if ($entry === null) {
                $this->error('setting', $line, $historyToken[1], "audit history table `{$historyToken[0]}` is unknown");
                continue;
            }
            if ($entry['table'] === null) {
                continue;
            }
            $history = $entry['table'];
            $historyColumns = $entry['columns'];
            if ($history === $audited) {
                $this->error('setting', $line, $historyToken[1], 'an audited table is not its own history table');
                continue;
            }
            $action = $historyColumns[$actionToken[0]] ?? null;
            if ($action === null || $action->nullable || $action->type->text() !== 'varchar(8)') {
                $this->error('setting', $line, $actionToken[1], "the audit action column `{$actionToken[0]}` is a non-null varchar(8) column of `{$history->name}`");
            }
            $previous = $historyColumns[$previousToken[0]] ?? null;
            if ($previous === null || !$previous->nullable || ($operationType !== null && $previous->type->text() !== $operationType->text())) {
                $this->error('setting', $line, $previousToken[1], "the audit previous column `{$previousToken[0]}` is a null column of `{$history->name}` with the operation column's type");
            }
            $key = $history->primaryKey?->columns ?? [];
            $identity = count($key) === 1 ? ($historyColumns[$key[0]] ?? null) : null;
            $shaped = $identity !== null && $identity->identity && $identity->type->name === 'i64';
            $own = [$key[0] ?? '' => true, $actionToken[0] => true, $previousToken[0] => true];
            if (count($own) !== 3) {
                $shaped = false;
            }
            foreach ($columns as $name => $column) {
                if (isset($own[$name]) || !isset($historyColumns[$name]) || $historyColumns[$name]->type->text() !== $column->type->text()) {
                    $shaped = false;
                }
            }
            foreach ($historyColumns as $name => $column) {
                if (!isset($own[$name]) && !isset($columns[$name])) {
                    $shaped = false;
                }
            }
            foreach ($history->settings?->settings ?? [] as $setting) {
                if ($setting->kind === 'audit') {
                    $shaped = false;
                }
            }
            if (!$shaped) {
                $this->error('setting', $line, $historyToken[1], "history table `{$history->name}` needs an i64 identity primary key, the action and previous columns and exactly the columns of `{$audited->name}` with their types, and no audit setting");
            }
        }
    }

    // ------------------------------------------------------- helpers

    /** @return array<string, Column> */
    private static function columnMap(Table $table): array
    {
        $map = [];
        foreach ($table->columns as $column) {
            $map[$column->name] ??= $column;
        }
        return $map;
    }

    private static function validName(string $name): bool
    {
        return preg_match('/^[a-z][a-z0-9_]*$/D', $name) === 1 && !in_array($name, self::RESERVED, true) && strlen($name) <= 63;
    }

    private static function isWord(string $token): bool
    {
        return preg_match('/^[A-Za-z0-9_]+$/D', $token) === 1;
    }

    /** Checks a name token's format and length; returns whether it is valid. */
    private function name(array $token): bool
    {
        [$name, $column] = $token;
        if (!preg_match('/^[a-z][a-z0-9_]*$/D', $name) || in_array($name, self::RESERVED, true)) {
            $this->error('name.format', $this->line, $column, "name `$name` does not match [a-z][a-z0-9_]* or is a reserved word");
            return false;
        }
        if (strlen($name) > 63) {
            $this->error('name.length', $this->line, $column, "name `$name` is longer than 63 bytes");
            return false;
        }
        return true;
    }

    /** Checks an index, unique key, foreign key or check name and reserves it in the schema. */
    private function constraintName(array $token): void
    {
        if (!$this->name($token)) {
            return;
        }
        if (isset($this->constraintNames[$token[0]])) {
            $this->error('name.duplicate', $this->line, $token[1], "constraint name `{$token[0]}` is already used in the schema");
            return;
        }
        if (isset($this->tables[$token[0]]) || isset($this->usedTableNames[$token[0]])) {
            $this->error('name.duplicate', $this->line, $token[1], "constraint name `{$token[0]}` is the name of a table");
        }
        $this->constraintNames[$token[0]] = true;
    }

    /** @return ?array{0:string,1:int} the word token at $i, or null after a syntax error */
    private function wordAt(int $i): ?array
    {
        $token = $this->tokens[$i] ?? null;
        if ($token === null || !self::isWord($token[0])) {
            $this->error('syntax', $this->line, $token[1] ?? $this->endColumn(), $token === null ? 'expected a name' : "expected a name, found `{$token[0]}`");
            return null;
        }
        return $token;
    }

    private function expectAt(int $i, string $expected): bool
    {
        $token = $this->tokens[$i] ?? null;
        if (($token[0] ?? null) !== $expected) {
            $this->error('syntax', $this->line, $token[1] ?? $this->endColumn(), "expected `$expected`" . ($token === null ? '' : ", found `{$token[0]}`"));
            return false;
        }
        return true;
    }

    private function endAt(int $i): bool
    {
        if (isset($this->tokens[$i])) {
            $this->error('syntax', $this->line, $this->tokens[$i][1], "unexpected `{$this->tokens[$i][0]}`");
            return false;
        }
        return true;
    }

    /**
     * `( <column> [asc|desc], ... )` from token $i.
     *
     * @return ?array{0: list<array{0:string,1:int,2:bool}>, 1: int} [name, column, descending] and the next token
     */
    private function columnList(int $i, bool $directions): ?array
    {
        if (!$this->expectAt($i, '(')) {
            return null;
        }
        $i++;
        $columns = [];
        while (true) {
            $name = $this->wordAt($i);
            if ($name === null) {
                return null;
            }
            $i++;
            $descending = false;
            $next = $this->tokens[$i][0] ?? null;
            if ($directions && ($next === 'asc' || $next === 'desc')) {
                $descending = $next === 'desc';
                $i++;
                $next = $this->tokens[$i][0] ?? null;
            }
            $columns[] = [$name[0], $name[1], $descending];
            if ($next === ',') {
                $i++;
                continue;
            }
            if (!$this->expectAt($i, ')')) {
                return null;
            }
            return [$columns, $i + 1];
        }
    }

    /** @return list<string> */
    private function takeComments(): array
    {
        $comments = $this->comments;
        $this->comments = [];
        return $comments;
    }

    private function endColumn(): int
    {
        return mb_strlen($this->text, 'UTF-8') + 1;
    }

    private function error(string $rule, int $line, int $column, string $message): void
    {
        if ($rule === 'syntax') {
            if (isset($this->syntaxLines[$line])) {
                return;
            }
            $this->syntaxLines[$line] = true;
        }
        $this->diagnostics[] = [$rule, $line, $column, $message];
    }

    private function stop(string $rule, int $line, int $column, string $message): never
    {
        $this->diagnostics[] = [$rule, $line, $column, $message];
        throw new ParseStop();
    }
}
