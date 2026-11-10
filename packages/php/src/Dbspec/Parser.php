<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * Reads one dbspec document line by line and validates it (docs/spec/dbspec.md).
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
    // As in Go's isWordRune, a word includes `.` (so `a.b` is one token, and a number like 1.5 is also one
    // token).
    private const TOKEN = "/[A-Za-z0-9_.]+|'(?:[^']|'')*+'|<=|>=|<>|[^ ]/u";
    private const VALID_UTF8 = '/\A(?:[\x00-\x7F]|[\xC2-\xDF][\x80-\xBF]|\xE0[\xA0-\xBF][\x80-\xBF]|'
        . '[\xE1-\xEC\xEE\xEF][\x80-\xBF]{2}|\xED[\x80-\x9F][\x80-\xBF]|\xF0[\x90-\xBF][\x80-\xBF]{2}|'
        . '[\xF1-\xF3][\x80-\xBF]{3}|\xF4[\x80-\x8F][\x80-\xBF]{2})*+/';
    private const MAX_BYTES = 32 * 1024 * 1024;
    private const MAX_TABLES = 4096;
    private const MAX_COLUMNS = 120000;
    private const MAX_FOREIGN_KEYS = 20000;
    private const MAX_TABLE_COLUMNS = 1000;
    private const MAX_KEY_COLUMNS = 16;
    private const MAX_KEY_VARCHAR = 640;
    /** The rule table of docs/spec/dbspec.md, in its order, which orders diagnostics at one position. */
    private const RULES = ['header', 'syntax', 'order', 'name.format', 'name.length', 'name.duplicate', 'type',
        'column', 'key', 'foreign_key', 'check', 'setting', 'use', 'diagram', 'limit', 'encoding'];
    /**
     * The rules judged on the whole document (docs/spec/dbspec.md DBS-144): a stopped document gives none of them,
     * though this parser judges some of them as it reads a table.
     */
    private const DOCUMENT_RULES = ['name.duplicate', 'column', 'key', 'foreign_key', 'use', 'diagram'];
    public const RESERVED = ['dbspec', 'use', 'table', 'diagram', 'primary', 'unique', 'index', 'foreign',
        'check', 'settings', 'null', 'identity', 'default', 'true', 'false', 'and', 'or', 'not', 'in', 'between',
        'is'];
    /** Codec stages that produce text; the others produce bytes. */
    private const TEXT_STAGES = ['hex', 'base64', 'ordered_json', 'yaml', 'serialize'];
    /** The keyword of markdown storage settings. The cursor reads it (storageLine). */
    private const STORAGE_KEYWORDS = ['markdown', 'store', 'title', 'body', 'order', 'task_marker'];
    /**
     * A storage keyword written only once per table. Repeating it is a setting error at the keyword's position.
     */
    private const ONCE_STORAGE = ['store', 'title', 'body', 'order', 'task_marker'];
    /** The codec stages, the fixed words after a codec column (docs/spec/dbspec.md "Keep, move or remove"; R12). */
    private const CODEC_STAGES = ['ordered_json', 'aes', 'hex', 'gz', 'base64', 'serialize', 'yaml', 'ip'];
    /** A character of valid UTF-8, or one invalid byte (R15): the code points of a line. */
    private const UTF8_CHAR = '(?:[\x00-\x7F]|[\xC2-\xDF][\x80-\xBF]|\xE0[\xA0-\xBF][\x80-\xBF]|'
        . '[\xE1-\xEC\xEE\xEF][\x80-\xBF]{2}|\xED[\x80-\x9F][\x80-\xBF]|\xF0[\x90-\xBF][\x80-\xBF]{2}|'
        . '[\xF1-\xF3][\x80-\xBF]{3}|\xF4[\x80-\x8F][\x80-\xBF]{2}|[\s\S])';

    /** @var list<array{0:string,1:int,2:int,3:string}> [rule, line, column, message] */
    private array $diagnostics = [];
    private Document $document;
    /** Whether an encoding, header or limit error stopped the read. */
    private bool $stopped = false;

    /**
     * @var array<string, array{table: ?Table, columns: array<string, Column>}> table name => definition; null
     *     for a table whose definition is unknown
     */
    private array $tables = [];
    /** @var array<string, true> index, unique key, foreign key and check names of the schema */
    private array $constraintNames = [];
    /** @var array<string, string> each constraint name of a used document => the first used document that has it */
    private array $usedConstraintOwners = [];
    /** @var array<string, true> the local index, unique key, foreign key and check names read so far */
    private array $localConstraints = [];
    /** @var array<int, true> spl_object_id of the stand-in columns of failed column lines (Go's missing column) */
    private array $standIns = [];
    /** @var array<string, true> */
    private array $usedDocuments = [];
    /** @var array<string, true> */
    private array $diagramNames = [];
    /** @var array<string, true> tables of failed `use` lines: references to them report nothing more */
    private array $failedTables = [];
    /**
     * @var array<string, string> the renderer names written by the tables read so far and by the used
     *     tables, with their sources
     */
    private array $generatedNames = [];
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
    /** @var list<array{0:string,1:int,2:int,3:int}> [text, column, index in the line, line] */
    private array $tokens = [];
    /** @var list<string> */
    private array $comments = [];
    /** @var array<int, array<int, string>> the class the readers gave a token: line => index in the line => class */
    private array $marks = [];
    /**
     * @var array<int, true> lines whose classes are lexical: abandoned by a syntax diagnostic, or in a block
     *     whose opening line failed (R1, R20)
     */
    private array $lexical = [];
    /** Whether a line is being read: a syntax diagnostic raised then abandons its line. */
    private bool $reading = false;
    /** Whether the classes are recorded: only for analysis, so that parse keeps no token data. */
    private bool $marking = false;
    /**
     * The body of a table or settings or diagram block whose opening line failed is read but keeps lexical
     * classes (R20).
     */
    private bool $tableFailed = false;
    private bool $settingsFailed = false;
    private bool $diagramFailed = false;

    // The open block.
    private string $state = 'top';
    private int $topPhase = 0;
    /** @var array{0:int,1:int,2:string} line, column and text of the open block's brace, or of its keyword */
    private array $blockOpen = [0, 0, ''];
    /** @var array{0:int,1:int,2:string} */
    private array $settingsOpen = [0, 0, ''];
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
    /**
     * @var list<array{0:Check,1:int,2:list<array{0:string,1:int}>,3:int}> [check, line, tokens after `(`, end
     *     column]
     */
    private array $tableChecks = [];
    /**
     * @var list<array{0:string,1:list<array{0:string,1:int}>,2:int,3:int}> [kind, argument tokens, line,
     *     keyword column]
     */
    private array $tableSettings = [];
    /** @var array<string, true> */
    private array $settingKeys = [];
    /**
     * @var Settings|null The block that reads a line: the first block of a table, or a repeated block, which
     *     is not kept
     */
    private ?Settings $settingsBlock = null;
    /**
     * A repeated settings block: lines are read only for syntax and not checked (Go's detached block)
     */
    private bool $detachedBlock = false;
    /** A primary key line of the table failed: its primary key columns are unknown. */
    private bool $failedPrimary = false;
    /**
     * @var array<string, true> tables with a failed unique or index line: some key's columns are unknown
     */
    private array $failedKeyTables = [];
    /**
     * @var array<string, array{0: int, 1: int}> the line and column of each local constraint name
     */
    private array $constraintAt = [];
    /**
     * @var array<string, true> names of foreign key and column lines that had a syntax error (Go's failedName)
     */
    private array $failedNames = [];
    /**
     * @var array<string, true> names of column lines that had a syntax error, so their identity check is
     *     unresolved
     */
    private array $failedColumns = [];
    /** Column lines of the table that had a syntax error (Go's failedLines). */
    private int $failedLines = 0;
    /** The first lex error of the current line: [column, message], or null. */
    private ?array $lexError = null;
    private ?Diagram $diagram = null;
    /** @var array<string, true> */
    private array $diagramTables = [];

    /** @var list<array{0:string,1:int,2:int,3:string}> the index and set_null diagnostics of the foreign keys */
    private array $laterForeignKeyDiagnostics = [];
    /** @var list<array> foreign keys whose target is checked after the last line */
    private array $deferredForeignKeys = [];
    /** @var list<array> audit settings whose history table is checked after the last line */
    private array $deferredAudits = [];
    /**
     * @var list<array{0: Table, 1: ?Column, 2: list<array{0: string, 1: int}>, 3: int, 4: bool}> Checks the
     *     audit setting's record table
     */
    private array $deferredAuditRecords = [];
    /** @var array<string, true> Tables whose primary key line failed */
    private array $failedPrimaryTables = [];
    /** @var int The position of the next token that the cursor reading the setting line will read */
    private int $cursor = 0;
    /**
     * The declaration positions in the order they were read; run sorts them. They are kept as parallel lists of scalars
     * and shared strings, not as one Position object each: a parse that holds many declarations (up to the limit of
     * columns) keeps the lists only, and sortedPositions makes the Position objects of a successful parse.
     *
     * @var list<string> the kind of each position
     */
    private array $positionKinds = [];
    /** @var list<int> the number of parts of the name path of each position */
    private array $positionPathLengths = [];
    /** @var list<string> the parts of the name paths, the parts of each position in turn */
    private array $positionPathParts = [];
    /** @var list<int> the line of each position */
    private array $positionLines = [];
    /** @var list<int> the column of each position */
    private array $positionColumns = [];

    /**
     * @param array<string, string> $documents the declared document set
     * @param list<string> $using the documents whose `use` lines lead to this one, to find cycles
     * @param \ArrayObject<string, array{0: ?Document, 1: ?string}|false> $used used document => [document,
     *     reason it is unusable], false while it is read
     */
    public function __construct(
        private readonly array $documents,
        private readonly array $using = [],
        private ?\ArrayObject $used = null,
    ) {
        $this->used ??= new \ArrayObject();
    }

    /**
     * @return array{0: ?Document, 1: list<Diagnostic>, 2: ?list<Position>, 3: list<Token>} the tokens are read
     *         only when $withTokens is set, and are empty after a limit stop (docs/spec/dbspec.md "Syntax analysis")
     */
    public function run(string $source, bool $withTokens = false): array
    {
        $this->marking = $withTokens;
        $stop = null;
        try {
            $this->read($source);
        } catch (ParseStop) {
            $this->stopped = true;
            $stop = array_pop($this->diagnostics);
            $this->diagnostics = array_values(array_filter(
                $this->diagnostics,
                static fn(array $d): bool => !in_array($d[0], self::DOCUMENT_RULES, true),
            ));
        }
        $tokens = $withTokens && ($stop === null || $stop[0] !== 'limit') ? $this->syntaxTokens($source) : [];
        if ($this->diagnostics === [] && $stop === null) {
            return [$this->document, [], $this->sortedPositions(), $tokens];
        }
        $rank = array_flip(self::RULES);
        $order = array_keys($this->diagnostics);
        usort($order, fn(int $a, int $b): int =>
            [$this->diagnostics[$a][1], $this->diagnostics[$a][2], $rank[$this->diagnostics[$a][0]], $a]
            <=> [$this->diagnostics[$b][1], $this->diagnostics[$b][2], $rank[$this->diagnostics[$b][0]], $b]);
        $diagnostics = array_map(fn(int $i): Diagnostic => new Diagnostic(...$this->diagnostics[$i]), $order);
        if ($stop !== null) {
            $diagnostics[] = new Diagnostic(...$stop);
        }
        return [null, $diagnostics, null, $tokens];
    }

    /**
     * The name that the header step reads from the source, or '' when the header fails (docs/spec/dbspec.md "Parsing a
     * set"): the read runs without used documents, as Go's parseStructure(text, nil), and its other diagnostics are
     * dropped.
     */
    public static function headerName(string $source): string
    {
        $parser = new self([]);
        try {
            $parser->read($source);
        } catch (ParseStop) {
            // A document that stops at an error still has the header read before it.
            return isset($parser->document) ? $parser->document->name : '';
        }
        return isset($parser->document) ? $parser->document->name : '';
    }

    /**
     * The tokens of every line of the source in source order, each with its class: the class a reader set,
     * unless the line is lexical, else the lexical class (docs/spec/dbspec.md "Syntax analysis"). The lines
     * are split and lexed as the parser reads them, so a line the parser did not read gets the same tokens.
     *
     * @return list<Token>
     */
    private function syntaxTokens(string $source): array
    {
        $raw = explode("\n", $source);
        $last = count($raw) - 1;
        $tokens = [];
        foreach ($raw as $index => $text) {
            $line = $index + 1;
            // A CR before an LF is part of the line end; a bare CR is an offending character (R8, R22).
            if ($index < $last && $text !== '' && $text[-1] === "\r") {
                $text = substr($text, 0, -1);
            }
            $trimmed = ltrim($text, ' ');
            if ($trimmed === '') {
                continue;
            }
            if ($trimmed[0] === '#') {
                $start = strlen($text) - strlen($trimmed);
                $tokens[] = new Token($line, $start, $start + count(self::chars($trimmed)), 'comment');
                continue;
            }
            [$lexed, $error] = self::lexLine($text);
            $items = $error === null ? $lexed : self::lexRecover($text);
            foreach (self::annotate($items, $line) as $token) {
                $class = isset($this->lexical[$line]) ? null : ($this->marks[$line][$token[2]] ?? null);
                $class ??= self::lexicalClass($token[0]);
                $start = $token[1] - 1;
                $tokens[] = new Token($line, $start, $start + count(self::chars($token[0])), $class);
            }
        }
        return $tokens;
    }

    /** The lexical class of a token of a line (docs/spec/dbspec.md "Syntax analysis"). */
    private static function lexicalClass(string $text): string
    {
        return match (true) {
            $text[0] === "'" => 'string',
            in_array($text, ['(', ')', '{', '}', ','], true) => 'punctuation',
            in_array($text, ['=', '<>', '<', '<=', '>', '>=', '+', '-', '*', '/'], true) => 'operator',
            self::isNumber($text) => 'number',
            default => 'word',
        };
    }

    /**
     * Gives each token its index in its line and its line, the keys of the marks.
     *
     * @param list<array{0:string,1:int}> $tokens
     * @return list<array{0:string,1:int,2:int,3:int}>
     */
    private static function annotate(array $tokens, int $line): array
    {
        return array_map(static fn(array $t, int $i): array => [$t[0], $t[1], $i, $line], $tokens, array_keys($tokens));
    }

    /** The code points of a line; an invalid UTF-8 byte is one code point of its own (R15). @return list<string> */
    private static function chars(string $text): array
    {
        if (preg_match('//u', $text) === 1) {
            return preg_split('//u', $text, -1, PREG_SPLIT_NO_EMPTY);
        }
        $chars = [];
        $offset = 0;
        $length = strlen($text);
        while ($offset < $length) {
            $size = preg_match('/\G' . self::UTF8_CHAR . '/', $text, $m, 0, $offset) === 1 ? strlen($m[0]) : 1;
            $chars[] = substr($text, $offset, $size);
            $offset += $size;
        }
        return $chars;
    }

    /**
     * Sets the class of a token the reader consumed. A token the parser makes itself has no index and is not
     * marked; the class of a line the parser abandons is dropped when the tokens are built.
     */
    private function mark(array $token, string $class): void
    {
        if ($this->marking && isset($token[2], $token[3])) {
            $this->marks[$token[3]][$token[2]] = $class;
        }
    }

    /**
     * A value position gives keyword to true, false, null and now (R6, R18); other words and numbers keep
     * their class.
     */
    private function markValue(array $token): void
    {
        if (in_array($token[0], ['true', 'false', 'null', 'now'], true)) {
            $this->mark($token, 'keyword');
        }
    }

    /**
     * Consumes the token at the cursor, giving it the class; returns it.
     *
     * @return array{0:string,1:int,2:int,3:int}
     */
    private function take(string $class): array
    {
        $token = $this->tokens[$this->cursor++];
        $this->mark($token, $class);
        return $token;
    }

    /**
     * The positions in source order, by line and then column; equal places keep the order they were read.
     *
     * @return list<Position>
     */
    private function sortedPositions(): array
    {
        $paths = [];
        $next = 0;
        foreach ($this->positionPathLengths as $i => $length) {
            $paths[$i] = array_slice($this->positionPathParts, $next, $length);
            $next += $length;
        }
        $order = array_keys($this->positionKinds);
        usort($order, fn(int $a, int $b): int =>
            [$this->positionLines[$a], $this->positionColumns[$a], $a]
            <=> [$this->positionLines[$b], $this->positionColumns[$b], $b]);
        return array_map(fn(int $i): Position => new Position(
            $this->positionKinds[$i],
            $paths[$i],
            $this->positionLines[$i],
            $this->positionColumns[$i]
        ), $order);
    }

    /**
     * Records the declaration at the line being read, at the token that names it (or, for a
     * setting and the primary key, the keyword). Only a successful parse returns the records.
     *
     * @param list<string> $path
     * @param array{0: string, 1: int} $token
     */
    private function declare(string $kind, array $path, array $token): void
    {
        $this->positionKinds[] = $kind;
        $this->positionPathLengths[] = count($path);
        foreach ($path as $part) {
            $this->positionPathParts[] = $part;
        }
        $this->positionLines[] = $this->line;
        $this->positionColumns[] = $token[1];
    }

    /**
     * The identity of a setting line that the repeat rule makes unique, as docs/spec/dbspec.md
     * "Declaration positions" states it: the column of codec, markdown, navigation and
     * blind_index. Every other setting has no identity.
     *
     * @param list<array{0: string, 1: int}> $arguments
     * @return list<string>
     */
    private static function settingIdentity(string $keyword, array $arguments): array
    {
        return match ($keyword) {
            'codec', 'markdown', 'navigation', 'blind_index' => [$arguments[0][0]],
            default => [],
        };
    }

    private function read(string $source): void
    {
        if (strlen($source) > self::MAX_BYTES) {
            $this->stop('limit', 1, 1, 'document has ' . strlen($source) . ' bytes, more than ' . self::MAX_BYTES);
        }
        if (str_starts_with($source, "\xEF\xBB\xBF")) {
            $this->stop('encoding', 1, 1, 'document starts with a byte order mark');
        }
        // Lines before the line of the first encoding error are intact, so they are read; from that line on
        // they are not read (as Go's splitSource).
        $encoding = self::encodingError($source);
        $lines = explode("\n", $source);
        if (end($lines) === '') {
            array_pop($lines);
        }
        if ($lines === []) {
            $this->stop('header', 1, 1, 'document is empty; the first line must be dbspec 1 <document>');
        }
        foreach ($lines as $index => $text) {
            if ($encoding !== null && $index + 1 >= $encoding[0]) {
                break;
            }
            if ($text !== '' && $text[-1] === "\r") {
                $text = substr($text, 0, -1);
            }
            $this->line = $index + 1;
            $this->text = $text;
            $this->reading = true;
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
            if ($this->marking && ($this->tableFailed || $this->settingsFailed || $this->diagramFailed)) {
                $this->lexical[$this->line] = true;
            }
            $this->tokenize();
            if ($this->lexError !== null) {
                $this->error('syntax', $this->line, $this->lexError[0], $this->lexError[1]);
                // Reads with the error character removed from the token (as Go's lexRecover): a table header
                // line at the top also opens its table.
                $this->tokens = self::annotate(self::lexRecover($text), $this->line);
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
        $this->reading = false;
        if ($encoding !== null) {
            $this->stop('encoding', ...$encoding);
        }
        // Reports only the innermost open block (as Go does): an open settings block does not report the
        // table's `{`.
        if ($this->state === 'settings') {
            $this->unclosed(...$this->settingsOpen);
            $this->state = 'table';
            $this->closeTable();
        } elseif ($this->state === 'table') {
            $this->unclosed(...$this->blockOpen);
            $this->closeTable();
        } elseif ($this->state === 'diagram') {
            $this->unclosed(...$this->blockOpen);
        }
        $this->document->trailingComments = $this->takeComments();
        $this->checkForeignKeyTargets();
        $this->checkAuditRecords();
        $this->checkAuditTables();
        $this->checkAuditHistories();
    }

    /**
     * The first encoding error after the byte order mark, as [line, column, message], or null. A bare CR is
     * not a line end, so it is an error; the lines before the error's line are complete and valid.
     *
     * @return ?array{0: int, 1: int, 2: string}
     */
    private static function encodingError(string $source): ?array
    {
        $bad = null;
        if (!preg_match('//u', $source)) {
            preg_match(self::VALID_UTF8, $source, $m);
            $bad = [strlen($m[0]), 'text is not valid UTF-8'];
        }
        if (preg_match('/\r(?!\n)/', $source, $m, PREG_OFFSET_CAPTURE) && ($bad === null || $m[0][1] < $bad[0])) {
            $bad = [$m[0][1], 'carriage return without a following line feed'];
        }
        if ($bad === null) {
            return null;
        }
        [$offset, $message] = $bad;
        $before = substr($source, 0, $offset);
        $newline = strrpos($before, "\n");
        $start = $newline === false ? 0 : $newline + 1;
        return [substr_count($source, "\n", 0, $offset) + 1,
            mb_strlen(substr($source, $start, $offset - $start), 'UTF-8') + 1, $message];
    }

    // ---------------------------------------------------------------- lines

    private function tokenize(): void
    {
        [$tokens, $this->lexError] = self::lexLine($this->text);
        $this->tokens = self::annotate($tokens, $this->line);
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
        $chars = self::chars($text);
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
        $chars = self::chars($text);
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
        // A single byte is ASCII, read without the table as Go's isWordRune does; from 0x80 it is an invalid
        // byte, since a valid code point of that range has two bytes or more.
        if (strlen($c) === 1) {
            return $c === '_' || $c === '.' || ($c >= 'a' && $c <= 'z') || ($c >= 'A' && $c <= 'Z')
                || ($c >= '0' && $c <= '9');
        }
        return UnicodeWord::contains(mb_ord($c, 'UTF-8'));
    }

    /** The character in single quotes, as the canonical quoting writes it (quote). */
    private static function goRune(string $c): string
    {
        return self::quote($c, "'");
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
            $this->settingsOpen = $this->openedAt(1);
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
            $this->standIns[spl_object_id($this->columns[$name])] = true;
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
            $this->stop(
                'header',
                1,
                min($same, strlen($this->text)) + 1,
                'the first line is exactly dbspec 1 <document>'
            );
        }
        $end = strlen($prefix) + strspn(
            $this->text,
            'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_',
            strlen($prefix)
        );
        if ($end === strlen($prefix) || $end < strlen($this->text)) {
            $this->stop('header', 1, $end + 1, 'the first line is exactly dbspec 1 <document>');
        }
        $t = $this->tokens;
        $this->mark($t[0], 'keyword');
        $this->name($t[2]);
        $this->document = new Document($t[2][0]);
        $this->declare('document', [$t[2][0]], $t[2]);
    }

    private function topLine(): void
    {
        $first = $this->tokens[0];
        switch ($first[0]) {
            case 'use':
                $this->mark($first, 'keyword');
                $this->useLine();
                return;
            case 'table':
                $this->mark($first, 'keyword');
                $outOfOrder = $this->topPhase > 1;
                $this->topPhase = max($this->topPhase, 1);
                $this->openTable($outOfOrder);
                return;
            case 'diagram':
                $this->mark($first, 'keyword');
                $this->topPhase = 2;
                $this->openDiagram();
                return;
        }
        $this->failAt(0, "'use', 'table' or 'diagram'");
    }

    private function useLine(): void
    {
        $t = $this->tokens;
        // The words of a use line that fails are names of a failed line, whose references report nothing more
        // (DBS-153).
        $count = count($this->document->uses);
        try {
            $this->readUseLine($t);
        } finally {
            if (count($this->document->uses) === $count) {
                foreach (array_slice($t, 2) as $token) {
                    if (self::isWord($token[0])) {
                        $this->failedTables[$token[0]] = true;
                    }
                }
            }
        }
    }

    /** @param list<array> $t */
    private function readUseLine(array $t): void
    {
        $document = $this->wordAt(1, 'a document name');
        if ($document === null) {
            return;
        }
        $this->mark($document, 'name');
        if (!$this->expectAt(2, '{')) {
            return;
        }
        $tables = [];
        $i = 3;
        while (true) {
            $table = $this->wordAt($i, 'a table name');
            if ($table === null) {
                return;
            }
            $this->mark($table, 'name');
            $tables[] = $table;
            $i++;
            if (($t[$i][0] ?? null) === ',') {
                $i++;
                continue;
            }
            if (!$this->expectAt($i, '}', "',' or '}'")) {
                return;
            }
            break;
        }
        if (!$this->endAt($i + 1)) {
            return;
        }
        if ($this->topPhase > 0) {
            $this->error('order', $this->line, $t[0][1], 'use lines come before table and diagram blocks');
        }
        $name = $document[0];
        $this->document->uses[] = new UseLine(
            $name,
            array_map(static fn(array $table): string => $table[0], $tables),
            $this->takeComments()
        );
        $this->declare('use', [$name], $document);
        foreach ($tables as $table) {
            $this->declare('use_table', [$name, $table[0]], $table);
        }
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
            $this->error(
                'name.duplicate',
                $this->line,
                $document[1],
                'document ' . self::quoted($name) . ' is used twice'
            );
            $failed();
            return;
        }
        $this->usedDocuments[$name] = true;
        $used = null;
        $reason = null;
        if ($name === $this->document->name) {
            $reason = 'a document cannot use itself';
        } elseif (in_array($name, $this->using, true)) {
            $reason = 'using document ' . self::quoted($name) . ' closes a use cycle';
        } elseif (!array_key_exists($name, $this->documents)) {
            $reason = 'document ' . self::quoted($name) . ' is not in the declared document set';
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
            foreach (
                [$definition->uniqueKeys, $definition->indexes, $definition->foreignKeys,
                $definition->checks] as $constraints
            ) {
                foreach ($constraints as $constraint) {
                    $owner = $this->usedConstraintOwners[$constraint->name] ?? null;
                    if ($owner !== null && $owner !== $name) {
                        $repeated ??= [$constraint->name, $owner];
                    }
                    $this->usedConstraintOwners[$constraint->name] ??= $name;
                    $this->constraintNames[$constraint->name] = true;
                }
            }
        }
        if ($repeated !== null) {
            $this->error('name.duplicate', $this->line, $document[1], 'document ' . self::quoted($name)
                . ' repeats constraint name ' . self::quoted($repeated[0]) . ' of document '
                . self::quoted($repeated[1]));
        }
        $listed = [];
        foreach ($tables as [$table, $column]) {
            if (!$this->name([$table, $column])) {
                $this->failedTables[$table] = true;
                continue;
            }
            if (isset($listed[$table])) {
                $this->error(
                    'name.duplicate',
                    $this->line,
                    $column,
                    'table ' . self::quoted($table) . ' is listed twice'
                );
                continue;
            }
            $listed[$table] = true;
            $definition = null;
            foreach ($used->tables as $candidate) {
                if ($candidate->name === $table) {
                    $definition = $candidate;
                    break;
                }
            }
            if ($definition === null) {
                $this->error('use', $this->line, $column, 'document ' . self::quoted($name) . ' does not define table '
                    . self::quoted($table));
                $this->failedTables[$table] = true;
                continue;
            }
            if (isset($this->tables[$table])) {
                $this->error('name.duplicate', $this->line, $column, 'table ' . self::quoted($table)
                    . ' is already used from another document');
                continue;
            }
            $this->tables[$table] = ['table' => $definition, 'columns' => self::columnMap($definition), 'used' => true];
            foreach (Names::ofTable($definition) as $generated) {
                $this->generatedNames[$generated] = "used table {$definition->name}";
            }
        }
    }

    /**
     * Refuses a renderer name that an earlier table or a used table of the document already
     * writes, at the later token (docs/spec/dbspec.md "Names").
     */
    private function claimGenerated(string $name, string $source, int $line, int $column): void
    {
        if (isset($this->generatedNames[$name])) {
            $this->error(
                'name.duplicate',
                $line,
                $column,
                "generated name $name of $source repeats the generated name of {$this->generatedNames[$name]}"
            );
            return;
        }
        $this->generatedNames[$name] = $source;
    }

    /**
     * Parses and validates a used document of the declared set once, with its own `use` lines.
     *
     * @return array{0: ?Document, 1: ?string} the document, or null and the reason it is unusable
     */
    private function usedDocument(string $name): array
    {
        if (isset($this->used[$name])) {
            // Rewriting a document being read is a use cycle. If the document's header name differs from the
            // set's name, the name cannot be found through the chain, so it is marked as being read.
            return $this->used[$name] === false
                ? [null, 'using document ' . self::quoted($name) . ' closes a use cycle']
                : $this->used[$name];
        }
        $this->used[$name] = false;
        $parser = new self($this->documents, [...$this->using, $this->document->name], $this->used);
        [$document, $diagnostics] = $parser->run($this->documents[$name]);
        // As Go, a document that did not stop is first checked for its header name, then for its diagnostics.
        $header = !$parser->stopped && isset($parser->document) ? $parser->document->name : $name;
        if ($header !== $name) {
            $result = [null, 'the document set entry ' . self::quoted($name) . ' holds document '
                . self::quoted($header)];
        } elseif ($document === null) {
            $first = $diagnostics[0];
            $result = [null, 'used document ' . self::quoted($name)
                . " is invalid: line {$first->line} column {$first->column} {$first->rule}: {$first->message}"];
        } else {
            $result = [$document, null];
        }
        return $this->used[$name] = $result;
    }

    private function openTable(bool $outOfOrder): void
    {
        $t = $this->tokens;
        if (++$this->tableCount > self::MAX_TABLES) {
            $this->stop('limit', $this->line, $t[0][1], 'document has more than ' . self::MAX_TABLES . ' tables');
        }
        $name = $t[1] ?? null;
        // A table line failed (no name, no `{`, or more words after `{`). This is Go's failed table.
        $headerFailed = false;
        if ($name === null || !self::isWord($name[0])) {
            $this->failAt(1, 'a table name');
            $name = ['', $t[0][1]];
            $headerFailed = true;
        } else {
            $this->mark($name, 'name');
        }
        if ($headerFailed || !$this->expectAt(2, '{') || !$this->endAt(3)) {
            $headerFailed = true;
        } else {
            // As Go, the name and the order are checked on a line that reads completely.
            $this->name($name);
            if ($outOfOrder) {
                $this->error('order', $this->line, $t[0][1], 'table blocks come before diagram blocks');
            }
        }
        $table = new Table($name[0], $this->takeComments());
        $this->document->tables[] = $table;
        $this->declare('table', [$name[0]], $name);
        if ($name[0] !== '') {
            if (isset($this->tables[$name[0]])) {
                // Go does not report a duplicate name of a table whose line failed (validate.go's failed table).
                if (!$headerFailed) {
                    $this->error('name.duplicate', $this->line, $name[1], 'table ' . self::quoted($name[0])
                        . (isset($this->tables[$name[0]]['used']) ? ' is also a used table' : ' is defined twice'));
                }
            } else {
                // Go reports a constraint with the same name as a table at the constraint's place, even if the
                // table comes later. A constraint in a document being written is reported at the table's place.
                if (isset($this->constraintAt[$name[0]])) {
                    [$constraintLine, $constraintColumn] = $this->constraintAt[$name[0]];
                    $this->error(
                        'name.duplicate',
                        $constraintLine,
                        $constraintColumn,
                        'name ' . self::quoted($name[0]) . ' is also a table name'
                    );
                }
                if (!$headerFailed && isset($this->usedConstraintOwners[$name[0]])) {
                    $this->error('name.duplicate', $this->line, $name[1], 'table ' . self::quoted($name[0])
                        . ' is named like a constraint of document '
                        . self::quoted($this->usedConstraintOwners[$name[0]]));
                }
                $this->tables[$name[0]] = ['table' => $table, 'columns' => [], 'headerFailed' => $headerFailed];
            }
        }
        $this->state = 'table';
        // R20: the body of a block whose opening line failed (a syntax diagnostic on it) keeps lexical classes.
        $this->tableFailed = isset($this->syntaxLines[$this->line]);
        $this->blockOpen = $this->openedAt(2);
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
        $this->failedNames = [];
        $this->failedColumns = [];
        $this->failedLines = 0;
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
                $this->mark($first, 'keyword');
                if ($this->tablePhase === 2) {
                    $this->error(
                        'order',
                        $this->line,
                        $first[1],
                        'key, index, foreign key and check lines come before the settings block'
                    );
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
                $this->mark($first, 'keyword');
                // Go reports the order of a repeated block's keyword only when the line is in correct form
                // (`settings {` only).
                $wellFormed = ($this->tokens[1][0] ?? null) === '{' && !isset($this->tokens[2]);
                if ($this->tablePhase === 2 && $wellFormed) {
                    $this->error(
                        'order',
                        $this->line,
                        $first[1],
                        'a table has at most one settings block, after its other lines'
                    );
                }
                $this->tablePhase = 2;
                if ($this->expectAt(1, '{')) {
                    $this->endAt(2);
                }
                $this->openSettingsBlock(new Settings($this->takeComments()));
                $this->settingsOpen = $this->openedAt(1);
                $this->state = 'settings';
                return;
        }
        $mark = count($this->diagnostics);
        $this->columnLine();
        if (isset($this->syntaxLines[$this->line])) {
            $this->keepSyntaxSince($mark);
            $this->failColumnLine($first[0]);
        } elseif ($this->tablePhase > 0) {
            // Go reports the order of a column only when the column line matches the syntax (after c.done in
            // columnLine). A line with a syntax error gives only the syntax error.
            $this->error(
                'order',
                $this->line,
                $first[1],
                'column lines come before key, index, foreign key, check and settings lines'
            );
        }
    }

    private function columnLine(): void
    {
        $t = $this->tokens;
        if (count($this->table->columns) + 1 > self::MAX_TABLE_COLUMNS) {
            $this->stop('limit', $this->line, $t[0][1], 'table has more than ' . self::MAX_TABLE_COLUMNS . ' columns');
        }
        if (++$this->columnCount > self::MAX_COLUMNS) {
            $this->stop('limit', $this->line, $t[0][1], 'document has more than ' . self::MAX_COLUMNS . ' columns');
        }
        $name = $this->wordAt(0, "a column name, key, index, foreign key, check, settings or '}'");
        if ($name === null) {
            return;
        }
        $wellFormed = $this->name($name);
        // Go's type position takes a word, not a number.
        if (!isset($t[1]) || !self::isWord($t[1][0]) || self::isNumber($t[1][0])) {
            $this->failAt(1, 'a type');
            $this->failColumn($name[0]);
            return;
        }
        [$type, $i] = $this->type(1);
        $nullable = false;
        $identity = null;
        $default = null;
        if (($t[$i][0] ?? null) === 'null') {
            $this->mark($t[$i], 'keyword');
            $nullable = true;
            $i++;
        }
        if (($t[$i][0] ?? null) === 'identity') {
            $this->mark($t[$i], 'keyword');
            $identity = $t[$i];
            $i++;
        }
        if (($t[$i][0] ?? null) === 'default') {
            $keyword = $t[$i];
            $this->mark($keyword, 'keyword');
            $value = $this->valueAt($i + 1, 'a default value', true);
            if ($value === null) {
                $this->failColumn($name[0]);
                return;
            }
            $this->markValue($t[$i + 1]);
            $default = [$keyword, $value[0]];
            $i = $value[1];
        }
        if (isset($t[$i])) {
            $this->failAt($i, 'the end of the line');
            $this->failColumn($name[0]);
            return;
        }
        $rejected = false;
        if ($identity !== null) {
            if ($nullable) {
                $this->error('column', $this->line, $identity[1], 'an identity column cannot be null');
                $rejected = true;
            } elseif ($type !== null && $type->name !== 'i64') {
                $this->error(
                    'column',
                    $this->line,
                    $identity[1],
                    "an identity column has type i64, not {$type->text()}"
                );
                $rejected = true;
            }
            if (!$rejected && $this->identities !== []) {
                $this->error(
                    'column',
                    $this->line,
                    $identity[1],
                    'a table has at most one identity column'
                );
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
                    $empty = $type->name === 'text' || $type->name === 'bytes';
                    $this->error(
                        'column',
                        $this->line,
                        $empty ? $keyword[1] : $value[1],
                        $empty ? "a {$type->name} column has no default"
                            : 'default ' . self::describe($value[0]) . " is not a literal of type {$type->text()}"
                    );
                }
            }
        }
        $column = new Column(
            $name[0],
            $type ?? new ColumnType('invalid'),
            $nullable,
            $identity !== null,
            $canonical,
            $this->takeComments()
        );
        // The name of a column whose renderer writes a type CHECK must not overlap another generated name.
        if (
            $identity === null && $type !== null && $type->name !== 'text' && $type->name !== 'bytes'
            && $wellFormed && self::validName($this->table->name)
        ) {
            $this->claimGenerated(
                Names::render($this->table->name, $name[0]),
                "table {$this->table->name} column {$name[0]}",
                $this->line,
                $name[1]
            );
        }
        if (isset($this->columns[$name[0]])) {
            $this->error(
                'name.duplicate',
                $this->line,
                $name[1],
                'column ' . self::quoted($name[0]) . ' repeats in the table'
            );
        } else {
            $this->columns[$name[0]] = $column;
            if ($type === null) {
                $this->invalidTypes[$name[0]] = true;
            }
        }
        $this->table->columns[] = $column;
        $this->declare('column', [$this->table->name, $name[0]], $name);
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
        $this->mark($t[$i], 'type');
        $parenthesis = ($t[$i + 1][0] ?? null) === '(';
        if (in_array($name, ColumnType::SIMPLE, true) && !$parenthesis) {
            return [$this->types[$name] ??= new ColumnType($name), $i + 1];
        }
        if (!isset(ColumnType::PARAMETERIZED[$name]) || !$parenthesis) {
            $this->error('type', $this->line, $column, match (true) {
                in_array($name, ColumnType::SIMPLE, true) => "$name takes no parameters",
                isset(ColumnType::PARAMETERIZED[$name]) => self::parametersMessage($name),
                default => "type \"$name\" is not a dbspec type",
            });
            return [null, $parenthesis ? $this->skipParentheses($i + 1) : $i + 1];
        }
        $parameters = [];
        $j = $i + 2;
        $malformed = false;
        // As in Go, reads the value (number, word, `-` number) and then the separator. A different token in
        // value position, or a separator other than `,` or `)`, is a syntax error.
        for (;;) {
            $value = $t[$j] ?? null;
            if ($value !== null && ctype_digit($value[0])) {
                $parameters[] = strlen(ltrim($value[0], '0')) > 6 ? PHP_INT_MAX : (int) $value[0];
                $j++;
            } else {
                // A negative number, a word or a fraction: Go's readValue reads it, and it is no parameter.
                $read = $this->valueAt($j, 'a type parameter', false);
                if ($read === null) {
                    return [null, $this->skipParentheses($j)];
                }
                $malformed = true;
                $parameters[] = PHP_INT_MAX;
                $j = $read[1];
            }
            $separator = $t[$j][0] ?? null;
            if ($separator === ',') {
                $j++;
                continue;
            }
            if ($separator === ')') {
                $j++;
                break;
            }
            $this->failAt($j, "',' or ')'");
            return [null, $this->skipParentheses($j)];
        }
        if ($malformed) {
            $this->error('type', $this->line, $column, self::parametersMessage($name));
            return [null, $j];
        }
        $valid = count($parameters) === ColumnType::PARAMETERIZED[$name] && match ($name) {
            'decimal' => $parameters[0] >= 1 && $parameters[0] <= 18 && $parameters[1] <= $parameters[0],
            'varchar' => $parameters[0] >= 1 && $parameters[0] <= 16383,
            'time', 'datetime' => $parameters[0] <= 6,
        };
        if (!$valid) {
            $this->error('type', $this->line, $column, self::parametersMessage($name));
            return [null, $j];
        }
        $text = $name . '(' . implode(',', $parameters) . ')';
        return [$this->types[$text] ??= new ColumnType($name, $parameters), $j];
    }

    /**
     * Go's readValue at token $i: a number with a `-` before it, a word, a number, or (when $string) a string.
     *
     * @return ?array{0: array{0:string,1:int}, 1: int} the value and the next token, or null after a syntax error
     */
    private function valueAt(int $i, string $what, bool $string): ?array
    {
        $t = $this->tokens;
        $token = $t[$i] ?? null;
        if (($token[0] ?? null) === '-') {
            if (isset($t[$i + 1]) && self::isNumber($t[$i + 1][0])) {
                return [['-' . $t[$i + 1][0], $token[1]], $i + 2];
            }
            $this->failAt($i + 1, "a number after '-'");
            return null;
        }
        if ($token !== null && (self::isWord($token[0]) || ($string && Literal::stringValue($token[0]) !== null))) {
            return [[$token[0], $token[1]], $i + 1];
        }
        $this->failAt($i, $what);
        return null;
    }

    private static function parametersMessage(string $name): string
    {
        return match ($name) {
            'decimal' => 'decimal(p,s) needs 1 <= p <= 18 and 0 <= s <= p',
            'varchar' => 'varchar(n) needs 1 <= n <= 16383',
            default => "$name(p) needs 0 <= p <= 6",
        };
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
            $this->error('key', $this->line, $first[1], 'table has more than one primary key');
            return;
        }
        $this->table->primaryKey = new PrimaryKey(
            array_map(static fn(array $c): string => $c[0], $list[0]),
            $this->takeComments()
        );
        $this->declare('constraint', [$this->table->name, 'primary key'], $first);
        $this->checkKeyColumns($list[0], $first[1], true);
    }

    private function keyLine(bool $index): void
    {
        $name = $this->wordAt(1, $index ? 'a index name' : 'a unique name');
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
            $this->table->indexes[] = new Index(
                $name[0],
                array_map(static fn(array $c): IndexColumn => new IndexColumn($c[0], $c[2]), $list[0]),
                $this->takeComments()
            );
        } else {
            $this->table->uniqueKeys[] = new UniqueKey($name[0], $columns, $this->takeComments());
        }
        $this->declare('constraint', [$this->table->name, $name[0]], $name);
        $this->checkKeyColumns($list[0], $name[1], false);
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
    private function checkKeyColumns(array $columns, int $at, bool $primary): void
    {
        $seen = [];
        $varchar = 0;
        foreach ($columns as [$name, $position]) {
            if (!$this->name([$name, $position])) {
                continue;
            }
            if (!isset($this->columns[$name])) {
                $this->error('key', $this->line, $position, $this->unknownColumn($name, $this->table->name));
                continue;
            }
            $column = $this->columns[$name];
            if ($this->isStandIn($column)) {
                continue;
            }
            if (isset($seen[$name])) {
                $this->error('key', $this->line, $position, 'column ' . self::quoted($name) . ' repeats in the key');
                continue;
            }
            $seen[$name] = true;
            $type = $column->type;
            if ($type->name === 'text' || $type->name === 'bytes') {
                $this->error('key', $this->line, $position, "a {$type->name} column cannot be part of a key or index");
            }
            if ($primary && $column->nullable) {
                $this->error(
                    'key',
                    $this->line,
                    $position,
                    'primary key column ' . self::quoted($name) . ' is nullable'
                );
            }
            if ($type->name === 'varchar') {
                $varchar += $type->parameters[0];
            }
        }
        if (count($columns) > self::MAX_KEY_COLUMNS) {
            $this->error('key', $this->line, $at, 'a key or index lists ' . count($columns) . ' columns, more than '
                . self::MAX_KEY_COLUMNS);
        }
        if ($varchar > self::MAX_KEY_VARCHAR) {
            $this->error('key', $this->line, $at, "the varchar columns of the key total $varchar characters, more than "
                . self::MAX_KEY_VARCHAR);
        }
    }

    /** Go's column %q is not a column of table %q. */
    private function unknownColumn(string $column, string $table): string
    {
        return 'column ' . self::quoted($column) . ' is not a column of table ' . self::quoted($table);
    }

    /** Whether the column stands in for a column line that failed: Go knows no such column. */
    private function isStandIn(Column $column): bool
    {
        return isset($this->standIns[spl_object_id($column)]);
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
            $this->stop(
                'limit',
                $this->line,
                $t[0][1],
                'document has more than ' . self::MAX_FOREIGN_KEYS . ' foreign keys'
            );
        }
        if (!$this->expectAt(1, 'key')) {
            return;
        }
        $name = $this->wordAt(2, 'a foreign key name');
        if ($name === null) {
            return;
        }
        $children = $this->columnList(3, false);
        if ($children === null || !$this->expectAt($children[1], 'references')) {
            return;
        }
        $target = $this->wordAt($children[1] + 1, 'a table name');
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
            // As Go, `on` before anything but `delete` is read as `on update`.
            if (($t[$i][0] ?? null) === 'on' && ($event === 'update' || ($t[$i + 1][0] ?? null) === $event)) {
                $this->mark($t[$i], 'keyword');
                if (!$this->expectAt($i + 1, $event)) {
                    return;
                }
                $action = $t[$i + 2] ?? null;
                if ($action === null || !self::isWord($action[0])) {
                    $this->failAt($i + 2, 'an action');
                    return;
                }
                if (in_array($action[0], ForeignKey::ACTIONS, true)) {
                    $this->mark($action, 'keyword');
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
                $this->error('foreign_key', $this->line, $action[1], 'action ' . self::quoted($action[0])
                    . ' is not restrict, cascade or set_null');
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
        $this->declare('constraint', [$this->table->name, $name[0]], $name);
        $known = true;
        // Go's known: the index check is done only when the child columns are all known and do not overlap.
        $childrenKnown = true;
        $seen = [];
        foreach ($children[0] as [$column, $position]) {
            if (!$this->name([$column, $position])) {
                $known = false;
                $childrenKnown = false;
            } elseif (!isset($this->columns[$column])) {
                $this->error('foreign_key', $this->line, $position, $this->unknownColumn($column, $this->table->name));
                $known = false;
                $childrenKnown = false;
            } elseif ($this->isStandIn($this->columns[$column])) {
                $known = false;
                $childrenKnown = false;
            } elseif (isset($seen[$column])) {
                $this->error('foreign_key', $this->line, $position, 'column ' . self::quoted($column)
                    . ' repeats in the foreign key');
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
            $this->deferredForeignKeys[] = [$this->columns, $foreignKey, $this->line, $name[1], $target[1],
                $parents[0]];
        }
    }

    private function checkLine(): void
    {
        $name = $this->wordAt(1, 'a check name');
        if ($name === null || !$this->expectAt(2, '(')) {
            return;
        }
        // Go: the tokens after `(` end with `)`; otherwise the line fails at its end and declares no check.
        $rest = array_slice($this->tokens, 3);
        if ($rest === [] || end($rest)[0] !== ')') {
            $this->failAt(count($this->tokens), "')' at the end of the check");
            return;
        }
        $this->constraintName($name);
        $check = new Check($name[0], '', $this->takeComments());
        $this->table->checks[] = $check;
        $this->declare('constraint', [$this->table->name, $name[0]], $name);
        $this->tableChecks[] = [$check, $this->line, array_slice($this->tokens, 3), end($rest)[1]];
    }

    /**
     * Opens the table's settings block: the first block is kept, and a repeated block is not attached to the
     * table; only its syntax is read (Go's detached block).
     */
    private function openSettingsBlock(Settings $settings): void
    {
        $this->detachedBlock = $this->table->settings !== null;
        $this->table->settings ??= $settings;
        $this->settingsBlock = $this->detachedBlock ? $settings : $this->table->settings;
        $this->settingsFailed = isset($this->syntaxLines[$this->line]);
    }

    private function settingsLine(): void
    {
        $t = $this->tokens;
        [$keyword, $at] = $t[0];
        if ($keyword === '}') {
            $this->endAt(1);
            $this->settingsBlock->closingComments = $this->takeComments();
            $this->state = 'table';
            $this->settingsFailed = false;
            return;
        }
        if (!self::isWord($keyword) || self::isNumber($keyword)) {
            $this->failAt(0, "a setting or '}'");
            return;
        }
        $this->mark($t[0], 'setting');
        if (in_array($keyword, self::STORAGE_KEYWORDS, true)) {
            $this->storageLine($keyword, $at);
            return;
        }
        $known = ['entity', 'updated', 'soft_delete', 'aes_version', 'select', 'codec', 'blind_index', 'navigation',
            'immutable', 'audit'];
        if (!in_array($keyword, $known, true)) {
            $this->error('setting', $this->line, $at, 'setting ' . self::quoted($keyword) . ' is unknown');
            return;
        }
        // The line is read by the cursor as Go's settingsLine reads it: the first token that breaks the grammar
        // fails the line.
        $this->cursor = 1;
        $lists = [];
        try {
            $arguments = $this->settingArguments($keyword, $lists);
            if (isset($this->tokens[$this->cursor])) {
                throw $this->cursorFail('the end of the line');
            }
        } catch (SettingFailure) {
            return;
        }
        $kind = $keyword === 'select' ? 'select_explicit' : $keyword;
        $perName = $kind === 'codec' || $kind === 'navigation' || $kind === 'blind_index';
        $key = $perName ? $kind . ' ' . $arguments[0][0] : $kind;
        if (!$this->detachedBlock) {
            if (isset($this->settingKeys[$key])) {
                $this->error(
                    'setting',
                    $this->line,
                    $at,
                    $perName ? "$kind repeats for " . self::quoted($arguments[0][0]) : "setting $keyword repeats"
                );
                return;
            }
            $this->settingKeys[$key] = true;
        }
        // Every argument is a name, except the stages of a codec.
        foreach ($kind === 'codec' ? [$arguments[0]] : $arguments as $argument) {
            $this->name($argument);
        }
        // Names in a list are checked only the first time they appear. An audit column is rejected by a separate check.
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
        $this->settingsBlock->settings[] = new Setting(
            $kind,
            array_map(static fn(array $a): string => $a[0], $arguments),
            $this->takeComments(),
            $listed['exclude'] ?? null,
            $listed['include'] ?? null
        );
        if (!$this->detachedBlock) {
            $this->declare('setting', [$this->table->name, $keyword,
                ...self::settingIdentity($keyword, $arguments)], [$keyword, $at]);
            $this->tableSettings[] = [$kind, $arguments, $this->line, $at, $lists];
        }
    }

    /**
     * From the cursor, reads the arguments of a setting other than a storage setting (Go's settingsLine). The
     * arguments of select leave out `explicit`; those of audit are the history table, the audit column, the audit
     * record table, the action and the previous column, and then the tables table, the record and the name column.
     *
     * @param list<array{0: array{0: string, 1: int}, 1: list<array{0: string, 1: int}>}> $lists the audit lists read
     * @return list<array{0:string,1:int}>
     */
    private function settingArguments(string $keyword, array &$lists): array
    {
        switch ($keyword) {
            case 'entity':
                return [$this->cursorWord('an entity name')];
            case 'select':
                $this->cursorKeyword('explicit');
                $arguments = [$this->cursorWord('a column name')];
                while (isset($this->tokens[$this->cursor])) {
                    $arguments[] = $this->cursorWord('a column name');
                }
                return $arguments;
            case 'codec':
                $arguments = [$this->cursorWord('a column name')];
                do {
                    $arguments[] = $this->cursorStage();
                } while (isset($this->tokens[$this->cursor]));
                return $arguments;
            case 'blind_index':
                return [$this->cursorWord('the AES column'), $this->cursorWord('the index column')];
            case 'navigation':
                return [$this->cursorWord('a foreign key name'), $this->cursorWord('the child relation name'),
                    $this->cursorWord('the parent relation name')];
            case 'immutable':
                return [];
            case 'audit':
                $arguments = [];
                foreach (
                    ['into' => 'the history table', 'column' => 'the audit column',
                    'references' => 'the audit record table', 'action' => 'the action column',
                    'previous' => 'the previous column'] as $word => $what
                ) {
                    $this->cursorKeyword($word);
                    $arguments[] = $this->cursorWord($what);
                }
                if (($this->tokens[$this->cursor][0] ?? null) === 'tables') {
                    $this->cursorKeyword('tables');
                    $arguments[] = $this->cursorWord('the tables table');
                    $this->cursorPunct('(');
                    $arguments[] = $this->cursorWord('the record column');
                    $this->cursorPunct(',');
                    $arguments[] = $this->cursorWord('the name column');
                    $this->cursorPunct(')');
                }
                while (in_array($this->tokens[$this->cursor][0] ?? null, ['exclude', 'include'], true)) {
                    $list = $this->take('keyword');
                    $this->cursorPunct('(');
                    $columns = [];
                    for (;;) {
                        $columns[] = $this->cursorWord('a column name');
                        if (($this->tokens[$this->cursor][0] ?? null) === ')') {
                            $this->cursor++;
                            break;
                        }
                        if (($this->tokens[$this->cursor][0] ?? null) !== ',') {
                            throw $this->cursorFail("',' or ')'");
                        }
                        $this->cursor++;
                    }
                    $lists[] = [$list, $columns];
                }
                if (isset($this->tokens[$this->cursor])) {
                    throw $this->cursorFail(count($arguments) === 5
                        ? "'tables', 'exclude', 'include' or the end of the line"
                        : "'exclude', 'include' or the end of the line");
                }
                return $arguments;
            default:
                return [$this->cursorWord('a column name')];
        }
    }

    /** Consumes the fixed word at the cursor, else fails the line. */
    private function cursorKeyword(string $word): void
    {
        if (($this->tokens[$this->cursor][0] ?? null) !== $word) {
            throw $this->cursorFail("'$word'");
        }
        $this->take('keyword');
    }

    /** Consumes the punctuation at the cursor, else fails the line. */
    private function cursorPunct(string $punct): void
    {
        if (($this->tokens[$this->cursor][0] ?? null) !== $punct) {
            throw $this->cursorFail("'$punct'");
        }
        $this->cursor++;
    }

    /** A codec stage: a word or number, a keyword when it is a known stage (Go's member). */
    private function cursorStage(): array
    {
        $token = $this->tokens[$this->cursor] ?? null;
        if ($token === null || !self::isWord($token[0])) {
            throw $this->cursorFail('a codec stage');
        }
        if (in_array($token[0], self::CODEC_STAGES, true)) {
            return $this->take('keyword');
        }
        $this->cursor++;
        return $token;
    }


    private function openDiagram(): void
    {
        $t = $this->tokens;
        $name = $this->wordAt(1, 'a diagram name');
        $this->diagramFailed = false;
        $this->state = 'diagram';
        $this->blockOpen = $this->openedAt(2);
        $this->diagramTables = [];
        $this->diagram = new Diagram($name[0] ?? '', $this->takeComments());
        $this->document->diagrams[] = $this->diagram;
        if ($name === null) {
            $this->diagramFailed = true;
            return;
        }
        $this->declare('diagram', [$name[0]], $name);
        $this->mark($name, 'name');
        // As Go, the name of a diagram line that reads completely is checked, and a failed line repeats no name.
        if ($this->expectAt(2, '{') && $this->endAt(3)) {
            $this->name($name);
            if (isset($this->diagramNames[$name[0]])) {
                $this->error('name.duplicate', $this->line, $name[1], 'diagram ' . self::quoted($name[0])
                    . ' is defined twice');
            }
        }
        $this->diagramNames[$name[0]] = true;
        $this->diagramFailed = isset($this->syntaxLines[$this->line]);
    }

    private function diagramLine(): void
    {
        $t = $this->tokens;
        if ($t[0][0] === '}') {
            $this->endAt(1);
            $this->diagram->closingComments = $this->takeComments();
            $this->diagramFailed = false;
            $this->state = 'top';
            return;
        }
        $table = $this->wordAt(0, "a table name or '}'");
        if ($table === null || !$this->expectAt(1, 'at')) {
            return;
        }
        $x = $this->valueAt(2, 'the x coordinate', true);
        if ($x === null) {
            return;
        }
        $this->markValue($t[2]);
        $i = $x[1];
        // A `-` before a word is a coordinate that is not an integer, reported at its `-` (as Go).
        if (
            ($t[$i][0] ?? null) === '-' && isset($t[$i + 1]) && self::isWord($t[$i + 1][0])
            && !self::isNumber($t[$i + 1][0])
        ) {
            $y = [['-' . $t[$i + 1][0], $t[$i][1]], $i + 2];
        } else {
            $y = $this->valueAt($i, 'the y coordinate', true);
            if ($y === null) {
                return;
            }
            $this->markValue($t[$i]);
        }
        $coordinates = [$x[0], $y[0]];
        $i = $y[1];
        if (!$this->endAt($i)) {
            return;
        }
        $valid = $this->name($table);
        if ($valid && !isset($this->tables[$table[0]]) && isset($this->failedTables[$table[0]])) {
            // A table of a failed use line reports nothing more, not even its coordinates (as Go).
            return;
        }
        if (!$valid) {
            $valid = false;
        } elseif (!isset($this->tables[$table[0]])) {
            $this->error('diagram', $this->line, $table[1], 'table ' . self::quoted($table[0])
                . ' is not a table of this document or a used table');
            $valid = false;
        } elseif (isset($this->diagramTables[$table[0]])) {
            $this->error(
                'diagram',
                $this->line,
                $table[1],
                'table ' . self::quoted($table[0]) . ' appears twice in the diagram'
            );
            $valid = false;
        }
        if (self::validName($table[0])) {
            $this->diagramTables[$table[0]] = true;
        }
        $values = [];
        foreach ($coordinates as [$text, $column]) {
            $integer = Literal::integer($text);
            $digits = ltrim((string) $integer, '-');
            if (
                $integer === null || strlen($digits) > 10
                || (strlen($digits) === 10 && strcmp($digits, $integer[0] === '-' ? '2147483648' : '2147483647') > 0)
            ) {
                $this->error('diagram', $this->line, $column, 'coordinate ' . self::describe($text)
                    . ' is not an integer from -2147483648 to 2147483647');
                $valid = false;
                continue;
            }
            $values[] = (int) $integer;
        }
        if ($valid) {
            $this->diagram->placements[] = new Placement($table[0], $values[0], $values[1], $this->takeComments());
            $this->declare('diagram_entry', [$this->diagram->name, $table[0]], $table);
        }
    }

    // ------------------------------------------------------- table checks

    private function closeTable(): void
    {
        $this->tableFailed = false;
        $this->settingsFailed = false;
        $table = $this->table;
        $primary = $table->primaryKey;
        if ($this->columns === []) {
            $this->error(
                'column',
                $this->tableName[0],
                $this->tableName[1],
                'table ' . self::quoted($table->name) . ' has no column'
            );
        }
        if ($primary === null && !$this->failedPrimary) {
            $this->error('key', $this->tableName[0], $this->tableName[1], 'table ' . self::quoted($table->name)
                . ' has no primary key');
        }
        foreach ($this->identities as [$name, $line, $column, $rejected]) {
            $resolved = $primary === null || array_reduce(
                $primary->columns,
                fn(bool $ok, string $c): bool => $ok && self::validName($c) && !isset($this->failedColumns[$c]),
                true
            );
            if (
                !$rejected && !$this->failedPrimary
                && ($primary === null || ($resolved && $primary->columns !== [$name]))
            ) {
                $this->error('column', $line, $column, 'the identity column must be the only primary key column');
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
            // Go checks set_null against known children even when the child columns are unknown; it skips only
            // the index check.
            if ($childrenKnown) {
                $covered = false;
                foreach ($leading as $columns) {
                    if (array_slice($columns, 0, count($foreignKey->columns)) === $foreignKey->columns) {
                        $covered = true;
                        break;
                    }
                }
                if (
                    !$covered && !isset($this->failedKeyTables[$table->name])
                    && !isset($this->failedPrimaryTables[$table->name])
                ) {
                    // Go reports these after the checks of the referenced table, which run after the last line.
                    $this->laterForeignKeyDiagnostics[] = ['foreign_key', $line, $column,
                        'the table declares no index or key whose leading columns are the foreign key columns'];
                }
            }
            if ($foreignKey->onDelete === 'set_null' || $foreignKey->onUpdate === 'set_null') {
                foreach ($foreignKey->columns as $child) {
                    if (
                        isset($this->columns[$child]) && !$this->isStandIn($this->columns[$child])
                        && !$this->columns[$child]->nullable
                    ) {
                        $this->laterForeignKeyDiagnostics[] = ['foreign_key', $line, $column,
                            'set_null requires every foreign key column to be null; ' . self::quoted($child)
                            . ' is not'];
                        break;
                    }
                }
            }
        }
        $checkColumns = [];
        // A column of a failed column line is unknown to a check, and reports nothing (Go's failedName).
        $real = array_filter($this->columns, fn(Column $c): bool => !$this->isStandIn($c));
        $standIns = array_fill_keys(array_map('strval', array_keys(array_diff_key($this->columns, $real))), true);
        foreach ($this->tableChecks as [$check, $line, $tokens, $end]) {
            [$text, $errors, $refs, $marks] = Expression::parse(
                $tokens,
                $line,
                $end,
                $real,
                $actionColumns,
                $table->name,
                $standIns
            );
            if ($this->marking) {
                foreach ($marks as $index => $class) {
                    $this->marks[$line][$index] = $class;
                }
            }
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
     * @param list<list<string>> $leading The column lists of the table's key and index
     * @param list<string> $checkColumns The columns that the table's check reads
     */
    private function checkSettings(array $leading, bool $changedByForeignKeys, array $checkColumns): void
    {
        $kinds = [];
        $aes = [];
        foreach ($this->tableSettings as [$kind, $arguments]) {
            $kinds[$kind] = true;
            if (
                $kind === 'codec' && in_array(
                    'aes',
                    array_map(static fn(array $a): string => $a[0], array_slice($arguments, 1)),
                    true
                )
            ) {
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
            $column = fn(array $token): ?Column => self::validName($token[0])
                ? $this->columnDefinition($token, $line, $kind, true) : null;
            // Go's columnRef: the column also when its type is invalid.
            $any = fn(array $token): ?Column => self::validName($token[0])
                ? $this->columnDefinition($token, $line, $kind, false) : null;
            switch ($kind) {
                case 'updated':
                    $definition = $column($arguments[0]);
                    if ($definition !== null && $definition->type->name !== 'datetime') {
                        $this->error('setting', $line, $arguments[0][1], 'updated needs a datetime column, not '
                            . $definition->type->text());
                    }
                    break;
                case 'soft_delete':
                    $definition = $any($arguments[0]);
                    if (
                        $definition !== null && (!in_array($definition->type->name, ['invalid', 'datetime'], true)
                        || !$definition->nullable)
                    ) {
                        $this->error(
                            'setting',
                            $line,
                            $arguments[0][1],
                            'soft_delete needs a nullable datetime column'
                        );
                    }
                    break;
                case 'select_explicit':
                    $seen = [];
                    foreach ($arguments as $token) {
                        if (isset($seen[$token[0]])) {
                            $this->error('setting', $line, $token[1], 'column ' . self::quoted($token[0])
                                . ' repeats in select explicit');
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
                            $this->error(
                                'setting',
                                $line,
                                $stage[1],
                                'codec stage ' . self::quoted($stage[0]) . ' is unknown'
                            );
                            $known = false;
                        } elseif ($stage[0] === 'ordered_json' && $n > 0) {
                            $this->error('setting', $line, $stage[1], 'ordered_json is the first codec stage');
                        }
                    }
                    $definition = $column($arguments[0]);
                    if ($definition !== null && $known) {
                        $last = end($stages)[0];
                        $text = in_array($last, self::TEXT_STAGES, true);
                        $type = $definition->type->name;
                        if ($text ? $type !== 'varchar' && $type !== 'text' : $type !== 'bytes') {
                            $this->error('setting', $line, $arguments[0][1], "the last codec stage $last stores "
                                . ($text ? 'text and needs a varchar or text' : 'bytes and needs a bytes')
                                . " column, not {$definition->type->text()}");
                        }
                    }
                    if (isset($aes[$arguments[0][0]]) && !isset($kinds['aes_version'])) {
                        $this->error(
                            'setting',
                            $line,
                            $at,
                            'a column with the aes stage requires an aes_version setting'
                        );
                    }
                    break;
                case 'aes_version':
                    if ($aes === []) {
                        $this->error('setting', $line, $at, 'aes_version without a column that uses aes');
                    }
                    $definition = $any($arguments[0]);
                    if (
                        $definition !== null
                        && (($definition->type->name !== 'invalid' && !$definition->type->isInteger())
                        || $definition->nullable)
                    ) {
                        $this->error('setting', $line, $arguments[0][1], 'aes_version needs a non-null integer column');
                    }
                    break;
                case 'blind_index':
                    [$source, $target] = $arguments;
                    $encrypted = $any($source);
                    if ($encrypted !== null && !isset($aes[$source[0]])) {
                        $this->error('setting', $line, $at, 'blind_index names column ' . self::quoted($source[0])
                            . ', which has no codec with the aes stage');
                    }
                    $index = $any($target);
                    if ($index === null) {
                        break;
                    }
                    $type = $index->type;
                    $message = match (true) {
                        isset($aes[$target[0]]) => 'the blind index column is not AES-encoded',
                        $type->name !== 'invalid' && !($type->name === 'varchar' && $type->parameters[0] >= 64)
                            => "the blind index column is varchar(n) with n >= 64, not {$type->text()}",
                        $encrypted !== null && $encrypted->nullable !== $index->nullable
                            => 'the blind index column has the nullability of the AES column',
                        !isset($singleColumnKeys[$target[0]]) && !isset($this->failedKeyTables[$this->table->name])
                            => 'column ' . self::quoted($target[0])
                                . ' is not the only column of a declared index or unique key',
                        default => null,
                    };
                    if ($message !== null) {
                        $this->error('setting', $line, $target[1], $message);
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
                        $this->error('setting', $line, $arguments[0][1], 'foreign key ' . self::quoted($arguments[0][0])
                            . ' is not a foreign key of the table');
                    }
                    break;
                case 'immutable':
                    if ($changedByForeignKeys) {
                        $this->error(
                            'setting',
                            $line,
                            $at,
                            'immutable is rejected on a child of a cascade or set_null foreign key'
                        );
                    }
                    foreach (['immutable_update', 'immutable_delete'] as $event) {
                        $this->claimGenerated(
                            Names::render($this->table->name, $event),
                            "table {$this->table->name} setting immutable",
                            $line,
                            $at
                        );
                    }
                    break;
                case 'markdown':
                    $definition = $this->columnRef($arguments[0], $line, $kind);
                    if (
                        $definition !== null && $definition->type->name !== 'invalid'
                        && !in_array($definition->type->name, ['varchar', 'text'], true)
                    ) {
                        $this->error(
                            'setting',
                            $line,
                            $arguments[0][1],
                            "markdown needs a varchar or text column, not {$definition->type->text()}"
                        );
                    }
                    break;
                case 'store':
                    if ($arguments[0][0] === 'block') {
                        $this->foreignKeyNamed($arguments[1], $line);
                    }
                    $this->checkStoreShard($arguments, $line, isset($kinds['order']));
                    break;
                case 'title':
                case 'body':
                    $this->requireTextColumn(
                        $arguments[0],
                        $line,
                        $kind,
                        "$kind needs a non-null varchar or text column"
                    );
                    break;
                case 'order':
                    $definition = $this->columnRef($arguments[0], $line, $kind);
                    if ($definition === null) {
                        break;
                    }
                    if (
                        ($definition->type->name !== 'invalid'
                        && !in_array($definition->type->name, ['i32', 'i64'], true))
                        || $definition->nullable || $definition->default !== null
                    ) {
                        $this->error(
                            'setting',
                            $line,
                            $arguments[0][1],
                            'order needs a non-null i32 or i64 column with no default'
                        );
                    } elseif ($this->inKeyOrCheck($arguments[0][0], $checkColumns)) {
                        $this->error(
                            'setting',
                            $line,
                            $arguments[0][1],
                            'order column ' . self::quoted($arguments[0][0]) . ' is in a key, index or check'
                        );
                    }
                    break;
                case 'task_marker':
                    $definition = $this->columnRef($arguments[0], $line, $kind);
                    if (
                        $definition !== null && $definition->type->name !== 'invalid'
                        && $definition->type->name !== 'bool' && $definition->type->text() !== 'varchar(1)'
                    ) {
                        $this->error(
                            'setting',
                            $line,
                            $arguments[0][1],
                            "task_marker needs a varchar(1) or bool column, not {$definition->type->text()}"
                        );
                    }
                    break;
                case 'audit':
                    if ($changedByForeignKeys) {
                        $this->error(
                            'setting',
                            $line,
                            $at,
                            'audit is rejected on a child of a cascade or set_null foreign key'
                        );
                    }
                    foreach (['audit_insert', 'audit_update', 'audit_delete'] as $event) {
                        $this->claimGenerated(
                            Names::render($this->table->name, $event),
                            "table {$this->table->name} setting audit",
                            $line,
                            $at
                        );
                    }
                    $audit = $any($arguments[1]);
                    if ($audit !== null && $audit->nullable) {
                        $this->error('setting', $line, $arguments[1][1], 'the audit column is a non-null column');
                    }
                    $recorded = $this->auditLists($lists, $arguments[1][0], $line, $column);
                    if (self::validName($arguments[2][0])) {
                        $this->deferredAuditRecords[] = [$this->table, $audit, $arguments, $line,
                            isset($this->failedKeyTables[$this->table->name])
                            || isset($this->failedPrimaryTables[$this->table->name])];
                    }
                    if (
                        self::validName($arguments[0][0]) && self::validName($arguments[3][0])
                        && self::validName($arguments[4][0])
                    ) {
                        $this->deferredAudits[] = [$this->table, $this->columns, $arguments, $audit?->type, $line,
                            $recorded];
                    }
                    break;
            }
        }
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
                $this->error('foreign_key', $line, $targetAt, 'table ' . self::quoted($foreignKey->table)
                    . ' is not a table of this document or a used table');
                continue;
            }
            if ($target['table'] === null) {
                continue;
            }
            // Go does not check the column count, pairing, or type of a target whose table line failed
            // (validate.go's foreignKey).
            if ($target['headerFailed'] ?? false) {
                continue;
            }
            $targetColumns = $target['columns'];
            // Same as Go's foreignKey: the count check is done regardless of whether the child columns are known,
            // while the pairing and type checks are done when all the reference columns are known.
            // Known. The type check looks only at known children, and stops at the first mismatch.
            $referencesKnown = true;
            foreach ($parents as [$parent, $position]) {
                if (!isset($targetColumns[$parent])) {
                    $this->error('foreign_key', $line, $position, $this->unknownColumn($parent, $foreignKey->table));
                    $referencesKnown = false;
                } elseif ($this->isStandIn($targetColumns[$parent])) {
                    $referencesKnown = false;
                }
            }
            if (count($foreignKey->columns) !== count($foreignKey->referencedColumns)) {
                $this->error('foreign_key', $line, $at, 'foreign key lists ' . count($foreignKey->columns)
                    . ' columns and ' . count($foreignKey->referencedColumns) . ' referenced columns');
                continue;
            }
            if (!$referencesKnown) {
                continue;
            }
            $keys = $target['table']->primaryKey === null ? [] : [$target['table']->primaryKey->columns];
            foreach ($target['table']->uniqueKeys as $unique) {
                $keys[] = $unique->columns;
            }
            if (
                !in_array($foreignKey->referencedColumns, $keys, true)
                && !isset($this->failedKeyTables[$foreignKey->table])
                && !isset($this->failedPrimaryTables[$foreignKey->table])
            ) {
                $this->error('foreign_key', $line, $at, 'the referenced columns are not the primary key or a '
                    . 'unique key of table ' . self::quoted($foreignKey->table));
            }
            foreach ($foreignKey->columns as $i => $child) {
                if (!isset($columns[$child]) || $columns[$child]->type->name === 'invalid') {
                    continue;
                }
                $parentType = $targetColumns[$foreignKey->referencedColumns[$i]]->type;
                if (
                    $parentType->name !== 'invalid' && $columns[$child]->type !== $parentType
                    && $columns[$child]->type->text() !== $parentType->text()
                ) {
                    $this->error('foreign_key', $line, $at, 'column ' . self::quoted($child)
                        . " has type {$columns[$child]->type->text()}, the referenced column has "
                        . $parentType->text());
                    break;
                }
            }
        }
        foreach ($this->laterForeignKeyDiagnostics as $diagnostic) {
            $this->error(...$diagnostic);
        }
    }

    /**
     * Checks the audit's exclude or include list, and returns a function telling whether a column is recorded
     * (docs/spec/dbspec.md "Audit"). If both lists are used, it rejects at the keyword of the second list and
     * returns null
     * . The columns in the list are table columns, appear only once, and are not audit columns.
     * Audit columns are always recorded, so they are not used in either list.
     *
     * @param list<array{0: array{0: string, 1: int}, 1: list<array{0: string, 1: int}>}> $lists
     * @param \Closure(array): ?Column $column
     * @return (\Closure(string): bool)|null
     */
    private function auditLists(array $lists, string $audit, int $line, \Closure $column): ?\Closure
    {
        if (count($lists) > 1) {
            $this->error(
                'setting',
                $line,
                $lists[1][0][1],
                'audit names its recorded columns by exclude or by include, not both'
            );
            return null;
        }
        $listed = [];
        foreach ($lists as [$keyword, $columns]) {
            foreach ($columns as $token) {
                if (isset($listed[$token[0]])) {
                    $this->error(
                        'setting',
                        $line,
                        $token[1],
                        'column ' . self::quoted($token[0]) . " repeats in audit {$keyword[0]}"
                    );
                    continue;
                }
                if ($token[0] === $audit) {
                    $this->error(
                        'setting',
                        $line,
                        $token[1],
                        'the audit column ' . self::quoted($token[0])
                            . ' is always recorded and is not listed in exclude or include'
                    );
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
     * Checks the audit record table. That table is another table of this document or of a used document, and
     * not a history
     * table; it is not itself audited, and it has a primary key of one column whose type is
     * the audit column's type. The audit column is the only column of a declared foreign key that restricts
     * its primary key
     * foreign key. So an audit column value without an audit record row is one the database
     * rejects.
     */
    private function checkAuditRecords(): void
    {
        foreach ($this->deferredAuditRecords as [$audited, $column, $arguments, $line, $failedKeys]) {
            [$historyToken, $columnToken, $referencesToken] = $arguments;
            $name = $referencesToken[0];
            $entry = $this->settingTable($referencesToken, $line, 'audit record table');
            if ($entry === null) {
                continue;
            }
            $record = $entry['table'];
            if ($record === null) {
                continue;
            }
            // Go does not check the key of an audit record table whose table line failed (settings.go's auditRecord).
            if ($entry['headerFailed'] ?? false) {
                continue;
            }
            if ($record === $audited) {
                $this->error('setting', $line, $referencesToken[1], 'a table cannot record its audits in itself');
                continue;
            }
            if ($name === $historyToken[0]) {
                $this->error(
                    'setting',
                    $line,
                    $referencesToken[1],
                    'the audit record table is another table than the history table'
                );
                continue;
            }
            foreach ($record->settings?->settings ?? [] as $setting) {
                if ($setting->kind === 'audit') {
                    $this->error(
                        'setting',
                        $line,
                        $referencesToken[1],
                        'audit record table ' . self::quoted($name) . ' is audited itself'
                    );
                }
            }
            $key = $record->primaryKey?->columns ?? [];
            if (count($key) !== 1) {
                if (!isset($this->failedPrimaryTables[$name])) {
                    $this->error(
                        'setting',
                        $line,
                        $referencesToken[1],
                        'audit record table ' . self::quoted($name) . ' needs a primary key of one column'
                    );
                }
                continue;
            }
            $pk = $entry['columns'][$key[0]] ?? null;
            if ($column === null || $pk === null) {
                continue;
            }
            if (
                $pk->type->name !== 'invalid' && $column->type->name !== 'invalid'
                && $pk->type->text() !== $column->type->text()
            ) {
                $this->error(
                    'setting',
                    $line,
                    $columnToken[1],
                    "the audit column has type {$column->type->text()}, not the type {$pk->type->text()} of the "
                    . 'primary key of ' . self::quoted($name)
                );
                continue;
            }
            foreach ($audited->foreignKeys as $foreignKey) {
                if (
                    $foreignKey->columns === [$columnToken[0]] && $foreignKey->table === $name
                    && $foreignKey->referencedColumns === [$key[0]]
                    && $foreignKey->onDelete === 'restrict' && $foreignKey->onUpdate === 'restrict'
                ) {
                    continue 2;
                }
            }
            if (!$failedKeys) {
                $this->error(
                    'setting',
                    $line,
                    $columnToken[1],
                    "the audit column needs the foreign key ($columnToken[0]) references $name ({$key[0]}) on delete "
                    . "restrict on update restrict"
                );
            }
        }
    }

    /**
     * Checks the tables table of `tables <table> (<record>, <name>)`: another table than the audited, the history
     * and the
     * audit record table, not audited itself, with exactly the record and the name column, the name column a varchar(n)
     * with n >= 63, the primary key (record, name) and the foreign key (record) references the audit record table's key
     * with restrict (docs/spec/dbspec.md "Audit").
     */
    private function checkAuditTables(): void
    {
        foreach ($this->deferredAuditRecords as [$audited, , $arguments, $line]) {
            if (count($arguments) !== 8) {
                continue;
            }
            [$historyToken, , $referencesToken, , , $tablesToken, $recordToken, $nameToken] = $arguments;
            $name = $tablesToken[0];
            $entry = $this->settingTable($tablesToken, $line, 'tables table');
            if ($entry === null) {
                continue;
            }
            $tables = $entry['table'];
            if ($tables === null || ($entry['headerFailed'] ?? false)) {
                continue;
            }
            if ($tables === $audited || $name === $historyToken[0] || $name === $referencesToken[0]) {
                $this->error('setting', $line, $tablesToken[1], 'the tables table is another table than the audited, '
                    . 'the history and the audit record table');
                continue;
            }
            foreach ($tables->settings?->settings ?? [] as $setting) {
                if ($setting->kind === 'audit') {
                    $this->error(
                        'setting',
                        $line,
                        $tablesToken[1],
                        'tables table ' . self::quoted($name) . ' is audited itself'
                    );
                    continue 2;
                }
            }
            $known = true;
            foreach ([$recordToken, $nameToken] as $token) {
                if (!isset($entry['columns'][$token[0]])) {
                    $this->error('setting', $line, $token[1], 'column ' . self::quoted($token[0])
                        . ' is not a column of tables table ' . self::quoted($name));
                    $known = false;
                }
            }
            if (!$known) {
                continue;
            }
            $type = $entry['columns'][$nameToken[0]]->type;
            if ($type->name !== 'invalid' && !($type->name === 'varchar' && (int) $type->parameters[0] >= 63)) {
                $this->error('setting', $line, $nameToken[1], 'the name column is a varchar(n) with n >= 63');
            }
            foreach ($tables->columns as $column) {
                if ($column->name !== $recordToken[0] && $column->name !== $nameToken[0]) {
                    $this->error('setting', $line, $tablesToken[1], 'tables table ' . self::quoted($name)
                        . ' has the extra column ' . self::quoted($column->name));
                }
            }
            if (
                !isset($this->failedPrimaryTables[$name])
                && ($tables->primaryKey?->columns ?? []) !== [$recordToken[0], $nameToken[0]]
            ) {
                $this->error('setting', $line, $tablesToken[1], 'the primary key of tables table ' . self::quoted($name)
                    . " is ({$recordToken[0]}, {$nameToken[0]})");
            }
            $record = $this->tables[$referencesToken[0]]['table'] ?? null;
            $key = $record?->primaryKey?->columns ?? [];
            if (
                $record === null || ($this->tables[$referencesToken[0]]['headerFailed'] ?? false)
                || count($key) !== 1 || isset($this->failedKeyTables[$name])
            ) {
                continue;
            }
            foreach ($tables->foreignKeys as $foreignKey) {
                if (
                    $foreignKey->columns === [$recordToken[0]] && $foreignKey->table === $referencesToken[0]
                    && $foreignKey->referencedColumns === $key
                    && $foreignKey->onDelete === 'restrict' && $foreignKey->onUpdate === 'restrict'
                ) {
                    continue 2;
                }
            }
            $this->error('setting', $line, $tablesToken[1], 'tables table ' . self::quoted($name)
                . ' needs the foreign key '
                . "({$recordToken[0]}) references {$referencesToken[0]} "
                . "({$key[0]}) on delete restrict on update restrict");
        }
    }

    private function checkAuditHistories(): void
    {
        foreach ($this->deferredAudits as [$audited, $columns, $arguments, $auditType, $line, $recorded]) {
            [$historyToken, , , $actionToken, $previousToken] = $arguments;
            $entry = $this->settingTable($historyToken, $line, 'history table');
            if ($entry === null) {
                continue;
            }
            if ($entry['table'] === null) {
                continue;
            }
            // Go does not match the columns of a history table whose table line failed (settings.go's audit).
            if ($entry['headerFailed'] ?? false) {
                continue;
            }
            $history = $entry['table'];
            $historyColumns = $entry['columns'];
            $quotedHistory = self::quoted($historyToken[0]);
            if ($history === $audited) {
                $this->error('setting', $line, $historyToken[1], 'a table cannot be its own history table');
                continue;
            }
            // As Go's audit: each mismatch in the shape of the history table is reported on its own.
            foreach ($history->settings?->settings ?? [] as $setting) {
                if ($setting->kind === 'audit') {
                    $this->error('setting', $line, $historyToken[1], "history table $quotedHistory is audited itself");
                }
            }
            // A column of a failed column line is unknown, and reports nothing more (Go's failedName).
            $found = fn(string $name): ?Column => isset($historyColumns[$name])
                && !$this->isStandIn($historyColumns[$name]) ? $historyColumns[$name] : null;
            $failed = fn(string $name): bool => isset($historyColumns[$name])
                && $this->isStandIn($historyColumns[$name]);
            $key = $history->primaryKey?->columns ?? [];
            $identity = count($key) === 1 ? $found($key[0]) : null;
            $reserved = [];
            if ($identity !== null && $identity->identity && $identity->type->name === 'i64') {
                $reserved[$identity->name] = true;
            } elseif (!isset($this->failedPrimaryTables[$history->name])) {
                $this->error('setting', $line, $historyToken[1], "history table $quotedHistory needs an i64 identity "
                    . 'primary key');
            }
            $action = $found($actionToken[0]);
            $message = match (true) {
                $action === null => $failed($actionToken[0]) ? null : 'column ' . self::quoted($actionToken[0])
                    . " is not a column of history table $quotedHistory",
                isset($reserved[$actionToken[0]]) => 'the action column is a separate column of the history table',
                $action->nullable || ($action->type->name !== 'invalid' && $action->type->text() !== 'varchar(8)')
                    => 'the action column is a non-null varchar(8)',
                default => null,
            };
            if ($message !== null) {
                $this->error('setting', $line, $actionToken[1], $message);
            }
            $reserved[$actionToken[0]] = true;
            $previous = $found($previousToken[0]);
            $message = match (true) {
                $previous === null => $failed($previousToken[0]) ? null : 'column ' . self::quoted($previousToken[0])
                    . " is not a column of history table $quotedHistory",
                isset($reserved[$previousToken[0]]) => 'the previous column is a separate column of the history table',
                !$previous->nullable => 'the previous column is nullable',
                $auditType !== null && $auditType->name !== 'invalid' && $previous->type->name !== 'invalid'
                    && $previous->type->text() !== $auditType->text()
                    => "the previous column has the audit column type {$auditType->text()}, not "
                        . $previous->type->text(),
                default => null,
            };
            if ($message !== null) {
                $this->error('setting', $line, $previousToken[1], $message);
            }
            $reserved[$previousToken[0]] = true;
            // A setting that used both lists does not match columns, since the recorded columns are not determined.
            if ($recorded === null) {
                continue;
            }
            // A column name made only of digits becomes an int as an array key, so it is turned back into a string.
            foreach ($columns as $name => $column) {
                $name = (string) $name;
                if ($this->isStandIn($column) || !$recorded($name)) {
                    continue;
                }
                $copy = $found($name);
                if ($copy === null && $failed($name)) {
                    continue;
                }
                if ($copy === null || isset($reserved[$name])) {
                    $this->error('setting', $line, $historyToken[1], "history table $quotedHistory has no copy of "
                        . 'column ' . self::quoted($name));
                } elseif (
                    $copy->type->name !== 'invalid' && $column->type->name !== 'invalid'
                    && $copy->type->text() !== $column->type->text()
                ) {
                    $this->error('setting', $line, $historyToken[1], 'history column ' . self::quoted($name)
                        . " has type {$copy->type->text()}, not {$column->type->text()}");
                }
            }
            foreach ($historyColumns as $name => $column) {
                $name = (string) $name;
                if ($this->isStandIn($column) || isset($reserved[$name])) {
                    continue;
                }
                if (isset($columns[$name]) && $this->isStandIn($columns[$name])) {
                    continue;
                }
                if (!isset($columns[$name])) {
                    $this->error('setting', $line, $historyToken[1], "history table $quotedHistory has column "
                        . self::quoted($name) . ', which is not a column of table ' . self::quoted($audited->name));
                } elseif (!$recorded($name)) {
                    $this->error('setting', $line, $historyToken[1], "history table $quotedHistory has column "
                        . self::quoted($name) . ', which table ' . self::quoted($audited->name) . ' does not record');
                }
            }
        }
    }

    // ---------------------------------------------------- storage settings

    /**
     * Reads one markdown storage setting line (`markdown`, `store`, `title`, `body`, `order`,
     * `task_marker`) by the cursor. As in Go's settingsLine,
     * the line ends at the first syntax error. The rules for the whole table are checked when the table closes.
     */
    private function storageLine(string $keyword, int $at): void
    {
        $this->cursor = 1;
        try {
            $arguments = $this->storageArguments($keyword);
            if (isset($this->tokens[$this->cursor])) {
                throw $this->cursorFail('the end of the line');
            }
        } catch (SettingFailure) {
            return;
        }
        if (!$this->detachedBlock) {
            if ($keyword === 'markdown' || in_array($keyword, self::ONCE_STORAGE, true)) {
                $key = $keyword === 'markdown' ? "markdown {$arguments[0][0]}" : $keyword;
                if (isset($this->settingKeys[$key])) {
                    $this->error('setting', $this->line, $at, $keyword === 'markdown'
                        ? 'markdown repeats for ' . self::quoted($arguments[0][0]) : "setting $keyword repeats");
                    return;
                }
                $this->settingKeys[$key] = true;
            }
        }
        $names = $arguments;
        if ($keyword === 'store' && count($names) > Setting::STORE_ARGUMENTS[$names[0][0]]) {
            array_splice($names, Setting::STORE_ARGUMENTS[$names[0][0]], 1);
        }
        $this->settingsBlock->settings[] = new Setting(
            $keyword,
            array_map(static fn(array $a): string => $a[0], $names),
            $this->takeComments(),
        );
        if (!$this->detachedBlock) {
            $this->declare('setting', [$this->table->name, $keyword,
                ...self::settingIdentity($keyword, $arguments)], [$keyword, $at]);
            $this->tableSettings[] = [$keyword, $arguments, $this->line, $at, []];
        }
    }

    /**
     * From the cursor, reads the arguments of the storage setting.
     *
     * @return list<array{0:string,1:int}>
     */
    private function storageArguments(string $keyword): array
    {
        switch ($keyword) {
            case 'store':
                $kind = $this->cursorOneOf("'files', 'document' or 'block'", ['files', 'document', 'block']);
                $arguments = [$kind];
                if ($kind[0] === 'block') {
                    $arguments[] = $this->cursorWord('a foreign key name');
                }
                if ($kind[0] !== 'files') {
                    $arguments[] = $this->cursorOneOf("'list' or 'table'", ['list', 'table']);
                }
                // The shard clause is also read in a block: a shard in a block table is a setting error. The
                // `shard` token
                // is kept for position and removed from the Setting's arguments.
                if (($this->tokens[$this->cursor][0] ?? null) === 'shard') {
                    $arguments[] = $this->take('keyword');
                    $arguments[] = $this->cursorWord('the shard column');
                    $arguments[] = $this->cursorOneOf("'year', 'month' or 'day'", ['year', 'month', 'day']);
                }
                return $arguments;
            default:
                return [$this->cursorWord('a column name')];
        }
    }

    /** A syntax error at the cursor position. Recorded on the line; the caller stops the line. */
    private function cursorFail(string $expected): SettingFailure
    {
        $token = $this->tokens[$this->cursor] ?? null;
        if ($token === null) {
            $this->error('syntax', $this->line, $this->endColumn(), "line ends, expected $expected");
        } else {
            // A token is shown as Go's cursor shows it: a string by its value, any other token by its text, in quotes.
            $shown = $token[0][0] === "'" && strlen($token[0]) >= 2
                ? "string '" . str_replace("''", "'", substr($token[0], 1, -1)) . "'" : "'{$token[0]}'";
            $this->error('syntax', $this->line, $token[1], "unexpected $shown, expected $expected");
        }
        return new SettingFailure();
    }

    /** @return array{0:string,1:int} A word or number token */
    private function cursorWord(string $what): array
    {
        $token = $this->tokens[$this->cursor] ?? null;
        if ($token === null || !self::isWord($token[0])) {
            throw $this->cursorFail($what);
        }
        return $this->take('name');
    }

    /** @param list<string> $words @return array{0:string,1:int} A token that is one of the list */
    private function cursorOneOf(string $what, array $words): array
    {
        $token = $this->tokens[$this->cursor] ?? null;
        if ($token === null || !in_array($token[0], $words, true)) {
            throw $this->cursorFail($what);
        }
        return $this->take('keyword');
    }

    public static function isNumber(string $token): bool
    {
        return preg_match('/^[0-9]+(?:\.[0-9]+)?$/D', $token) === 1;
    }

    /**
     * The column the setting names: after checking the name, it must be a column of the table. Even if
     * the type is invalid, it still returns the column.
     */
    private function columnRef(array $token, int $line, string $kind): ?Column
    {
        if (!$this->name($token, $line)) {
            return null;
        }
        return $this->columnDefinition($token, $line, $kind, false);
    }

    private function columnDefinition(array $token, int $line, string $kind, bool $requireValidType): ?Column
    {
        if (!isset($this->columns[$token[0]])) {
            $this->error('setting', $line, $token[1], $this->unknownColumn($token[0], $this->table->name));
            return null;
        }
        $column = $this->columns[$token[0]];
        if ($this->isStandIn($column)) {
            return null;
        }
        return $requireValidType && isset($this->invalidTypes[$token[0]]) ? null : $column;
    }

    /** A setting that names text requires a non-null varchar or text column. */
    private function requireTextColumn(array $token, int $line, string $kind, string $message): void
    {
        $column = $this->columnRef($token, $line, $kind);
        if (
            $column !== null && (($column->type->name !== 'invalid'
            && !in_array($column->type->name, ['varchar', 'text'], true)) || $column->nullable)
        ) {
            $this->error('setting', $line, $token[1], $message);
        }
    }

    /** The foreign key that the `store block` line names must be a foreign key of the table. */
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
        $this->error(
            'setting',
            $line,
            $token[1],
            'foreign key ' . self::quoted($token[0]) . ' is not a foreign key of the table'
        );
    }

    /**
     * A store's shard clause names a non-null date or datetime column; it is rejected for a block table, a
     * self foreign key,
     * and a table that has order.
     *
     * @param list<array{0:string,1:int}> $arguments After the kind's arguments come the `shard` token, a column,
     *     and a period
     */
    private function checkStoreShard(array $arguments, int $line, bool $order): void
    {
        $at = Setting::STORE_ARGUMENTS[$arguments[0][0]];
        if (count($arguments) <= $at) {
            return;
        }
        [$shard, $column] = [$arguments[$at], $arguments[$at + 1]];
        $definition = $this->columnRef($column, $line, 'store');
        if (
            $definition !== null && (($definition->type->name !== 'invalid'
            && !in_array($definition->type->name, ['date', 'datetime'], true)) || $definition->nullable)
        ) {
            $this->error('setting', $line, $column[1], 'store shard needs a non-null date or datetime column');
        }
        if ($arguments[0][0] === 'block') {
            $this->error('setting', $line, $shard[1], 'store shard is rejected on a block table');
        }
        foreach ($this->table->foreignKeys as $foreignKey) {
            if ($foreignKey->table === $this->table->name) {
                $this->error('setting', $line, $shard[1], 'store shard is rejected on a table with a self foreign key');
                break;
            }
        }
        if ($order) {
            $this->error('setting', $line, $shard[1], 'store shard is rejected on a table with order');
        }
    }

    /** Checks whether the column is named by the table's primary key, unique key, index, foreign key, or check. */
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

    /** @return ?array{table: ?Table, columns: array, headerFailed?: bool} */
    private function settingTable(
        array $token,
        int $line,
        string $role,
        string $missing = 'is not a table of this document or a used table'
    ): ?array {
        $name = $token[0];
        $entry = $this->tables[$name] ?? null;
        if ($entry !== null) {
            return $entry;
        }
        if (isset($this->failedTables[$name])) {
            return null;
        }
        $this->error('setting', $line, $token[1], "$role " . self::quoted($name) . " $missing");
        return null;
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
        return preg_match('/^[a-z][a-z0-9_]*$/D', $name) === 1 && !in_array($name, self::RESERVED, true)
            && strlen($name) <= 63;
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
        $this->mark($token, 'name');
        [$name, $column] = $token;
        $line ??= $this->line;
        $matchesFormat = preg_match('/^[a-z][a-z0-9_]*$/D', $name) === 1
            && !in_array($name, self::RESERVED, true);
        if (!$matchesFormat) {
            $this->error('name.format', $line, $column, self::formatMessage($name));
        }
        $matchesLength = strlen($name) <= 63;
        if (!$matchesLength) {
            $this->error('name.length', $line, $column, self::lengthMessage($name));
        }
        return $matchesFormat && $matchesLength;
    }

    public static function formatMessage(string $name): string
    {
        return 'name ' . self::quoted($name) . ' does not match [a-z][a-z0-9_]* or is a reserved word';
    }

    public static function lengthMessage(string $name): string
    {
        return 'name ' . self::quoted($name) . ' has ' . strlen($name) . ' bytes, more than 63';
    }

    /** Checks an index, unique key, foreign key or check name and reserves it in the schema. */
    private function constraintName(array $token): void
    {
        if (!$this->name($token)) {
            return;
        }
        $name = $token[0];
        if (isset($this->localConstraints[$name])) {
            $this->error('name.duplicate', $this->line, $token[1], 'index, unique key, foreign key or check name '
                . self::quoted($name) . ' repeats in the schema');
            return;
        }
        $this->localConstraints[$name] = true;
        $this->constraintNames[$name] = true;
        if (isset($this->usedConstraintOwners[$name])) {
            $this->error('name.duplicate', $this->line, $token[1], 'name ' . self::quoted($name)
                . ' is a constraint name of used document ' . self::quoted($this->usedConstraintOwners[$name]));
            return;
        }
        if (isset($this->tables[$name]) || isset($this->usedTableNames[$name])) {
            $this->error(
                'name.duplicate',
                $this->line,
                $token[1],
                'name ' . self::quoted($name) . ' is also a table name'
            );
            return;
        }
        $this->constraintAt[$name] = [$this->line, $token[1]];
    }

    /** @return ?array{0:string,1:int} the word token at $i, or null after a syntax error */
    private function wordAt(int $i, string $what): ?array
    {
        $token = $this->tokens[$i] ?? null;
        if ($token === null || !self::isWord($token[0])) {
            $this->failAt($i, $what);
            return null;
        }
        return $token;
    }

    /**
     * The syntax error of Go's cursor at token $i: `unexpected <token>, expected <what>`, or `line ends, expected
     * <what>` after the last token.
     */
    private function failAt(int $i, string $what): void
    {
        $token = $this->tokens[$i] ?? null;
        if ($token === null) {
            $this->error('syntax', $this->line, $this->endColumn(), "line ends, expected $what");
            return;
        }
        $this->error('syntax', $this->line, $token[1], 'unexpected ' . self::describe($token[0]) . ", expected $what");
    }

    /** A token as Go's token.describe shows it: a string by its value, any other token by its text, in quotes. */
    public static function describe(string $text): string
    {
        $value = Literal::stringValue($text);
        return $value !== null ? "string '$value'" : "'$text'";
    }

    /** A name in double quotes, as the canonical quoting writes it (quote). */
    public static function quoted(string $text): string
    {
        return self::quote($text, '"');
    }

    /**
     * The canonical quoting of a diagnostic: the delimiter, then each code point, the delimiter or `\\` after a
     * backslash, \\a \\b \\f \\n \\r \\t \\v as those escapes, any other code point below 0x20 and 0x7F as \\xNN,
     * every other code point as is; then the delimiter.
     */
    public static function quote(string $text, string $delimiter): string
    {
        $out = $delimiter;
        foreach (self::chars($text) as $c) {
            if (strlen($c) !== 1) {
                $out .= $c;
                continue;
            }
            $o = ord($c);
            $out .= match (true) {
                $c === $delimiter, $c === '\\' => '\\' . $c,
                $c === "\x07" => '\\a',
                $c === "\x08" => '\\b',
                $c === "\f" => '\\f',
                $c === "\n" => '\\n',
                $c === "\r" => '\\r',
                $c === "\t" => '\\t',
                $c === "\v" => '\\v',
                $o < 0x20 || $o === 0x7f => sprintf('\\x%02x', $o),
                default => $c,
            };
        }
        return $out . $delimiter;
    }

    /**
     * Where an unclosed block is reported (Go's p.open): the `{` at token $brace when the line reads up to it,
     * else the keyword.
     *
     * @return array{0:int,1:int,2:string}
     */
    private function openedAt(int $brace): array
    {
        $t = $this->tokens;
        $named = $brace === 1 || (isset($t[1]) && self::isWord($t[1][0]));
        return $named && ($t[$brace][0] ?? null) === '{'
            ? [$this->line, $t[$brace][1], "'{'"] : [$this->line, $t[0][1], self::describe($t[0][0])];
    }

    /** Requires token $i to be $expected, else fails with $what (by default the token in quotes). */
    private function expectAt(int $i, string $expected, ?string $what = null): bool
    {
        $token = $this->tokens[$i] ?? null;
        if (($token[0] ?? null) !== $expected) {
            $this->failAt($i, $what ?? "'$expected'");
            return false;
        }
        // The expected words of the grammar are its fixed words (R12); punctuation keeps its lexical class.
        if (ctype_alpha($expected[0])) {
            $this->mark($token, 'keyword');
        }
        return true;
    }

    private function endAt(int $i): bool
    {
        if (isset($this->tokens[$i])) {
            $this->failAt($i, 'the end of the line');
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
            $name = $this->wordAt($i, 'a column name');
            if ($name === null) {
                return null;
            }
            $this->mark($name, 'name');
            $i++;
            $descending = false;
            $next = $this->tokens[$i][0] ?? null;
            if ($directions && ($next === 'asc' || $next === 'desc')) {
                $this->mark($this->tokens[$i], 'keyword');
                $descending = $next === 'desc';
                $i++;
                $next = $this->tokens[$i][0] ?? null;
            }
            $columns[] = [$name[0], $name[1], $descending];
            if ($next === ',') {
                $i++;
                continue;
            }
            if (!$this->expectAt($i, ')', "',' or ')'")) {
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
     * As in Go, a column line with a syntax error keeps only the syntax error: name and type checks are done
     * only when the line matches the syntax.
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
     * An error for a block not closed at the end of the document. Reported together with other syntax errors
     * on the same line (Go does not limit it to one per line).
     */
    private function unclosed(int $line, int $column, string $shown): void
    {
        $this->diagnostics[] = ['syntax', $line, $column, "block opened at this $shown is not closed"];
    }

    private function error(string $rule, int $line, int $column, string $message): void
    {
        if ($rule === 'syntax') {
            // A syntax diagnostic that a reader raises abandons its line (R1); deferred checks do not.
            if ($this->reading && $this->marking) {
                $this->lexical[$line] = true;
            }
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
