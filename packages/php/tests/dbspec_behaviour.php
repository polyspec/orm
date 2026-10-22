<?php

declare(strict_types=1);

// The PHP behaviours of the dbspec interface that the shared vectors do not fix: non-UTF-8 text, argument errors,
// result objects, documents built and edited in PHP, introspection failures, the apply argument errors, and apply,
// recover, rollback and finalize stopped at each event on a SQLite file. Each case returns the outcome as JSON values;
// fixtures/dbspec-behaviour.json holds the outcomes that the PHP client gives (DbspecBehaviourTest compares, and
// packages/php/testing/dbspec/behaviour.php records). Both implementations of Polyspec\Orm\Dbspec, the PHP library and
// the extension, run the same cases, each in its own process.

use Polyspec\Orm\Dbspec\Dbspec;

require_once __DIR__ . '/dbspec_cases.php';
require_once __DIR__ . '/dbspec_plan_cases.php';

/** The repository root, which outcomes write as <root> so that a recorded message names no machine's path. */
function behaviour_root(): string
{
    return dirname(__DIR__, 3);
}

/**
 * The text of an outcome: the root as <root>, and without the ", called in <file> on line <n>" that only a user
 * function's TypeError has.
 */
function behaviour_text(string $text): string
{
    return preg_replace('/, called in .* on line \d+$/', '', str_replace(behaviour_root(), '<root>', $text));
}

/** @return list<string> "rule line column message" for each diagnostic */
function behaviour_described(array $diagnostics): array
{
    return array_map(
        static fn(object $d): string => behaviour_text("{$d->rule} {$d->line} {$d->column} {$d->message}"),
        $diagnostics
    );
}

/** The result of $body as ['returned', JSON text], or its exception as [class, message]. */
function behaviour_outcome(callable $body): array
{
    try {
        return ['returned', behaviour_text(json_encode($body(), JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR))];
    } catch (Throwable $error) {
        return [get_class($error), behaviour_text($error->getMessage())];
    }
}

/** The parse diagnostics and the emission of a text. */
function behaviour_parsed(string $text, array $set): array
{
    $result = Dbspec::parse($text, $set);
    return [
        behaviour_described($result->diagnostics),
        $result->document === null ? null : Dbspec::emit($result->document)
    ];
}

/** A PDO subclass that returns the fixed rows for each catalog query, or throws the fixed exception. */
final class BehaviourScriptedPdo extends PDO
{
    /** @param Closure(string): mixed $answer */
    public function __construct(private Closure $answer)
    {
        parent::__construct('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        // Rows are a SELECT of SQLite literals that keep the value's type: integers are int, reals are float, null is
        // null.
        $literal = fn(mixed $v): string => match (true) {
            $v === null => 'NULL',
            is_int($v), is_float($v) => var_export($v, true),
            default => $this->quote((string) $v),
        };
        $rows = ($this->answer)($query);
        $selects = array_map(
            static fn(array $row): string => 'SELECT ' . implode(', ', array_map($literal, $row)),
            $rows
        );
        return parent::query($rows === [] ? 'SELECT 1 WHERE 0' : implode(' UNION ALL ', $selects), PDO::FETCH_NUM);
    }
}

/** The emission and unsupported objects of introspect, or its exception and previous exception. */
function behaviour_introspected(PDO $pdo, string $dialect): array
{
    try {
        $result = Dbspec::introspect($pdo, $dialect, 'introspected');
        return [
            'returned',
            Dbspec::emit($result->document),
            array_map(static fn(object $u): array => [$u->kind, $u->table, $u->name, $u->reason], $result->unsupported)
        ];
    } catch (Throwable $error) {
        $previous = $error->getPrevious();
        return [
            get_class($error),
            behaviour_text($error->getMessage()),
            $previous === null ? null : [get_class($previous), behaviour_text($previous->getMessage())]
        ];
    }
}

/** An exception as its class, message, ApplyError fields, cleanup errors and previous exception. */
function behaviour_thrown(Throwable $e): array
{
    $out = [get_class($e), behaviour_text($e->getMessage())];
    if (property_exists($e, 'code_')) {
        $out[] = [$e->code_, $e->plan, $e->step, $e->detail];
    }
    if (property_exists($e, 'cleanup')) {
        $out[] = array_map(behaviour_thrown(...), $e->cleanup);
    }
    if ($e->getPrevious() !== null) {
        $out[] = behaviour_thrown($e->getPrevious());
    }
    return $out;
}

/**
 * Runs the apply commands of $script on a new SQLite file and records, for each command, the events, the result or
 * exception, the history rows and the schema. A script entry is [command, number of plans of the chain, event number to
 * stop at (0 does not stop, null passes no event closure), SQL to run first].
 */
function behaviour_applied(array $chain, array $script): array
{
    $path = sys_get_temp_dir() . '/orm-dbspec-behaviour-' . getmypid() . '.sqlite';
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
                Dbspec::$command($pdo, 'sqlite', array_slice($chain, 0, $count), $now, $events);
                $log[] = "$command returned";
            } catch (Throwable $e) {
                $log[] = behaviour_thrown($e);
            }
            $log[] = $pdo->query('SELECT * FROM "dbspec$plans" ORDER BY name')->fetchAll(PDO::FETCH_NUM);
            $result = Dbspec::introspect($pdo, 'sqlite', 'x');
            $log[] = [
                Dbspec::emit($result->document),
                array_map(static fn(object $u): array => [$u->kind, $u->table, $u->name], $result->unsupported)
            ];
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

/**
 * The chains of tests/dbspec/plans.json that the apply cases run: main, and three cases each after its source as the
 * first plan.
 */
function behaviour_chains(): array
{
    static $chains = null;
    if ($chains !== null) {
        return $chains;
    }
    $vectors = plan_vectors();
    $cases = array_column($vectors['cases'], null, 'id');
    $parse = static fn(string $text): object => Dbspec::parsePlan($text)->plan ?? throw new RuntimeException(
        "plan does not parse:\n$text"
    );
    $chains = [
        'main' => [
            $parse(implode("\n", $cases['create-from-empty']['plan']) . "\n"),
            $parse(implode("\n", $cases['rename-table-and-column']['plan']) . "\n")
        ]
    ];
    foreach (['representative', 'drop-required-column', 'rebuild-keeps-key-counter'] as $id) {
        $chains[$id] = [
            $parse("dbplan 1 base\nfrom empty\n\n" . implode("\n", $cases[$id]['source']) . "\n"),
            $parse(implode("\n", $cases[$id]['plan']) . "\n")
        ];
    }
    return $chains;
}

/** @return array<string, list<array>> each apply script by name */
function behaviour_apply_scripts(): array
{
    $scripts = [];
    foreach (['main', 'representative', 'drop-required-column', 'rebuild-keeps-key-counter'] as $id) {
        $scripts["$id/apply"] = [
            ['apply', 1, 0, null],
            ['apply', 2, 0, null],
            ['apply', 2, 0, null],
            ['finalize', 2, 0, null],
            ['rollback', 2, 0, null]
        ];
        // After each event of the second plan: stop, then apply, recover and rollback.
        for ($stop = 1; $stop <= 12; $stop++) {
            $scripts["$id/stop-$stop/recover"] = [
                ['apply', 1, null, null],
                ['apply', 2, $stop, null],
                ['apply', 2, 0, null],
                ['recover', 2, 0, null],
                ['finalize', 2, 0, null]
            ];
            $scripts["$id/stop-$stop/rollback"] = [
                ['apply', 1, null, null],
                ['apply', 2, $stop, null],
                ['rollback', 2, $stop + 1, null],
                ['rollback', 2, 0, null],
                ['rollback', 2, 0, null]
            ];
        }
        $scripts["$id/drift"] = [
            ['apply', 1, null, null],
            ['apply', 2, 0, 'CREATE TABLE stray (id INTEGER PRIMARY KEY)']
        ];
        $scripts["$id/history"] = [['apply', 2, null, null], [
            'rollback',
            2,
            0,
            'UPDATE "dbspec$plans" SET step = 99'
        ], [
            'recover',
            2,
            0,
            'UPDATE "dbspec$plans" SET state = \'applying\''
        ],
            [
                'apply',
                2,
                0,
                'UPDATE "dbspec$plans" SET state = \'weird\''
            ], ['apply', 2, 0, 'UPDATE "dbspec$plans" SET to_hash = \'x\''], ['apply', 1, 0, null]];
    }
    return $scripts;
}

/** @return array<string, Closure(): mixed> every case by name; each returns its outcome as JSON values */
function dbspec_behaviour_cases(): array
{
    $root = behaviour_root();
    $shop = "dbspec 1 shop\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n";
    $cases = [];

    // Text that is not UTF-8 is one encoding diagnostic; a used document that is not UTF-8 is the diagnostic of its use
    // line.
    $bytes = [
        'invalid-byte' => "dbspec 1 shop\n\ntable t\xFF {\n",
        'invalid-byte-after-a-lone-carriage-return' => "dbspec 1 shop\r\ntable \rt\xFF {\n",
        'byte-order-mark-and-an-invalid-byte' => "\xEF\xBB\xBFdbspec 1 shop\n\xC3\n",
        'invalid-byte-in-the-header' => "dbspec 1 sh\xE9p\n",
        'truncated-sequence-at-the-end' => "dbspec 1 shop\n# caf\xC3",
        'nul-in-a-comment' => "dbspec 1 shop\n\n# a\0b\ntable t {\n  id i64\n  primary key (id)\n}\n",
    ];
    foreach ($bytes as $name => $text) {
        $cases["bytes/$name"] = static fn(): array => behaviour_parsed($text, []);
    }
    $cases['bytes/used-document-not-utf8'] = static fn(): array => behaviour_parsed(
        "dbspec 1 shop\n\nuse core { users }\n\ntable orders {\n  id i64 identity\n  primary key (id)\n}\n",
        ['core' => "dbspec 1 core\xFF"]
    );

    $cases['arguments/integer-document-name'] = static fn(): array => behaviour_outcome(
        static fn() => behaviour_parsed($shop, [1 => $shop])
    );
    $cases['arguments/document-text-not-a-string'] = static fn(): array => behaviour_outcome(
        static fn() => behaviour_parsed($shop, ['core' => 1])
    );
    $cases['arguments/render-unknown-dialect'] = static fn(): array => behaviour_outcome(
        static fn() => Dbspec::render([Dbspec::parse($shop, [])->document], 'oracle')
    );
    $cases['arguments/missing-file'] = static fn(): array => behaviour_outcome(
        static fn() => behaviour_described(Dbspec::readFile("$root/tests/dbspec/files/missing.dbs")->diagnostics)
    );
    $cases['arguments/directory'] = static fn(): array => behaviour_outcome(
        static fn() => behaviour_described(Dbspec::readFile("$root/tests/dbspec/files")->diagnostics)
    );
    $cases['arguments/manifest-of-a-text'] = static fn(): array => behaviour_outcome(
        static fn() => Dbspec::manifest([$shop])
    );
    // A document text of the set that is not a string, given to the syntax analysis and to format.
    $cases['arguments/analyze-document-text-not-a-string'] = static fn(): array => behaviour_outcome(
        static fn() => Dbspec::analyze('dbspec 1 d', ['d' => 5])
    );
    $cases['arguments/format-document-text-not-a-string'] = static fn(): array => behaviour_outcome(
        static fn() => Dbspec::format('dbspec 1 d', ['d' => 5])
    );

    $cases['manifest/repeated-document'] = static function () use ($shop): array {
        $set = [Dbspec::parse($shop, [])->document, Dbspec::parse($shop, [])->document];
        $manifest = Dbspec::manifest($set);
        $render = Dbspec::render($set, 'sqlite');
        return [
            $manifest->manifest,
            behaviour_described($manifest->diagnostics),
            $render->statements,
            behaviour_described($render->diagnostics)
        ];
    };

    // Result objects are readonly, have no dynamic properties, and keep the declaration order of their properties.
    $cases['objects/same-document-object'] = static function (): bool {
        $result = Dbspec::parse("dbspec 1 shop\n\ntable users {\n  id i64\n  primary key (id)\n}\n", []);
        return $result->document === $result->document;
    };
    $cases['objects/signature'] = static fn(): string => Dbspec::SIGNATURE;
    $cases['objects/diagnostic-write'] = static fn(): array => behaviour_outcome(static function (): void {
        $diagnostic = Dbspec::parse('x', [])->diagnostics[0];
        $diagnostic->line = 2;
    });
    $cases['objects/diagnostic-dynamic-property'] = static fn(): array => behaviour_outcome(static function (): void {
        $diagnostic = Dbspec::parse('x', [])->diagnostics[0];
        $diagnostic->extra = 1;
    });
    $cases['objects/diagnostic-properties'] = static fn(): array => array_keys(
        get_object_vars(Dbspec::parse('x', [])->diagnostics[0])
    );
    $cases['objects/position-write'] = static fn(): array => behaviour_outcome(static function (): void {
        $position = Dbspec::parse("dbspec 1 shop\n", [])->positions[0];
        $position->line = 2;
    });
    $cases['objects/position-properties'] = static fn(): array => array_keys(
        get_object_vars(Dbspec::parse("dbspec 1 shop\n", [])->positions[0])
    );
    $cases['objects/parse-result-properties'] = static fn(): array => array_keys(
        get_object_vars(Dbspec::parse("dbspec 1 shop\n", []))
    );
    $cases['objects/document-properties'] = static fn(): array => array_keys(
        get_object_vars(new Polyspec\Orm\Dbspec\Document('d'))
    );
    $cases['objects/invalid-result-without-a-diagnostic'] = static fn(): array => behaviour_outcome(
        static fn() => Polyspec\Orm\Dbspec\ParseResult::invalid([])
    );
    $cases[
        'objects/repeated-readonly-construction'
    ] = static fn(): array => behaviour_outcome(static function (): void {
        $d = new Polyspec\Orm\Dbspec\Diagnostic('syntax', 1, 2, 'm');
        $d->__construct('syntax', 1, 2, 'm');
    });

    // A document built and edited in PHP emits, manifests and renders like a parsed one; the value methods of its
    // parts.
    $cases['documents/edited'] = static function (): array {
        $document = Dbspec::parse(
            "dbspec 1 shop\n\ntable users {\n  id i64 identity\n  name varchar(64)\n  primary key (id)\n  unique users_name (name)\n}\n",
            []
        )->document;
        $ns = 'Polyspec\\Orm\\Dbspec';
        $table = $document->tables[0];
        $table->columns[] = new ("$ns\\Column")(
            'email',
            new ("$ns\\ColumnType")('varchar', [120]),
            true,
            false,
            "'a@b'",
            ['# the address']
        );
        $table->indexes[] = new ("$ns\\Index")('users_email', [new ("$ns\\IndexColumn")('email', true)]);
        $table->checks[] = new ("$ns\\Check")('users_email_set', "email <> ''");
        $table->settings = new ("$ns\\Settings")(['# settings']);
        $table->settings->settings[] = new ("$ns\\Setting")('immutable', []);
        $orders = new ("$ns\\Table")('orders', ['# orders']);
        $orders->columns[] = new ("$ns\\Column")('id', new ("$ns\\ColumnType")('i64'), false, true, null);
        $orders->columns[] = new ("$ns\\Column")('user_id', new ("$ns\\ColumnType")('i64'), false, false, null);
        $orders->primaryKey = new ("$ns\\PrimaryKey")(['id']);
        $orders->indexes[] = new ("$ns\\Index")('orders_user', [new ("$ns\\IndexColumn")('user_id', false)]);
        $orders->foreignKeys[] = new ("$ns\\ForeignKey")(
            'orders_user_fk',
            ['user_id'],
            'users',
            ['id'],
            'cascade',
            'restrict'
        );
        $document->tables[] = $orders;
        $document->diagrams[] = new ("$ns\\Diagram")('main');
        $document->diagrams[0]->placements[] = new ("$ns\\Placement")('users', -5, 10, ['# here']);
        $document->trailingComments = ['# end'];
        $emitted = Dbspec::emit($document);
        $setting = new ("$ns\\Setting")('audit', ['history', 'audit_seq', 'audit', 'action', 'previous'], [], ['name']);
        return [
            'emission' => $emitted,
            'manifest' => json_decode(json_encode(Dbspec::manifest([$document])->manifest, JSON_THROW_ON_ERROR), true),
            'statements' => array_map(
                static fn(string $dialect): ?array => Dbspec::render([$document], $dialect)->statements,
                ['mysql' => 'mysql', 'postgres' => 'postgres', 'sqlite' => 'sqlite']
            ),
            'parses-back' => behaviour_described(Dbspec::parse($emitted, [])->diagnostics),
            'records' => [$setting->records('name'), $setting->records('audit_seq'), $setting->records('id')],
            'excluded' => $setting->excluded($document->tables[0]),
            'audit-line' => $setting->auditLine('exclude', ['name']),
            'type-text' => [
                (new ("$ns\\ColumnType")('decimal', [5, 2]))->text(),
                (new ("$ns\\ColumnType")('i32'))->isInteger()
            ],
            'changes-child-rows' => $orders->foreignKeys[0]->changesChildRows(),
        ];
    };

    // A failing catalog query in each error mode; catalog values of another shape and exceptions of a PDO subclass; an
    // unknown dialect; a connection that is not a PDO.
    foreach (
        [
        PDO::ERRMODE_EXCEPTION => 'exception',
        PDO::ERRMODE_SILENT => 'silent',
        PDO::ERRMODE_WARNING => 'warning'
        ] as $mode => $modeName
    ) {
        foreach (['mysql', 'postgres'] as $dialect) {
            $cases["introspect/query-failure/$modeName/$dialect"] = static fn(): array => @behaviour_introspected(
                new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => $mode]),
                $dialect
            );
        }
    }
    $answers = [
        'table-name-that-is-a-number' => static fn(string $q): array => [[5, 'table', 't', '']],
        'null-table-kind' => static fn(string $q): array => [['t', null, 't', '']],
        'float-flag' => static fn(string $q): array => str_contains($q, 'pg_class c') ? [['t', 'r', 1.5]] : [],
        'word-flag' => static fn(string $q): array => str_contains($q, 'pg_class c') ? [['t', 'r', 'yes']] : [],
        'exception-of-the-subclass' => static fn(string $q): array => throw new DomainException('refused'),
        'pdo-exception-of-the-subclass' => static fn(string $q): array => throw new PDOException(
            'SQLSTATE[HY000]: gone'
        ),
    ];
    foreach ($answers as $name => $answer) {
        foreach (['sqlite', 'postgres'] as $dialect) {
            $cases["introspect/catalog/$name/$dialect"] = static fn(): array => behaviour_introspected(
                new BehaviourScriptedPdo($answer),
                $dialect
            );
        }
    }
    $cases['introspect/unknown-dialect'] = static fn(): array => behaviour_outcome(
        static fn() => Dbspec::introspect(new PDO('sqlite::memory:'), 'oracle', 'x')
    );
    $cases['introspect/not-a-pdo'] = static fn(): array => behaviour_outcome(
        static fn() => Dbspec::introspect(new stdClass(), 'sqlite', 'x')
    );

    // The argument errors of the apply commands.
    $now = static fn(): DateTimeImmutable => new DateTimeImmutable('2026-10-01T00:00:00Z');
    foreach ([PDO::ERRMODE_SILENT => 'silent', PDO::ERRMODE_WARNING => 'warning'] as $mode => $modeName) {
        $cases["apply-arguments/error-mode-$modeName"] = static fn(): array => behaviour_outcome(
            static fn() => Dbspec::apply(
                new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => $mode]),
                'sqlite',
                behaviour_chains()['main'],
                $now,
                null
            )
        );
    }
    $exceptions = static fn(): PDO => new PDO(
        'sqlite::memory:',
        null,
        null,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
    $cases['apply-arguments/unknown-dialect'] = static fn(): array => behaviour_outcome(
        static fn() => Dbspec::finalize($exceptions(), 'oracle', behaviour_chains()['main'], $now, null)
    );
    $cases['apply-arguments/two-plans-from-empty'] = static fn(): array => behaviour_outcome(
        static fn() => Dbspec::apply(
            $exceptions(),
            'sqlite',
            [behaviour_chains()['main'][0], behaviour_chains()['main'][0]],
            $now,
            null
        )
    );
    $cases['apply-arguments/clock-returns-text'] = static fn(): array => behaviour_outcome(
        static fn() => Dbspec::apply($exceptions(), 'sqlite', behaviour_chains()['main'], static fn() => 'now', null)
    );

    // The constructors of SetResult.
    $cases['sets/result-invalid-without-an-error'] = static fn(): array => behaviour_outcome(
        static fn() => Polyspec\Orm\Dbspec\SetResult::invalid([])
    );
    $cases['sets/result-invalid'] = static fn(): array => behaviour_outcome(
        static fn() => Polyspec\Orm\Dbspec\SetResult::invalid(
            [new Polyspec\Orm\Dbspec\SetError('set.file', 'a', 'a: m')]
        )
    );
    $cases['sets/result-valid'] = static fn(): array => behaviour_outcome(
        static fn() => Polyspec\Orm\Dbspec\SetResult::valid([new Polyspec\Orm\Dbspec\SetFile('a.dbs', 'x')], [])
    );

    // Names: render keeps a name of at most 63 bytes and otherwise cuts it by bytes and adds a $ and 8 hex digits of
    // its SHA-256; column finds the first column whose rendered name is the name, and stops reading there; ofTable
    // lists the rendered names of a table.
    $renders = [
        ['t', 'c'],
        ['orders', 'immutable_update'],
        [str_repeat('a', 61), 'c'],
        [str_repeat('a', 62), 'c'],
        [str_repeat('a', 62), 'abc'],
        ["caf\u{e9}_" . str_repeat('x', 56), 'name'],
        ['x', '']
    ];
    foreach ($renders as $i => [$table, $suffix]) {
        $cases["names/render/$i"] = static fn(): array => behaviour_outcome(
            static fn() => Polyspec\Orm\Dbspec\Names::render($table, $suffix)
        );
    }
    $long = 'c_' . str_repeat('y', 60);
    $target = static fn(): string => Polyspec\Orm\Dbspec\Names::render('orders', $long);
    $columns = ['id', $long, 'other', $long];
    $cases['names/column/array-hit'] = static fn(): array => behaviour_outcome(
        static fn() => Polyspec\Orm\Dbspec\Names::column('orders', $target(), $columns)
    );
    $cases['names/column/array-miss'] = static fn(): array => behaviour_outcome(
        static fn() => Polyspec\Orm\Dbspec\Names::column('orders', 'nothing$00000000', $columns)
    );
    $cases['names/column/empty-array'] = static fn(): array => behaviour_outcome(
        static fn() => Polyspec\Orm\Dbspec\Names::column('orders', $target(), [])
    );
    $cases[
        'names/column/generator-stops-at-the-match'
    ] = static fn(): array => behaviour_outcome(static fn() => Polyspec\Orm\Dbspec\Names::column('orders', $target(), (static function () use (
        $long
    ): Generator {
        yield 'id';
        yield $long;
        throw new RuntimeException('read past the first match');
    })()));
    $cases['names/column/array-iterator'] = static fn(): array => behaviour_outcome(
        static fn() => Polyspec\Orm\Dbspec\Names::column('orders', $target(), new ArrayIterator(['id', $long]))
    );
    $cases['names/column/non-string-element'] = static fn(): array => behaviour_outcome(
        static fn() => Polyspec\Orm\Dbspec\Names::column('orders', $target(), ['id', 5])
    );
    $named = "dbspec 1 d\ntable orders {\n  id i64 identity\n  note text\n  code varchar(40) null\n  amount decimal(10,2)\n  primary key (id)\n  settings {\n    immutable\n  }\n}\ntable "
        . str_repeat(
            'a',
            62
        ) . " {\n  id i64 identity\n  c_long_column_name_that_is_hashed i64\n  primary key (id)\n}\n";
    $cases['names/of-table'] = static function () use ($named): array {
        $parsed = Dbspec::parse($named, ['d' => $named]);
        return [
            behaviour_described($parsed->diagnostics),
            array_map(
                static fn(Polyspec\Orm\Dbspec\Table $t): array => Polyspec\Orm\Dbspec\Names::ofTable($t),
                $parsed->document->tables
            )
        ];
    };

    foreach (behaviour_apply_scripts() as $name => $script) {
        $cases["apply/$name"] = static fn(): array => behaviour_applied(
            behaviour_chains()[explode('/', $name)[0]],
            $script
        );
    }
    return $cases;
}

/** The recorded outcomes of fixtures/dbspec-behaviour.json. */
function dbspec_behaviour_recorded(): array
{
    return json_decode(
        file_get_contents(__DIR__ . '/fixtures/dbspec-behaviour.json'),
        true,
        512,
        JSON_THROW_ON_ERROR
    )['cases'];
}
