<?php

// The recipe helper of PHP (docs/spec/feature-coverage.md FCV-2 to FCV-4): the entry of each suite unit, a test class
// <Recipe>RecipeTest whose method test<Database> takes the cases of Recipe::cases, calls Recipe::run for each case, and
// each step calls the public API of Polyspec\Orm that its op names. The PHP extension runs the same entry through a
// class that extends it. It has no command line and no output of its own.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\OrderedJson\Kind;
use Polyspec\OrderedJson\Value as OrderedJson;
use Polyspec\Orm\Bytes;
use Polyspec\Orm\Catalog;
use Polyspec\Orm\CatalogGridCell;
use Polyspec\Orm\CatalogResult;
use Polyspec\Orm\CatalogTablePage;
use Polyspec\Orm\CatalogTableMetadata;
use Polyspec\Orm\Codec;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Dbspec\Change;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Diagnostic;
use Polyspec\Orm\Dbspec\Difference;
use Polyspec\Orm\Dbspec\Plan;
use Polyspec\Orm\Dbspec\PlanStep;
use Polyspec\Orm\Engine;
use Polyspec\Orm\Model;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Registry;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;
use Polyspec\Orm\StatementEvent;
use Polyspec\Orm\StyledValue;
use Polyspec\Orm\Validator;
use RuntimeException;

final class Recipe
{
    use RecipeModel;

    /** The table models of the statement-event fixture that have no generated class: each names its table (FCV-4). */
    public const TABLE_MODELS = ['EventProbe' => 'event_probe'];

    /** The database part of a recipe without a database (FCV-3). */
    public const NONE = 'none';

    /** The dbspec ops on parsed texts that dbspecStep runs (FCV-4). */
    private const DBSPEC_OPS = [
        'dbspec.parse', 'dbspec.parse_plan', 'dbspec.emit_plan', 'dbspec.diff', 'dbspec.plan_steps', 'dbspec.chain',
        'dbspec.compare',
    ];

    /** The dbspec ops whose documents are files relative to the recipe, which dbspecFileStep runs (FCV-4). */
    private const DBSPEC_FILE_OPS = [
        'dbspec.parse_emit', 'dbspec.manifest', 'dbspec.render', 'dbspec.analyze', 'dbspec.parse_positions',
        'dbspec.format', 'dbspec.parse_set', 'dbspec.set', 'dbspec.read_file', 'dbspec.read_bytes',
    ];

    /** The Mermaid ops (FCV-4), on the public Mermaid calls of Dbspec (DBS-169). */
    private const MERMAID_OPS = ['dbspec.export_mermaid', 'dbspec.import_mermaid'];

    /** @return iterable<string, array{array<string, mixed>}> each case of the recipe at path, relative to the repository root */
    public static function cases(string $path): iterable
    {
        $text = (string) file_get_contents(dirname(__DIR__, 3) . '/' . $path);
        RecipeKeys::check($path, $text);
        $recipe = json_decode($text, true, 512, JSON_THROW_ON_ERROR);
        foreach ($recipe['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    /** Runs the steps of one case on database. */
    public static function run(string $path, array $case, string $database): void
    {
        // A case with `only` runs on the databases that it names, and no other.
        if (isset($case['only']) && !in_array($database, $case['only'], true)) {
            return;
        }
        if ($database !== self::NONE) {
            self::runDatabase($path, $case, $database);
            return;
        }
        $bound = [];
        foreach ($case['steps'] as $index => $step) {
            try {
                if ($step['op'] === 'ir.validate') {
                    self::validateStep($step, $path, $database);
                    continue;
                }
                if ($step['op'] === 'ir.answer') {
                    self::answerStep($step);
                    continue;
                }
                if ($step['op'] === 'planner.compile') {
                    self::planStep($step, $path, $database);
                    continue;
                }
                if (in_array($step['op'], self::DBSPEC_OPS, true)) {
                    self::dbspecStep($step, $bound, $database);
                    continue;
                }
                if ($step['op'] === 'dsn.connect') {
                    self::dsnConnectStep($step, $database);
                    continue;
                }
                if (in_array($step['op'], self::DBSPEC_FILE_OPS, true)) {
                    self::dbspecFileStep($step, $path, $database);
                    continue;
                }
                if (in_array($step['op'], self::MERMAID_OPS, true)) {
                    self::mermaidStep($step, $bound, $path, $database);
                    continue;
                }
                self::step($step, $bound, $database);
            } catch (\PHPUnit\Framework\AssertionFailedError $failure) {
                Assert::fail(
                    "recipe $path case {$case['id']} step $index ({$step['op']}) on $database: {$failure->getMessage()}"
                );
            }
        }
    }

    /**
     * Gives the request of an ir.validate step to the validator, with the manifest_hash of the schema that the recipe
     * names (relative to the recipe file) added, and checks the outcome of the expect of database: {value: {bool:
     * true}} for an accepted request, {error: CODE} for a request that fails with CODE.
     */
    private static function validateStep(array $step, string $path, string $database): void
    {
        $outcome = $step['expect'][$database] ?? Assert::fail("ir.validate has no expect for $database");
        $root = dirname(__DIR__, 3);
        $recipe = json_decode(file_get_contents($root . '/' . $path), true, 512, JSON_THROW_ON_ERROR);
        $schema = realpath(dirname($root . '/' . $path) . '/' . $recipe['schema']);
        if ($schema === false) {
            Assert::fail("ir.validate: the schema of $path is missing");
        }
        if (array_key_exists('manifest_hash', $step['request'])) {
            Assert::fail('request already holds manifest_hash');
        }
        $model = RuntimeModel::build(RuntimeModel::files([$schema]));
        $got = 'no error';
        try {
            (new Validator($model))->validate($step['request'] + ['manifest_hash' => $model->manifestHash]);
        } catch (OrmException $error) {
            $got = $error->code_;
        }
        if (isset($outcome['error'])) {
            Assert::assertSame($outcome['error'], $got);
            return;
        }
        Assert::assertSame(['bool' => true], $outcome['value'] ?? null, 'ir.validate expects {bool true} or an error');
        Assert::assertSame('no error', $got);
    }

    /**
     * Compiles the request of a planner.compile step with the Engine of each dialect, against the manifest of the
     * schema that the step names relative to the recipe file, and checks the plans with the expect of database:
     * {value: {mysql, postgres, sqlite}} with the statements of each dialect, or {error: CODE}, which every dialect
     * must reject with.
     */
    private static function planStep(array $step, string $path, string $database): void
    {
        if ($database !== self::NONE) {
            Assert::fail('planner.compile runs without a database');
        }
        $outcome = $step['expect'][$database] ?? Assert::fail("planner.compile has no expect for $database");
        $root = dirname(__DIR__, 3);
        $schema = realpath(dirname($root . '/' . $path) . '/' . $step['schema']);
        if ($schema === false) {
            Assert::fail("planner.compile: the schema of $path is missing");
        }
        $model = RuntimeModel::build(RuntimeModel::files([$schema]));
        $request = $step['input'] + ['manifest_hash' => $model->manifestHash];
        $dialects = ['mysql', 'postgres', 'sqlite'];
        if (isset($outcome['error'])) {
            foreach ($dialects as $dialect) {
                $code = 'no error';
                try {
                    (new Engine($model, $dialect, 8))->compile($request);
                } catch (OrmException $error) {
                    $code = $error->code_;
                }
                Assert::assertSame($outcome['error'], $code, "$dialect planner.compile");
            }
            return;
        }
        $got = [];
        foreach ($dialects as $dialect) {
            $plan = (new Engine($model, $dialect, 8))->compile($request);
            $got[$dialect] = array_map(static fn(array $planned): array => [
                'role' => $planned['role'],
                'slots' => array_map(self::planSlot(...), $planned['bind_slots']),
                'sql' => $planned['sql'],
                'tables' => $planned['tables'],
            ], $plan['steps']);
        }
        Assert::assertSame(self::sortedKeys($outcome['value']), self::sortedKeys($got), 'planner.compile statements');
    }

    /** A bind slot in the form of the planner fixture: its source, param number, type and the fields that the fixture writes. */
    private static function planSlot(array $slot): array
    {
        if ($slot['from'] === 'parent') {
            return ['from' => 'parent', 'key_types' => $slot['key_types']];
        }
        $type = $slot['col_type'] ?? '';
        $out = ['from' => $slot['from']];
        if ($slot['from'] === 'param' && $type === 'varchar') {
            $out['length'] = $slot['length'] ?? 0;
        }
        if (!empty($slot['not_null'])) {
            $out['not_null'] = true;
        }
        if ($slot['from'] === 'param') {
            $out['param'] = $slot['param'];
        }
        if ($type === 'datetime' || $type === 'time') {
            $out['precision'] = $slot['precision'] ?? 0;
        }
        $out['type'] = $type;
        return $out;
    }

    /**
     * Runs one dbspec op through its public call (FCV-4) and compares its result with the expect of database, as a
     * JSON value: the diagnostics as [rule, line, column, message], the message kept for rule plan (for every rule in
     * compare), or the messages of the diagnostics of one rule. A parse op binds its document or plan to as, for a
     * later ref; a null source of diff is the empty schema.
     *
     * @param array<string, mixed> $step
     * @param array<string, mixed> $bound
     */
    private static function dbspecStep(array $step, array &$bound, string $database): void
    {
        $op = $step['op'];
        $expect = $step['expect'][$database] ?? Assert::fail("$op has no expect for $database");
        if ($op === 'dbspec.parse') {
            $result = Dbspec::parse(self::dbspecText($step['lines']), []);
            if (isset($step['as'])) {
                $bound[$step['as']] = $result->document;
            }
            $got = ['diagnostics' => self::dbspecRows($result->diagnostics, false)];
        } elseif ($op === 'dbspec.parse_plan') {
            $result = Dbspec::parsePlan(self::dbspecText($step['lines']));
            if (isset($step['as'])) {
                $bound[$step['as']] = $result->plan;
            }
            $got = ['diagnostics' => self::dbspecRows($result->diagnostics, false)];
        } elseif ($op === 'dbspec.diff') {
            $source = ($step['source'] ?? null) === null ? null : self::dbspecBound($step['source'], $bound);
            $result = Dbspec::diff($source, self::dbspecBound($step['plan'], $bound));
            $got = $result->diagnostics === []
                ? ['changes' => array_map(
                    static fn(Change $c): array => [$c->kind, $c->table, $c->name],
                    $result->changes ?? []
                )]
                : ['messages' => self::dbspecMessages($result->diagnostics, 'plan')];
        } elseif ($op === 'dbspec.chain') {
            $plans = array_map(static fn(mixed $raw): mixed => self::dbspecBound($raw, $bound), $step['plans']);
            $result = Dbspec::chain($plans);
            $got = $result->diagnostics === []
                ? ['order' => array_map(static fn(Plan $p): string => $p->name, $result->plans ?? [])]
                : ['messages' => self::dbspecMessages($result->diagnostics, 'chain')];
        } elseif ($op === 'dbspec.compare') {
            $result = Dbspec::compareSchemas(
                self::dbspecBound($step['source'], $bound),
                self::dbspecBound($step['target'], $bound)
            );
            $got = [
                'differences' => array_map(
                    static fn(Difference $d): array => [$d->kind, $d->table, $d->name],
                    $result->differences ?? []
                ),
                'diagnostics' => self::dbspecRows($result->diagnostics, true),
            ];
        } elseif ($op === 'dbspec.emit_plan') {
            $got = ['text' => Dbspec::emitPlan(self::dbspecBound($step['plan'], $bound))];
        } elseif ($op === 'dbspec.plan_steps') {
            $source = ($step['source'] ?? null) === null ? null : self::dbspecBound($step['source'], $bound);
            $result = Dbspec::planSteps($source, self::dbspecBound($step['plan'], $bound), $step['dialect']);
            $steps = $result->steps ?? Assert::fail('plan steps: ' . self::diagnostics($result->diagnostics));
            $got = ['steps' => array_map(static fn(PlanStep $s): array => self::planStepFields($s), $steps)];
        } else {
            Assert::fail("OP_UNKNOWN $op");
        }
        Assert::assertSame(self::sortedKeys($expect), self::sortedKeys($got), "$op: result differs from the expect");
    }

    /** The object of one step as docs/spec/plans.md "Steps" writes it, keys in name order. */
    private static function planStepFields(PlanStep $s): array
    {
        $out = ['statement' => $s->statement, 'effect' => $s->effect->text()];
        if ($s->rollback !== '') {
            $out['rollback'] = $s->rollback;
        } elseif ($s->irreversible !== '') {
            $out['irreversible'] = $s->irreversible;
        }
        if ($s->restore !== '') {
            $out['restore'] = $s->restore;
        }
        if ($s->rollbackRestore !== '') {
            $out['rollback_restore'] = $s->rollbackRestore;
        }
        if ($s->restore !== '' || $s->rollbackRestore !== '') {
            $out['restore_if'] = $s->restoreIf?->text();
        }
        if ($s->nullChecks !== []) {
            $out['null_checks'] = array_map(
                static fn($c): array => [$c->table, $c->column, $c->default],
                $s->nullChecks
            );
        }
        if ($s->finalize) {
            $out['finalize'] = true;
        }
        ksort($out);
        return $out;
    }

    /** The text of lines, each ended by LF, as a dbspec or plan text (Parse and ParsePlan of the lines + "\n"). */
    private static function dbspecText(array $lines): string
    {
        return implode("\n", $lines) . "\n";
    }

    /** The value that the ref of raw binds by an earlier dbspec step; a ref that binds no value fails the case. */
    private static function dbspecBound(mixed $raw, array $bound): mixed
    {
        if (!is_array($raw) || !array_key_exists('ref', $raw)) {
            Assert::fail(json_encode($raw) . ' is not a ref');
        }
        return $bound[$raw['ref']] ?? Assert::fail("ref {$raw['ref']} binds no value");
    }

    /** @param list<Diagnostic> $diagnostics @return list<array{string, int, int, ?string}> */
    private static function dbspecRows(array $diagnostics, bool $everyMessage): array
    {
        return array_map(
            static fn(Diagnostic $d): array => [
                $d->rule,
                $d->line,
                $d->column,
                $everyMessage || $d->rule === 'plan' ? $d->message : null,
            ],
            $diagnostics
        );
    }

    /** The messages of the diagnostics; a diagnostic of a rule other than rule fails the case. @param list<Diagnostic> $diagnostics @return list<string> */
    private static function dbspecMessages(array $diagnostics, string $rule): array
    {
        return array_map(static function (Diagnostic $d) use ($rule): string {
            Assert::assertSame($rule, $d->rule, "diagnostic of rule {$d->rule}, want $rule: {$d->message}");
            return $d->message;
        }, $diagnostics);
    }

    /** The value with the keys of every object sorted, so that two plans compare as their fixture writes them. */
    private static function sortedKeys(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }
        $value = array_map(self::sortedKeys(...), $value);
        if (!array_is_list($value)) {
            ksort($value);
        }
        return $value;
    }

    /**
     * Runs the chain of an ir.answer step (a case of MarkdownConformanceTest::conformanceCases) on a connection whose
     * listener answers connect with {"ok":true} and then the one request with answer. A step with answers instead
     * gets the keyed listener (--keyed), which answers each control message by its op and each request by its
     * request.kind. The normalized result of the chain must equal the normalized expect.none.value. An OrmException
     * of the chain is the result {error: CODE}; any other exception fails the case.
     */
    private static function answerStep(array $step): void
    {
        $outcome = $step['expect']['none'] ?? [];
        $params = array_key_exists('params', $outcome);
        if (!array_key_exists('value', $outcome) && !$params) {
            Assert::fail('ir.answer has neither expect.none.value nor params');
        }
        if ($params && array_key_exists('answers', $step)) {
            Assert::fail('a params expect needs one answer, not answers');
        }
        $want = $params ? $outcome['params'] : $outcome['value'];
        $bind = $step['bind'] ?? null;
        if ($bind !== null && $step['chain'] !== 'slot') {
            Assert::fail("a bind step names the chain slot, not {$step['chain']}");
        }
        $chain = $bind !== null
            ? self::bindSlotChain($bind)
            : (MarkdownConformanceTest::conformanceCases()[$step['chain']] ?? null);
        if ($chain === null) {
            Assert::fail("chain {$step['chain']} is no markdown conformance case");
        }
        $flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR;
        $server = array_key_exists('answers', $step)
            ? start_markdown_test_server(['--keyed', json_encode($step['answers'], $flags)])
            : start_markdown_test_server(['{"ok":true}', json_encode($step['answer'], $flags)]);
        $served = new Served();
        $served->db = $bind !== null
            ? \Polyspec\Orm\Tests\BindModel\connect($server[2], new Config())
            : \Polyspec\Orm\Tests\MarkdownModel\connect($server[2], new Config());
        $failed = false;
        try {
            $got = $chain($served);
        } catch (OrmException $error) {
            $got = ['error' => $error->code_];
            $failed = true;
        } finally {
            $served->db->close();
            $received = markdown_test_server_received_messages($server);
        }
        if ($params && !$failed) {
            $got = self::requestParams($received);
        }
        $actual = MarkdownConformanceTest::normalize($got);
        $expect = MarkdownConformanceTest::normalize($want);
        Assert::assertSame(
            $expect,
            $actual,
            'got ' . MarkdownConformanceTest::jsonText($actual) . ', want ' . MarkdownConformanceTest::jsonText($expect)
        );
    }

    /**
     * The chain of a bind step (T334-3-15-3c, PRT-67): it writes the bind value into the slot column of the bind model
     * through its setter and sends the insert, so the request carries the wire value of the slot.
     */
    private static function bindSlotChain(array $bind): \Closure
    {
        $setter = 'set' . self::studly(explode('_', $bind['column'])[0]) . 'Value';
        return static function (Served $served) use ($setter, $bind): mixed {
            $row = (new \Polyspec\Orm\Tests\BindModel\Slots())->connect($served->db);
            $row->{$setter}($bind['value'])->create();
            return null;
        };
    }

    /** The params of the request message that a server received, in the JSON form of PRT-67 (PRT-66). */
    private static function requestParams(array $received): array
    {
        foreach ($received as $line) {
            $message = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
            if (array_key_exists('request', $message)) {
                return $message['params'] ?? [];
            }
        }
        throw new \RuntimeException('the listener received no request message');
    }

    /** Opens a DSN with Orm::connect, closes it and returns its driver: the one implementation of dsn.connect (FCV-4). */
    private static function connectDriver(string $dsn): string
    {
        $db = Orm::connect($dsn, new Config());
        try {
            return $db->driver();
        } finally {
            $db->close();
        }
    }

    /** The dsn.connect op (FCV-4): the DSN text of the step, checked against the outcome of the expect of database. */
    private static function dsnConnectStep(array $step, string $database): void
    {
        $expect = $step['expect'][$database] ?? null;
        if ($expect === null) {
            Assert::fail("dsn.connect has no expect for $database");
        }
        $code = null;
        $driver = null;
        try {
            $driver = self::connectDriver($step['dsn']);
        } catch (OrmException $error) {
            $code = $error->code_;
        }
        if (isset($expect['error'])) {
            if ($code !== $expect['error']) {
                Assert::fail('error ' . ($code ?? 'none') . ", want {$expect['error']}");
            }
            return;
        }
        if ($code !== null) {
            Assert::fail("unexpected error $code");
        }
        if ($expect['value'] !== ['text' => $driver]) {
            Assert::fail("driver $driver, want " . json_encode($expect['value']));
        }
    }

    /** The name of a document: the third word of its header line. */
    private static function headerName(string $text): string
    {
        $fields = preg_split('/\s+/', trim(explode("\n", $text, 2)[0])) ?: [];

        return $fields[2] ?? '';
    }

    /** The table names that the CREATE TABLE statements create, in statement order. */
    private static function createdTables(array $statements): array
    {
        $names = [];
        foreach ($statements as $statement) {
            if (str_starts_with($statement, 'CREATE TABLE ')) {
                $rest = explode(' ', substr($statement, strlen('CREATE TABLE ')), 2)[0];
                $names[] = trim($rest, '`"');
            }
        }

        return $names;
    }

    /** Checks that the diagnostics have the rule, line and column of each expected diagnostic, in order, each with a message. */
    private static function sameDiagnostics(array $want, array $got): void
    {
        $values = array_map(
            static fn ($d): array => ['rule' => $d->rule, 'line' => $d->line, 'column' => $d->column],
            $got,
        );
        Assert::assertSame($want, $values, 'diagnostics');
        foreach ($got as $d) {
            Assert::assertNotSame('', $d->message, "diagnostic {$d->rule} has no message");
        }
    }

    /**
     * Runs dbspec.set (the port of checkSet of packages/go/internal/recipe/dbspec.go). The owned texts, then the
     * external texts, are parsed each against the other texts and the parsing texts, and Dbspec::manifest builds the
     * set's manifest. A refused set (expect diagnostics not empty) expects those diagnostics from the manifest and from
     * each dialect of render, and no manifest and no statements. A built set expects its texts and hashes when expect
     * manifest is given, parses its manifest and external texts back as a set without diagnostics, gives the same
     * hashes in the reversed order, and renders statements in each dialect that create the tables of expect created.
     */
    private static function dbspecSet(array $step, array $expect): void
    {
        $owned = array_values($step['owned'] ?? []);
        $all = array_merge($owned, array_values($step['external'] ?? []));
        $parsing = $step['parsing'] ?? [];
        $documents = [];
        foreach ($all as $i => $text) {
            $set = $parsing;
            foreach ($all as $j => $other) {
                if ($j !== $i) {
                    $set[self::headerName($other)] = $other;
                }
            }
            $parsed = Dbspec::parse($text, $set);
            if ($parsed->document === null) {
                Assert::fail('document ' . ($i + 1) . ': ' . self::diagnostics($parsed->diagnostics));
            }
            $document = $parsed->document;
            $document->external = $i >= count($owned);
            $documents[] = $document;
        }
        $want = $expect['diagnostics'] ?? [];
        $refused = $want !== [];
        $built = Dbspec::manifest($documents);
        self::sameDiagnostics($want, $built->diagnostics);
        Assert::assertSame(
            $refused,
            $built->manifest === null,
            'the manifest is absent exactly when the set is refused',
        );
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            $rendered = Dbspec::render($documents, $dialect);
            if ($refused) {
                self::sameDiagnostics($want, $rendered->diagnostics);
                Assert::assertNull($rendered->statements, "$dialect renders no statements for a refused set");
                continue;
            }
            if ($rendered->diagnostics !== []) {
                Assert::fail("$dialect: " . self::diagnostics($rendered->diagnostics));
            }
            if (($rendered->statements ?? []) === []) {
                Assert::fail("$dialect renders no statements");
            }
            if (array_key_exists('created', $expect)) {
                Assert::assertSame(
                    $expect['created'],
                    self::createdTables($rendered->statements),
                    "tables that $dialect creates",
                );
            }
        }
        if ($refused) {
            return;
        }
        $manifest = $built->manifest;
        if (isset($expect['manifest'])) {
            $want = $expect['manifest'];
            Assert::assertSame($want['manifest_text'], $manifest->manifestText, 'manifest_text');
            Assert::assertSame($want['schema_text'], $manifest->schemaText, 'schema_text');
            Assert::assertSame($want['manifest_hash'], $manifest->manifestHash, 'manifest_hash');
            Assert::assertSame($want['schema_hash'], $manifest->schemaHash, 'schema_hash');
            if (array_key_exists('external_text', $want)) {
                Assert::assertSame($want['external_text'], $manifest->externalText, 'external_text');
            }
        }
        // The manifest and external text parse back as a set without diagnostics (docs/spec/dbspec.md "Manifest and
        // hashes").
        $split = static fn (string $text): array => $text === ''
            ? []
            : preg_split('/(?<=\n)(?=dbspec )/', $text, -1, PREG_SPLIT_NO_EMPTY);
        foreach (Dbspec::parseSet($split($manifest->manifestText), $split($manifest->externalText)) as $r) {
            Assert::assertSame([], $r->diagnostics, "manifest and external text of {$r->name}");
        }
        $reversed = Dbspec::manifest(array_reverse($documents));
        Assert::assertNotNull($reversed->manifest, 'the reversed set has a manifest');
        Assert::assertSame(
            $manifest->manifestHash,
            $reversed->manifest->manifestHash,
            'the reversed set has the manifest hash',
        );
        Assert::assertSame(
            $manifest->schemaHash,
            $reversed->manifest->schemaHash,
            'the reversed set has the schema hash',
        );
    }

    /**
     * Runs one dbspec op of a recipe step through the public calls of Dbspec and checks the result against the expect
     * of none (the Go twin is checkDBSpec in packages/go/internal/recipe/dbspec.go; the semantics are the same).
     */
    private static function dbspecFileStep(array $step, string $path, string $database): void
    {
        $expect = $step['expect'][$database] ?? Assert::fail("{$step['op']} has no expect for $database");
        $dir = dirname(dirname(__DIR__, 3) . '/' . $path);
        switch ($step['op']) {
            case 'dbspec.parse_emit':
                [$texts, $documents] = self::dbspecDocuments($dir, $step['documents']);
                $identical = true;
                foreach ($documents as $i => $document) {
                    $identical = $identical && Dbspec::emit($document) === $texts[$i];
                }
                Assert::assertSame($expect['identical'] ?? null, $identical, 'emit identical');
                return;
            case 'dbspec.manifest':
                [, $documents] = self::dbspecDocuments($dir, $step['documents']);
                $result = Dbspec::manifest($documents);
                if ($result->diagnostics !== []) {
                    Assert::fail(self::diagnostics($result->diagnostics));
                }
                $hash = $expect['manifest_hash'] ?? '';
                if ($hash === '' || $result->manifest->manifestHash !== $hash) {
                    Assert::fail("manifest hash {$result->manifest->manifestHash}, want $hash");
                }
                return;
            case 'dbspec.render':
                [, $documents] = self::dbspecDocuments($dir, $step['documents']);
                foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
                    $result = Dbspec::render($documents, $dialect);
                    if ($result->diagnostics !== []) {
                        Assert::fail("$dialect: " . self::diagnostics($result->diagnostics));
                    }
                    $want = $expect[$dialect] ?? [];
                    if ($want === [] || $result->statements !== $want) {
                        Assert::fail("$dialect statements " . json_encode($result->statements));
                    }
                }
                return;
            case 'dbspec.analyze':
                if (!array_key_exists('document', $step)) {
                    [$text, $set] = self::inlineDocument($step);
                    self::checkTokens(Dbspec::analyze($text, $set)->tokens, $expect['tokens'] ?? []);
                    return;
                }
                $text = self::dbspecFile($dir, $step['document']);
                $analysis = Dbspec::analyze($text, []);
                $parsed = Dbspec::parse($text, []);
                if ($analysis->diagnostics !== []) {
                    Assert::fail(self::diagnostics($analysis->diagnostics));
                }
                $same = $analysis->document !== null && $parsed->document !== null
                    && Dbspec::emit($analysis->document) === Dbspec::emit($parsed->document)
                    && $analysis->positions == $parsed->positions;
                if (!$same) {
                    Assert::fail('the analysis differs from the parse');
                }
                self::checkTokens($analysis->tokens, $expect['tokens'] ?? []);
                return;
            case 'dbspec.parse_positions':
                if (array_key_exists('document', $step)) {
                    $parsed = Dbspec::parse(self::dbspecFile($dir, $step['document']), []);
                } else {
                    [$text, $set] = self::inlineDocument($step);
                    $parsed = Dbspec::parse($text, $set);
                }
                if ($parsed->document === null) {
                    Assert::fail(self::diagnostics($parsed->diagnostics));
                }
                $got = array_map(
                    static fn(object $p): array => [$p->kind, $p->path, $p->line, $p->column],
                    $parsed->positions
                );
                $want = array_map(
                    static fn(array $p): array => [$p['kind'], $p['path'], $p['line'], $p['column']],
                    $expect['positions'] ?? []
                );
                if ($got === [] || $got !== $want) {
                    Assert::fail('positions ' . json_encode($got));
                }
                return;
            case 'dbspec.format':
                if (($step['text'] ?? []) === []) {
                    Assert::fail('dbspec.format has no text');
                }
                [$text, $set] = self::inlineDocument($step);
                if (array_key_exists('diagnostics', $expect)) {
                    self::checkRefusal($text, $set, $expect['diagnostics']);
                    return;
                }
                $expected = implode("\n", $expect['text'] ?? []) . "\n";
                $emitted = self::emitStable($text, $set);
                if ($emitted !== $expected) {
                    Assert::fail("emission {$emitted}, want $expected");
                }
                $result = Dbspec::format($text, $set);
                if ($result->diagnostics !== []) {
                    Assert::fail(self::diagnostics($result->diagnostics));
                }
                if ($result->text !== $expected) {
                    Assert::fail("formatted text {$result->text}, want $expected");
                }
                if (Dbspec::format($result->text, $set)->text !== $result->text) {
                    Assert::fail('the format of the formatted text differs');
                }
                return;
            case 'dbspec.parse_set':
                $got = Dbspec::parseSet(array_values($step['owned'] ?? []), array_values($step['external'] ?? []));
                $want = $expect['documents'] ?? [];
                Assert::assertSame(count($want), count($got), 'one result per text');
                foreach ($got as $i => $d) {
                    $w = $want[$i];
                    Assert::assertSame($w['name'], $d->name, "documents[$i].name");
                    Assert::assertSame($w['external'], $d->external, "documents[$i].external");
                    Assert::assertSame($w['parsed'], $d->document !== null, "documents[$i].parsed");
                    Assert::assertSame(
                        count($w['diagnostics']),
                        count($d->diagnostics),
                        "documents[$i] diagnostic count"
                    );
                    foreach ($w['diagnostics'] as $k => $wd) {
                        $x = $d->diagnostics[$k];
                        Assert::assertSame(
                            [$wd['rule'], $wd['line'], $wd['column']],
                            [$x->rule, $x->line, $x->column],
                            "documents[$i] diagnostic $k"
                        );
                        if (isset($wd['message'])) {
                            Assert::assertSame($wd['message'], $x->message, "documents[$i] diagnostic $k message");
                        }
                    }
                }
                return;
            case 'dbspec.read_file':
            case 'dbspec.read_bytes':
                $want = $expect['errors'] ?? [];
                $full = "$dir/" . $step['path'];
                $name = $full;
                if ($step['op'] === 'dbspec.read_file') {
                    $read = Dbspec::readFile($full);
                } else {
                    $name = $step['path'];
                    $read = Dbspec::readBytes($name, (string) file_get_contents($full));
                }
                if ($want !== []) {
                    Assert::assertNull($read->text, 'the reader returned text with diagnostics');
                    Assert::assertSame(count($want), count($read->diagnostics), 'diagnostic count');
                    foreach ($read->diagnostics as $i => $d) {
                        $suffix = match ($d->rule) {
                            'signature' => ' is not a dbspec document',
                            'encoding' => ' is not valid UTF-8',
                            default => Assert::fail("no message for {$d->rule}"),
                        };
                        Assert::assertSame($name . $suffix, $d->message, "message $i");
                        Assert::assertSame(
                            [$want[$i]['rule'], $want[$i]['line'], $want[$i]['column']],
                            [$d->rule, $d->line, $d->column],
                            "diagnostic $i"
                        );
                    }
                    return;
                }
                if ($read->diagnostics !== []) {
                    Assert::fail(self::diagnostics($read->diagnostics));
                }
                Assert::assertSame(
                    (string) file_get_contents($full),
                    $read->text,
                    'the reader text differs from the file bytes'
                );
                Assert::assertSame($read->text, self::emitStable($read->text, []), 'emission');
                return;
            case 'dbspec.set':
                self::dbspecSet($step, $expect);
                return;
            default:
                Assert::fail("OP_UNKNOWN {$step['op']}");
        }
    }

    /**
     * The text and the set of a step, joined with its line endings (the Go twin is inlineDocument): a mixed document
     * starts with CRLF, alternates CRLF and LF from its second line, and has no final line ending.
     *
     * @return array{string, array<string, string>}
     */
    private static function inlineDocument(array $step): array
    {
        $crlf = ($step['crlf'] ?? false) === true;
        $mixed = ($step['mixed'] ?? false) === true;
        $set = [];
        foreach ($step['set'] ?? [] as $name => $lines) {
            $set[$name] = self::joinText($lines, $crlf, $mixed);
        }
        return [self::joinText($step['text'] ?? [], $crlf, $mixed), $set];
    }

    /** @param list<string> $lines */
    private static function joinText(array $lines, bool $crlf, bool $mixed): string
    {
        if ($mixed) {
            $text = '';
            foreach ($lines as $i => $line) {
                if ($i > 0) {
                    $text .= $i % 2 === 1 ? "\r\n" : "\n";
                }
                $text .= $line;
            }
            return $text;
        }
        $end = $crlf ? "\r\n" : "\n";
        return implode($end, $lines) . $end;
    }

    /** Parses text with the set, emits it, and checks that the emission parses and emits to itself (the Go twin is emitStable). */
    private static function emitStable(string $text, array $set): string
    {
        $parsed = Dbspec::parse($text, $set);
        if ($parsed->document === null) {
            Assert::fail('the text parses: ' . self::diagnostics($parsed->diagnostics));
        }
        $first = Dbspec::emit($parsed->document);
        $again = Dbspec::parse($first, $set);
        if ($again->document === null) {
            Assert::fail('the emission parses: ' . self::diagnostics($again->diagnostics));
        }
        if (Dbspec::emit($again->document) !== $first) {
            Assert::fail('the emission is not idempotent');
        }
        return $first;
    }

    /**
     * Checks that parse refuses text with exactly the diagnostics of want, and that format returns no text and the same
     * diagnostics (the Go twin is checkRefusal).
     *
     * @param list<array{rule: string, line: int, column: int}> $want
     */
    private static function checkRefusal(string $text, array $set, array $want): void
    {
        $parsed = Dbspec::parse($text, $set);
        if ($parsed->document !== null) {
            Assert::fail('Parse returned a document for an invalid source');
        }
        $formatted = Dbspec::format($text, $set);
        if ($formatted->text !== null) {
            Assert::fail("a document with a diagnostic was rewritten: {$formatted->text}");
        }
        foreach ([$parsed->diagnostics, $formatted->diagnostics] as $got) {
            $rows = array_map(
                static fn(object $d): array => ['rule' => $d->rule, 'line' => $d->line, 'column' => $d->column],
                $got
            );
            $expect = array_map(
                static fn(array $d): array => ['rule' => $d['rule'], 'line' => $d['line'], 'column' => $d['column']],
                $want
            );
            if ($expect === [] || $rows !== $expect) {
                Assert::fail('diagnostics ' . json_encode($rows));
            }
            foreach ($got as $d) {
                Assert::assertNotSame('', $d->message, "diagnostic {$d->rule} has no message");
            }
        }
    }

    /** Compares the tokens of an analysis with the tokens of a case, as line, start, end and class. */
    private static function checkTokens(array $tokens, array $want): void
    {
        $got = array_map(static fn(object $t): array => [$t->line, $t->start, $t->end, $t->class], $tokens);
        if ($got !== $want) {
            Assert::fail('tokens ' . json_encode($got));
        }
    }

    /**
     * Reads the .dbs files that paths name relative to dir and parses each with the set of their headers (the Go twin
     * is readDocuments). Returns the text of each file and its parsed document, in the order of paths.
     *
     * @param list<string> $paths
     * @return array{list<string>, list<\Polyspec\Orm\Dbspec\Document>}
     */
    private static function dbspecDocuments(string $dir, array $paths): array
    {
        $texts = [];
        $set = [];
        foreach ($paths as $path) {
            $text = self::dbspecFile($dir, $path);
            $texts[] = $text;
            $fields = preg_split('/\s+/', trim(explode("\n", $text, 2)[0]), -1, PREG_SPLIT_NO_EMPTY);
            if ($fields === false || count($fields) !== 3 || $fields[0] !== 'dbspec') {
                Assert::fail("$path has no dbspec header");
            }
            $set[$fields[2]] = $text;
        }
        $documents = [];
        foreach ($texts as $i => $text) {
            $result = Dbspec::parse($text, $set);
            if ($result->document === null) {
                Assert::fail("{$paths[$i]}: " . self::diagnostics($result->diagnostics));
            }
            $documents[] = $result->document;
        }
        return [$texts, $documents];
    }

    /** The text of the file that path names relative to dir. */
    private static function dbspecFile(string $dir, string $path): string
    {
        $text = file_get_contents("$dir/$path");
        if ($text === false) {
            Assert::fail("cannot read $path");
        }
        return $text;
    }

    /**
     * Runs the dbspec.export_mermaid or dbspec.import_mermaid op of step (FCV-4) on the public Mermaid calls
     * (DBS-169) and checks its plain result against the expect of database, key by key. A step with as binds
     * the result for a ref.
     *
     * @param array<string, array{decoded: bool, value: mixed, error: ?OrmException}> $bound
     */
    private static function mermaidStep(array $step, array &$bound, string $path, string $database): void
    {
        $got = $step['op'] === 'dbspec.export_mermaid'
            ? self::exportStep($step, $path)
            : self::importStep($step, $bound, $path);
        if (isset($step['as'])) {
            $bound[$step['as']] = ['decoded' => false, 'value' => $got, 'error' => null];
        }
        $expect = $step['expect'][$database] ?? Assert::fail("{$step['op']} has no expect for $database");
        foreach ($expect['value'] ?? Assert::fail("{$step['op']} has no expect.value for $database") as $key => $want) {
            if (!array_key_exists($key, $got)) {
                Assert::fail("the result has no $key: " . json_encode($got));
            }
            if ($got[$key] !== $want) {
                Assert::fail("$key: got " . json_encode($got[$key]) . ', want ' . json_encode($want));
            }
        }
    }

    /** The result of an export step: the Mermaid text and the dropped [kind, table, name] of its document (docs/spec/mermaid.md). */
    private static function exportStep(array $step, string $path): array
    {
        // The inline text and the other documents of its set, or the .dbs file document (FCV-4).
        [$source, $set] = self::inlineDocument($step);
        if (isset($step['document'])) {
            [$source, $set] = [self::readRecipeFile($path, $step['document']), []];
        }
        $parsed = Dbspec::parse($source, $set);
        if ($parsed->document === null) {
            Assert::fail('parse: ' . json_encode($parsed->diagnostics));
        }
        $result = Dbspec::exportMermaid($parsed->document);
        return ['mermaid' => $result->text, 'dropped' => self::drops($result->dropped)];
    }

    /**
     * The result of an import step: the errors as [rule, line, column] when the Mermaid text is invalid; otherwise the
     * emitted document and the dropped list, or with skeleton_of whether the skeleton of the document equals the one of
     * the file that skeleton_of names.
     */
    private static function importStep(array $step, array $bound, string $path): array
    {
        $mermaid = $step['mermaid'];
        $text = is_string($mermaid) ? $mermaid : self::mermaidReference($mermaid, $bound);
        $result = Dbspec::importMermaid($text, $step['name'] ?? 'imported');
        if ($result->diagnostics !== []) {
            return ['errors' => array_map(
                static fn($d): array => [$d->rule, $d->line, $d->column],
                $result->diagnostics
            )];
        }
        if (!isset($step['skeleton_of'])) {
            return ['document' => Dbspec::emit($result->document), 'dropped' => self::drops($result->dropped)];
        }
        $original = Dbspec::parse(self::readRecipeFile($path, $step['skeleton_of']), []);
        if ($original->document === null) {
            Assert::fail("parse {$step['skeleton_of']}: " . json_encode($original->diagnostics));
        }
        $same = self::mermaidSkeleton($original->document) === self::mermaidSkeleton($result->document);
        return ['dropped' => self::drops($result->dropped), 'same_skeleton' => $same];
    }

    /** The text of a file that a step names relative to the recipe file (the document and skeleton_of fields). */
    private static function readRecipeFile(string $path, string $file): string
    {
        $read = Dbspec::readFile(dirname(__DIR__, 3) . '/' . dirname($path) . '/' . $file);
        if ($read->text === null) {
            Assert::fail("read $file: " . json_encode($read->diagnostics));
        }
        return $read->text;
    }

    /** The text of a ref, {ref: "<name>.<field>"}, of a bound plain result. */
    private static function mermaidReference(array $raw, array $bound): string
    {
        [$name, $field] = array_pad(explode('.', (string) ($raw['ref'] ?? ''), 2), 2, '');
        if (!array_key_exists($name, $bound)) {
            Assert::fail("ref {$raw['ref']} names no bound result");
        }
        $value = $bound[$name]['value'][$field] ?? null;
        if (!is_string($value)) {
            Assert::fail("ref {$raw['ref']} is not a text");
        }
        return $value;
    }

    /** @param list<\Polyspec\Orm\Dbspec\Unsupported> $dropped */
    private static function drops(array $dropped): array
    {
        return array_map(static fn($u): array => [$u->kind, $u->table, $u->name], $dropped);
    }

    /**
     * Writes the tables, columns, primary keys and foreign keys that Mermaid carries, as lines in table
     * name order. Foreign key actions are not carried by Mermaid, so they are left out.
     *
     * @return list<string>
     */
    private static function mermaidSkeleton(\Polyspec\Orm\Dbspec\Document $d): array
    {
        $tables = $d->tables;
        usort($tables, static fn($a, $b): int => strcmp($a->name, $b->name));
        $out = [];
        foreach ($tables as $t) {
            $out[] = "table {$t->name}";
            foreach ($t->columns as $c) {
                $out[] = "column {$c->name} {$c->type->text()} null=" . ($c->nullable ? 'true' : 'false')
                    . ' identity=' . ($c->identity ? 'true' : 'false') . ' default=' . ($c->default ?? '-');
            }
            $out[] = 'primary key ' . implode(', ', $t->primaryKey->columns);
            $foreignKeys = $t->foreignKeys;
            usort($foreignKeys, static fn($a, $b): int => strcmp($a->name, $b->name));
            foreach ($foreignKeys as $f) {
                $out[] = "foreign key {$f->name} (" . implode(', ', $f->columns) . ") references {$f->table} ("
                    . implode(', ', $f->referencedColumns) . ')';
            }
        }
        return $out;
    }

    /** Maps the op of step to its call and checks the result against the expect of database. */
    private static function step(array $step, array &$bound, string $database): void
    {
        $result = ['decoded' => false, 'value' => null, 'error' => null];
        $styles = $step['styles'] ?? [];
        $key = $step['key'] ?? '';
        try {
            $result['value'] = match ($step['op']) {
                'codec.decode' => Codec::decode($styles, self::cell($step['raw'], $bound)),
                'codec.encode' => Codec::encode($styles, self::styledArgument($step['value'], $styles, $bound)),
                'codec.host_encode' => Codec::hostEncode(self::argument($step['value'], $bound), $styles, $key),
                'codec.host_decode' => Codec::hostDecode(self::cell($step['raw'], $bound), $styles, $key),
                'codec.blind_index' => Codec::blindIndex(self::argument($step['value'], $bound), $key),
                default => Assert::fail("OP_UNKNOWN {$step['op']}"),
            };
        } catch (OrmException $error) {
            $result['error'] = $error;
        }
        $result['decoded'] = $step['op'] === 'codec.decode';
        if (isset($step['as'])) {
            $bound[$step['as']] = $result;
        }
        $expect = $step['expect'][$database] ?? null;
        if ($expect === null) {
            if ($result['error'] !== null) {
                Assert::fail("unexpected error {$result['error']->getMessage()}");
            }
            return;
        }
        if (isset($expect['error'])) {
            $code = $result['error']?->code_ ?? 'none';
            if ($code !== $expect['error']) {
                Assert::fail("error $code, want {$expect['error']}");
            }
            return;
        }
        if ($result['error'] !== null) {
            Assert::fail("unexpected error {$result['error']->getMessage()}");
        }
        $want = $expect['value'];
        if (!$result['decoded']) {
            self::compareCell($want, $result['value']);
            return;
        }
        $styled = $result['value'];
        if ($styled->kind === 'sql-null') {
            if (!array_key_exists('null', $want)) {
                Assert::fail('SQL NULL, want ' . json_encode($want));
            }
            return;
        }
        $payload = $styled->payload();
        $ordered = in_array('ordered_json', $styles, true);
        if (!self::equal($payload, $want, $ordered)) {
            Assert::fail('decoded ' . self::shown($payload) . ', want ' . json_encode($want, JSON_UNESCAPED_UNICODE));
        }
    }

    /**
     * Compares the cell of an encode, a host decode or a blind index with a wrapper: bytes by bytes, a text cell by its
     * UTF-8 bytes (FCV-4), and SQL NULL with null.
     */
    private static function compareCell(array $want, mixed $cell): void
    {
        if ($cell === null) {
            if (!array_key_exists('null', $want)) {
                Assert::fail('no cell, want ' . json_encode($want));
            }
            return;
        }
        $got = $cell instanceof Bytes ? $cell->bytes : $cell;
        $expected = match (true) {
            array_key_exists('bytes_hex', $want) => hex2bin($want['bytes_hex']),
            array_key_exists('text', $want) => $want['text'],
            default => Assert::fail('a cell compares with bytes_hex or text, not ' . json_encode($want)),
        };
        if ($got !== $expected) {
            Assert::fail('cell ' . bin2hex($got) . ', want ' . bin2hex($expected));
        }
    }

    private static function reference(string $name, array $bound): mixed
    {
        if (!array_key_exists($name, $bound)) {
            Assert::fail("ref $name names no bound result");
        }
        if ($bound[$name]['error'] !== null) {
            Assert::fail("ref $name names a failed step: {$bound[$name]['error']->getMessage()}");
        }
        return $bound[$name]['value'];
    }

    /** A stored cell, which PHP holds as a string of bytes: SQL NULL is null, and bytes or a written cell are their string. */
    private static function cell(array $raw, array $bound): ?string
    {
        $value = self::argument($raw, $bound);
        return $value instanceof Bytes ? $value->bytes : $value;
    }

    /** The value of an argument: the result that a ref names, or the value of a wrapper. */
    private static function argument(array $raw, array $bound): mixed
    {
        if (array_key_exists('ref', $raw)) {
            return self::reference($raw['ref'], $bound);
        }
        return self::toValue($raw);
    }

    /**
     * Whether the recipe value is bytes or a list or a map that holds bytes at any depth.
     *
     * @param array<string, mixed> $raw
     */
    private static function holdsBytes(array $raw): bool
    {
        if (array_key_exists('bytes_hex', $raw)) {
            return true;
        }
        foreach ($raw['array'] ?? [] as $item) {
            if (self::holdsBytes($item)) {
                return true;
            }
        }
        foreach ($raw['object'] ?? [] as [, $item]) {
            if (self::holdsBytes($item)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The styled value an encode takes: SQL NULL for null, an ordered-json value for an ordered_json stage, so that its
     * member order and number text are those of the recipe, and the common value model otherwise.
     */
    private static function styledArgument(array $raw, array $styles, array $bound): StyledValue
    {
        if (array_key_exists('ref', $raw)) {
            $value = self::reference($raw['ref'], $bound);
            return $value instanceof StyledValue ? $value : StyledValue::value($value);
        }
        if (array_key_exists('null', $raw)) {
            return StyledValue::sqlNull();
        }
        // An ordered_json wrapper is the ordered-json value of its value, whatever the stages (FCV-4).
        if (array_key_exists('ordered_json', $raw)) {
            return StyledValue::value(OrderedJson::parse(self::jsonText($raw['ordered_json'])));
        }
        // Bytes have no JSON text, so a value that holds bytes reaches an ordered_json stage as the value it is
        // (COD-63).
        if (in_array('ordered_json', $styles, true) && !self::holdsBytes($raw)) {
            return StyledValue::value(OrderedJson::parse(self::jsonText($raw)));
        }
        return StyledValue::value(self::toValue($raw));
    }

    /** A wrapper as JSON text with its members in order and its numbers as their recipe text. */
    private static function jsonText(array $w): string
    {
        $kind = array_key_first($w);
        $flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR;
        return match ($kind) {
            'nil' => 'null',
            'bool' => $w['bool'] ? 'true' : 'false',
            'int', 'float' => $w[$kind],
            'text' => json_encode($w['text'], $flags),
            'array' => '[' . implode(',', array_map(self::jsonText(...), $w['array'])) . ']',
            'object' => '{' . implode(',', array_map(
                static fn(array $pair): string => json_encode($pair[0], $flags) . ':' . self::jsonText($pair[1]),
                $w['object']
            )) . '}',
            default => Assert::fail("a $kind wrapper is not a codec value"),
        };
    }

    /** The PHP value of a wrapper in the common value model of COD-16. */
    private static function toValue(array $w): mixed
    {
        $kind = array_key_first($w);
        switch ($kind) {
            case 'nil':
            case 'null':
                return null;
            case 'bool':
                return $w['bool'];
            case 'int':
                // A cast clamps a text beyond PHP_INT_MAX or PHP_INT_MIN; such an integer has no PHP value (COD-62).
                $int = filter_var($w['int'], FILTER_VALIDATE_INT);
                if ($int === false) {
                    throw new \LogicException("the recipe integer {$w['int']} has no PHP value");
                }
                return $int;
            case 'float':
                return (float) $w['float'];
            case 'f64':
                // The three non-finite binary64 values; a cast would read NaN and Infinity as 0.
                return match ($w['f64']) {
                    'NaN' => NAN,
                    'Infinity' => INF,
                    '-Infinity' => -INF,
                };
            case 'text':
                return $w['text'];
            case 'bytes_hex':
                return new Bytes(hex2bin($w['bytes_hex']));
            case 'array':
                return array_map(self::toValue(...), $w['array']);
            case 'object':
                $out = [];
                foreach ($w['object'] as [$k, $v]) {
                    $out[$k] = self::toValue($v);
                }
                return $out;
        }
        Assert::fail("a $kind wrapper is not a codec value");
    }

    /**
     * Compares a decoded value with a wrapper: an ordered-json value by its number text and member order (COD-16),
     * every other value by number value and with its object as a set of pairs (FCV-4). A PHP array is a list or a map
     * by the wrapper it is compared with, since an array with the keys 0 to n-1 is both.
     */
    private static function equal(mixed $got, array $want, bool $ordered): bool
    {
        $kind = array_key_first($want);
        if ($got instanceof OrderedJson) {
            return self::equalJson($got, $want);
        }
        return match ($kind) {
            'nil' => $got === null,
            'bool' => $got === $want['bool'],
            'int' => is_int($got) && (string) $got === $want['int'],
            'float' => is_float($got) && $got === (float) $want['float'],
            'text' => is_string($got) && $got === $want['text'],
            'bytes_hex' => $got instanceof Bytes && $got->bytes === hex2bin($want['bytes_hex']),
            'array' => is_array($got) && array_is_list($got) && count($got) === count($want['array'])
                && self::all($want['array'], static fn(array $w, int $i): bool => self::equal($got[$i], $w, $ordered)),
            'object' => is_array($got) && count($got) === count($want['object'])
                && self::all($want['object'], static fn(array $pair): bool => array_key_exists($pair[0], $got)
                    && self::equal($got[$pair[0]], $pair[1], $ordered)),
            default => false,
        };
    }

    private static function equalJson(OrderedJson $got, array $want): bool
    {
        $kind = array_key_first($want);
        return match ($got->kind()) {
            Kind::Null->value => $kind === 'nil',
            Kind::Boolean->value => $kind === 'bool' && $got->booleanValue() === $want['bool'],
            Kind::String->value => $kind === 'text' && $got->stringValue() === $want['text'],
            Kind::Number->value => ($kind === 'int' || $kind === 'float')
                && ($kind === 'float') === (strpbrk($got->numberLiteral(), '.eE') !== false)
                && $got->numberLiteral() === $want[$kind],
            Kind::Array->value => $kind === 'array' && count($got->items()) === count($want['array'])
                && self::all(
                    $want['array'],
                    static fn(array $w, int $i): bool => self::equalJson($got->items()[$i], $w)
                ),
            Kind::Object->value => $kind === 'object' && self::orderedMembers($got) === array_column($want['object'], 0)
                && self::all(
                    $want['object'],
                    static fn(array $pair): bool => self::equalJson($got->get($pair[0]), $pair[1])
                ),
            default => false,
        };
    }

    /** @return list<string> the member names of an ordered-json object in order */
    private static function orderedMembers(OrderedJson $object): array
    {
        return array_map('strval', array_keys($object->members()));
    }

    private static function all(array $items, callable $check): bool
    {
        foreach ($items as $index => $item) {
            if (!$check($item, $index)) {
                return false;
            }
        }
        return true;
    }

    private static function shown(mixed $value): string
    {
        if ($value instanceof OrderedJson) {
            return \Polyspec\OrderedJson\stringify($value);
        }
        if ($value instanceof Bytes) {
            return 'bytes(' . bin2hex($value->bytes) . ')';
        }
        return var_export($value, true);
    }

    // The database path (FCV-3 and FCV-4): each case runs on a case database of its own through the public catalog API.

    /** The databases of a recipe with a fixture (FCV-3). */
    private const DATABASES = ['mysql', 'postgres', 'sqlite'];

    /** @var array<string, array{0: Schema, 1: list<Schema>}> the Schema and the external Schemas of each fixture set, built once per process */
    private static array $schemas = [];

    /** Runs one case of the recipe at path on a case database of database, which is removed when the case ends. */
    private static function runDatabase(string $path, array $case, string $database): void
    {
        if (!in_array($database, self::DATABASES, true)) {
            Assert::fail("recipe $path: unknown database $database");
        }
        $root = dirname(__DIR__, 3);
        $recipe = json_decode(file_get_contents($root . '/' . $path), true, 512, JSON_THROW_ON_ERROR);
        if (!isset($recipe['fixture'])) {
            Assert::fail("recipe $path: no fixture, so it has no database");
        }
        // A fixture of none runs every case on an empty case database; the helper never infers it (FCV-3).
        [$schema, $installFirst] = $recipe['fixture'] === 'none'
            ? [null, []]
            : (self::$schemas[$recipe['fixture']] ??= self::fixtureSchema($root . '/' . $recipe['fixture']));
        $caseArgs = [$path, $recipe, $case, $database, $schema, $installFirst];
        with_case_database(
            $database,
            static function (string $step): void {
            },
            static function (string $dsn, CaseDatabase $caseDatabase) use ($caseArgs) {
                self::runDatabaseCase(...array_merge($caseArgs, [$dsn, $caseDatabase->name]));
            }
        );
    }

    /**
     * The Schema of a dbspec-set.json through the public dbspec API (docs/spec/dbspec.md "External documents"): the
     * owned documents parsed with the external ones of the set, and the manifest of the owned documents with the
     * external text.
     * Each external document is also a schema of its own, which a case installs first, as the bench set does.
     *
     * @return array{0: Schema, 1: list<Schema>}
     */
    private static function fixtureSchema(string $setPath): array
    {
        $set = Dbspec::readSet($setPath);
        if ($set->documents === null) {
            Assert::fail("$setPath: " . self::diagnostics($set->errors));
        }
        $owned = array_map(static fn ($file): string => $file->bytes, $set->documents);
        $external = array_map(static fn ($file): string => $file->bytes, $set->external);
        $manifestOf = static function (array $owners, array $externals) use ($setPath): object {
            $documents = [];
            foreach (Dbspec::parseSet($owners, $externals) as $parsed) {
                if ($parsed->document === null || $parsed->diagnostics !== []) {
                    Assert::fail("$setPath: {$parsed->name}: " . self::diagnostics($parsed->diagnostics));
                }
                $documents[] = $parsed->document;
            }
            $result = Dbspec::manifest($documents);
            if ($result->manifest === null) {
                Assert::fail("$setPath: " . self::diagnostics($result->diagnostics));
            }
            return $result->manifest;
        };
        $manifest = $manifestOf($owned, $external);
        $installFirst = [];
        foreach ($external as $text) {
            $shared = $manifestOf([$text], []);
            $installFirst[] = new Schema($shared->manifestText, $shared->manifestHash);
        }
        return [new Schema($manifest->manifestText, $manifest->manifestHash, $manifest->externalText), $installFirst];
    }

    private static function diagnostics(array $diagnostics): string
    {
        return json_encode($diagnostics, JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
    }

    /**
     * Installs the Schema on the case database, connects the catalog, binds `database` to the name of the case
     * database, inserts the seed rows of the recipe and then of the case, runs the steps and closes the catalog.
     */
    private static function runDatabaseCase(
        string $path,
        array $recipe,
        array $case,
        string $database,
        ?Schema $schema,
        array $installFirst,
        string $dsn,
        string $name,
    ): void {
        $db = Orm::connect($dsn, new Config());
        try {
            // A case with install: false installs nothing before its steps; its steps install the
            // schema themselves (FCV-4).
            if ($schema !== null && ($case['install'] ?? true) !== false) {
                foreach ([...$installFirst, $schema] as $shared) {
                    $db->utils()->schema()->install($shared);
                }
            }
            $catalog = Catalog::connect($dsn);
            $context = [
                'catalog' => $catalog,
                'namespace' => '',
                'database' => $database,
                'dsn' => $dsn,
                'bound' => ['database' => ['text' => $name]],
                'db' => $db,
                'schema' => $schema,
                'dir' => dirname(__DIR__, 3) . '/' . dirname($path),
            ];
            try {
                $namespace = $catalog->currentNamespace();
                $context['namespace'] = $namespace;
                foreach ([$recipe['seed']['rows'] ?? [], $case['seed']['rows'] ?? []] as $rows) {
                    foreach ($rows as $table => $values) {
                        $metadata = $catalog->describeTable(['namespace' => $namespace, 'name' => $table]);
                        foreach ($values as $row) {
                            $catalog->insertRow($metadata, self::mapAssignments($row, $context));
                        }
                    }
                }
                foreach ($case['steps'] as $index => $step) {
                    // A step with `only` runs on the databases that it names, and no other.
                    if (isset($step['only']) && !in_array($database, $step['only'], true)) {
                        continue;
                    }
                    try {
                        self::databaseStep($step, $context);
                    } catch (\Throwable $failure) {
                        Assert::fail(
                            "recipe $path, case {$case['id']}, step $index ({$step['op']}), database $database: "
                            . get_class($failure) . ': ' . $failure->getMessage()
                        );
                    }
                }
            } finally {
                self::closeModelConnections();
                // The case may have reconnected, so the catalog that is open now is the one of the context.
                $context['catalog']->close();
            }
        } finally {
            $db->close();
        }
    }

    /**
     * The Schema argument of a schema op (FCV-4): the documents of the set and its external documents, read from the
     * recipe's directory and parsed through the public dbspec API; manifest_replace changes the manifest text after
     * building and keeps its hash.
     */
    private static function schemaArgument(array $arg, array $context): Schema
    {
        $read = static fn(array $names): array => array_map(
            static fn(string $name): string => (string) file_get_contents($context['dir'] . '/' . $name),
            $names,
        );
        $documents = [];
        foreach (Dbspec::parseSet($read($arg['documents']), $read($arg['external'] ?? [])) as $entry) {
            if ($entry->document === null) {
                Assert::fail(self::diagnostics($entry->diagnostics));
            }
            $documents[] = $entry->document;
        }
        $result = Dbspec::manifest($documents);
        if ($result->manifest === null) {
            Assert::fail(self::diagnostics($result->diagnostics));
        }
        $text = $result->manifest->manifestText;
        if (isset($arg['manifest_replace'])) {
            $text = str_replace($arg['manifest_replace']['from'], $arg['manifest_replace']['to'], $text);
        }
        return new Schema($text, $result->manifest->manifestHash, $result->manifest->externalText);
    }

    /**
     * Runs one step and compares the keys that its expect names. A step whose expect is {"error": CODE} passes only
     * when the call fails with that orm error code; `as` binds the bound object of the op or its value.
     */
    private static function databaseStep(array $step, array &$context): void
    {
        $expected = isset($step['expect'][$context['database']])
            ? self::resolveRefs($step['expect'][$context['database']], $context)
            : null;
        try {
            $actual = self::databaseOp($step, $context);
        } catch (OrmException $error) {
            if (!is_array($expected) || !array_key_exists('error', $expected)) {
                throw $error;
            }
            Assert::assertSame($expected['error'], $error->code_, "the error code ({$error->getMessage()})");
            return;
        } catch (CallbackFailed $failure) {
            // The step ends with its failed callback, so an enclosing transaction goes on (FCV-4).
            if (!is_array($expected) || ($expected['error'] ?? null) !== 'CALLBACK') {
                throw $failure;
            }
            return;
        }
        if (isset($step['as'])) {
            $context['bound'][$step['as']] = array_key_exists('bind', $actual)
                ? $actual['bind']
                : ($actual['value'] ?? null);
            if (isset($actual['row'])) {
                $context['rows'][$step['as']] = $actual['row'];
            }
        }
        if ($expected === null) {
            return;
        }
        if (array_key_exists('error', $expected)) {
            Assert::fail("expected {$expected['error']}, and the op succeeded");
        }
        $compared = [];
        foreach (array_keys($expected) as $key) {
            $compared[$key] = $actual[$key] ?? null;
        }
        $want = self::normalizedNull($expected);
        $got = self::normalizedNull($compared);
        if ($want !== $got) {
            Assert::fail(
                'want ' . json_encode($want, JSON_UNESCAPED_UNICODE)
                    . ', got ' . json_encode($got, JSON_UNESCAPED_UNICODE)
            );
        }
    }

    /** Maps the op of a step to its one call of the public API and returns the fields that its expect compares. */
    private static function databaseOp(array $s, array &$context): array
    {
        $catalog = $context['catalog'];
        // A step names its own namespace when it has one (a MySQL system view is in information_schema).
        $namespace = is_string($s['namespace'] ?? null) ? $s['namespace'] : $context['namespace'];
        $table = static fn (): array => ['namespace' => $namespace, 'name' => $s['table']];
        switch ($s['op']) {
            case 'schema.install':
                if (isset($s['connection'])) {
                    self::connectionOf($s, $context)->utils()->schema()->install($context['schema']);
                    return ['value' => ['bool' => true]];
                }
                $context['db']->utils()->schema()->install(self::schemaArgument($s['schema'], $context));
                return ['value' => ['bool' => true]];
            case 'schema.register':
                $context['db']->utils()->schema()->register(self::schemaArgument($s['schema'], $context));
                return ['value' => ['bool' => true]];
            case 'schema.connect':
                Orm::connectSchema(
                    $context['dsn'],
                    self::schemaArgument($s['schema'], $context),
                    new Config(),
                )->close();
                return ['value' => ['bool' => true]];
            case 'schema.add_tables_and_columns':
                $added = $context['db']->utils()->schema()->addTablesAndColumns(
                    self::schemaArgument($s['schema'], $context),
                );
                return ['value' => ['array' => array_map(static fn(string $name): array => ['text' => $name], $added)]];
            case 'statements.count':
                $count = 0;
                $unsubscribe = $context['db']->subscribe(static function () use (&$count): void {
                    $count++;
                });
                try {
                    foreach ($s['steps'] as $nested) {
                        self::databaseStep($nested, $context);
                    }
                } finally {
                    $unsubscribe();
                }
                return ['count' => $count];
            case 'transaction':
                self::connectionOf($s, $context)->transaction(
                    function () use ($s, &$context): void {
                        foreach ($s['steps'] as $nested) {
                            self::databaseStep($nested, $context);
                        }
                        if ($s['fail'] ?? false) {
                            throw new CallbackFailed('the transaction callback failed');
                        }
                    },
                    // The options of the transaction (INT-46): a nested transaction that names one is refused with
                    // CONFIG.
                    isolation: $s['isolation'] ?? '',
                    readOnly: ($s['read_only'] ?? false) === true,
                    retry: 0,
                );
                return ['value' => ['bool' => true]];
            case 'catalog.connect':
                return self::connectOp($s, $context);
            case 'catalog.close':
                $catalog->close();
                return [];
            case 'catalog.reconnect':
                $reconnected = Catalog::connect($context['dsn']);
                $context['namespace'] = $reconnected->currentNamespace();
                $context['catalog'] = $reconnected;
                return [];
            case 'catalog.current_namespace':
                return ['value' => ['text' => $catalog->currentNamespace()]];
            case 'catalog.revision':
                $snapshot = self::stepArgument($s['snapshot'], $context);
                return ['value' => ['text' => $snapshot->revision()]];
            case 'catalog.row_cells':
                $snapshot = self::stepArgument($s['snapshot'], $context);
                $types = array_map(static fn ($column): ?string => $column->nativeType, $snapshot->metadata->columns);
                return ['cells' => array_map(
                    static fn (mixed $cell, int $at): array => self::plainWrapper($cell, $types[$at]),
                    $snapshot->cells,
                    array_keys($snapshot->cells)
                )];
            case 'catalog.describe_table':
                $metadata = $catalog->describeTable($table());
                $columns = $metadata->columns;
                return [
                    'bind' => $metadata,
                    'namespace' => ['text' => $metadata->table['namespace']],
                    'kind' => $metadata->kind,
                    'columns' => array_map(static fn ($column): string => $column->name, $columns),
                    'columns_present' => $columns !== [],
                    'native_types' => array_map(static fn ($column): string => $column->nativeType, $columns),
                    'nullable' => array_map(static fn ($column): bool => $column->nullable, $columns),
                    'generated' => array_map(static fn ($column): bool => $column->generated, $columns),
                    'automatic_keys' => array_map(static fn ($column): bool => $column->automaticKey, $columns),
                    'defaults' => array_map(static fn ($column): bool => $column->defaultExpression !== null, $columns),
                    'primary_key' => $metadata->primaryKey,
                    'reliable_row_identity' => $metadata->reliableRowIdentity,
                ];
            case 'catalog.table_page':
                $page = $catalog->tablePage($table(), $s['limit'], $s['offset']);
                $indexes = array_map(static function (string $column) use ($page): int {
                    $at = $page->columnIndex($column);
                    if ($at < 0) {
                        Assert::fail("the page has no column $column");
                    }
                    return $at;
                }, $s['columns']);
                $types = self::nativeTypes($page->metadata, $page->result->columns);
                return [
                    'bind' => $page,
                    'columns' => $page->result->columns,
                    'order_by' => $page->orderBy,
                    'has_more' => $page->hasMore,
                    'rows' => array_map(
                        static fn (array $row): array => array_map(
                            static fn (int $at): array => self::plainWrapper($row[$at], $types[$at]),
                            $indexes
                        ),
                        $page->result->rows
                    ),
                ];
            case 'catalog.read_only_query':
                $result = $catalog->readOnlyQuery(
                    self::sqlField($s['sql'], $context),
                    array_map(self::nativeValue(...), $s['binds'] ?? []),
                    $s['max_rows'] ?? 0,
                    $s['max_bytes'] ?? 0
                );
                return ['columns' => $result->columns, 'row_count' => count($result->rows), 'rows' => array_map(
                    static fn (array $row): array => array_map(
                        static fn (mixed $cell): array => self::plainWrapper($cell, null),
                        $row
                    ),
                    $result->rows
                )];
            case 'catalog.read_only_grid_query':
                $result = $catalog->readOnlyGridQuery(
                    self::sqlField($s['sql'], $context),
                    [],
                    $s['max_rows'] ?? 0,
                    $s['max_bytes'] ?? 0
                );
                return [
                    'columns' => $result->columns,
                    'rows' => array_map(
                        static fn (array $row): array => array_map(self::gridWrapper(...), $row),
                        $result->rows
                    ),
                ];
            case 'catalog.row_snapshot':
                // page_with names the page and the order_by it replaces; the snapshot checks the replaced order.
                $page = self::stepArgument($s['page_with']['page'] ?? $s['page'], $context);
                if (isset($s['page_with']['order_by'])) {
                    $page = new CatalogTablePage(
                        $page->metadata,
                        $page->result,
                        $page->limit,
                        $page->offset,
                        $s['page_with']['order_by'],
                        $page->hasMore,
                    );
                }
                $snapshot = $catalog->rowSnapshotFromPage($page, $s['index']);
                $types = array_map(static fn ($column): ?string => $column->nativeType, $snapshot->metadata->columns);
                return [
                    'bind' => $snapshot,
                    'key_indexes' => $snapshot->keyIndexes,
                    'keys' => array_map(
                        static fn (int $at): array => self::plainWrapper($snapshot->cells[$at], $types[$at]),
                        $snapshot->keyIndexes
                    ),
                ];
            case 'catalog.insert_row':
                $metadata = self::stepArgument($s['metadata'], $context);
                return self::mutation(
                    $metadata,
                    $catalog->insertRow($metadata, self::assignments($s['values'], $context))
                );
            case 'catalog.update_row':
                $snapshot = self::stepArgument($s['snapshot'], $context);
                return self::mutation(
                    $snapshot->metadata,
                    $catalog->updateRow($snapshot, self::assignments($s['set'], $context))
                );
            case 'catalog.delete_row':
                $deleted = $catalog->deleteRow(self::stepArgument($s['snapshot'], $context));
                return ['value' => ['int' => (string) $deleted]];
            case 'events.subscribe':
                $recording = new RecipeRecording();
                $stop = self::connectionOf($s, $context)->subscribe($recording->receive(...));
                return ['bind' => new RecipeSubscription($stop, $recording)];
            case 'events.fail_subscriber':
                $kind = $s['kind'];
                $stop = self::connectionOf($s, $context)->subscribe(
                    static function (StatementEvent $e) use ($kind): void {
                        if ($e->kind === $kind) {
                            throw new RuntimeException('subscriber refused the event');
                        }
                    }
                );
                return ['bind' => new RecipeSubscription($stop, null)];
            case 'events.stop_failing':
            case 'events.unsubscribe':
                (self::boundValue($s['ref'], $context)->stop)();
                return [];
            case 'events.captured':
                $subscription = self::boundValue($s['ref'], $context);
                if ($subscription->recording === null) {
                    throw new RuntimeException('the subscription of ref is not a recording subscriber');
                }
                if ($subscription->recording->negative !== []) {
                    throw new RuntimeException('an event has a negative elapsed time');
                }
                return ['value' => ['array' => self::capturedEvents(
                    $subscription->recording->events,
                    $s['compare'] ?? '',
                )]];
            case 'model.read_bind_cell':
                // The generated model reads the body of the bind_cell row through the model connection, which keeps a
                // SQL NULL distinct from an empty text.
                $db = \Polyspec\Orm\Tests\Model\connect(
                    $context['dsn'],
                    new Config(aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index')
                );
                try {
                    $body = (new \Polyspec\Orm\Tests\Model\BindCell())($db)->seq($s['seq'])->get()->getBody();
                } finally {
                    $db->close();
                }
                return ['value' => $body === null ? ['null' => 'text'] : ['text' => $body]];
            case 'sql.exec':
                // The native driver of PHP is PDO, opened on the case database.
                $pdo = case_admin($context['dsn']);
                $pdo->exec(self::sqlField($s['sql'], $context));
                return [];
            // dsn.connect (FCV-4): the DSN of the case database for "case", otherwise the text of the step.
            case 'dsn.connect':
                $dsn = $s['dsn'] === 'case' ? $context['dsn'] : $s['dsn'];
                return ['value' => ['text' => self::connectDriver($dsn)]];
        }
        if (str_starts_with($s['op'], 'model.')) {
            return self::modelOp($s, $context);
        }
        Assert::fail("OP_UNKNOWN {$s['op']}");
    }

    /**
     * Connects the DSN of the op. An unsupported URL or an absent SQLite file fails with CONFIG, and the expect may
     * name file_created: the file is created by no failing connection.
     */
    private static function connectOp(array $s, array &$context): array
    {
        $expected = $s['expect'][$context['database']] ?? [];
        $dsn = $s['dsn'];
        if (isset($dsn['url'])) {
            $target = $dsn['url'];
        } else {
            $path = sys_get_temp_dir() . '/recipe-absent-' . bin2hex(random_bytes(8)) . '.sqlite';
            $target = 'sqlite://' . $path;
        }
        try {
            Catalog::connect($target)->close();
        } catch (OrmException $error) {
            if (isset($path) && array_key_exists('file_created', $expected)) {
                Assert::assertSame($expected['file_created'], file_exists($path), 'file_created');
            }
            throw $error;
        }
        return [];
    }

    /** A field that holds SQL or a database-decided value: the string itself, or the entry of the database. */
    /** A new model of the table, connected to db, whose entity is the one that the fixture gives the table. */
    private static function newRow(string $table, mixed $db, array $context): RecipeRow
    {
        RecipeRow::bindTable($table, $context['schema']);
        return (new RecipeRow())->connect($db);
    }

    /** Writes each column of the assignments on the row, and returns the row. */
    private static function setColumns(RecipeRow $row, array $assignments): RecipeRow
    {
        foreach ($assignments as $column => $value) {
            $row->setColumn((string) $column, $value);
        }
        return $row;
    }

    /** The name of a column in the form of its generated methods: seq_no becomes SeqNo. */
    private static function studly(string $column): string
    {
        return str_replace(' ', '', ucwords(str_replace('_', ' ', $column)));
    }

    /**
     * The recipe objects of the events of a recording. The transactions are numbered from 1 in the order of their first
     * appearance among all the events; then compare "tables" keeps the events that name a table.
     */
    private static function capturedEvents(array $events, string $compare): array
    {
        $numbers = [];
        $out = [];
        foreach ($events as $event) {
            $value = self::eventValue($event, $numbers);
            if ($compare === 'tables' && $event->tables === []) {
                continue;
            }
            $out[] = $value;
        }
        return $out;
    }

    /** The recipe object of one statement event: its sql, binds, kind, tables, transaction and error (FCV-4). */
    private static function eventValue(StatementEvent $event, array &$numbers): array
    {
        $transaction = ['null' => true];
        if ($event->transaction !== null) {
            $numbers[$event->transaction] ??= count($numbers) + 1;
            $transaction = ['int' => (string) $numbers[$event->transaction]];
        }
        return ['object' => [
            ['sql', ['text' => $event->sql]],
            ['binds', ['array' => array_map(
                static fn (mixed $bind): array => self::plainWrapper($bind, null),
                $event->binds
            )]],
            ['kind', ['text' => $event->kind]],
            ['tables', ['array' => array_map(static fn (string $name): array => ['text' => $name], $event->tables)]],
            ['transaction', $transaction],
            ['error', $event->error === null ? ['null' => true] : ['text' => $event->error->code_]],
        ]];
    }

    private static function sqlField(string|array $field, array $context): string
    {
        return is_string($field) ? $field : $field[$context['database']];
    }

    /** The connection that an op names, or the case connection when the op names none (FCV-4). */
    private static function connectionOf(array $s, array $context): Db
    {
        if (!isset($s['connection'])) {
            return $context['db'];
        }
        $db = $context['bound'][$s['connection']] ?? null;
        if (!$db instanceof Db) {
            Assert::fail("connection {$s['connection']} is not bound");
        }
        return $db;
    }

    /** A model op on a table model of the fixture: the entity that the fixture gives its table (FCV-4). */
    private static function tableModelOp(array $s, array $context): array
    {
        $table = self::TABLE_MODELS[$s['model']];
        switch ($s['op']) {
            case 'model.create':
                $row = self::newRow($table, self::connectionOf($s, $context), $context);
                self::setColumns($row, self::mapAssignments($s['values'], $context))->create();
                // With `as`, the created row is bound with the record of the path and connection that made it.
                return isset($s['as']) ? ['bind' => $row, 'row' => self::rowRecord($s, $context)] : [];
            case 'model.get_by':
                if (isset($s['key'])) {
                    throw new RuntimeException('model.get_by with key has no table-model path');
                }
                $where = self::mapAssignments($s['where'], $context);
                if (count($where) !== 1) {
                    throw new RuntimeException('model.get_by names one column of the recipe');
                }
                $column = (string) array_key_first($where);
                $row = self::newRow($table, self::connectionOf($s, $context), $context);
                return [
                    'bind' => $row->{'getBy' . self::studly($column)}($where[$column]),
                    'row' => self::rowRecord($s, $context),
                ];
            case 'model.update':
                self::setColumns(self::boundValue($s['row'], $context), self::mapAssignments($s['set'], $context))
                    ->update();
                return [];
            case 'model.delete':
                self::boundValue($s['row'], $context)->delete();
                return [];
            case 'model.count':
                $row = self::newRow($table, self::connectionOf($s, $context), $context);
                return ['value' => ['int' => (string) $row->getCount()]];
        }
        Assert::fail("model op {$s['op']} has no table-model path");
    }

    /**
     * The record of a bound row (coordinator ruling on row routing): the path that made it, its model and
     * the connection it was made on. A model op of the {row} form runs on this path and connection.
     */
    private static function rowRecord(array $s, array $context): array
    {
        return ['path' => 'table', 'model' => $s['model'], 'db' => self::connectionOf($s, $context)];
    }

    /**
     * A model op of the {row} form, which names no model and no connection: the bound row routes it, and a row that no
     * bound row holds fails by its name.
     */
    private static function rowOp(array $s, array $context): array
    {
        $name = is_string($s['row']) ? $s['row'] : (string) ($s['row']['ref'] ?? '');
        $record = $context['rows'][$name] ?? null;
        if ($record === null) {
            Assert::fail("{$s['op']} names row $name, which no bound row holds");
        }
        if ($record['path'] !== 'table') {
            Assert::fail("{$s['op']}: row $name was bound by the {$record['path']} path, which has no row form");
        }
        return self::tableModelOp(['model' => $record['model']] + $s, $context);
    }

    /** A bound value of {"ref": "<name>"} or {"ref": "<name>.<path>"}. */
    private static function boundValue(string $ref, array $context): mixed
    {
        $path = explode('.', $ref);
        $head = array_shift($path);
        if (!array_key_exists($head, $context['bound'])) {
            Assert::fail("no bound value $head");
        }
        $value = $context['bound'][$head];
        foreach ($path as $key) {
            if (is_array($value) && array_key_exists($key, $value)) {
                $value = $value[$key];
            } elseif (is_object($value) && property_exists($value, $key)) {
                $value = $value->$key;
            } else {
                Assert::fail("bound value $head has no " . implode('.', $path));
            }
        }
        return $value;
    }

    private static function stepArgument(mixed $field, array $context): mixed
    {
        if (is_array($field) && array_key_exists('ref', $field)) {
            return self::boundValue($field['ref'], $context);
        }
        return $field;
    }

    private static function resolveRefs(mixed $value, array $context): mixed
    {
        if (!is_array($value)) {
            return $value;
        }
        if (count($value) === 1 && array_key_exists('ref', $value)) {
            return self::boundValue($value['ref'], $context);
        }
        return array_map(static fn (mixed $item): mixed => self::resolveRefs($item, $context), $value);
    }

    /**
     * The assignments of an object of column names whose values are recipe wrappers or per-database objects.
     *
     * @return array<string, mixed>
     */
    /**
     * The assignments of a step: the list of [column, value] pairs that the catalog takes, so that a repeated column
     * reaches the catalog, each value a wrapper or a reference.
     */
    private static function assignments(array $pairs, array $context): array
    {
        $out = [];
        foreach ($pairs as [$name, $value]) {
            $argument = self::stepArgument($value, $context);
            $out[] = [(string) $name, self::nativeValue(self::databaseValue($argument, $context))];
        }
        return $out;
    }

    /** The assignments of a seed row: a map of column to wrapper. */
    private static function mapAssignments(array $values, array $context): array
    {
        $out = [];
        foreach ($values as $name => $value) {
            $argument = self::stepArgument($value, $context);
            $out[(string) $name] = self::nativeValue(self::databaseValue($argument, $context));
        }
        return $out;
    }

    private static function databaseValue(mixed $value, array $context): mixed
    {
        if (
            is_array($value) && array_key_exists('mysql', $value) && array_key_exists('postgres', $value)
            && array_key_exists('sqlite', $value)
        ) {
            return $value[$context['database']];
        }
        return $value;
    }

    /** The value of the PHP catalog API for a recipe wrapper; the catalog binds bytes as a string. */
    private static function nativeValue(array $w): mixed
    {
        $kind = array_key_first($w);
        switch ($kind) {
            case 'int':
                $n = (int) $w['int'];
                if ((string) $n !== $w['int']) {
                    Assert::fail("the int wrapper {$w['int']} is outside the range of a PHP int");
                }
                return $n;
            case 'text':
            case 'date':
            case 'time':
            case 'datetime':
            case 'decimal':
                return $w[$kind];
            case 'bytes_hex':
                return hex2bin($w['bytes_hex']);
            case 'bool':
                return $w['bool'];
            case 'null':
                return null;
        }
        Assert::fail("unknown recipe wrapper $kind");
    }

    /** The recipe wrapper of a plain value; a string takes the wrapper of the native type of its column when one is known. */
    private static function plainWrapper(mixed $value, ?string $nativeType): array
    {
        if ($value === null) {
            return ['null' => true];
        }
        if (is_int($value)) {
            return ['int' => (string) $value];
        }
        if (is_bool($value)) {
            return ['bool' => $value];
        }
        if (is_string($value)) {
            return [self::temporalKind($nativeType) ?? 'text' => $value];
        }
        if (is_float($value) && $nativeType === null) {
            // A plain value with no column type is compared by its shortest round-trip decimal.
            return ['float' => json_encode($value, JSON_PRESERVE_ZERO_FRACTION)];
        }
        if (is_float($value)) {
            // A float of a described column is compared by its IEEE bits: a real column is float32, any other is
            // float64.
            $real = preg_match('/^(real|float4|float\(|float$)/i', $nativeType ?? '') === 1;
            return $real
                ? ['f32_bits' => unpack('V', pack('g', $value))[1]]
                : ['f64_bits' => self::unsignedDecimal(bin2hex(pack('E', $value)))];
        }
        Assert::fail('no recipe wrapper for the plain value ' . var_export($value, true));
    }

    private static function temporalKind(?string $nativeType): ?string
    {
        $type = strtolower($nativeType ?? '');
        return match (true) {
            preg_match('/^(datetime|timestamp)/', $type) === 1 => 'datetime',
            preg_match('/^time/', $type) === 1 => 'time',
            preg_match('/^date/', $type) === 1 => 'date',
            preg_match('/^(decimal|numeric)/', $type) === 1 => 'decimal',
            default => null,
        };
    }

    /** The recipe wrapper of a grid cell. */
    private static function gridWrapper(CatalogGridCell $cell): array
    {
        return match ($cell->kind) {
            'null' => ['null' => true],
            'integer' => ['int' => (string) $cell->value],
            // An unsigned value may exceed the range of a PHP int, so it is compared as its decimal digits.
            'unsigned' => ['uint' => (string) $cell->value],
            'decimal', 'text', 'date', 'time', 'datetime' => [$cell->kind => $cell->value],
            'boolean' => ['bool' => $cell->value],
            'binary' => ['bytes_hex' => bin2hex($cell->value)],
            // The grid cell holds the IEEE bits as hexadecimal; the recipe compares them as unsigned decimal.
            'float32' => ['f32_bits' => (int) hexdec($cell->value)],
            'float64' => ['f64_bits' => self::unsignedDecimal($cell->value)],
            default => Assert::fail("no recipe wrapper for the grid cell {$cell->kind}"),
        };
    }

    /** The unsigned decimal of hexadecimal bits of up to 64 bits, exact over the whole range. */
    private static function unsignedDecimal(string $hex): string
    {
        return sprintf('%u', unpack('J', hex2bin(str_pad($hex, 16, '0', STR_PAD_LEFT)))[1]);
    }

    /**
     * The native type of each named column in the metadata, or null for a name that it has no column of.
     *
     * @param list<string> $names
     * @return list<?string>
     */
    private static function nativeTypes(CatalogTableMetadata $metadata, array $names): array
    {
        $types = [];
        foreach ($metadata->columns as $column) {
            $types[$column->name] = $column->nativeType;
        }
        return array_map(static fn (string $name): ?string => $types[$name] ?? null, $names);
    }

    /** The fields of a mutation result: its rows, each cell wrapped by the native type of its column in the metadata. */
    private static function mutation(CatalogTableMetadata $metadata, CatalogResult $result): array
    {
        $types = self::nativeTypes($metadata, $result->columns);
        return ['rows' => array_map(
            static fn (array $row): array => array_map(
                static fn (mixed $cell, int $at): array => self::plainWrapper($cell, $types[$at]),
                $row,
                array_keys($row)
            ),
            $result->rows
        )];
    }

    /** NULL compares by its nullness: an expect names the parameter type of NULL, and a result has none. */
    private static function normalizedNull(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }
        if (count($value) === 1 && array_key_exists('null', $value)) {
            return ['null' => true];
        }
        return array_map(self::normalizedNull(...), $value);
    }
}
