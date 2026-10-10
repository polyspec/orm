<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

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
    // 단어는 Go의 isWordRune과 같이 `.`을 포함한다(`a.b`는 한 token이고 1.5 같은 수도 한 token이다).
    private const TOKEN = "/[A-Za-z0-9_.]+|'(?:[^']|'')*+'|<=|>=|<>|[^ ]/u";
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
    public const RESERVED = ['dbspec', 'use', 'table', 'diagram', 'primary', 'unique', 'index', 'foreign', 'check', 'settings', 'null', 'identity', 'default', 'true', 'false', 'and', 'or', 'not', 'in', 'between', 'is'];
    /** Codec stages that produce text; the others produce bytes. */
    private const TEXT_STAGES = ['hex', 'base64', 'ordered_json', 'yaml', 'serialize'];
    /** markdown 저장 설정의 keyword다. cursor가 읽는다 (storageLine). */
    private const STORAGE_KEYWORDS = ['markdown', 'store', 'key_prefix', 'title', 'body', 'order', 'checkbox', 'state_machine'];
    /** 표마다 한 번만 쓰는 저장 keyword다. 되풀이하면 keyword 위치에 setting 오류를 낸다. */
    private const ONCE_STORAGE = ['store', 'key_prefix', 'title', 'body', 'order'];

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
    /** @var Settings|null 줄을 읽는 block: 표의 첫 block이거나, 반복된 block이면 유지하지 않는 block */
    private ?Settings $settingsBlock = null;
    /** 반복된 settings block: 줄은 구문만 읽고 검사하지 않는다(Go의 detached block) */
    private bool $detachedBlock = false;
    /** A primary key line of the table failed: its primary key columns are unknown. */
    private bool $failedPrimary = false;
    /** @var array<string, true> tables with a failed unique or index line: some key's columns are unknown */
    private array $failedKeyTables = [];
    /** @var array<string, array{0: int, 1: int}> the line and column of each local constraint name */
    private array $constraintAt = [];
    /** @var array<string, true> names of foreign key and column lines that had a syntax error (Go's failedName) */
    private array $failedNames = [];
    /** @var array<string, true> names of column lines that had a syntax error, so their identity check is unresolved */
    private array $failedColumns = [];
    /** Column lines of the table that had a syntax error (Go's failedLines). */
    private int $failedLines = 0;
    /** Primary key lines of the table that were read (Go keeps every one). */
    private int $primaryKeyLines = 0;
    /** @var array<string, list<string>> per table, the title and body lines that parsed, duplicates included */
    private array $parsedTitleBody = [];
    /** The first lex error of the current line: [column, message], or null. */
    private ?array $lexError = null;
    private ?Diagram $diagram = null;
    /** @var array<string, true> */
    private array $diagramTables = [];

    /** @var list<array> foreign keys whose target is checked after the last line */
    private array $deferredForeignKeys = [];
    /** @var list<array> audit settings whose history table is checked after the last line */
    private array $deferredAudits = [];
    /** @var list<array{0: Table, 1: ?Column, 2: list<array{0: string, 1: int}>, 3: int, 4: bool}> audit setting의 기록 table 검사 */
    private array $deferredAuditRecords = [];
    /** @var array<string, true> primary key 줄이 실패한 table */
    private array $failedPrimaryTables = [];
    /** @var list<array> state_machine history 줄의 history table을 마지막 줄 뒤에 검사한다 */
    private array $deferredHistories = [];
    /** @var array<string, array{0: string, 1: int, 2: int}> column => [default 값, 줄, column], 처음 선언한 column만 */
    private array $defaultValues = [];
    /** @var int 설정 줄을 읽는 커서가 다음에 읽을 token의 위치 */
    private int $cursor = 0;

    /**
     * @param array<string, string> $documents the declared document set
     * @param list<string> $using the documents whose `use` lines lead to this one, to find cycles
     * @param \ArrayObject<string, array{0: ?Document, 1: ?string}|false> $used used document => [document, reason it is unusable], false while it is read
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
            if ($this->lexError !== null) {
                $this->error('syntax', $this->line, $this->lexError[0], $this->lexError[1]);
                // 오류 글자를 뺀 token으로 읽는다(Go의 lexRecover): 맨 위 줄의 table 머리줄도 표를 연다.
                $this->tokens = self::lexRecover($text);
                if ($this->lexedLine()) {
                    continue;
                }
            }
            match ($this->state) {
                'top' => $this->topLine(),
                'table' => $this->tableLine(),
                'settings' => $this->settingsLine(),
                'diagram' => $this->diagramLine(),
            };
        }
        // 가장 안쪽의 열린 block만 보고한다(Go처럼): 열린 settings block은 표의 `{`를 보고하지 않는다.
        if ($this->state === 'settings') {
            $this->unclosed($this->settingsOpen[0], $this->settingsOpen[1], 'the settings block is not closed');
            $this->state = 'table';
            $this->closeTable();
        } elseif ($this->state === 'table') {
            $this->unclosed($this->blockOpen[0], $this->blockOpen[1], 'the table block is not closed');
            $this->closeTable();
        } elseif ($this->state === 'diagram') {
            $this->unclosed($this->blockOpen[0], $this->blockOpen[1], 'the diagram block is not closed');
        }
        $this->document->trailingComments = $this->takeComments();
        $this->checkForeignKeyTargets();
        $this->checkAuditRecords();
        $this->checkAuditHistories();
        $this->checkStateHistories();
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
        [$this->tokens, $this->lexError] = self::lexLine($this->text);
    }

    /**
     * Splits one line into [token, column] pairs as Go's lexLine does: the
     * tokens before the first character that starts no token, and that
     * character's error (or an unclosed string's), or null.
     *
     * @return array{0: list<array{0: string, 1: int}>, 1: ?array{0: int, 1: string}}
     */
    private static function lexLine(string $text): array
    {
        $chars = preg_split('//u', $text, -1, PREG_SPLIT_NO_EMPTY);
        $n = count($chars);
        $tokens = [];
        $i = 0;
        $column = 1;
        while ($i < $n) {
            $c = $chars[$i];
            if ($c === ' ') {
                $i++;
                $column++;
                continue;
            }
            if (in_array($c, ['(', ')', '{', '}', ','], true)) {
                $tokens[] = [$c, $column];
                $i++;
                $column++;
                continue;
            }
            if ($c === '<' || $c === '>') {
                $next = $chars[$i + 1] ?? '';
                $length = $next === '=' || ($c === '<' && $next === '>') ? 2 : 1;
                $tokens[] = [implode('', array_slice($chars, $i, $length)), $column];
                $i += $length;
                $column += $length;
                continue;
            }
            if (in_array($c, ['=', '+', '-', '*', '/'], true)) {
                $tokens[] = [$c, $column];
                $i++;
                $column++;
                continue;
            }
            if ($c === "'") {
                $start = $column;
                $j = $i + 1;
                $closed = false;
                while ($j < $n) {
                    if ($chars[$j] === "'") {
                        if (($chars[$j + 1] ?? '') === "'") {
                            $j += 2;
                            continue;
                        }
                        $j++;
                        $closed = true;
                        break;
                    }
                    $j++;
                }
                if (!$closed) {
                    return [$tokens, [$start, 'string is not closed on its line']];
                }
                $tokens[] = [implode('', array_slice($chars, $i, $j - $i)), $start];
                $column += $j - $i;
                $i = $j;
                continue;
            }
            if (self::wordRune($c)) {
                $j = $i + 1;
                while ($j < $n && self::wordRune($chars[$j])) {
                    $j++;
                }
                $tokens[] = [implode('', array_slice($chars, $i, $j - $i)), $column];
                $column += $j - $i;
                $i = $j;
                continue;
            }
            return [$tokens, [$column, 'character ' . self::goRune($c) . ' is not allowed here']];
        }
        return [$tokens, null];
    }

    /** Go's lexRecover: the line's tokens with each character that starts no token replaced by a space. */
    private static function lexRecover(string $text): array
    {
        $chars = preg_split('//u', $text, -1, PREG_SPLIT_NO_EMPTY);
        for ($attempt = 0; $attempt <= count($chars); $attempt++) {
            [$tokens, $error] = self::lexLine(implode('', $chars));
            if ($error === null) {
                return $tokens;
            }
            $chars[$error[0] - 1] = ' ';
        }
        return [];
    }

    /** Go's isWordRune: `_` or `.`, or a code point of the table of UnicodeWord (a letter or digit of Go's unicode). */
    private static function wordRune(string $c): bool
    {
        return $c === '_' || $c === '.' || UnicodeWord::contains(mb_ord($c, 'UTF-8'));
    }

    /** The character as Go's %q writes a rune. */
    private static function goRune(string $c): string
    {
        return "'" . match ($c) {
            "\t" => '\\t',
            "\n" => '\\n',
            "\r" => '\\r',
            '\\' => '\\\\',
            "'" => "\\'",
            default => $c,
        } . "'";
    }

    /**
     * A line with a lex error (Go's cursor failure): a table, settings or diagram line reads nothing but its
     * state and the names it fails, and a closing brace still closes its block. Returns whether the line is done.
     */
    private function lexedLine(): bool
    {
        $first = $this->tokens[0][0] ?? null;
        if ($first === null || $first === '}') {
            return $first === null;
        }
        return match ($this->state) {
            'top' => false,
            'table' => $this->lexedTableLine(),
            default => true,
        };
    }

    /** A table line with a lex error: `settings` opens the settings block; a key, foreign key or column line fails. */
    private function lexedTableLine(): bool
    {
        $first = $this->tokens[0];
        if ($first[0] === 'settings') {
            $this->tablePhase = 2;
            $this->openSettingsBlock(new Settings($this->takeComments()));
            $this->settingsOpen = [$this->line, $this->tokens[1][1] ?? $first[1]];
            $this->state = 'settings';
            return true;
        }
        match ($first[0]) {
            'primary' => $this->failKey(true),
            'unique', 'index' => $this->failKey(false),
            'foreign' => $this->failForeignKeyName(),
            'check' => null,
            default => $this->failColumnLine($first[0]),
        };
        return true;
    }

    /** Knows a foreign key line that failed: its name is failed, so that references to it report nothing more. */
    private function failForeignKeyName(): void
    {
        $name = $this->tokens[2] ?? null;
        if ($name !== null && self::isWord($name[0])) {
            $this->failedNames[$name[0]] = true;
        }
    }

    /** Knows a column line that had a syntax error (Go's markFailed and failedLines). */
    private function failColumnLine(string $token): void
    {
        $this->failedLines++;
        if (self::isWord($token)) {
            $this->failColumn($token);
            $this->failedColumns[$token] = true;
        }
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
            // 읽는 중인 문서를 다시 쓰면 use cycle이다. 문서의 header 이름이 집합의 이름과 다르면 이름의
            // 사슬로는 찾지 못하므로 읽는 중임을 표시해 둔다.
            return $this->used[$name] === false ? [null, 'use cycle: ' . implode(' -> ', [...$this->using, $this->document->name, $name])] : $this->used[$name];
        }
        $this->used[$name] = false;
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
        // 표 줄이 실패했다(이름이 없거나, `{`가 없거나, `{` 뒤에 말이 더 있다). Go의 failed table이다.
        $headerFailed = false;
        if ($name === null || !self::isWord($name[0])) {
            $this->error('syntax', $this->line, $name[1] ?? $this->endColumn(), 'expected a table name');
            $name = ['', $t[0][1]];
            $headerFailed = true;
        } else {
            $this->name($name);
        }
        if ($this->expectAt(2, '{')) {
            if (!$this->endAt(3)) {
                $headerFailed = true;
            }
        } else {
            $headerFailed = true;
        }
        $table = new Table($name[0], $this->takeComments());
        $this->document->tables[] = $table;
        if ($name[0] !== '') {
            if (isset($this->tables[$name[0]])) {
                // Go는 표 줄이 실패한 표의 이름 중복을 보고하지 않는다(validate.go의 failed table).
                if (!$headerFailed) {
                    $this->error('name.duplicate', $this->line, $name[1], "table `{$name[0]}` is already defined or used");
                }
            } else {
                // Go은 표와 같은 이름의 제약을 제약의 자리에 보고한다(표가 뒤에 와도). 쓰는 문서의 제약은 표의 자리에 보고한다.
                if (isset($this->constraintAt[$name[0]])) {
                    [$constraintLine, $constraintColumn] = $this->constraintAt[$name[0]];
                    $this->error('name.duplicate', $constraintLine, $constraintColumn, "constraint name `{$name[0]}` is the name of a table");
                } elseif (isset($this->constraintNames[$name[0]])) {
                    $this->error('name.duplicate', $this->line, $name[1], "table `{$name[0]}` is named like an index, key, foreign key or check");
                }
                $this->tables[$name[0]] = ['table' => $table, 'columns' => [], 'headerFailed' => $headerFailed];
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
        $this->defaultValues = [];
        $this->failedPrimary = false;
        $this->failedNames = [];
        $this->failedColumns = [];
        $this->failedLines = 0;
        $this->primaryKeyLines = 0;
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
                    'foreign' => $this->foreignKeyLineChecked(),
                    'check' => $this->checkLine(),
                };
                return;
            case 'settings':
                // Go는 반복된 block의 키워드에 order를 줄이 올바른 형식(`settings {`만)일 때만 보고한다.
                $wellFormed = ($this->tokens[1][0] ?? null) === '{' && !isset($this->tokens[2]);
                if ($this->tablePhase === 2 && $wellFormed) {
                    $this->error('order', $this->line, $first[1], 'a table has at most one settings block, after its other lines');
                }
                $this->tablePhase = 2;
                if ($this->expectAt(1, '{')) {
                    $this->endAt(2);
                }
                $this->openSettingsBlock(new Settings($this->takeComments()));
                $this->settingsOpen = [$this->line, $this->tokens[1][1] ?? $first[1]];
                $this->state = 'settings';
                return;
        }
        $mark = count($this->diagnostics);
        $this->columnLine();
        if (isset($this->syntaxLines[$this->line])) {
            $this->keepSyntaxSince($mark);
            $this->failColumnLine($first[0]);
        } elseif ($this->tablePhase > 0) {
            // Go는 column 줄이 구문에 맞을 때만 order를 보고한다(columnLine의 c.done 뒤). 구문 오류가 난 줄은 syntax만 낸다.
            $this->error('order', $this->line, $first[1], 'column lines come before key, index, foreign key, check and settings lines');
        }
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
        $wellFormed = $this->name($name);
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
        // renderer 가 type CHECK 를 쓰는 컬럼은 그 이름 <table>$<column> 이 이름 한도를 지킨다.
        if ($identity === null && $type !== null && $type->name !== 'text' && $type->name !== 'bytes' && $wellFormed) {
            $this->generatedName($this->line, $name[1], $this->table->name . '$' . $name[0]);
        }
        if (isset($this->columns[$name[0]])) {
            $this->error('name.duplicate', $this->line, $name[1], "column `{$name[0]}` is already defined");
        } else {
            $this->columns[$name[0]] = $column;
            if ($type === null) {
                $this->invalidTypes[$name[0]] = true;
            }
            if ($default !== null) {
                $this->defaultValues[$name[0]] = [self::literalValue($default[1][0]), $this->line, $default[1][1]];
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
        $this->primaryKeyLines++;
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
        if ($primary) {
            $this->failedPrimary = true;
            $this->failedPrimaryTables[$this->table->name] = true;
            return;
        }
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

    /** A foreign key line whose syntax failed marks its name failed (Go's markFailed). */
    private function foreignKeyLineChecked(): void
    {
        $this->foreignKeyLine();
        if (isset($this->syntaxLines[$this->line])) {
            $this->failForeignKeyName();
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
        $actionTokens = [];
        foreach (['delete', 'update'] as $event) {
            if (($t[$i][0] ?? null) === 'on' && ($t[$i + 1][0] ?? null) === $event) {
                $action = $t[$i + 2] ?? null;
                if ($action === null || !self::isWord($action[0])) {
                    $this->error('syntax', $this->line, $action[1] ?? $this->endColumn(), 'expected an action');
                    return;
                }
                $actions[$event] = $action[0];
                $actionTokens[$event] = $action;
                $i += 3;
            }
        }
        if (!$this->endAt($i)) {
            return;
        }
        foreach ($actionTokens as $action) {
            if (!in_array($action[0], ForeignKey::ACTIONS, true)) {
                $this->error('foreign_key', $this->line, $action[1], "action `{$action[0]}` is not restrict, cascade or set_null");
            }
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
        // Go의 known이다: 자식 열이 모두 알려지고 겹치지 않을 때만 색인 검사를 한다.
        $childrenKnown = true;
        $seen = [];
        foreach ($children[0] as [$column, $position]) {
            if (!$this->name([$column, $position])) {
                $known = false;
                $childrenKnown = false;
            } elseif (!isset($this->columns[$column])) {
                $this->error('foreign_key', $this->line, $position, "foreign key `{$name[0]}` lists unknown column `$column`");
                $known = false;
                $childrenKnown = false;
            } elseif (isset($seen[$column])) {
                $this->error('foreign_key', $this->line, $position, "foreign key `{$name[0]}` repeats column `$column`");
                $known = false;
                $childrenKnown = false;
            } elseif (isset($this->invalidTypes[$column])) {
                $known = false;
            }
            $seen[$column] = true;
        }
        $this->tableForeignKeys[] = [$foreignKey, $this->line, $name[1], $known, $childrenKnown];
        foreach ($parents[0] as [$column, $position]) {
            if (!$this->name([$column, $position])) {
                $resolvable = false;
            }
        }
        if ($resolvable) {
            $this->deferredForeignKeys[] = [$this->columns, $foreignKey, $this->line, $name[1], $target[1], $parents[0]];
        }
    }

    private function checkLine(): void
    {
        $name = $this->wordAt(1);
        if ($name === null || !$this->expectAt(2, '(')) {
            return;
        }
        // Go: the tokens after `(` end with `)`; otherwise the line fails at its end and declares no check.
        $rest = array_slice($this->tokens, 3);
        if ($rest === [] || end($rest)[0] !== ')') {
            $this->error('syntax', $this->line, $this->endColumn(), "expected ')' at the end of the check");
            return;
        }
        $this->constraintName($name);
        $check = new Check($name[0], '', $this->takeComments());
        $this->table->checks[] = $check;
        $this->tableChecks[] = [$check, $this->line, array_slice($this->tokens, 3), $this->endColumn()];
    }

    /**
     * 표의 설정 block을 연다: 첫 block은 유지하고, 반복된 block은 표에 붙이지 않고 구문만 읽는다(Go의 detached block).
     */
    private function openSettingsBlock(Settings $settings): void
    {
        $this->detachedBlock = $this->table->settings !== null;
        $this->table->settings ??= $settings;
        $this->settingsBlock = $this->detachedBlock ? $settings : $this->table->settings;
    }

    private function settingsLine(): void
    {
        $t = $this->tokens;
        [$keyword, $at] = $t[0];
        if ($keyword === '}') {
            $this->endAt(1);
            $this->settingsBlock->closingComments = $this->takeComments();
            $this->state = 'table';
            return;
        }
        if (in_array($keyword, self::STORAGE_KEYWORDS, true)) {
            $this->storageLine($keyword, $at);
            return;
        }
        $arity = match ($keyword) {
            'entity', 'updated', 'soft_delete', 'aes_version' => [1, 1],
            'select' => [2, PHP_INT_MAX],
            'codec' => [2, PHP_INT_MAX],
            'blind_index' => [2, 2],
            'navigation' => [3, 3],
            'immutable' => [0, 0],
            'audit' => [10, 10],
            default => null,
        };
        if ($arity === null) {
            $this->error('setting', $this->line, $at, "unknown setting `$keyword`");
            return;
        }
        $arguments = array_slice($t, 1);
        // audit의 exclude와 include 목록은 열 낱말 뒤에 오며 앞의 낱말을 검사한 뒤 따로 읽는다.
        $rest = [];
        if ($keyword === 'audit' && count($arguments) > 10) {
            $rest = array_slice($arguments, 10);
            $arguments = array_slice($arguments, 0, 10);
        }
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
        $lists = [];
        $kind = $keyword;
        if ($keyword === 'select') {
            if ($arguments[0][0] !== 'explicit') {
                $this->error('syntax', $this->line, $arguments[0][1], 'expected `select explicit`');
                return;
            }
            $kind = 'select_explicit';
            $arguments = array_slice($arguments, 1);
        } elseif ($keyword === 'audit') {
            foreach (['into', 'column', 'references', 'action', 'previous'] as $n => $word) {
                if ($arguments[2 * $n][0] !== $word) {
                    $this->error('syntax', $this->line, $arguments[2 * $n][1], "expected `$word`");
                    return;
                }
            }
            // audit의 인자는 history table, audit column, audit 기록 table, action, previous 순이다.
            $arguments = [$arguments[1], $arguments[3], $arguments[5], $arguments[7], $arguments[9]];
            if ($rest !== []) {
                $lists = $this->auditListTokens($rest);
                if ($lists === null) {
                    return;
                }
            }
        }
        $perName = $kind === 'codec' || $kind === 'navigation' || $kind === 'blind_index';
        $key = $perName ? $kind . ' ' . $arguments[0][0] : $kind;
        if (!$this->detachedBlock) {
            if (isset($this->settingKeys[$key])) {
                $this->error('setting', $this->line, $at, $perName ? "setting `$kind` repeats for `{$arguments[0][0]}`" : "setting `$keyword` repeats");
                return;
            }
            $this->settingKeys[$key] = true;
        }
        // Every argument is a name, except the stages of a codec.
        foreach ($kind === 'codec' ? [$arguments[0]] : $arguments as $argument) {
            $this->name($argument);
        }
        // 목록의 이름은 처음 나올 때만 검사한다. audit column은 검사가 따로 거부한다.
        $named = [];
        foreach ($lists as [, $columns]) {
            foreach ($columns as $token) {
                if (!isset($named[$token[0]]) && $token[0] !== $arguments[1][0]) {
                    $this->name($token);
                }
                $named[$token[0]] = true;
            }
        }
        $listed = [];
        foreach ($lists as [$list, $columns]) {
            $listed[$list[0]] = array_map(static fn(array $a): string => $a[0], $columns);
        }
        $this->settingsBlock->settings[] = new Setting($kind, array_map(static fn(array $a): string => $a[0], $arguments), $this->takeComments(), $listed['exclude'] ?? null, $listed['include'] ?? null);
        if (!$this->detachedBlock) {
            $this->tableSettings[] = [$kind, $arguments, $this->line, $at, $lists, null];
        }
    }

    /**
     * audit의 `exclude (<column>, ...)`와 `include (<column>, ...)` 목록을 읽는다. 문법이 틀리면
     * syntax 오류를 내고 null을 돌려준다.
     *
     * @param list<array{0: string, 1: int}> $tokens
     * @return list<array{0: array{0: string, 1: int}, 1: list<array{0: string, 1: int}>}>|null
     */
    private function auditListTokens(array $tokens): ?array
    {
        $lists = [];
        $i = 0;
        while ($i < count($tokens)) {
            $keyword = $tokens[$i];
            if ($keyword[0] !== 'exclude' && $keyword[0] !== 'include') {
                $this->error('syntax', $this->line, $keyword[1], "expected `exclude`, `include` or the end of the line, not `{$keyword[0]}`");
                return null;
            }
            if (($tokens[$i + 1][0] ?? null) !== '(') {
                $this->error('syntax', $this->line, $tokens[$i + 1][1] ?? $this->endColumn(), 'expected `(`');
                return null;
            }
            $i += 2;
            $columns = [];
            for (;;) {
                $name = $tokens[$i] ?? null;
                if ($name === null || !self::isWord($name[0])) {
                    $this->error('syntax', $this->line, $name[1] ?? $this->endColumn(), 'expected a column name');
                    return null;
                }
                $columns[] = $name;
                $next = $tokens[$i + 1] ?? null;
                $i += 2;
                if ($next !== null && $next[0] === ')') {
                    break;
                }
                if ($next === null || $next[0] !== ',') {
                    $this->error('syntax', $this->line, $next[1] ?? $this->endColumn(), 'expected `,` or `)`');
                    return null;
                }
            }
            $lists[] = [$keyword, $columns];
        }
        return $lists;
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
            $resolved = $primary === null || array_reduce($primary->columns, fn(bool $ok, string $c): bool => $ok && self::validName($c) && !isset($this->failedColumns[$c]), true);
            if (!$rejected && !$this->failedPrimary && ($primary === null || ($resolved && $primary->columns !== [$name]))) {
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
        foreach ($this->tableForeignKeys as [$foreignKey, $line, $column, $known, $childrenKnown]) {
            if ($foreignKey->changesChildRows()) {
                foreach ($foreignKey->columns as $child) {
                    $actionColumns[$child] ??= $foreignKey->name;
                }
            }
            // Go는 자식 열이 알려지지 않아도 set_null 검사를 알려진 자식에 대해 한다. 색인 검사만 건너뛴다.
            if ($childrenKnown) {
                $covered = false;
                foreach ($leading as $columns) {
                    if (array_slice($columns, 0, count($foreignKey->columns)) === $foreignKey->columns) {
                        $covered = true;
                        break;
                    }
                }
                if (!$covered && !isset($this->failedKeyTables[$table->name]) && !isset($this->failedPrimaryTables[$table->name])) {
                    $this->error('foreign_key', $line, $column, "foreign key `{$foreignKey->name}` needs an index or key whose leading columns are its columns");
                }
            }
            if ($foreignKey->onDelete === 'set_null' || $foreignKey->onUpdate === 'set_null') {
                foreach ($foreignKey->columns as $child) {
                    if (isset($this->columns[$child]) && !$this->columns[$child]->nullable) {
                        $this->error('foreign_key', $line, $column, "foreign key `{$foreignKey->name}` sets `$child` null but the column is not null");
                        break;
                    }
                }
            }
        }
        $checkColumns = [];
        foreach ($this->tableChecks as [$check, $line, $tokens, $end]) {
            [$text, $errors, $refs] = Expression::parse($tokens, $line, $end, $this->columns, $actionColumns);
            foreach ($errors as $error) {
                $this->error(...$error);
            }
            $check->expression = $text ?? '';
            array_push($checkColumns, ...$refs);
        }
        $this->checkSettings($leading, $actionColumns !== [], $checkColumns);
        if (isset($this->tables[$table->name]) && $this->tables[$table->name]['table'] === $table) {
            $this->tables[$table->name]['columns'] = $this->columns;
        }
        $this->table = null;
    }

    /**
     * @param list<list<string>> $leading 표의 key와 index의 column 목록
     * @param list<string> $checkColumns 표의 check가 읽는 column
     */
    private function checkSettings(array $leading, bool $changedByForeignKeys, array $checkColumns): void
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
        foreach ($this->tableSettings as [$kind, $arguments, $line, $at, $lists]) {
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
                        $this->error('setting', $line, $at, "setting `blind_index` needs a column with the `aes` codec, not `{$source[0]}`");
                    }
                    $index = $column($target);
                    if ($index !== null) {
                        $type = $index->type;
                        if (!($type->name === 'varchar' && $type->parameters[0] >= 64)
                            || ($encrypted !== null && $encrypted->nullable !== $index->nullable)
                            || isset($aes[$target[0]])
                            || (!isset($singleColumnKeys[$target[0]]) && !isset($this->failedKeyTables[$this->table->name]))) {
                            $this->error('setting', $line, $target[1], "blind index column `{$target[0]}` is a varchar(n >= 64) column with the AES column's nullability, not AES-encoded, and the only column of an index or unique key");
                        }
                    }
                    break;
                case 'navigation':
                    if (!self::validName($arguments[0][0])) {
                        break;
                    }
                    $found = isset($this->failedNames[$arguments[0][0]]);
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
                    $this->generatedName($line, $at, $this->table->name . '$immutable_update');
                    break;
                case 'markdown':
                    $definition = $this->columnRef($arguments[0], $line, $kind);
                    if ($definition !== null && $definition->type->name !== 'invalid' && !in_array($definition->type->name, ['varchar', 'text'], true)) {
                        $this->error('setting', $line, $arguments[0][1], "markdown needs a varchar or text column, not {$definition->type->text()}");
                    }
                    break;
                case 'store':
                    if ($arguments[0][0] === 'block') {
                        $this->foreignKeyNamed($arguments[1], $line);
                    }
                    break;
                case 'key_prefix':
                    $this->checkKeyPrefix($line, $at);
                    break;
                case 'title':
                case 'body':
                    $definition = $this->columnRef($arguments[0], $line, $kind);
                    if ($definition !== null && (($definition->type->name !== 'invalid' && !in_array($definition->type->name, ['varchar', 'text'], true)) || $definition->nullable)) {
                        $this->error('setting', $line, $arguments[0][1], "$kind needs a non-null varchar or text column");
                    }
                    break;
                case 'order':
                    $definition = $this->columnRef($arguments[0], $line, $kind);
                    if ($definition === null) {
                        break;
                    }
                    if (($definition->type->name !== 'invalid' && !in_array($definition->type->name, ['i32', 'i64'], true)) || $definition->nullable || $definition->default !== null) {
                        $this->error('setting', $line, $arguments[0][1], 'order needs a non-null i32 or i64 column with no default');
                    } elseif ($this->inKeyOrCheck($arguments[0][0], $checkColumns)) {
                        $this->error('setting', $line, $arguments[0][1], "order column `{$arguments[0][0]}` is in a key, index or check");
                    }
                    break;
                case 'state_machine':
                    $definition = $this->columnRef($arguments[0], $line, $kind);
                    if ($definition !== null && (($definition->type->name !== 'invalid' && !in_array($definition->type->name, ['varchar', 'text'], true)) || $definition->nullable)) {
                        $this->error('setting', $line, $arguments[0][1], 'state_machine needs a non-null varchar or text column');
                    }
                    foreach ($lists as [, $columns]) {
                        foreach ($columns as $token) {
                            $this->columnRef($token, $line, $kind);
                        }
                    }
                    break;
                case 'audit':
                    if ($changedByForeignKeys) {
                        $this->error('setting', $line, $at, 'setting `audit` is rejected on a child of a cascade or set_null foreign key');
                    }
                    $audit = $column($arguments[1]);
                    if ($audit !== null && $audit->nullable) {
                        $this->error('setting', $line, $arguments[1][1], 'the audit column is a non-null column');
                    }
                    $recorded = $this->auditLists($lists, $arguments[1][0], $line, $column);
                    if (self::validName($arguments[2][0])) {
                        $this->deferredAuditRecords[] = [$this->table, $audit, $arguments, $line, isset($this->failedKeyTables[$this->table->name]) || isset($this->failedPrimaryTables[$this->table->name])];
                    }
                    if (self::validName($arguments[0][0]) && self::validName($arguments[3][0]) && self::validName($arguments[4][0])) {
                        $this->deferredAudits[] = [$this->table, $this->columns, $arguments, $audit?->type, $line, $recorded];
                    }
                    $this->generatedName($line, $at, $this->table->name . '$audit_insert');
                    break;
            }
        }
        $this->checkStateMachine();
    }

    // ------------------------------------------------------- cross-table checks

    private function checkForeignKeyTargets(): void
    {
        foreach ($this->deferredForeignKeys as [$columns, $foreignKey, $line, $at, $targetAt, $parents]) {
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
            // Go는 표 줄이 실패한 target의 열, 짝과 type을 검사하지 않는다(validate.go의 foreignKey).
            if ($target['headerFailed'] ?? false) {
                continue;
            }
            $targetColumns = $target['columns'];
            // Go의 foreignKey와 같다: 개수 검사는 자식 열이 알려졌는지와 관계없이 하고, 짝과 type 검사는 참조 열이 모두
            // 알려졌을 때 한다. type 검사는 알려진 자식만 보며, 첫 불일치에서 멈춘다.
            $referencesKnown = true;
            foreach ($parents as [$parent, $position]) {
                if (!isset($targetColumns[$parent])) {
                    $this->error('foreign_key', $line, $position, "table `{$foreignKey->table}` has no column `$parent`");
                    $referencesKnown = false;
                }
            }
            if (count($foreignKey->columns) !== count($foreignKey->referencedColumns)) {
                $this->error('foreign_key', $line, $at, "foreign key `{$foreignKey->name}` lists " . count($foreignKey->columns) . ' columns and references ' . count($foreignKey->referencedColumns));
                continue;
            }
            if (!$referencesKnown) {
                continue;
            }
            $keys = $target['table']->primaryKey === null ? [] : [$target['table']->primaryKey->columns];
            foreach ($target['table']->uniqueKeys as $unique) {
                $keys[] = $unique->columns;
            }
            if (!in_array($foreignKey->referencedColumns, $keys, true) && !isset($this->failedKeyTables[$foreignKey->table]) && !isset($this->failedPrimaryTables[$foreignKey->table])) {
                $this->error('foreign_key', $line, $at, "foreign key `{$foreignKey->name}` references columns that are not the primary key or a unique key of `{$foreignKey->table}`");
            }
            foreach ($foreignKey->columns as $i => $child) {
                if (!isset($columns[$child]) || $columns[$child]->type->name === 'invalid') {
                    continue;
                }
                $parentType = $targetColumns[$foreignKey->referencedColumns[$i]]->type;
                if ($parentType->name !== 'invalid' && $columns[$child]->type !== $parentType && $columns[$child]->type->text() !== $parentType->text()) {
                    $this->error('foreign_key', $line, $at, "foreign key `{$foreignKey->name}` column `$child` is {$columns[$child]->type->text()} but `{$foreignKey->referencedColumns[$i]}` is {$parentType->text()}");
                    break;
                }
            }
        }
    }

    /**
     * audit의 exclude나 include 목록을 검사하고, column이 기록되는지 알리는 함수를 돌려준다
     * (docs/dbspec.md "Audit"). 두 목록을 다 쓰면 둘째 목록의 keyword에서 거부하고 null을
     * 돌려준다. 목록의 column은 table의 column이고, 한 번만 나오며, audit column이 아니다.
     * audit column은 언제나 기록하므로 어느 목록에도 쓰지 않는다.
     *
     * @param list<array{0: array{0: string, 1: int}, 1: list<array{0: string, 1: int}>}> $lists
     * @param \Closure(array): ?Column $column
     * @return (\Closure(string): bool)|null
     */
    private function auditLists(array $lists, string $audit, int $line, \Closure $column): ?\Closure
    {
        if (count($lists) > 1) {
            $this->error('setting', $line, $lists[1][0][1], 'audit names its recorded columns by exclude or by include, not both');
            return null;
        }
        $listed = [];
        foreach ($lists as [$keyword, $columns]) {
            foreach ($columns as $token) {
                if (isset($listed[$token[0]])) {
                    $this->error('setting', $line, $token[1], "column `{$token[0]}` repeats in audit {$keyword[0]}");
                    continue;
                }
                if ($token[0] === $audit) {
                    $this->error('setting', $line, $token[1], "the audit column `{$token[0]}` is always recorded and is not listed in exclude or include");
                } else {
                    $column($token);
                }
                $listed[$token[0]] = true;
            }
        }
        if (count($lists) === 1 && $lists[0][0][0] === 'include') {
            return static fn(string $c): bool => $c === $audit || isset($listed[$c]);
        }
        return static fn(string $c): bool => $c === $audit || !isset($listed[$c]);
    }

    /**
     * audit 기록 table을 검사한다. 그 table은 이 문서나 사용한 문서의 다른 table이며 history
     * table이 아니고, 자신은 audit 대상이 아니며, column 하나의 primary key를 가지고 그 type이
     * audit column의 type이다. audit column은 그 primary key를 restrict로 가리키는 선언한
     * foreign key의 유일한 column이다. 그래서 audit 기록 행이 없는 audit column 값은 database가
     * 거부한다.
     */
    private function checkAuditRecords(): void
    {
        foreach ($this->deferredAuditRecords as [$audited, $column, $arguments, $line, $failedKeys]) {
            [$historyToken, $columnToken, $referencesToken] = $arguments;
            $name = $referencesToken[0];
            $entry = $this->tables[$name] ?? null;
            if ($entry === null && isset($this->failedTables[$name])) {
                continue;
            }
            if ($entry === null) {
                $this->error('setting', $line, $referencesToken[1], "audit record table `$name` is not a table of this document or a used table");
                continue;
            }
            $record = $entry['table'];
            if ($record === null) {
                continue;
            }
            // Go는 표 줄이 실패한 audit 기록 table의 key를 검사하지 않는다(settings.go의 auditRecord).
            if ($entry['headerFailed'] ?? false) {
                continue;
            }
            if ($record === $audited) {
                $this->error('setting', $line, $referencesToken[1], 'a table cannot record its audits in itself');
                continue;
            }
            if ($name === $historyToken[0]) {
                $this->error('setting', $line, $referencesToken[1], 'the audit record table is another table than the history table');
                continue;
            }
            foreach ($record->settings?->settings ?? [] as $setting) {
                if ($setting->kind === 'audit') {
                    $this->error('setting', $line, $referencesToken[1], "audit record table `$name` is audited itself");
                }
            }
            $key = $record->primaryKey?->columns ?? [];
            if (count($key) !== 1) {
                if (!isset($this->failedPrimaryTables[$name])) {
                    $this->error('setting', $line, $referencesToken[1], "audit record table `$name` needs a primary key of one column");
                }
                continue;
            }
            $pk = $entry['columns'][$key[0]] ?? null;
            if ($column === null || $pk === null) {
                continue;
            }
            if ($pk->type->name !== 'invalid' && $column->type->name !== 'invalid' && $pk->type->text() !== $column->type->text()) {
                $this->error('setting', $line, $columnToken[1], "the audit column has type {$column->type->text()}, not the type {$pk->type->text()} of the primary key of `$name`");
                continue;
            }
            foreach ($audited->foreignKeys as $foreignKey) {
                if ($foreignKey->columns === [$columnToken[0]] && $foreignKey->table === $name && $foreignKey->referencedColumns === [$key[0]]
                    && $foreignKey->onDelete === 'restrict' && $foreignKey->onUpdate === 'restrict') {
                    continue 2;
                }
            }
            if (!$failedKeys) {
                $this->error('setting', $line, $columnToken[1], "the audit column needs the foreign key ($columnToken[0]) references $name ({$key[0]}) on delete restrict on update restrict");
            }
        }
    }

    private function checkAuditHistories(): void
    {
        foreach ($this->deferredAudits as [$audited, $columns, $arguments, $auditType, $line, $recorded]) {
            [$historyToken, , , $actionToken, $previousToken] = $arguments;
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
            // Go는 표 줄이 실패한 history table의 열을 맞추어 보지 않는다(settings.go의 audit).
            if ($entry['headerFailed'] ?? false) {
                continue;
            }
            $history = $entry['table'];
            $historyColumns = $entry['columns'];
            if ($history === $audited) {
                $this->error('setting', $line, $historyToken[1], 'an audited table is not its own history table');
                continue;
            }
            // history table의 모양은 어긋난 곳마다 하나씩 보고한다: audit된 history table, i64
            // identity primary key, action과 previous column, 기록하는 column의 사본, 남는 column.
            foreach ($history->settings?->settings ?? [] as $setting) {
                if ($setting->kind === 'audit') {
                    $this->error('setting', $line, $historyToken[1], "history table `{$history->name}` is audited itself");
                }
            }
            $key = $history->primaryKey?->columns ?? [];
            $identity = count($key) === 1 ? ($historyColumns[$key[0]] ?? null) : null;
            $reserved = [];
            if ($identity !== null && $identity->identity && $identity->type->name === 'i64') {
                $reserved[$identity->name] = true;
            } else {
                $this->error('setting', $line, $historyToken[1], "history table `{$history->name}` needs an i64 identity primary key");
            }
            $action = $historyColumns[$actionToken[0]] ?? null;
            if ($action === null || isset($reserved[$actionToken[0]]) || $action->nullable || $action->type->text() !== 'varchar(8)') {
                $this->error('setting', $line, $actionToken[1], "the audit action column `{$actionToken[0]}` is a separate non-null varchar(8) column of `{$history->name}`");
            }
            $reserved[$actionToken[0]] = true;
            $previous = $historyColumns[$previousToken[0]] ?? null;
            if ($previous === null || isset($reserved[$previousToken[0]]) || !$previous->nullable || ($auditType !== null && $previous->type->text() !== $auditType->text())) {
                $this->error('setting', $line, $previousToken[1], "the audit previous column `{$previousToken[0]}` is a separate null column of `{$history->name}` with the audit column's type");
            }
            $reserved[$previousToken[0]] = true;
            // 두 목록을 다 쓴 setting은 기록하는 column이 정해지지 않으므로 column을 맞추어 보지 않는다.
            if ($recorded === null) {
                continue;
            }
            // 숫자로만 된 column 이름은 배열 key에서 int가 되므로 문자열로 되돌린다.
            foreach ($columns as $name => $column) {
                $name = (string) $name;
                if (!$recorded($name)) {
                    continue;
                }
                if (isset($reserved[$name]) || !isset($historyColumns[$name])) {
                    $this->error('setting', $line, $historyToken[1], "history table `{$history->name}` has no copy of column `$name`");
                } elseif ($historyColumns[$name]->type->text() !== $column->type->text()) {
                    $this->error('setting', $line, $historyToken[1], "history column `$name` has type {$historyColumns[$name]->type->text()}, not {$column->type->text()}");
                }
            }
            foreach ($historyColumns as $name => $column) {
                $name = (string) $name;
                if (isset($reserved[$name])) {
                    continue;
                }
                if (!isset($columns[$name])) {
                    $this->error('setting', $line, $historyToken[1], "history table `{$history->name}` has column `$name`, which is not a column of `{$audited->name}`");
                } elseif (!$recorded($name)) {
                    $this->error('setting', $line, $historyToken[1], "history table `{$history->name}` has column `$name`, which `{$audited->name}` does not record");
                }
            }
        }
    }

    // ---------------------------------------------------- 저장 설정

    /**
     * markdown 저장 설정 줄 하나(`markdown`, `store`, `key_prefix`, `title`, `body`,
     * `order`, `checkbox`, `state_machine`)를 cursor로 읽는다. Go의 settingsLine과 같이
     * 첫 syntax 오류에서 줄이 끝난다. 표 전체의 규칙은 표가 닫힐 때 검사한다.
     */
    private function storageLine(string $keyword, int $at): void
    {
        $this->cursor = 1;
        try {
            [$arguments, $form, $lists] = $this->storageArguments($keyword);
            if (isset($this->tokens[$this->cursor])) {
                throw $this->cursorFail('the end of the line');
            }
        } catch (SettingFailure) {
            return;
        }
        if (!$this->detachedBlock) {
            if ($keyword === 'title' || $keyword === 'body') {
                $this->parsedTitleBody[$this->table->name][] = $keyword;
            }
            if ($keyword === 'markdown' || in_array($keyword, self::ONCE_STORAGE, true)) {
                $key = $keyword === 'markdown' ? "markdown {$arguments[0][0]}" : $keyword;
                if (isset($this->settingKeys[$key])) {
                    $this->error('setting', $this->line, $at, $keyword === 'markdown' ? "setting `markdown` repeats for `{$arguments[0][0]}`" : "setting `$keyword` repeats");
                    return;
                }
                $this->settingKeys[$key] = true;
            }
        }
        $requires = $lists === [] ? null : array_map(static fn(array $a): string => $a[0], $lists[0][1]);
        $this->settingsBlock->settings[] = new Setting(
            $keyword,
            array_map(static fn(array $a): string => $a[0], $arguments),
            $this->takeComments(),
            null,
            null,
            $form,
            $requires,
        );
        if (!$this->detachedBlock) {
            $this->tableSettings[] = [$keyword, $arguments, $this->line, $at, $lists, $form];
        }
    }

    /**
     * cursor에서 저장 설정의 인자를 읽고, 이어서 줄 형태와 `require` 목록을 읽는다
     * (transition과 terminal 줄에만 있다).
     *
     * @return array{0: list<array{0:string,1:int}>, 1: ?string, 2: list<array{0: array{0:string,1:int}, 1: list<array{0:string,1:int}>}>}
     */
    private function storageArguments(string $keyword): array
    {
        switch ($keyword) {
            case 'markdown':
            case 'title':
            case 'body':
            case 'order':
                return [[$this->cursorWord('a column name')], null, []];
            case 'store':
                $kind = $this->cursorOneOf('`files`, `document` or `block`', ['files', 'document', 'block']);
                $arguments = [$kind];
                if ($kind[0] === 'block') {
                    $arguments[] = $this->cursorWord('a foreign key name');
                }
                if ($kind[0] !== 'files') {
                    $arguments[] = $this->cursorOneOf('`list` or `table`', ['list', 'table']);
                }
                return [$arguments, null, []];
            case 'key_prefix':
                return [[$this->cursorQuoted('a key prefix in quotes')], null, []];
            case 'checkbox':
                $column = $this->cursorWord('the state column');
                $state = $this->cursorWord('a state name');
                $glyph = $this->cursorQuoted('a glyph in quotes');
                return [[$column, $state, $glyph], null, []];
            default:
                return $this->machineArguments();
        }
    }

    /**
     * column 뒤의 state_machine 줄을 읽는다: initial, terminal, history, limit 또는
     * transition 줄이며, Go의 settingsLine이 읽는 방식과 같다.
     *
     * @return array{0: list<array{0:string,1:int}>, 1: string, 2: list<array{0: array{0:string,1:int}, 1: list<array{0:string,1:int}>}>}
     */
    private function machineArguments(): array
    {
        $arguments = [$this->cursorWord('the state column')];
        foreach (['initial', 'terminal'] as $form) {
            if ($this->formAhead($form)) {
                $this->cursor++;
                $arguments[] = $this->cursorWord('a state name');
                return [$arguments, $form, $form === 'terminal' ? $this->optionalRequire() : []];
            }
        }
        if ($this->formAhead('history')) {
            $this->cursor++;
            $arguments[] = $this->cursorWord('the history table');
            $this->cursorKeyword('row');
            $arguments[] = $this->cursorWord('the foreign key column');
            $this->cursorKeyword('from');
            $arguments[] = $this->cursorWord('the from column');
            $this->cursorKeyword('to');
            $arguments[] = $this->cursorWord('the to column');
            $this->cursorKeyword('at');
            $arguments[] = $this->cursorWord('the at column');
            return [$arguments, 'history', []];
        }
        if ($this->formAhead('limit')) {
            $this->cursor++;
            $arguments[] = $this->cursorWord('a state name');
            $arguments[] = $this->cursorValue('a row count');
            return [$arguments, 'limit', []];
        }
        $arguments[] = $this->cursorWord('the from state');
        $this->cursorArrow();
        $arguments[] = $this->cursorWord('the to state');
        return [$arguments, 'transition', $this->optionalRequire()];
    }

    /**
     * 다음에 오면 `require (<column>, ...)`을 읽는다: 목록 하나이며 keyword token으로 식별한다.
     *
     * @return list<array{0: array{0:string,1:int}, 1: list<array{0:string,1:int}>}>
     */
    private function optionalRequire(): array
    {
        $keyword = $this->tokens[$this->cursor] ?? null;
        if ($keyword === null || $keyword[0] !== 'require') {
            return [];
        }
        $this->cursor++;
        if (($this->tokens[$this->cursor][0] ?? null) !== '(') {
            throw $this->cursorFail('`(`');
        }
        $this->cursor++;
        $columns = [];
        while (true) {
            $columns[] = $this->cursorWord('a column name');
            $next = $this->tokens[$this->cursor][0] ?? null;
            if ($next === ')') {
                $this->cursor++;
                return [[$keyword, $columns]];
            }
            if ($next !== ',') {
                throw $this->cursorFail('`,` or `)`');
            }
            $this->cursor++;
        }
    }

    /** cursor 위치의 syntax 오류다. 줄에 기록하고, 호출한 쪽이 줄을 멈춘다. */
    private function cursorFail(string $expected): SettingFailure
    {
        $token = $this->tokens[$this->cursor] ?? null;
        if ($token === null) {
            $this->error('syntax', $this->line, $this->endColumn(), "line ends, expected $expected");
        } else {
            $shown = $token[0][0] === "'" && strlen($token[0]) >= 2 ? "string {$token[0]}" : "`{$token[0]}`";
            $this->error('syntax', $this->line, $token[1], "unexpected $shown, expected $expected");
        }
        return new SettingFailure();
    }

    /** @return array{0:string,1:int} 낱말 또는 숫자 token */
    private function cursorWord(string $what): array
    {
        $token = $this->tokens[$this->cursor] ?? null;
        if ($token === null || !self::isWord($token[0])) {
            throw $this->cursorFail($what);
        }
        $this->cursor++;
        return $token;
    }

    private function cursorKeyword(string $text): void
    {
        if (($this->tokens[$this->cursor][0] ?? null) !== $text) {
            throw $this->cursorFail("`$text`");
        }
        $this->cursor++;
    }

    /** @param list<string> $words @return array{0:string,1:int} 목록 가운데 하나인 token */
    private function cursorOneOf(string $what, array $words): array
    {
        $token = $this->tokens[$this->cursor] ?? null;
        if ($token === null || !in_array($token[0], $words, true)) {
            throw $this->cursorFail($what);
        }
        $this->cursor++;
        return $token;
    }

    /** 문자열 literal이다. 값은 따옴표 사이 글이며, 겹따옴표는 한 글자로 읽는다. @return array{0:string,1:int} */
    private function cursorQuoted(string $what): array
    {
        $token = $this->tokens[$this->cursor] ?? null;
        if ($token === null || strlen($token[0]) < 2 || $token[0][0] !== "'") {
            throw $this->cursorFail($what);
        }
        $this->cursor++;
        return [self::literalValue($token[0]), $token[1]];
    }

    /** 행 수다: 낱말이나 소수점 숫자, 또는 숫자 앞의 minus다. @return array{0:string,1:int} */
    private function cursorValue(string $what): array
    {
        $token = $this->tokens[$this->cursor] ?? null;
        if ($token !== null && $token[0] === '-') {
            $this->cursor++;
            $number = $this->tokens[$this->cursor] ?? null;
            if ($number === null || !self::isNumber($number[0])) {
                throw $this->cursorFail('a number after `-`');
            }
            $this->cursor++;
            return ['-' . $number[0], $token[1]];
        }
        if ($token === null || !(self::isWord($token[0]) || self::isNumber($token[0]))) {
            throw $this->cursorFail($what);
        }
        $this->cursor++;
        return $token;
    }

    private function cursorArrow(): void
    {
        if (($this->tokens[$this->cursor][0] ?? null) !== '-' || ($this->tokens[$this->cursor + 1][0] ?? null) !== '>') {
            throw $this->cursorFail('`->`');
        }
        $this->cursor += 2;
    }

    /** keyword $text가 다음이고, transition의 from state가 아닌지 본다(뒤에 `->`가 오지 않는다). */
    private function formAhead(string $text): bool
    {
        return ($this->tokens[$this->cursor][0] ?? null) === $text && ($this->tokens[$this->cursor + 1][0] ?? null) !== '-';
    }

    /** default literal token의 값이다: 문자열이면 따옴표를 뺀 글, 아니면 token 그대로다. */
    private static function literalValue(string $text): string
    {
        return $text !== '' && $text[0] === "'" && strlen($text) >= 2 ? str_replace("''", "'", substr($text, 1, -1)) : $text;
    }

    private static function isNumber(string $token): bool
    {
        return preg_match('/^[0-9]+(?:\.[0-9]+)?$/D', $token) === 1;
    }

    /** 행 수가 10진수 양의 int64인지 본다 (Go의 strconv.ParseInt와 n >= 1). */
    private static function positiveCount(string $text): bool
    {
        if (preg_match('/^[0-9]+$/D', $text) !== 1) {
            return false;
        }
        $digits = ltrim($text, '0');
        return $digits !== '' && (strlen($digits) < 19 || (strlen($digits) === 19 && strcmp($digits, '9223372036854775807') <= 0));
    }

    /**
     * 설정이 이름 붙인 column이다: 이름을 검사한 뒤 표의 column이어야 한다. type이
     * invalid여도 column을 돌려준다.
     */
    private function columnRef(array $token, int $line, string $kind): ?Column
    {
        if (!$this->name($token, $line)) {
            return null;
        }
        if (!isset($this->columns[$token[0]])) {
            $this->error('setting', $line, $token[1], "setting `$kind` names unknown column `{$token[0]}`");
            return null;
        }
        return $this->columns[$token[0]];
    }

    /** `store block` 줄이 이름 붙인 foreign key는 표의 foreign key여야 한다. */
    private function foreignKeyNamed(array $token, int $line): void
    {
        if (!$this->name($token, $line) || isset($this->failedNames[$token[0]])) {
            return;
        }
        foreach ($this->table->foreignKeys as $foreignKey) {
            if ($foreignKey->name === $token[0]) {
                return;
            }
        }
        $this->error('setting', $line, $token[1], "foreign key `{$token[0]}` is not a foreign key of the table");
    }

    /** `key_prefix`는 varchar type의 single-column primary key가 필요하다. */
    private function checkKeyPrefix(int $line, int $at): void
    {
        if ($this->failedPrimary) {
            return;
        }
        $primary = $this->table->primaryKey;
        if ($this->primaryKeyLines !== 1 || $primary === null || count($primary->columns) !== 1) {
            $this->error('setting', $line, $at, 'key_prefix needs a single-column primary key');
            return;
        }
        $definition = $this->columns[$primary->columns[0]] ?? null;
        if ($definition !== null && $definition->type->name !== 'invalid' && $definition->type->name !== 'varchar') {
            $this->error('setting', $line, $at, "key_prefix needs a varchar primary key, not {$definition->type->text()}");
        }
    }

    /** column이 표의 primary key, unique key, index, foreign key 또는 check가 이름 붙였는지 본다. */
    private function inKeyOrCheck(string $column, array $checkColumns): bool
    {
        $groups = [];
        if ($this->table->primaryKey !== null) {
            $groups[] = $this->table->primaryKey->columns;
        }
        foreach ($this->table->uniqueKeys as $unique) {
            $groups[] = $unique->columns;
        }
        foreach ($this->table->indexes as $index) {
            $groups[] = array_map(static fn(IndexColumn $c): string => $c->name, $index->columns);
        }
        foreach ($this->table->foreignKeys as $foreignKey) {
            $groups[] = $foreignKey->columns;
        }
        foreach ($groups as $columns) {
            if (in_array($column, $columns, true)) {
                return true;
            }
        }
        return in_array($column, $checkColumns, true);
    }

    /**
     * 표의 state_machine 줄들을 함께 검사한다 (Go의 stateMachineConsistency): column 하나,
     * initial과 terminal state, terminal state에서 나가는 transition, limit 줄, history 줄
     * (마지막 줄 뒤에 검사한다), state column의 default, 그리고 checkbox 줄이다.
     */
    private function checkStateMachine(): void
    {
        $column = '';
        $states = [];
        $initials = [];
        $terminals = [];
        $lines = [];
        $limits = [];
        $history = null;
        $requires = [];
        foreach ($this->tableSettings as [$kind, $arguments, $line, $at, $lists, $form]) {
            if ($kind !== 'state_machine') {
                continue;
            }
            if ($column === '') {
                $column = $arguments[0][0];
            } elseif ($arguments[0][0] !== $column) {
                $this->error('setting', $line, $arguments[0][1], "state_machine repeats for `{$arguments[0][0]}`; a table holds one machine");
            }
            if ($form === 'history') {
                if ($history !== null) {
                    $this->error('setting', $line, $at, 'state_machine repeats history');
                    continue;
                }
                $history = [$line, $arguments];
            } elseif ($form === 'limit') {
                $limits[] = [$line, $arguments];
            } else {
                $lines[] = [$line, $arguments, $form, $at];
                foreach ($lists as [, $columns]) {
                    array_push($requires, ...$columns);
                }
                if ($form === 'initial') {
                    $initials[$arguments[1][0]] = true;
                    $states[$arguments[1][0]] = true;
                } elseif ($form === 'terminal') {
                    $terminals[$arguments[1][0]] = true;
                    $states[$arguments[1][0]] = true;
                } else {
                    $states[$arguments[1][0]] = true;
                    $states[$arguments[2][0]] = true;
                }
            }
        }
        foreach ($lines as [$line, $arguments, $form, $at]) {
            if ($form === 'initial' && isset($terminals[$arguments[1][0]])) {
                $this->error('setting', $line, $at, "an initial state `{$arguments[1][0]}` is also terminal");
            } elseif ($form === 'transition' && isset($terminals[$arguments[1][0]])) {
                $this->error('setting', $line, $at, "a transition leaves the terminal state `{$arguments[1][0]}`");
            }
        }
        $seen = [];
        foreach ($limits as [$line, $arguments]) {
            $state = $arguments[1];
            if (!isset($states[$state[0]])) {
                $this->error('setting', $line, $state[1], "limit names state `{$state[0]}` outside the state set");
            } elseif (isset($seen[$state[0]])) {
                $this->error('setting', $line, $state[1], "limit repeats for state `{$state[0]}`");
            }
            $seen[$state[0]] = true;
            if (!self::positiveCount($arguments[2][0])) {
                $this->error('setting', $line, $arguments[2][1], "limit needs a positive row count, not {$arguments[2][0]}");
            }
        }
        $definition = $column === '' ? null : ($this->columns[$column] ?? null);
        if ($history !== null) {
            [$line, $arguments] = $history;
            if ($this->name($arguments[1], $line)) {
                $this->deferredHistories[] = [$this->table, $line, $arguments, $definition, $requires, $this->columns];
            }
        }
        if ($definition !== null && isset($this->defaultValues[$column])) {
            [$text, $line, $at] = $this->defaultValues[$column];
            if (!isset($initials[$text])) {
                $this->error('setting', $line, $at, "the default `$text` of the state column is not an initial state");
            }
        }
        $this->checkCheckboxes($column, $states);
    }

    /**
     * checkbox 줄들을 검사한다 (Go의 checkboxes): state_machine column을 이름 붙이고,
     * 각 state를 한 글자 glyph로 한 번씩 덮으며, glyph는 서로 달라야 한다.
     *
     * @param array<string, true> $states 기계의 state 집합
     */
    private function checkCheckboxes(string $column, array $states): void
    {
        $boxes = [];
        foreach ($this->tableSettings as [$kind, $arguments, $line, $at]) {
            if ($kind === 'checkbox') {
                $boxes[] = [$line, $arguments, $at];
            }
        }
        if ($boxes === []) {
            return;
        }
        [$firstLine, $firstArguments, $firstAt] = $boxes[0];
        if ($column === '') {
            $this->error('setting', $firstLine, $firstArguments[0][1], "checkbox needs a state_machine on column `{$firstArguments[0][0]}`");
            return;
        }
        $covered = [];
        $glyphs = [];
        foreach ($boxes as [$line, $arguments]) {
            if ($this->columnRef($arguments[0], $line, 'checkbox') === null) {
                continue;
            }
            if ($arguments[0][0] !== $column) {
                $this->error('setting', $line, $arguments[0][1], "checkbox names column `{$arguments[0][0]}`, but the state_machine column is `$column`");
                continue;
            }
            $state = $arguments[1];
            if (!isset($states[$state[0]])) {
                $this->error('setting', $line, $state[1], "checkbox names state `{$state[0]}` outside the state set");
            } elseif (isset($covered[$state[0]])) {
                $this->error('setting', $line, $state[1], "checkbox repeats for state `{$state[0]}`");
            }
            $covered[$state[0]] = true;
            $glyph = $arguments[2];
            if (mb_strlen($glyph[0], 'UTF-8') !== 1) {
                $this->error('setting', $line, $glyph[1], 'a checkbox glyph is one character');
            } elseif (isset($glyphs[$glyph[0]])) {
                $this->error('setting', $line, $glyph[1], "checkbox glyph `{$glyph[0]}` repeats");
            }
            $glyphs[$glyph[0]] = true;
        }
        foreach (array_keys($states) as $state) {
            if (!isset($covered[$state])) {
                $this->error('setting', $firstLine, $firstAt, "checkbox does not cover state `$state`");
            }
        }
    }

    /**
     * state_machine history 줄의 history table을 검사한다 (Go의 history). 마지막 줄 뒤에
     * 검사하며, 문서나 사용한 문서의 table이어야 하고, row column이 기계의 table을 가리키는
     * foreign key를 가져야 하며, from과 to column은 state type, at column은 datetime(6)이어야
     * 한다. 필요한 column마다 nullable 사본이 있어야 하고, 줄이 이름 붙이지 않은 column은 없어야
     * 한다. title이나 body를 선언하지 않는다.
     */
    private function checkStateHistories(): void
    {
        foreach ($this->deferredHistories as [$machine, $line, $arguments, $state, $requires, $columns]) {
            [, $tableToken, $rowToken, $fromToken, $toToken, $atToken] = $arguments;
            $name = $tableToken[0];
            $entry = $this->tables[$name] ?? null;
            if ($entry === null && isset($this->failedTables[$name])) {
                continue;
            }
            if ($entry === null) {
                $this->error('setting', $line, $tableToken[1], "history table `$name` is not a table of this document or a used table");
                continue;
            }
            if ($entry['table'] === null || $state === null || $state->type->name === 'invalid') {
                continue;
            }
            $history = $entry['table'];
            $historyColumns = $entry['columns'];
            $foreignKey = false;
            foreach ($history->foreignKeys as $candidate) {
                $foreignKey = $foreignKey || ($candidate->columns === [$rowToken[0]] && $candidate->table === $machine->name);
            }
            if (!$foreignKey) {
                $this->error('setting', $line, $tableToken[1], "history table `$name` has no foreign key of `{$rowToken[0]}` to table `{$machine->name}`");
            }
            $named = [$rowToken[0] => true];
            $stateType = $state->type->text();
            foreach ([[$fromToken, $stateType], [$toToken, $stateType], [$atToken, 'datetime(6)']] as [$ref, $want]) {
                $named[$ref[0]] = true;
                $column = $historyColumns[$ref[0]] ?? null;
                if ($column === null) {
                    $this->error('setting', $line, $tableToken[1], "history table `$name` has no column `{$ref[0]}`");
                } elseif ($column->type->name !== 'invalid' && $column->type->text() !== $want) {
                    $this->error('setting', $line, $tableToken[1], "history column `{$ref[0]}` has type {$column->type->text()}, not $want");
                }
            }
            foreach ($requires as $ref) {
                $named[$ref[0]] = true;
                $required = $columns[$ref[0]] ?? null;
                $copy = $historyColumns[$ref[0]] ?? null;
                if ($required === null || $required->type->name === 'invalid') {
                    continue;
                }
                if ($copy === null) {
                    $this->error('setting', $line, $tableToken[1], "history table `$name` has no column `{$ref[0]}` of the required column");
                } elseif (!$copy->nullable || ($copy->type->name !== 'invalid' && $copy->type->text() !== $required->type->text())) {
                    $this->error('setting', $line, $tableToken[1], "history column `{$ref[0]}` is not a nullable {$required->type->text()} column");
                }
            }
            foreach ($history->primaryKey?->columns ?? [] as $column) {
                $named[$column] = true;
            }
            foreach ($history->columns as $column) {
                if (!isset($named[$column->name])) {
                    $this->error('setting', $line, $tableToken[1], "history table `$name` has column `{$column->name}`, which the history line does not name");
                }
            }
            foreach ($this->parsedTitleBody[$history->name] ?? [] as $kind) {
                $this->error('setting', $line, $tableToken[1], "history table `$name` declares $kind, which a history table does not");
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

    public static function validName(string $name): bool
    {
        return preg_match('/^[a-z][a-z0-9_]*$/D', $name) === 1 && !in_array($name, self::RESERVED, true) && strlen($name) <= 63;
    }

    /**
     * Reports a name the renderer generates from a well-formed table name
     * that is longer than 63 bytes (docs/dbspec.md "Names"); the longest
     * name of a setting stands for all of its names. A malformed or too long
     * table name is already reported.
     */
    private function generatedName(int $line, int $column, string $name): void
    {
        if (strlen($name) > 63 && self::validName(explode('$', $name, 2)[0])) {
            $this->error('name.length', $line, $column, "the generated name `$name` has " . strlen($name) . ' bytes, more than 63');
        }
    }

    /** Whether a token is a word: one or more Go word runes (wordRune). */
    public static function isWord(string $token): bool
    {
        $chars = preg_split('//u', $token, -1, PREG_SPLIT_NO_EMPTY);
        if ($chars === false || $chars === []) {
            return false;
        }
        foreach ($chars as $c) {
            if (!self::wordRune($c)) {
                return false;
            }
        }
        return true;
    }

    /** Checks a name token's format and length; returns whether it is valid. */
    private function name(array $token, ?int $line = null): bool
    {
        [$name, $column] = $token;
        $line ??= $this->line;
        if (!preg_match('/^[a-z][a-z0-9_]*$/D', $name) || in_array($name, self::RESERVED, true)) {
            $this->error('name.format', $line, $column, "name `$name` does not match [a-z][a-z0-9_]* or is a reserved word");
            return false;
        }
        if (strlen($name) > 63) {
            $this->error('name.length', $line, $column, "name `$name` is longer than 63 bytes");
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
        $this->constraintAt[$token[0]] = [$this->line, $token[1]];
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

    /**
     * 구문 오류가 난 column 줄은 Go처럼 구문 오류만 남긴다: 이름과 type 검사는 줄이 구문에 맞을 때만 한다.
     */
    private function keepSyntaxSince(int $mark): void
    {
        $later = array_slice($this->diagnostics, $mark);
        $this->diagnostics = array_merge(
            array_slice($this->diagnostics, 0, $mark),
            array_values(array_filter($later, static fn(array $d): bool => $d[0] === 'syntax')),
        );
    }

    /**
     * 문서 끝에서 닫히지 않은 block의 오류다. 같은 줄의 다른 syntax 오류와 함께 보고한다(Go는 줄당 한 번으로 제한하지 않는다).
     */
    private function unclosed(int $line, int $column, string $message): void
    {
        $this->diagnostics[] = ['syntax', $line, $column, $message];
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
