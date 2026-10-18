<?php
declare(strict_types=1);

// Checks the dbspec interface of the extension orm_dbspec (Polyspec\Orm\Dbspec\Native\Dbspec) with the shared vectors and the pure PHP client. The PHP
// client is the specification, so for the same input the results must match down to the diagnostic message and the exception class and message.
// - canonical, normalize and invalid cases of tests/dbspec/cases.json: the emission or diagnostic the vector fixes (rule, line,
//   column), and the same diagnostic and emission as the PHP client for every document.
// - files case: the diagnostic and message of readFile and readBytes, or the text.
// - hashes case and tests/dbspec/ddl.json: the five values of the manifest and the statements for the three dialects match the PHP client.
// - Document is an object graph that can be edited like the PHP client's: the emission, manifest and statements of two documents edited the same way match.
// - Argument errors and the rules for result objects match the PHP client.
// - introspect: the ddl.json cases applied to an in-memory SQLite database, and the SQLite cases of tests/dbspec/introspect.json,
//   are read the same as the PHP client and yield the vector's documents and unsupported objects. A failing catalog query (two error modes), catalog values of a different shape,
//   and exceptions thrown by a PDO subclass, and an unknown dialect, give the same exception and previous exception as the PHP client.
// - apply, recover, rollback, finalize: apply the chain of tests/dbspec/plans.json on a SQLite file, stop at each event, then
//   recover or roll back, finalize, and run again with the changed history rows; the events, exceptions, history rows and schema match the PHP client.
//   Errors in the error mode, dialect, clock and event arguments are the same too.

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Native\Dbspec as NativeDbspec;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

require_once dirname(__DIR__, 2) . '/php/tests/dbspec_cases.php';

/** @return ?list<string> for each position, [kind, path, line, column] from JSON; null if null */
function described_positions(?array $positions): ?array
{
    return $positions === null ? null : array_map(static fn(object $p): string => json_encode([$p->kind, $p->path, $p->line, $p->column], JSON_UNESCAPED_SLASHES), $positions);
}

/** @return list<string> "rule line column message" for each diagnostic */
function described(array $diagnostics): array
{
    return array_map(static fn(object $d): string => "{$d->rule} {$d->line} {$d->column} {$d->message}", $diagnostics);
}

/** Returns the result or exception of $body as [class, message]. The exception class is compared without its namespace. */
function outcome(callable $body): array
{
    try {
        return ['returned', json_encode($body(), JSON_UNESCAPED_SLASHES)];
    } catch (Throwable $error) {
        return [get_class($error), $error->getMessage()];
    }
}

/** The same operation in two namespaces gives the same result or the same exception. The extension's class names are read as the PHP client's names. */
function same_outcome(string $what, callable $php, callable $native): void
{
    Assert::assertSame(outcome($php), array_map(static fn(string $s): string => str_replace('Polyspec\\Orm\\Dbspec\\Native\\', 'Polyspec\\Orm\\Dbspec\\', $s), outcome($native)), $what);
}

/** Parses each document of the document set using the other documents as the set. Null if any document has a diagnostic. */
function parsed_set(string $dbspec, array $documents): ?array
{
    $names = array_keys($documents);
    sort($names, SORT_STRING);
    $texts = dbspec_documents($documents, false);
    $parsed = [];
    foreach ($names as $name) {
        $set = $texts;
        unset($set[$name]);
        $result = $dbspec::parse($texts[$name], $set);
        if ($result->document === null) {
            return null;
        }
        $parsed[] = $result->document;
    }
    return $parsed;
}

/** The statement vectors of tests/dbspec/ddl.json. */
function ext_ddl(): array
{
    return json_decode(file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/ddl.json'), true, 512, JSON_THROW_ON_ERROR);
}

/** A PDO subclass that returns the fixed rows for each catalog query, or throws the fixed exception. */
final class ScriptedPdo extends PDO
{
    /** @param Closure(string): mixed $answer */
    public function __construct(private Closure $answer)
    {
        parent::__construct('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        // Rows are returned as a SELECT of SQLite literals that keep the value's type: integers are int, reals are float, null is null.
        $literal = fn(mixed $v): string => match (true) {
            $v === null => 'NULL',
            is_int($v), is_float($v) => var_export($v, true),
            default => $this->quote((string) $v),
        };
        $rows = ($this->answer)($query);
        $selects = array_map(static fn(array $row): string => 'SELECT ' . implode(', ', array_map($literal, $row)), $rows);
        return parent::query($rows === [] ? 'SELECT 1 WHERE 0' : implode(' UNION ALL ', $selects), PDO::FETCH_NUM);
    }
}

/** Class and message of the result or exception of introspect, and of the previous exception. */
function introspected(string $dbspec, PDO $pdo, string $dialect): array
{
    try {
        $result = $dbspec::introspect($pdo, $dialect, 'introspected');
        return ['returned', $dbspec::emit($result->document), array_map(static fn(object $u): array => [$u->kind, $u->table, $u->name, $u->reason], $result->unsupported)];
    } catch (Throwable $error) {
        $previous = $error->getPrevious();
        return [get_class($error), $error->getMessage(), $previous === null ? null : [get_class($previous), $previous->getMessage()]];
    }
}

/** Records an exception as its class (the PHP client name, without namespace), message, ApplyError fields, cleanup error, and previous exception. */
function thrown(Throwable $e): array
{
    $out = [str_replace('Polyspec\\Orm\\Dbspec\\Native\\', 'Polyspec\\Orm\\Dbspec\\', get_class($e)), $e->getMessage()];
    if (property_exists($e, 'code_')) {
        $out[] = [$e->code_, $e->plan, $e->step, $e->detail];
    }
    if (property_exists($e, 'cleanup')) {
        $out[] = array_map(thrown(...), $e->cleanup);
    }
    if ($e->getPrevious() !== null) {
        $out[] = thrown($e->getPrevious());
    }
    return $out;
}

/**
 * Runs the dbspec apply command on a new SQLite file as the script says, and for each command records the event, the result or exception, and the history rows and schema
 * for each command. A script entry is [command, number of plans before the chain, event number to stop at (0 means do not stop, null means no event), SQL to run first].
 */
function applied(string $dbspec, array $chain, array $script, string $path): array
{
    $now = static fn(): DateTimeImmutable => new DateTimeImmutable('2026-10-01T02:00:00.123456789+02:00');
    $pdo = new PDO("sqlite:$path", null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('PRAGMA foreign_keys = ON');
    $log = [];
    try {
        foreach ($script as [$command, $count, $stopAt, $sql]) {
            if ($sql !== null) {
                $pdo->exec($sql);
            }
            $seen = 0;
            $events = $stopAt === null ? null : static function (object $event) use (&$log, &$seen, $stopAt): void {
                $log[] = [$event->kind, $event->plan, $event->step, $event->steps, $event->statement];
                if (++$seen === $stopAt) {
                    throw new RuntimeException("stop at $seen");
                }
            };
            try {
                $dbspec::$command($pdo, 'sqlite', array_slice($chain, 0, $count), $now, $events);
                $log[] = "$command returned";
            } catch (Throwable $e) {
                $log[] = thrown($e);
            }
            $log[] = $pdo->query('SELECT * FROM "dbspec$plans" ORDER BY name')->fetchAll(PDO::FETCH_NUM);
            $result = $dbspec::introspect($pdo, 'sqlite', 'x');
            $log[] = [$dbspec::emit($result->document), array_map(static fn(object $u): array => [$u->kind, $u->table, $u->name], $result->unsupported)];
        }
    } finally {
        $pdo = null;
        foreach (['', '-journal'] as $suffix) {
            if (file_exists($path . $suffix)) {
                unlink($path . $suffix);
            }
        }
    }
    return $log;
}

#[Small]
final class DbspecTest extends TestCase
{
    /** The canonical cases of tests/dbspec/cases.json, one data set per case id. */
    public static function canonicalCases(): iterable
    {
        return dbspec_case_ids('canonical', dbspec_read_cases()['canonical']);
    }

    /** The normalize cases of tests/dbspec/cases.json, one data set per case id. */
    public static function normalizeCases(): iterable
    {
        return dbspec_case_ids('normalize', dbspec_read_cases()['normalize']);
    }

    /** The invalid cases of tests/dbspec/cases.json, one data set per case id. */
    public static function invalidCases(): iterable
    {
        return dbspec_case_ids('invalid', dbspec_read_cases()['invalid']);
    }

    #[DataProvider('canonicalCases')]
    public function test_canonical(string $kind, array $case): void
    {
        $this->checkDocument($kind, $case);
    }

    #[DataProvider('normalizeCases')]
    public function test_normalize(string $kind, array $case): void
    {
        $this->checkDocument($kind, $case);
    }

    #[DataProvider('invalidCases')]
    public function test_invalid(string $kind, array $case): void
    {
        $this->checkDocument($kind, $case);
    }

    // php-extension/canonical, normalize, invalid
    private function checkDocument(string $kind, array $case): void
    {
        $id = "$kind/{$case['id']}";
        $texts = dbspec_documents($case['documents'], $case['crlf'] ?? false, $case['mixed'] ?? false);
        foreach ($texts as $name => $text) {
            $native = NativeDbspec::parse($text, $texts);
            $php = Dbspec::parse($text, $texts);
            Assert::assertSame(described($php->diagnostics), described($native->diagnostics), "$id/$name diagnostics against the PHP client");
            Assert::assertSame($php->document === null ? null : Dbspec::emit($php->document), $native->document === null ? null : NativeDbspec::emit($native->document), "$id/$name emission against the PHP client");
        }
        $native = NativeDbspec::parse($texts[$case['main']], $texts);
        if ($kind === 'invalid') {
            Assert::assertSame(array_map(static fn(array $e): string => "{$e['rule']} {$e['line']} {$e['column']}", $case['errors']), array_map(static fn(object $d): string => "{$d->rule} {$d->line} {$d->column}", $native->diagnostics), "$id diagnostics");
            Assert::assertSame(null, $native->document, "$id document");
            Assert::assertSame(null, described_positions($native->positions), "$id positions");
            return;
        }
        $want = $kind === 'canonical' ? implode("\n", $case['documents'][$case['main']]) . "\n" : implode("\n", $case['canonical']) . "\n";
        Assert::assertSame($want, NativeDbspec::emit($native->document), "$id emission");
        $again = NativeDbspec::parse($want, $texts);
        Assert::assertSame($want, NativeDbspec::emit($again->document), "$id emission of the emission");
    }

    public static function positionCases(): iterable
    {
        foreach (dbspec_read_cases()['positions'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    // php-extension/positions
    #[DataProvider('positionCases')]
    public function test_positions(array $case): void
    {
        $id = "positions/{$case['id']}";
        $texts = dbspec_documents($case['documents'], false);
        $native = NativeDbspec::parse($texts[$case['main']], $texts);
        $php = Dbspec::parse($texts[$case['main']], $texts);
        Assert::assertSame(described_positions($php->positions), described_positions($native->positions), "$id positions against the PHP client");
        Assert::assertSame(array_map(static fn(array $p): string => json_encode([$p['kind'], $p['path'], $p['line'], $p['column']], JSON_UNESCAPED_SLASHES), $case['positions']), described_positions($native->positions), "$id positions against the vector");
    }

    public static function fileCases(): iterable
    {
        foreach (dbspec_read_cases()['files'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    // php-extension/files
    #[DataProvider('fileCases')]
    public function test_files(array $case): void
    {
        $path = dirname(__DIR__, 3) . "/tests/dbspec/{$case['path']}";
        foreach (['file' => [$path], 'bytes' => [$case['path'], (string) file_get_contents($path)]] as $kind => $arguments) {
            $id = "files/{$case['id']}/$kind";
            $native = $kind === 'file' ? NativeDbspec::readFile(...$arguments) : NativeDbspec::readBytes(...$arguments);
            $php = $kind === 'file' ? Dbspec::readFile(...$arguments) : Dbspec::readBytes(...$arguments);
            Assert::assertSame(described($php->diagnostics), described($native->diagnostics), "$id diagnostics");
            Assert::assertSame($php->text, $native->text, "$id text");
            Assert::assertSame(array_map(static fn(array $e): string => "{$e['rule']} {$e['line']} {$e['column']}", $case['errors']), array_map(static fn(object $d): string => "{$d->rule} {$d->line} {$d->column}", $native->diagnostics), "$id vector");
        }
    }

    public static function hashesCases(): iterable
    {
        foreach (dbspec_read_cases()['hashes'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    // php-extension/hashes
    #[DataProvider('hashesCases')]
    public function test_hashes(array $case): void
    {
        $native = parsed_set(NativeDbspec::class, $case['documents']);
        $php = parsed_set(Dbspec::class, $case['documents']);
        Assert::assertSame($php === null, $native === null, "hashes/{$case['id']} parse");
        $nativeManifest = NativeDbspec::manifest($native)->manifest;
        $phpManifest = Dbspec::manifest($php)->manifest;
        foreach (['manifestText', 'schemaText', 'manifestHash', 'schemaHash', 'externalText'] as $field) {
            Assert::assertSame($phpManifest->$field, $nativeManifest->$field, "hashes/{$case['id']} $field");
        }
    }

    public static function renderCases(): iterable
    {
        foreach (ext_ddl()['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    // php-extension/render
    #[DataProvider('renderCases')]
    public function test_render(array $case): void
    {
        $native = parsed_set(NativeDbspec::class, $case['documents']);
        $php = parsed_set(Dbspec::class, $case['documents']);
        Assert::assertSame($php === null, $native === null, "render/{$case['id']} parse");
        if ($native === null) {
            return;
        }
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            $nativeResult = NativeDbspec::render($native, $dialect);
            $phpResult = Dbspec::render($php, $dialect);
            Assert::assertSame(described($phpResult->diagnostics), described($nativeResult->diagnostics), "render/{$case['id']}/$dialect diagnostics");
            Assert::assertSame($phpResult->statements, $nativeResult->statements, "render/{$case['id']}/$dialect statements");
        }
    }

    // php-extension/manifest-set-diagnostics
    public function test_manifest_set_diagnostics(): void
    {
        // Two documents with the same name are one name.duplicate diagnostic, and have no manifest or statement.
        $text = "dbspec 1 shop\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n";
        $set = [NativeDbspec::parse($text, [])->document, NativeDbspec::parse($text, [])->document];
        $phpSet = [Dbspec::parse($text, [])->document, Dbspec::parse($text, [])->document];
        $manifest = NativeDbspec::manifest($set);
        Assert::assertSame(null, $manifest->manifest, 'manifest');
        Assert::assertSame(described(Dbspec::manifest($phpSet)->diagnostics), described($manifest->diagnostics), 'manifest diagnostics');
        $render = NativeDbspec::render($set, 'sqlite');
        Assert::assertSame(null, $render->statements, 'render statements');
        Assert::assertSame(described(Dbspec::render($phpSet, 'sqlite')->diagnostics), described($render->diagnostics), 'render diagnostics');
    }

    // php-extension/bytes
    public function test_bytes(): void
    {
        // PHP strings are bytes. Text that is not UTF-8 is one encoding diagnostic, the same as the pure PHP client.
        $texts = [
            'invalid byte' => "dbspec 1 shop\n\ntable t\xFF {\n",
            'invalid byte after a lone carriage return' => "dbspec 1 shop\r\ntable \rt\xFF {\n",
            'byte order mark and an invalid byte' => "\xEF\xBB\xBFdbspec 1 shop\n\xC3\n",
            'invalid byte in the header' => "dbspec 1 sh\xE9p\n",
            'truncated sequence at the end' => "dbspec 1 shop\n# caf\xC3",
            'a NUL in a comment' => "dbspec 1 shop\n\n# a\0b\ntable t {\n  id i64\n  primary key (id)\n}\n",
        ];
        foreach ($texts as $what => $text) {
            $native = NativeDbspec::parse($text, []);
            $php = Dbspec::parse($text, []);
            Assert::assertSame(described($php->diagnostics), described($native->diagnostics), "$what diagnostics");
            Assert::assertSame($php->document === null ? null : Dbspec::emit($php->document), $native->document === null ? null : NativeDbspec::emit($native->document), "$what emission");
        }
        // A document of the set that is not UTF-8 is the diagnostic of the use line that uses that document.
        $text = "dbspec 1 shop\n\nuse core { users }\n\ntable orders {\n  id i64 identity\n  primary key (id)\n}\n";
        $set = ['core' => "dbspec 1 core\xFF"];
        Assert::assertSame(described(Dbspec::parse($text, $set)->diagnostics), described(NativeDbspec::parse($text, $set)->diagnostics), 'a used document that is not UTF-8');
    }

    // php-extension/arguments
    public function test_arguments(): void
    {
        $root = dirname(__DIR__, 3);
        $text = "dbspec 1 shop\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n";
        same_outcome('an integer document name', static fn() => Dbspec::parse($text, [1 => $text]), static fn() => NativeDbspec::parse($text, [1 => $text]));
        same_outcome('a document text that is not a string', static fn() => Dbspec::parse($text, ['core' => 1]), static fn() => NativeDbspec::parse($text, ['core' => 1]));
        same_outcome('an unknown dialect', static fn() => Dbspec::render([Dbspec::parse($text, [])->document], 'oracle'),
            static fn() => NativeDbspec::render([NativeDbspec::parse($text, [])->document], 'oracle'));
        $missing = "$root/tests/dbspec/files/missing.dbs";
        same_outcome('a missing file', static fn() => Dbspec::readFile($missing), static fn() => NativeDbspec::readFile($missing));
        same_outcome('a directory', static fn() => Dbspec::readFile("$root/tests/dbspec/files"), static fn() => NativeDbspec::readFile("$root/tests/dbspec/files"));
        // The extension's document set holds only the extension's Document.
        $documents = 'the document set holds string, not Polyspec\\Orm\\Dbspec\\Native\\Document';
        Assert::assertSame([TypeError::class, $documents], outcome(static fn() => NativeDbspec::manifest([$text])), 'a manifest of a text');
        Assert::assertSame([TypeError::class, 'the document set holds Polyspec\\Orm\\Dbspec\\Document, not Polyspec\\Orm\\Dbspec\\Native\\Document'], outcome(static fn() => NativeDbspec::render([Dbspec::parse($text, [])->document], 'mysql')), 'a rendering of a PHP client document');
    }

    // php-extension/objects
    public function test_objects(): void
    {
        $result = NativeDbspec::parse("dbspec 1 shop\n\ntable users {\n  id i64\n  primary key (id)\n}\n", []);
        Assert::assertSame(true, $result->document === $result->document, 'the same document object');
        Assert::assertSame(Dbspec::SIGNATURE, NativeDbspec::SIGNATURE, 'the signature');
        $diagnostic = NativeDbspec::parse('x', [])->diagnostics[0];
        // Result objects are readonly like the pure PHP client's and have no dynamic properties.
        Assert::assertSame([Error::class, 'Cannot modify readonly property Polyspec\\Orm\\Dbspec\\Native\\Diagnostic::$line'], outcome(static function () use ($diagnostic): void {
            $diagnostic->line = 2;
        }), 'a write');
        Assert::assertSame([Error::class, 'Cannot create dynamic property Polyspec\\Orm\\Dbspec\\Native\\Diagnostic::$extra'], outcome(static function () use ($diagnostic): void {
            $diagnostic->extra = 1;
        }), 'a dynamic property');
        Assert::assertSame(['rule', 'line', 'column', 'message'], array_keys(get_object_vars($diagnostic)), 'the properties in declaration order');
        $position = NativeDbspec::parse("dbspec 1 shop\n", [])->positions[0];
        Assert::assertSame([Error::class, 'Cannot modify readonly property Polyspec\\Orm\\Dbspec\\Native\\Position::$line'], outcome(static function () use ($position): void {
            $position->line = 2;
        }), 'a position write');
        Assert::assertSame(['kind', 'path', 'line', 'column'], array_keys(get_object_vars($position)), 'a position properties in declaration order');
        Assert::assertSame(['document', 'diagnostics', 'positions'], array_keys(get_object_vars(NativeDbspec::parse("dbspec 1 shop\n", []))), 'the parse result properties in declaration order');
        Assert::assertSame(array_keys(get_object_vars(new Polyspec\Orm\Dbspec\Document('d'))), array_keys(get_object_vars(new Polyspec\Orm\Dbspec\Native\Document('d'))), 'the document properties in declaration order');
        same_outcome('an invalid result without a diagnostic', static fn() => Polyspec\Orm\Dbspec\ParseResult::invalid([]), static fn() => Polyspec\Orm\Dbspec\Native\ParseResult::invalid([]));
        same_outcome('a repeated readonly construction', static function () {
            $d = new Polyspec\Orm\Dbspec\Diagnostic('syntax', 1, 2, 'm');
            $d->__construct('syntax', 1, 2, 'm');
        }, static function () {
            $d = new Polyspec\Orm\Dbspec\Native\Diagnostic('syntax', 1, 2, 'm');
            $d->__construct('syntax', 1, 2, 'm');
        });
    }

    // php-extension/documents
    public function test_documents(): void
    {
        // Two documents edited the same way give the same text and statements: the extension's Document can be edited like the PHP client's Document.
        $text = "dbspec 1 shop\n\ntable users {\n  id i64 identity\n  name varchar(64)\n  primary key (id)\n  unique users_name (name)\n}\n";
        $change = static function (string $ns, object $document): object {
            $table = $document->tables[0];
            $table->columns[] = new ("$ns\\Column")('email', new ("$ns\\ColumnType")('varchar', [120]), true, false, "'a@b'", ['# the address']);
            $table->indexes[] = new ("$ns\\Index")('users_email', [new ("$ns\\IndexColumn")('email', true)]);
            $table->checks[] = new ("$ns\\Check")('users_email_set', "email <> ''");
            $table->settings = new ("$ns\\Settings")(['# settings']);
            $table->settings->settings[] = new ("$ns\\Setting")('immutable', []);
            $orders = new ("$ns\\Table")('orders', ['# orders']);
            $orders->columns[] = new ("$ns\\Column")('id', new ("$ns\\ColumnType")('i64'), false, true, null);
            $orders->columns[] = new ("$ns\\Column")('user_id', new ("$ns\\ColumnType")('i64'), false, false, null);
            $orders->primaryKey = new ("$ns\\PrimaryKey")(['id']);
            $orders->indexes[] = new ("$ns\\Index")('orders_user', [new ("$ns\\IndexColumn")('user_id', false)]);
            $orders->foreignKeys[] = new ("$ns\\ForeignKey")('orders_user_fk', ['user_id'], 'users', ['id'], 'cascade', 'restrict');
            $document->tables[] = $orders;
            $document->diagrams[] = new ("$ns\\Diagram")('main');
            $document->diagrams[0]->placements[] = new ("$ns\\Placement")('users', -5, 10, ['# here']);
            $document->trailingComments = ['# end'];
            return $document;
        };
        $php = $change('Polyspec\\Orm\\Dbspec', Dbspec::parse($text, [])->document);
        $native = $change('Polyspec\\Orm\\Dbspec\\Native', NativeDbspec::parse($text, [])->document);
        Assert::assertSame(Dbspec::emit($php), NativeDbspec::emit($native), 'emission');
        Assert::assertSame(json_encode(Dbspec::manifest([$php])->manifest), json_encode(NativeDbspec::manifest([$native])->manifest), 'manifest');
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            Assert::assertSame(Dbspec::render([$php], $dialect)->statements, NativeDbspec::render([$native], $dialect)->statements, "$dialect statements");
        }
        Assert::assertSame(described(Dbspec::parse(Dbspec::emit($php), [])->diagnostics), described(NativeDbspec::parse(NativeDbspec::emit($native), [])->diagnostics), 'a built document parses back');
        // Value methods are the same as the PHP client's.
        $setting = new Polyspec\Orm\Dbspec\Native\Setting('audit', ['history', 'audit_seq', 'audit', 'action', 'previous'], [], ['name']);
        $phpSetting = new Polyspec\Orm\Dbspec\Setting('audit', ['history', 'audit_seq', 'audit', 'action', 'previous'], [], ['name']);
        Assert::assertSame([$phpSetting->records('name'), $phpSetting->records('audit_seq'), $phpSetting->records('id')], [$setting->records('name'), $setting->records('audit_seq'), $setting->records('id')], 'records');
        Assert::assertSame($phpSetting->excluded($php->tables[0]), $setting->excluded($native->tables[0]), 'excluded');
        Assert::assertSame($phpSetting->auditLine('exclude', ['name']), $setting->auditLine('exclude', ['name']), 'auditLine');
        Assert::assertSame([(new Polyspec\Orm\Dbspec\ColumnType('decimal', [5, 2]))->text(), (new Polyspec\Orm\Dbspec\ColumnType('i32'))->isInteger()], [(new Polyspec\Orm\Dbspec\Native\ColumnType('decimal', [5, 2]))->text(), (new Polyspec\Orm\Dbspec\Native\ColumnType('i32'))->isInteger()], 'type text');
        Assert::assertSame($php->tables[1]->foreignKeys[0]->changesChildRows(), $native->tables[1]->foreignKeys[0]->changesChildRows(), 'changes child rows');
    }

    /** A memory SQLite database with the statements applied. */
    private static function applied(array $statements): PDO
    {
        $pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        foreach (['PRAGMA foreign_keys = ON', ...$statements] as $statement) {
            $pdo->exec($statement);
        }
        return $pdo;
    }

    public static function introspectDdlCases(): iterable
    {
        foreach (ext_ddl()['cases'] as $case) {
            yield 'ddl/' . $case['id'] => [$case];
        }
    }

    // php-extension/introspect: every case of tests/dbspec/ddl.json applied to a memory SQLite database.
    #[DataProvider('introspectDdlCases')]
    public function test_introspect_ddl(array $case): void
    {
        $documents = parsed_set(Dbspec::class, $case['documents']);
        $statements = Dbspec::render($documents, 'sqlite')->statements;
        $pdo = self::applied($statements);
        $php = introspected(Dbspec::class, $pdo, 'sqlite');
        Assert::assertSame($php, introspected(NativeDbspec::class, $pdo, 'sqlite'), "ddl/{$case['id']} introspection against the PHP client");
        Assert::assertSame([], $php[2] ?? $php, "ddl/{$case['id']} unsupported");
    }

    public static function introspectVectorCases(): iterable
    {
        $vectors = json_decode(file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/introspect.json'), true, 512, JSON_THROW_ON_ERROR);
        foreach ($vectors['cases'] as $case) {
            if ($case['dialect'] === 'sqlite') {
                yield 'introspect/' . $case['id'] => [$case];
            }
        }
    }

    // php-extension/introspect: the SQLite cases of tests/dbspec/introspect.json.
    #[DataProvider('introspectVectorCases')]
    public function test_introspect_vector(array $case): void
    {
        $documents = parsed_set(Dbspec::class, $case['documents']);
        $pdo = self::applied([...Dbspec::render($documents, 'sqlite')->statements, ...$case['statements']]);
        $native = introspected(NativeDbspec::class, $pdo, 'sqlite');
        Assert::assertSame(introspected(Dbspec::class, $pdo, 'sqlite'), $native, "introspect/{$case['id']} against the PHP client");
        Assert::assertSame(implode("\n", $case['document']) . "\n", $native[1], "introspect/{$case['id']} document");
        Assert::assertSame($case['unsupported'], array_map(static fn(array $u): array => array_slice($u, 0, 3), $native[2]), "introspect/{$case['id']} unsupported");
    }

    // php-extension/introspect: failing catalog queries, catalog values of another shape, exceptions of a PDO subclass,
    // an unknown dialect and a connection that is not a PDO.
    public function test_introspect_failures(): void
    {
        // A failing catalog query is a RuntimeException that contains the query, regardless of the error mode.
        foreach ([PDO::ERRMODE_EXCEPTION, PDO::ERRMODE_SILENT, PDO::ERRMODE_WARNING] as $mode) {
            foreach (['mysql', 'postgres'] as $dialect) {
                $pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => $mode]);
                Assert::assertSame(@introspected(Dbspec::class, $pdo, $dialect), @introspected(NativeDbspec::class, $pdo, $dialect), "$dialect query failure in error mode $mode");
            }
        }
        // Catalog values of a different shape, and exceptions thrown by a PDO subclass
        $answers = [
            'a table name that is a number' => static fn(string $q): array => [[5, 'table', 't', '']],
            'a null table kind' => static fn(string $q): array => [['t', null, 't', '']],
            'a float flag' => static fn(string $q): array => str_contains($q, 'pg_class c') ? [['t', 'r', 1.5]] : [],
            'a word flag' => static fn(string $q): array => str_contains($q, 'pg_class c') ? [['t', 'r', 'yes']] : [],
            'an exception of the subclass' => static fn(string $q): array => throw new DomainException('refused'),
            'a PDOException of the subclass' => static fn(string $q): array => throw new PDOException('SQLSTATE[HY000]: gone'),
        ];
        foreach ($answers as $what => $answer) {
            foreach (['sqlite', 'postgres'] as $dialect) {
                $pdo = new ScriptedPdo($answer);
                Assert::assertSame(introspected(Dbspec::class, $pdo, $dialect), introspected(NativeDbspec::class, $pdo, $dialect), "$what in $dialect");
            }
        }
        $pdo = new PDO('sqlite::memory:');
        same_outcome('an unknown dialect', static fn() => Dbspec::introspect($pdo, 'oracle', 'x'), static fn() => NativeDbspec::introspect($pdo, 'oracle', 'x'));
        // The TypeError message of an internal function does not contain the ", called in <file> on line <n>" of a user function.
        $php = outcome(static fn() => Dbspec::introspect(new stdClass(), 'sqlite', 'x'));
        Assert::assertSame([$php[0], preg_replace('/, called in .* on line \d+$/', '', $php[1])], array_map(static fn(string $s): string => str_replace('Polyspec\\Orm\\Dbspec\\Native\\', 'Polyspec\\Orm\\Dbspec\\', $s), outcome(static fn() => NativeDbspec::introspect(new stdClass(), 'sqlite', 'x'))), 'a connection that is not a PDO');
    }

    /**
     * The chains of tests/dbspec/plans.json in both namespaces and the scripts run on them, made once.
     *
     * @return array{php: array<string, list<object>>, native: array<string, list<object>>, scripts: array<string, list<array>>}
     */
    private static function applyScripts(): array
    {
        static $made = null;
        if ($made !== null) {
            return $made;
        }
        $root = dirname(__DIR__, 3);
        $vectors = json_decode(file_get_contents("$root/tests/dbspec/plans.json"), true, 512, JSON_THROW_ON_ERROR);
        $cases = array_column($vectors['cases'], null, 'id');
        $chains = static function (string $dbspec) use ($cases): array {
            $parse = static fn(string $text): object => $dbspec::parsePlan($text)->plan ?? throw new RuntimeException("plan does not parse:\n$text");
            $out = ['main' => [$parse(implode("\n", $cases['create-from-empty']['plan']) . "\n"), $parse(implode("\n", $cases['rename-table-and-column']['plan']) . "\n")]];
            foreach (['representative', 'drop-required-column', 'rebuild-keeps-key-counter'] as $id) {
                $out[$id] = [$parse("dbplan 1 base\nfrom empty\n\n" . implode("\n", $cases[$id]['source']) . "\n"), $parse(implode("\n", $cases[$id]['plan']) . "\n")];
            }
            return $out;
        };
        $php = $chains(Dbspec::class);
        $native = $chains(NativeDbspec::class);
        $scripts = [];
        foreach (array_keys($php) as $id) {
            $scripts["$id/apply"] = [['apply', 1, 0, null], ['apply', 2, 0, null], ['apply', 2, 0, null], ['finalize', 2, 0, null], ['rollback', 2, 0, null]];
            // After each event of the second plan, stop, then run apply, recover and rollback.
            for ($stop = 1; $stop <= 12; $stop++) {
                $scripts["$id/stop-$stop/recover"] = [['apply', 1, null, null], ['apply', 2, $stop, null], ['apply', 2, 0, null], ['recover', 2, 0, null], ['finalize', 2, 0, null]];
                $scripts["$id/stop-$stop/rollback"] = [['apply', 1, null, null], ['apply', 2, $stop, null], ['rollback', 2, $stop + 1, null], ['rollback', 2, 0, null], ['rollback', 2, 0, null]];
            }
            $scripts["$id/drift"] = [['apply', 1, null, null], ['apply', 2, 0, 'CREATE TABLE stray (id INTEGER PRIMARY KEY)']];
            $scripts["$id/history"] = [['apply', 2, null, null], ['rollback', 2, 0, 'UPDATE "dbspec$plans" SET step = 99'], ['recover', 2, 0, 'UPDATE "dbspec$plans" SET state = \'applying\''],
                ['apply', 2, 0, 'UPDATE "dbspec$plans" SET state = \'weird\''], ['apply', 2, 0, 'UPDATE "dbspec$plans" SET to_hash = \'x\''], ['apply', 1, 0, null]];
        }
        return $made = ['php' => $php, 'native' => $native, 'scripts' => $scripts];
    }

    public static function applyCases(): iterable
    {
        foreach (array_keys(self::applyScripts()['scripts']) as $name) {
            yield "apply/$name" => [$name];
        }
    }

    // php-extension/apply: each script on SQLite files of the PHP client and of the extension.
    #[DataProvider('applyCases')]
    public function test_apply(string $name): void
    {
        ['php' => $php, 'native' => $native, 'scripts' => $scripts] = self::applyScripts();
        $script = $scripts[$name];
        $dir = sys_get_temp_dir() . '/orm-dbspec-apply-' . getmypid();
        if (!mkdir($dir)) {
            throw new RuntimeException("cannot create $dir");
        }
        try {
            $id = explode('/', $name)[0];
            Assert::assertSame(applied(Dbspec::class, $php[$id], $script, "$dir/php.sqlite"), applied(NativeDbspec::class, $native[$id], $script, "$dir/native.sqlite"), "apply $name");
        } finally {
            rmdir($dir);
        }
    }

    // php-extension/apply: the argument errors.
    public function test_apply_arguments(): void
    {
        ['php' => $php, 'native' => $native] = self::applyScripts();
        // Argument errors
        $plans = $php['main'];
        $nativePlans = $native['main'];
        $now = static fn(): DateTimeImmutable => new DateTimeImmutable('2026-10-01T00:00:00Z');
        foreach ([PDO::ERRMODE_SILENT, PDO::ERRMODE_WARNING] as $mode) {
            $pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => $mode]);
            same_outcome("apply in error mode $mode", static fn() => Dbspec::apply($pdo, 'sqlite', $plans, $now, null), static fn() => NativeDbspec::apply($pdo, 'sqlite', $nativePlans, $now, null));
        }
        $pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        same_outcome('an unknown dialect', static fn() => Dbspec::finalize($pdo, 'oracle', $plans, $now, null), static fn() => NativeDbspec::finalize($pdo, 'oracle', $nativePlans, $now, null));
        same_outcome('two plans from empty', static fn() => Dbspec::apply($pdo, 'sqlite', [$plans[0], $plans[0]], $now, null), static fn() => NativeDbspec::apply($pdo, 'sqlite', [$nativePlans[0], $nativePlans[0]], $now, null));
        $text = static fn() => 'now';
        same_outcome('a clock that returns text', static fn() => Dbspec::apply(new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]), 'sqlite', $plans, $text, null),
            static fn() => NativeDbspec::apply(new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]), 'sqlite', $nativePlans, $text, null));
    }
}
