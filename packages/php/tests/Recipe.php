<?php

// The recipe helper of PHP (docs/spec/feature-coverage.md FCV-2 to FCV-4): the entry of each suite unit, a test class
// <Recipe>RecipeTest whose method test<Database> takes the cases of Recipe::cases, calls Recipe::run for each case, and
// each step calls the public API of Polyspec\Orm that its op names. The PHP extension runs the same entry through a
// class that extends it. It has no command line and no output of its own.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use InvalidArgumentException;
use Polyspec\OrderedJson\Kind;
use Polyspec\OrderedJson\Value as OrderedJson;
use Polyspec\Orm\AesKeyring;
use Polyspec\Orm\Bytes;
use Polyspec\Orm\Catalog;
use Polyspec\Orm\CatalogColumn;
use Polyspec\Orm\Chain;
use Polyspec\Orm\Collection;
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
use Polyspec\Orm\Func;
use Polyspec\Orm\Model;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Registry;
use Polyspec\Orm\Request;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;
use Polyspec\Orm\StatementEvent;
use Polyspec\Orm\StyledValue;
use Polyspec\Orm\TxFrame;
use Polyspec\Orm\Validator;
use RuntimeException;

final class Recipe
{
    use RecipeModel;

    /** The ops that RecipeModel runs, by their full names (FCV-15). */
    private const MODEL_OPS = [
        'model.arithmetic',
        'model.assign',
        'model.connect',
        'model.count',
        'model.create',
        'model.creates',
        'model.delete',
        'model.duplicate_create',
        'model.get_by',
        'model.query',
        'model.read_bind_cell',
        'model.restore',
        'model.save',
        'model.update',
        'model.chain',
        'db.last_affected',
        'db.notify',
        'utils.lock',
        'utils.set_local',
        'utils.local',
        'utils.was_inserted',
        'utils.backend_waiting_for_lock',
        'utils.groups',
    ];

    /** The database part of a recipe without a database (FCV-3). */
    public const NONE = 'none';

    /** The dbspec ops on parsed texts that dbspecStep runs (FCV-4). */
    private const DBSPEC_OPS = [
        'dbspec.parse', 'dbspec.parse_plan', 'dbspec.emit_plan', 'dbspec.diff', 'dbspec.plan_steps', 'dbspec.add_tables_steps', 'dbspec.chain',
        'dbspec.compare', 'dbspec.introspect_refusal',
    ];

    /** The dbspec ops whose documents are files relative to the recipe, which dbspecFileStep runs (FCV-4). */
    private const DBSPEC_FILE_OPS = [
        'dbspec.parse_emit', 'dbspec.manifest', 'dbspec.render', 'dbspec.analyze', 'dbspec.parse_positions',
        'dbspec.format', 'dbspec.parse_set', 'dbspec.set', 'dbspec.load_set', 'dbspec.runtime_model', 'dbspec.read_file', 'dbspec.read_bytes',
    ];

    /** The Mermaid ops (FCV-4), on the public Mermaid calls of Dbspec (DBS-169). */
    private const MERMAID_OPS = ['dbspec.export_mermaid', 'dbspec.import_mermaid'];

    /** @var array<string, array<string, array{string}>> the data sets of the recipes that have been read, by path */
    private static array $caseIds = [];

    private static ?string $documentPath = null;

    /** @var array<string, mixed> the recipe at $documentPath: one recipe is held at a time */
    private static array $document = [];

    /**
     * The id of each case of the recipe at path, relative to the repository root, as the data sets of its tests. PHPUnit calls
     * every provider when it builds the suite, whatever the filter of the run, so this reads each recipe once and keeps no case.
     *
     * @return array<string, array{string}>
     */
    public static function cases(string $path): array
    {
        if (!isset(self::$caseIds[$path])) {
            $recipe = RecipeKeys::decoded($path, (string) file_get_contents(dirname(__DIR__, 3) . '/' . $path));
            self::$caseIds[$path] = [];
            foreach ($recipe['cases'] as $case) {
                self::$caseIds[$path][$case['id']] = [$case['id']];
            }
        }
        return self::$caseIds[$path];
    }

    /** The recipe at path, relative to the repository root, decoded when a test of another recipe ran last. */
    private static function document(string $path): array
    {
        if (self::$documentPath !== $path) {
            self::$document = [];
            self::$document = json_decode(
                (string) file_get_contents(dirname(__DIR__, 3) . '/' . $path),
                true,
                512,
                JSON_THROW_ON_ERROR
            );
            self::$documentPath = $path;
        }
        return self::$document;
    }

    /** @return array<string, mixed> the case of the recipe at path with this id */
    public static function caseOf(string $path, string $id): array
    {
        foreach (self::document($path)['cases'] as $case) {
            if ($case['id'] === $id) {
                return $case;
            }
        }
        throw new \RuntimeException("recipe $path: no case $id");
    }

    /**
     * Appends the pass of a case that ran on database to the file that ORM_RECIPE_RESULTS names, the line the feature
     * checker reads (FCV-12). A run outside the checker names no file.
     *
     * @param array<string, mixed> $case
     */
    public static function report(array $case, string $database): void
    {
        $path = getenv('ORM_RECIPE_RESULTS');
        if ($path === false || $path === '' || (isset($case['only']) && !in_array($database, $case['only'], true))) {
            return;
        }
        $named = $database === self::NONE ? '' : " [{$database}]";
        if (file_put_contents($path, "CASE {$case['id']}{$named} PASS\n", FILE_APPEND) === false) {
            throw new \RuntimeException("recipe results: cannot append to {$path}");
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
        foreach ($case['steps'] as $index => $raw) {
            $step = new RecipeStep($raw, $database);
            try {
                self::fileStep($step, $bound, $path, $database);
                $step->check();
            } catch (\PHPUnit\Framework\AssertionFailedError $failure) {
                Assert::fail(
                    "recipe $path case {$case['id']} step $index ({$raw['op']}) on $database: {$failure->getMessage()}"
                );
            }
        }
    }

    /** Runs a step of a case on no database through the op that it names. */
    private static function fileStep(RecipeStep $step, array &$bound, string $path, string $database): void
    {
        if ($step['op'] === 'ir.validate') {
            self::validateStep($step, $path, $database);
            return;
        }
        if ($step['op'] === 'ir.answer') {
            self::answerStep($step);
            return;
        }
        if ($step['op'] === 'collection.key') {
            self::collectionKeyStep($step, $database);
            return;
        }
        if ($step['op'] === 'planner.compile') {
            self::planStep($step, $path, $database);
            return;
        }
        if ($step['op'] === 'generator.check') {
            RecipeGenerator::checkFiles($step, dirname(__DIR__, 3) . '/' . dirname($path));
            return;
        }
        if ($step['op'] === 'generator.refused') {
            RecipeGenerator::checkRefused($step, dirname(__DIR__, 3) . '/' . dirname($path));
            return;
        }
        if ($step['op'] === 'ir.param_uses') {
            self::paramUsesStep($step, $path, $database);
            return;
        }
        if ($step['op'] === 'planner.columns') {
            self::plannerColumnsStep($step, $path, $database);
            return;
        }
        if ($step['op'] === 'generator.generate') {
            RecipeGenerator::check($step, dirname(__DIR__, 3) . '/' . dirname($path), $database);
            return;
        }
        if (in_array($step['op'], self::DBSPEC_OPS, true)) {
            self::dbspecStep($step, $bound, $database);
            return;
        }
        if ($step['op'] === 'dsn.connect') {
            self::dsnConnectStep($step, $database);
            return;
        }
        if ($step['op'] === 'dbspec.introspect_shown') {
            self::dbspecIntrospectShownStep($step, dirname(__DIR__, 3) . '/' . dirname($path), $database);
            return;
        }
        if ($step['op'] === 'dbspec.apply_fault') {
            self::dbspecApplyFaultStep($step, $bound, $database);
            return;
        }
        if ($step['op'] === 'dbspec.introspect_sqlite') {
            self::dbspecIntrospectSqliteStep($step, $database);
            return;
        }
        if ($step['op'] === 'markdown.session') {
            self::markdownSessionStep($step, $database);
            return;
        }
        if ($step['op'] === 'markdown.connect') {
            self::markdownConnectStep($step, $database);
            return;
        }
        if ($step['op'] === 'keyring.versions') {
            self::keyringVersionsStep($step, $database);
            return;
        }
        if ($step['op'] === 'markdown.builder') {
            self::markdownBuilderStep($step, $database);
            return;
        }
        if (in_array($step['op'], self::DBSPEC_FILE_OPS, true)) {
            self::dbspecFileStep($step, $path, $database);
            return;
        }
        if (in_array($step['op'], self::MERMAID_OPS, true)) {
            self::mermaidStep($step, $bound, $path, $database);
            return;
        }
        if ($step['op'] === 'markdown.send') {
            if ($step->has('process_zone')) {
                // The process zone holds while the step runs, so the public call sees it, and is restored
                // after it.
                $saved = date_default_timezone_get();
                date_default_timezone_set($step['process_zone']);
                try {
                    self::sendStep($step);
                } finally {
                    date_default_timezone_set($saved);
                }
            } else {
                self::sendStep($step);
            }
            return;
        }
        if ($step['op'] === 'model.assign') {
            self::assignStep($step);
            return;
        }
        self::step($step, $bound, $database);
    }

    /**
     * Gives the request of an ir.validate step to the validator, with the manifest_hash of the schema that the recipe
     * names (relative to the recipe file) added, and checks the outcome of the expect of database: {value: {bool:
     * true}} for an accepted request, {error: CODE} for a request that fails with CODE.
     */
    private static function userFromDatabaseDsn(string $dsn, string $prefix): string
    {
        preg_match('#/([^/?]+)(?:\?.*)?$#', $dsn, $name);
        return (string) preg_replace('#^mysql://[^@]+@#', 'mysql://' . $prefix . substr($name[1], -28) . '@', $dsn);
    }

    private static function validateStep(RecipeStep $step, string $path, string $database): void
    {
        $outcome = $step['expect'][$database] ?? Assert::fail("ir.validate has no expect for $database");
        $root = dirname(__DIR__, 3);
        $recipe = self::document($path);
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
            (new Validator($model))->validate($step['request'] + ['manifest_hash' => $step['manifest_hash'] ?? $model->manifestHash]);
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

    /** The model of the schema of a planner step and its input with the manifest_hash of that schema. */
    private static function plannerRequest(RecipeStep $step, string $path): array
    {
        $schema = realpath(dirname(dirname(__DIR__, 3) . '/' . $path) . '/' . $step['schema']);
        if ($schema === false) {
            Assert::fail("{$step['op']}: the schema of $path is missing");
        }
        $model = RuntimeModel::build(RuntimeModel::files([$schema]));
        return [$model, $step['input'] + ['manifest_hash' => $model->manifestHash]];
    }

    /** States the uses of each parameter of a validated request (DIA-31, PRT-67). */
    private static function paramUsesStep(RecipeStep $step, string $path, string $database): void
    {
        [$model, $request] = self::plannerRequest($step, $path);
        $validator = new Validator($model);
        $validator->validate($request);
        $uses = array_map(static fn(array $list): array => array_map(static fn(array $use): array => $use['column'] === null
            ? ['type' => $use['type']]
            : ($use['assign'] ?? false ? ['assign' => true] : []) + [
                'column' => $use['column']['name'],
                'length' => $use['column']['length'] ?? 0,
                'null' => $use['column']['nullable'],
                'precision' => $use['column']['precision'] ?? 0,
                'scale' => $use['column']['scale'] ?? 0,
                'type' => $use['type'],
            ], $list), $validator->paramUses($request));
        Assert::assertSame(self::sortedKeys($step['expect'][$database]['value']), self::sortedKeys(['uses' => $uses]), 'ir.param_uses');
    }

    /**
     * States the output columns that the names of the step select from the first statement of the plan of each dialect: their
     * type and whether they are hidden (PRT-69, DIA-33).
     */
    private static function plannerColumnsStep(RecipeStep $step, string $path, string $database): void
    {
        [$model, $request] = self::plannerRequest($step, $path);
        foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
            $assemble = (new Engine($model, $dialect, 8))->compile($request)['steps'][0]['assemble'];
            $got = [];
            foreach ($step['names'] as $name) {
                foreach ($assemble['columns'] as $column) {
                    if ($column['name'] === $name) {
                        $got[] = ['hidden' => $column['hidden'] ?? false, 'name' => $name, 'type' => $column['type']];
                    }
                }
            }
            Assert::assertSame(self::sortedKeys($step['expect'][$database]['value']), self::sortedKeys($got), "$dialect planner.columns");
        }
    }

    /**
     * Compiles the request of a planner.compile step with the Engine of each dialect, against the manifest of the
     * schema that the step names relative to the recipe file, and checks the plans with the expect of database:
     * {value: {mysql, postgres, sqlite}} with the statements of each dialect, or {error: CODE}, which every dialect
     * must reject with.
     */
    private static function planStep(RecipeStep $step, string $path, string $database): void
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
                $message = '';
                try {
                    (new Engine($model, $dialect, 8))->compile($request);
                } catch (OrmException $error) {
                    $code = $error->code_;
                    $message = $error->getMessage();
                }
                Assert::assertSame($outcome['error'], $code, "$dialect planner.compile");
                if (isset($outcome['message'])) {
                    Assert::assertSame($outcome['message'], $message, "$dialect planner.compile message");
                }
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
            ] + (($step['assemble_types'] ?? false) === true ? [
                'assemble_types' => array_column($planned['assemble']['columns'], 'type', 'name'),
            ] : []), $plan['steps']);
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
        if ($slot['from'] === 'audit') {
            $out['name'] = $slot['name'];
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
    private static function dbspecStep(RecipeStep $step, array &$bound, string $database): void
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
        } elseif ($op === 'dbspec.add_tables_steps') {
            $result = Dbspec::addTablesAndColumnsSteps(
                self::dbspecBound($step['source'], $bound),
                [],
                self::dbspecBound($step['target'], $bound),
                $step['dialect']
            );
            $got = [
                'added' => $result[0],
                'statements' => array_map(static fn(PlanStep $s): string => $s->statement, $result[1]),
                'differences' => $result[2],
            ];
        } elseif ($op === 'dbspec.introspect_refusal') {
            $got = self::dialectRefusal(
                $step['dialect'],
                static fn() => Dbspec::introspect(new \PDO('sqlite::memory:'), $step['dialect'], 'introspected'),
            );
            Assert::assertSame(self::sortedKeys($expect), self::sortedKeys($got), "$op: result differs from the expect");
            return;
        } elseif ($op === 'dbspec.plan_steps') {
            $source = ($step['source'] ?? null) === null ? null : self::dbspecBound($step['source'], $bound);
            if (!in_array($step['dialect'], ['mysql', 'postgres', 'sqlite'], true)) {
                $plan = self::dbspecBound($step['plan'], $bound);
                $got = self::dialectRefusal(
                    $step['dialect'],
                    static fn() => Dbspec::planSteps($source, $plan, $step['dialect']),
                );
                Assert::assertSame(self::sortedKeys($expect->all()), self::sortedKeys($got), "$op: result differs from the expect");
                return;
            }
            $result = Dbspec::planSteps($source, self::dbspecBound($step['plan'], $bound), $step['dialect']);
            $steps = $result->steps ?? Assert::fail('plan steps: ' . self::diagnostics($result->diagnostics));
            $got = ['steps' => array_map(static fn(PlanStep $s): array => self::planStepFields($s), $steps)];
        } else {
            Assert::fail("OP_UNKNOWN $op");
        }
        Assert::assertSame(self::sortedKeys($expect->all()), self::sortedKeys($got), "$op: result differs from the expect");
    }

    /**
     * Runs a call that takes the dialect name and returns {refused: name} when it throws an InvalidArgumentException that
     * names it (DBS-174).
     */
    private static function dialectRefusal(string $name, callable $call): array
    {
        try {
            $call();
        } catch (InvalidArgumentException $refusal) {
            Assert::assertStringContainsString($name, $refusal->getMessage());
            return ['refused' => $name];
        }
        Assert::fail("the call accepted the dialect $name");
    }

    /** The schema argument of schema.exists and schema.installed: the name, or that of the database, where $database is the name of the case database. */
    private static function inspectedSchema(mixed $value, array $context): string
    {
        $name = is_string($value) ? $value : $value[$context['database']];
        return $name === '$database' ? ltrim((string) parse_url($context['dsn'], PHP_URL_PATH), '/') : $name;
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
    private static function answerStep(RecipeStep $step): void
    {
        $outcome = $step['expect']['none'] ?? new RecipeStep([]);
        $params = $outcome->has('params');
        if (!$outcome->has('value') && !$params) {
            Assert::fail('ir.answer has neither expect.none.value nor params');
        }
        if ($params && $step->has('answers')) {
            Assert::fail('a params expect needs one answer, not answers');
        }
        $want = $params ? $outcome['params'] : $outcome['value'];
        $chain = MarkdownConformanceTest::conformanceCases()[$step['chain']] ?? null;
        if ($chain === null) {
            Assert::fail("chain {$step['chain']} is no markdown conformance case");
        }
        $flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR;
        $server = $step->has('answers')
            ? start_markdown_test_server(['--keyed', json_encode($step['answers'], $flags)])
            : start_markdown_test_server(['{"ok":true}', json_encode($step['answer'], $flags)]);
        $served = new Served();
        $served->db = \Polyspec\Orm\Tests\MarkdownModel\connect($server[2], new Config());
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
     * Runs a collection.key step: each value through the public Collection::keyOf and Collection::identityOf. Its groups are,
     * for each key, the index of the first key equal to it, and its types the native type that keyOf keeps (INT-11, INT-63,
     * PRT-35).
     */
    private static function collectionKeyStep(RecipeStep $step, string $database): void
    {
        $got = ['groups' => [], 'types' => []];
        $seen = [];
        try {
            foreach ($step['keys'] as $index => $entry) {
                $value = match ($entry['type']) {
                    'null' => null,
                    'bytes' => new \Polyspec\Orm\Bytes(hex2bin($entry['hex'])),
                    'datetime' => new \DateTime($entry['value']),
                    default => $entry['value'],
                };
                $key = \Polyspec\Orm\Collection::keyOf($value);
                Assert::assertSame($value, $key, 'a key changed its native value');
                $identity = \Polyspec\Orm\Collection::identityOf($value);
                $seen[$identity] ??= $index;
                $got['groups'][] = $seen[$identity];
                $got['types'][] = match (true) {
                    is_string($key) => 'text',
                    is_bool($key) => 'bool',
                    is_int($key) => 'int',
                    $key instanceof \Polyspec\Orm\Bytes => 'bytes',
                    $key instanceof \DateTimeInterface => 'datetime',
                };
            }
        } catch (OrmException $error) {
            $got = ['error' => $error->code_, 'message' => $error->getMessage()];
        }
        Assert::assertSame($step['expect'][$database]->all(), $got);
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

    /**
     * Opens a DSN with Orm::connect, runs SELECT 1 through the statement runner (INT-150), closes it and returns its
     * driver: the one implementation of dsn.connect (FCV-4).
     */
    private static function connectDriver(string $dsn, array $config = []): string
    {
        $db = Orm::connect($dsn, new Config(
            poolSize: $config['pool_size'] ?? 0,
            poolIdleSize: $config['pool_idle_size'] ?? 0,
            poolLifetimeMs: $config['pool_lifetime_ms'] ?? 0,
            statementTimeoutMs: $config['statement_timeout_ms'] ?? 0,
        ));
        try {
            $rows = $db->utils()->run(
                static fn (TxFrame $frame): array => $frame->run(
                    StatementEvent::UTILITY,
                    [],
                    'SELECT 1',
                ),
            );
            Assert::assertCount(1, $rows, 'SELECT 1 on the connection returns one row');
            Assert::assertCount(1, $rows[0], 'SELECT 1 on the connection returns one column');
            Assert::assertSame(1, (int) $rows[0][0], 'SELECT 1 on the connection returns 1');
            if ($config['tls_version'] ?? false) {
                $status = $db->utils()->run(
                    static fn (TxFrame $frame): array => $frame->run(
                        StatementEvent::UTILITY,
                        [],
                        "SHOW SESSION STATUS LIKE 'Ssl_version'",
                    ),
                );
                Assert::assertContains($status[0][1] ?? null, ['TLSv1.2', 'TLSv1.3'], 'the Ssl_version of the connection');
            }
            return $db->driver();
        } finally {
            $db->close();
        }
    }

    /**
     * The names in a new directory, other than the journals, after a connection to a file of it (dsn.sqlite_file, FCV-4,
     * CFG-26).
     */
    private static function sqliteFileNames(string $name, string $query): string
    {
        $directory = sys_get_temp_dir() . '/orm-recipe-sqlite-name-' . bin2hex(random_bytes(8));
        if (!mkdir($directory, 0o700)) {
            throw new RuntimeException("cannot create $directory");
        }
        try {
            try {
                self::connectDriver("sqlite://$directory/$name?$query");
            } catch (OrmException $refused) {
                Assert::assertSame(['.', '..'], scandir($directory), 'a refused DSN creates no file');
                throw $refused;
            }
            $names = array_diff(
                scandir($directory),
                ['.', '..', "$name-journal", "$name-shm", "$name-wal"],
            );
            return implode(',', $names);
        } finally {
            exec('rm -rf ' . escapeshellarg($directory));
        }
    }

    /** The markdown.connect op (FCV-4, PRT-64): Db.connect on a listener that answers the first line with the reply of the step. */
    private static function markdownConnectStep(RecipeStep $step, string $database): void
    {
        $server = \Polyspec\Orm\Tests\start_markdown_test_server([$step['reply']]);
        $code = null;
        $message = '';
        $port = parse_url($server[2], PHP_URL_PORT);
        try {
            self::connectDriver("markdown://127.0.0.1:$port/{$step['corpus']}?token={$step['token']}");
        } catch (OrmException $error) {
            $code = $error->code_;
            $message = $error->getMessage();
        }
        Assert::assertSame(
            [$step['received']],
            \Polyspec\Orm\Tests\markdown_test_server_received_messages($server),
            'the lines that the listener received',
        );
        Assert::assertSame($step['expect'][$database]['error'] ?? null, $code);
        Assert::assertStringContainsString($step['expect'][$database]['message_holds'] ?? '', $message);
    }

    /**
     * The markdown.session op (FCV-4, PRT-64): on a listener that answers each line with the next of the replies of the
     * step, a read-only transaction that holds a nested one, then a transaction, whose error is compared with the expect.
     */
    private static function markdownSessionStep(RecipeStep $step, string $database): void
    {
        $server = \Polyspec\Orm\Tests\start_markdown_test_server($step['replies']);
        $port = parse_url($server[2], PHP_URL_PORT);
        $db = Orm::connect("markdown://127.0.0.1:$port/{$step['corpus']}?token={$step['token']}", new Config());
        $code = null;
        $message = '';
        $empty = static function (): void {
        };
        $db->transaction(static function () use ($db, $empty): void {
            $db->transaction($empty);
        }, readOnly: true);
        try {
            $db->transaction($empty);
        } catch (OrmException $error) {
            $code = $error->code_;
            $message = $error->getMessage();
        }
        $db->close();
        Assert::assertSame(
            $step['messages'],
            \Polyspec\Orm\Tests\markdown_test_server_received_messages($server),
            'the lines that the listener received',
        );
        Assert::assertSame($step['expect'][$database]['error'], $code);
        Assert::assertStringContainsString($step['expect'][$database]['message_holds'] ?? '', $message);
    }

    /** The public call of a markdown.send surface, one that has no form on a markdown connection (DIA-183 to DIA-189). */
    private static function refusedSurface(string $surface, mixed $db): void
    {
        $empty = static function (): void {
        };
        $model = new \Polyspec\Orm\Tests\BindModel\Slots();
        $keyring = new \Polyspec\Orm\AesKeyring([1 => 'key'], 1);
        $schema = new \Polyspec\Orm\Schema('', '');
        match ($surface) {
            'audit' => $db->transaction($empty, audit: ['actor' => 'tester']),
            'isolation' => $db->transaction($empty, isolation: 'serializable'),
            'timeout_ms' => $db->transaction($empty, timeoutMs: 100),
            'get_query' => $model->connect($db)->getQuery(),
            'subscribe' => $db->subscribe($empty),
            'lock' => $db->utils()->lock('k'),
            'set_local' => $db->utils()->setLocal('k', 'v'),
            'local' => $db->utils()->local('k'),
            'backend_waiting_for_lock' => $db->utils()->backendWaitingForLock(),
            'privileges' => $db->utils()->privileges()->inspectTable('public.items'),
            'aes_status' => $db->utils()->aes()->status($model, $keyring),
            'aes_rotate' => $db->utils()->aes()->rotate($model, $keyring),
            'schema_install' => $db->utils()->schema()->install($schema),
            'schema_evolution' => $db->utils()->schema()->addTablesAndColumns($schema),
            'schema_exists' => $db->utils()->schema()->exists('orm'),
        };
    }

    /** The dsn.connect op (FCV-4): the DSN text of the step, checked against the outcome of the expect of database. */
    private static function dsnConnectStep(RecipeStep $step, string $database): void
    {
        $expect = $step['expect'][$database] ?? null;
        if ($expect === null) {
            Assert::fail("dsn.connect has no expect for $database");
        }
        $code = null;
        $message = '';
        $driver = null;
        try {
            $driver = self::connectDriver($step['dsn'], $step['config'] ?? []);
        } catch (OrmException $error) {
            $code = $error->code_;
            $message = $error->getMessage();
        }
        if (isset($expect['error'])) {
            if ($code !== $expect['error']) {
                Assert::fail('error ' . ($code ?? 'none') . ", want {$expect['error']}");
            }
            Assert::assertStringContainsString($expect['message_holds'] ?? '', $message);
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
    private static function dbspecSet(RecipeStep $step, RecipeStep $expect): void
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
            if ($expect->has('created')) {
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
    private static function dbspecFileStep(RecipeStep $step, string $path, string $database): void
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
                if ($step->has('dialect')) {
                    $got = self::dialectRefusal($step['dialect'], static fn() => Dbspec::render($documents, $step['dialect']));
                    Assert::assertSame($expect->all(), $got, 'refused dialect');
                    return;
                }
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
                [$text, $set] = $step->has('document')
                    ? [self::dbspecFile($dir, $step['document']), []]
                    : self::inlineDocument($step);
                $analysis = Dbspec::analyze($text, $set);
                if ($step->has('document') && $analysis->diagnostics !== []) {
                    Assert::fail(self::diagnostics($analysis->diagnostics));
                }
                $parsed = Dbspec::parse($text, $set);
                if (
                    $analysis->document != $parsed->document
                    || $analysis->positions != $parsed->positions
                    || $analysis->diagnostics != $parsed->diagnostics
                ) {
                    Assert::fail('the analysis differs from the parse');
                }
                self::checkTokens($analysis->tokens, $expect['tokens'] ?? []);
                return;
            case 'dbspec.parse_positions':
                if ($step->has('document')) {
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
                if ($expect->has('diagnostics')) {
                    self::checkRefusal($text, $set, $expect['diagnostics']);
                    return;
                }
                $expected = implode("\n", self::expandLines($expect['text'] ?? [])) . "\n";
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
            case 'dbspec.load_set':
                $text = static fn(array $lines): string => $lines === [] ? '' : implode("\n", $lines) . "\n";
                try {
                    $documents = RuntimeModel::loadSet($text($step['owned']), $text($step['external']));
                } catch (OrmException $error) {
                    Assert::assertSame($expect['error'] ?? null, $error->code_, 'error');
                    // Each diagnostic is "<line>:<column> <rule>: <message>", in order (SCH-12).
                    if ($expect->has('diagnostics')) {
                        $prefix = "{$expect['error']}: ";
                        Assert::assertStringStartsWith($prefix, $error->getMessage());
                        $problems = explode('; ', substr($error->getMessage(), strlen($prefix)));
                        Assert::assertCount(count($expect['diagnostics']), $problems, $error->getMessage());
                        foreach ($problems as $i => $problem) {
                            Assert::assertStringStartsWith("{$expect['diagnostics'][$i]}: ", $problem);
                        }
                    }
                    return;
                }
                Assert::assertSame(
                    $expect['documents'] ?? null,
                    array_map(static fn($d): array => ['name' => $d->name, 'external' => $d->external], $documents),
                    'documents',
                );
                if ($expect->has('manifest_hash')) {
                    Assert::assertSame($expect['manifest_hash'], Dbspec::manifest($documents)->manifest->manifestHash, 'manifest hash');
                }
                return;
            case 'dbspec.runtime_model':
                $read = static fn(array $paths): array => array_map(
                    static fn(string $path): string => self::dbspecFile($dir, $path),
                    $paths,
                );
                $model = RuntimeModel::build(RuntimeModel::parseSet($read($step['documents']), $read($step['external'] ?? [])));
                Assert::assertSame($expect['entities'], array_keys($model->entities), 'entities');
                if ($expect->has('manifest_text')) {
                    Assert::assertSame(implode("\n", $expect['manifest_text']) . "\n", $model->manifestText, 'manifest text');
                }
                if ($expect->has('manifest_hash')) {
                    Assert::assertSame($expect['manifest_hash'], $model->manifestHash, 'manifest hash');
                }
                $named = static function (array $have, array $want) use (&$named): array {
                    $out = [];
                    foreach ($want as $key => $value) {
                        $out[$key] = is_array($value) && !array_is_list($value) ? $named($have[$key], $value) : $have[$key];
                    }
                    return $out;
                };
                foreach ($expect['models'] ?? [] as $name => $values) {
                    $entity = $model->entities[$name];
                    $fields = [];
                    foreach ($entity['columns'] as $column) {
                        $fields[$column['name']] = [
                            'type' => $column['type'],
                            'nullable' => $column['nullable'],
                            'default' => $column['default'],
                            'default_now' => $column['default_now'],
                            'select_explicit' => !$column['select'],
                            'codec' => $column['codec'],
                            'blind_index' => $column['blind_index'],
                            'primary_key' => $column['pk'],
                            'foreign_key' => $column['foreign_key'],
                        ];
                    }
                    $keyNames = [...array_keys($entity['unique']), ...array_keys($entity['indexes'])];
                    sort($keyNames);
                    $got = [
                        'table' => $entity['table'],
                        'primary_key' => $entity['pk'],
                        'identity' => $entity['identity'],
                        'updated' => $entity['updated'],
                        'soft_delete' => $entity['soft_delete'],
                        'aes_version' => $entity['aes_version'],
                        'audit_column' => $entity['audit'],
                        'audit_record' => $entity['audit_record'],
                        'key_names' => $keyNames,
                        'fields' => $fields,
                    ];
                    Assert::assertEquals($values, $named($got, $values), "entity $name");
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
    private static function inlineDocument(RecipeStep $step): array
    {
        $crlf = ($step['crlf'] ?? false) === true;
        $mixed = ($step['mixed'] ?? false) === true;
        $set = [];
        foreach ($step['set'] ?? [] as $name => $lines) {
            $set[$name] = self::joinText($lines, $crlf, $mixed);
        }
        return [self::joinText(self::expandLines($step['text'] ?? []), $crlf, $mixed), $set];
    }

    /**
     * The lines of a text (FCV-4): a repeat gives its lines count times with {var} replaced, a fill one line of its text.
     *
     * @param list<mixed> $items
     * @return list<string>
     */
    private static function expandLines(array $items): array
    {
        $out = [];
        foreach ($items as $item) {
            if (is_string($item)) {
                $out[] = $item;
            } elseif (isset($item['fill'])) {
                $out[] = str_repeat($item['fill']['text'], $item['fill']['count']);
            } else {
                $repeat = $item['repeat'];
                $inner = self::expandLines($repeat['lines']);
                $mark = '{' . $repeat['var'] . '}';
                for ($i = $repeat['from']; $i < $repeat['from'] + $repeat['count']; $i++) {
                    foreach ($inner as $line) {
                        $out[] = str_replace($mark, (string) $i, $line);
                    }
                }
            }
        }
        return $out;
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
    private static function mermaidStep(RecipeStep $step, array &$bound, string $path, string $database): void
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
    private static function exportStep(RecipeStep $step, string $path): array
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
    private static function importStep(RecipeStep $step, array $bound, string $path): array
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

    /** The typed filters of the bind fixture tests/bind/slots.dbs that a markdown.send statement may name, by column
     * (DBS-121). */
    private const BIND_FILTERS = [
        'slots.uuid_value' => 'uuidValue',
        'slots.time0_value' => 'time0Value',
        'slots.time1_value' => 'time1Value',
        'slots.time2_value' => 'time2Value',
        'slots.datetime1_value' => 'datetime1Value',
        'slots.datetime2_value' => 'datetime2Value',
        'slots.time3_value' => 'time3Value',
        'slots.time6_value' => 'time6Value',
        'slots.datetime0_value' => 'datetime0Value',
        'slots.datetime3_value' => 'datetime3Value',
        'slots.datetime6_value' => 'datetime6Value',
        'slots.date_value' => 'dateValue',
        'slots.decimal_value' => 'decimalValue',
        'slots.varchar_value' => 'varcharValue',
        'slots.varchar_null_value' => 'varcharNullValue',
        'slots.varchar_long_value' => 'varcharLongValue',
        'slots.text_value' => 'textValue',
        'slots.bytes_value' => 'bytesValue',
        'slots.i16_value' => 'i16Value',
        'slots.i32_value' => 'i32Value',
        'slots.i64_value' => 'i64Value',
        'slots.f64_value' => 'f64Value',
        'slots.bool_value' => 'boolValue',
    ];

    /** The answer of the markdown.send listener to the message it records, which ends the call. */
    private const SEND_ERROR = '{"error":{"code":"IR_INVALID","message":"recorded by the markdown.send listener"}}';

    /**
     * Runs one markdown.send step (FCV-4) on a listener that answers connect with {"ok":true}, records the first
     * message after
     * it and answers that message with SEND_ERROR so the call ends. The expect is {"message": JSON}, compared with the
     * whole
     * message of a begin or the one parameter of a statement, or {"error": CODE}, compared with the code of the orm
     * error that
     * the call raises before it sends a message.
     */
    private static function sendStep(RecipeStep $step): void
    {
        self::loadBindModels();
        [$message, $code] = self::sendFirst(static function (mixed $db) use ($step): void {
            if ($step->has('surface')) {
                self::refusedSurface($step['surface'], $db);
            } elseif ($step->has('begin')) {
                $db->transaction(static fn(): null => null, '', $step['begin']['read_only'] === true);
            } else {
                self::sendQuery($step, $db);
            }
        });
        self::checkMessage($step['expect'], $message, $code);
    }

    /**
     * Runs one dbspec.apply_fault step (FCV-4): the public apply or rollback on a SQLite connection, after applied_first
     * and sql, with the fail_catalog_read-th read of the SQLite master query in the call failing. An injected failure must
     * reach the apply error as its cause (PLN-92, PLN-93, PLN-96).
     *
     * @param array<string, mixed> $step
     * @param array<string, mixed> $bound
     */
    private static function dbspecApplyFaultStep(RecipeStep $step, array $bound, string $database): void
    {
        $expect = $step['expect'][$database];
        $master = "SELECT type, name, tbl_name, IFNULL(sql, '') FROM sqlite_master\n"
            . "WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE 'dbspec$%' ORDER BY type, name";
        $plans = [self::dbspecBound($step['plan'], $bound)];
        $now = static fn(): \DateTimeImmutable => new \DateTimeImmutable('2026-10-01T00:00:00Z');
        $noRow = array_fill_keys($step['no_row_queries'] ?? [], 'SELECT 1 WHERE 0');
        $pdo = dbspec_failing_pdo('dbspec_apply_fault', [], $noRow);
        if (($step['applied_first'] ?? false) === true) {
            Dbspec::apply($pdo, 'sqlite', $plans, $now, null);
        }
        foreach ($step['sql'] ?? [] as $statement) {
            $pdo->exec($statement);
        }
        $cause = null;
        if (isset($step['fail_catalog_read'])) {
            $cause = new \PDOException('catalog read failed');
            $pdo->failQuery($master, $cause, $step['fail_catalog_read']);
        }
        $fail = [];
        foreach ($step['fail_statements'] ?? [] as $f) {
            $fail[$f['statement']] = new \PDOException($f['message']);
            if (isset($f['sqlite_result'])) {
                $fail[$f['statement']]->errorInfo = ['HY000', $f['sqlite_result'], $f['message']];
            }
        }
        $pdo->failStatements($fail);
        $kinds = [];
        $events = static function (\Polyspec\Orm\Dbspec\ApplyEvent $event) use (&$kinds, $step): void {
            $kinds[] = $event->kind;
            if (isset($step['stop_on_applied']) && $event->kind === 'applied') {
                throw new \RuntimeException($step['stop_on_applied']);
            }
        };
        $error = null;
        try {
            if ($step['call'] === 'rollback') {
                Dbspec::rollback($pdo, 'sqlite', $plans, $now, $events);
            } else {
                Dbspec::apply($pdo, 'sqlite', $plans, $now, $events);
            }
        } catch (\Throwable $caught) {
            $error = $caught;
        }
        Assert::assertNotNull($error, 'the call succeeded');
        // ApplyCleanupError holds the failure as its previous throwable and the cleanup errors in order (PLN-98, PLN-106).
        $cleanup = [];
        if ($error instanceof \Polyspec\Orm\Dbspec\ApplyCleanupError) {
            $cleanup = array_map(static fn(\Throwable $e): string => $e->getMessage(), $error->cleanup);
            $error = $error->getPrevious();
        }
        if (isset($expect['code'])) {
            Assert::assertInstanceOf(\Polyspec\Orm\Dbspec\ApplyError::class, $error);
            Assert::assertSame($expect['code'], $error->code_);
        }
        if (isset($expect['failure'])) {
            Assert::assertSame($expect['failure'], $error->getMessage());
        }
        if (isset($expect['failure_ends_with'])) {
            Assert::assertStringEndsWith($expect['failure_ends_with'], $error->getMessage());
        }
        if (isset($expect['cleanup'])) {
            Assert::assertSame($expect['cleanup'], $cleanup);
        }
        if ($cause !== null) {
            $previous = $error->getPrevious();
            Assert::assertTrue(
                $previous === $cause || $previous?->getPrevious() === $cause,
                'the apply error holds the catalog read error'
            );
        }
        if (isset($expect['history_state'])) {
            Assert::assertSame($expect['history_state'], $pdo->query('SELECT state FROM "dbspec$plans"')->fetchColumn());
        }
        foreach ($expect['absent_events'] ?? [] as $kind) {
            Assert::assertNotContains($kind, $kinds);
        }
    }

    /**
     * Runs one dbspec.introspect_shown step (FCV-4): the public Dbspec::introspect on the canned catalog of a case of
     * the vectors file, whose check lines and unsupported objects, or error, it compares (DIA-84). A reason compares
     * by its rule, the text before the first ": ", since its text differs between the clients.
     *
     * @param array<string, mixed> $step
     */
    private static function dbspecIntrospectShownStep(RecipeStep $step, string $dir, string $database): void
    {
        $vectors = json_decode((string) file_get_contents($dir . '/' . $step['vectors']), true, 512, JSON_THROW_ON_ERROR);
        $found = null;
        foreach ($vectors['cases'] as $vector) {
            if ($vector['id'] === $step['case']) {
                $found = $vector;
            }
        }
        Assert::assertNotNull($found, 'the vectors have the case');
        $pdo = new CannedCatalogPdo($vectors['catalog'], implode("\n", $found['create']) . "\n", $found['name']);
        $expect = $step['expect'][$database];
        try {
            $result = Dbspec::introspect($pdo, 'mysql', 'introspected');
        } catch (RuntimeException $error) {
            Assert::assertSame($expect['error'] ?? null, $error->getMessage());
            return;
        }
        Assert::assertArrayNotHasKey('error', $expect, 'the introspection returned no error');
        $checks = [];
        foreach (explode("\n", Dbspec::emit($result->document)) as $line) {
            $line = trim($line);
            if (str_starts_with($line, 'check ')) {
                $checks[] = $line;
            }
        }
        $reasons = array_map(
            static fn($item): string => "$item->kind $item->name: " . explode(': ', $item->reason, 2)[0],
            $result->unsupported
        );
        Assert::assertSame($expect['checks'], $checks, 'checks');
        Assert::assertSame($expect['unsupported'], $reasons, 'unsupported');
    }

    /**
     * Runs one dbspec.introspect_sqlite step (FCV-4): the statements on a memory SQLite connection of its own,
     * then the public Dbspec::introspect, whose unsupported objects it compares (DIA-191).
     *
     * @param array<string, mixed> $step
     */
    private static function dbspecIntrospectSqliteStep(RecipeStep $step, string $database): void
    {
        $pdo = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        foreach ($step['sql'] as $statement) {
            $pdo->exec($statement);
        }
        $result = Dbspec::introspect($pdo, 'sqlite', 'introspected');
        $got = array_map(
            static fn($item): array => [
                'kind' => $item->kind,
                'table' => $item->table,
                'name' => $item->name,
                'reason' => $item->reason,
            ],
            $result->unsupported
        );
        Assert::assertSame($step['expect'][$database]['unsupported'], $got);
    }

    /**
     * Runs one keyring.versions step (FCV-4): the public constructor of the keyring, then its current version and its
     * versions (INT-74, INT-130), against the expect of database.
     */
    private static function keyringVersionsStep(RecipeStep $step, string $database): void
    {
        $expect = $step['expect'][$database];
        try {
            $keyring = self::aesKeyring($step['keyring']);
        } catch (OrmException $error) {
            Assert::assertSame($expect['error'] ?? null, $error->code_, 'the error of the keyring');
            return;
        }
        Assert::assertArrayNotHasKey('error', $expect, 'the keyring was built');
        Assert::assertSame($expect['current'], $keyring->currentVersion, 'the current version');
        Assert::assertSame($expect['versions'], $keyring->versions(), 'the versions');
    }

    /**
     * Runs one markdown.builder step (FCV-4): the builder calls on the slots model, then getCount, on the listener of
     * sendFirst. The terminal returns the first recorded error before it sends a message (INT-88, INT-89).
     */
    private static function markdownBuilderStep(RecipeStep $step, string $database): void
    {
        self::loadBindModels();
        $caught = null;
        [$message, $code] = self::sendFirst(static function (mixed $db) use ($step, &$caught): void {
            $model = (new \Polyspec\Orm\Tests\BindModel\Slots())->connect($db);
            try {
                foreach ($step['calls'] as $call) {
                    $model = match ($call) {
                        'limit_zero_count' => $model->limit(0, 0),
                        'limit_negative_offset' => $model->limit(-1, 1),
                        'empty_i64_list' => $model->i64Value([]),
                        'empty_varchar_list' => $model->varcharValue([]),
                    };
                }
                $model->getCount();
            } catch (OrmException $error) {
                $caught = $error;
                throw $error;
            }
        });
        Assert::assertNull($message, 'the terminal sent a message before its error');
        $expect = $step['expect'][$database];
        Assert::assertSame($expect['error'], $code, 'the error code of the terminal');
        Assert::assertSame($expect['message'], $caught->getMessage());
    }

    /**
     * Runs one model.assign step (FCV-4): sets the column of a new row of the generated model through its public
     * setter and builds the insert of that row on the markdown listener of sendFirst, with no database. The value is
     * a text wrapper, the only one the typed setter of the case takes; the nil case is excluded in PHP
     * (SetVarcharValue takes a string, not null).
     */
    private static function assignStep(RecipeStep $step): void
    {
        self::loadBindModels();
        [$message, $code] = self::sendFirst(static function (mixed $db) use ($step): void {
            $model = $step['model'];
            $column = $step['column'];
            if ($model !== 'slots' || $column !== 'varchar_value') {
                Assert::fail("model.assign of $model.$column has no typed setter in the PHP cases");
            }
            $text = $step['value']['text'] ?? Assert::fail('model.assign takes a text wrapper in the PHP cases');
            (new \Polyspec\Orm\Tests\BindModel\Slots())->connect($db)->setVarcharValue($text)->create();
        });
        self::checkMessage($step['expect'], $message, $code);
    }

    /**
     * Runs call with a connection to a markdown listener that answers connect with {"ok":true}, records the first
     * message after it and answers that message with SEND_ERROR so the call ends. Returns the first message, or null,
     * and the code of the orm error that call raises before it sends a message.
     *
     * @param callable(mixed): void $call
     * @return array{0: ?string, 1: string}
     */
    private static function sendFirst(callable $call): array
    {
        $server = start_markdown_test_server(['{"ok":true}', self::SEND_ERROR]);
        $code = '';
        $db = null;
        try {
            $db = \Polyspec\Orm\Tests\BindModel\connect($server[2], new Config());
            $call($db);
        } catch (OrmException $error) {
            $code = $error->code_;
        } finally {
            $db?->close();
            $received = markdown_test_server_received_messages($server);
        }
        // The first line is connect; the second is the first message after it.
        return [$received[1] ?? null, $code];
    }

    /**
     * Checks the message or the error code of a listener step against its expect, {"message": JSON} or {"error": CODE}.
     */
    private static function checkMessage(array $expect, ?string $message, string $code): void
    {
        if (isset($expect['error'])) {
            Assert::assertSame($expect['error'], $message === null ? $code : '', 'the error code of the call');
            return;
        }
        if ($message === null) {
            Assert::fail("the call returned error $code before a message, want " . json_encode($expect['message']));
        }
        $got = self::messageValue($message);
        if (is_array($expect['message'])) {
            Assert::assertEqualsCanonicalizing($expect['message'], $got, "message $message");
            return;
        }
        Assert::assertSame($expect['message'], $got, "message $message");
    }

    /** The message that an expect compares: the whole message of a begin, or the one parameter of a statement. */
    private static function messageValue(string $text): mixed
    {
        $message = json_decode($text, true, 512, JSON_THROW_ON_ERROR);
        if (($message['op'] ?? null) === 'begin') {
            return $message;
        }
        $params = $message['params'] ?? null;
        // A statement with no parameter (a nil compared with eq is IS NULL, DSL-48) has the empty list as its message.
        if (is_array($params) && $params === []) {
            return [];
        }
        if (!is_array($params)) {
            Assert::fail("the statement message $text holds no parameters");
        }
        // A list of several parameters (a list condition, DSL-50) is compared as the list.
        return count($params) === 1 ? $params[0] : $params;
    }

    /**
     * Runs the generated typed filter of the slot column of step with the PHP value of its wrapper (DBS-121). A text
     * wrapper
     * gives its text, an int wrapper its PHP int; a float, text or bool wrapper on an integer column gives the value
     * the
     * untyped PHP path receives, so the public call refuses it with CODEC_ENCODE.
     */
    private static function sendQuery(RecipeStep $step, mixed $db): void
    {
        $column = $step['column'];
        $operatorPrefix = ['eq_method' => 'eq', 'ne_method' => 'ne', 'gt_method' => 'gt'][$step['operator']] ?? null;
        if ($operatorPrefix !== null) {
            // A chain method of an operator (DSL-50), which __call dispatches.
            $method = $operatorPrefix . ucfirst(self::BIND_FILTERS[$column]
                ?? Assert::fail("the column $column has no typed filter in the PHP cases"));
        } elseif ($step['operator'] === 'like_contains') {
            // The contains condition of the text column is the lk operator of the generated model, which __call
            // dispatches (DSL-29).
            if ($column !== 'slots.text_value') {
                Assert::fail("the column $column has no contains filter in the PHP cases");
            }
            $method = 'lkTextValue';
        } elseif ($step['operator'] === 'eq') {
            $method = self::BIND_FILTERS[$column]
                ?? Assert::fail("the column $column has no typed filter in the PHP cases");
        } else {
            Assert::fail("operator {$step['operator']} has no typed filter in the PHP cases");
        }
        $wrapper = $step['params'][0];
        if (!is_array($wrapper) || count($wrapper) !== 1) {
            Assert::fail('the parameter ' . json_encode($wrapper) . ' is no single-member wrapper');
        }
        // A time, datetime, date or decimal wrapper is the text the typed string filter takes; the others go through
        // the common value model.
        $kind = array_key_first($wrapper);
        $textual = in_array($kind, ['time', 'datetime', 'date', 'decimal'], true);
        $value = $textual ? $wrapper[$kind] : self::toValue($wrapper);
        (new \Polyspec\Orm\Tests\BindModel\Slots())->connect($db)->{$method}($value)->gets();
    }

    /** Loads the generated models of tests/bind/dbspec-set.json, which make php-models writes, once. */
    private static function loadBindModels(): void
    {
        static $loaded = false;
        if ($loaded) {
            return;
        }
        $directory = dirname(__DIR__) . '/bindmodel';
        requireGeneratedClasses($directory);
        require_once $directory . '/bootstrap.php';
        $loaded = true;
    }

    /** Maps the op of step to its call and checks the result against the expect of database. */
    private static function step(RecipeStep $step, array &$bound, string $database): void
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
        if (isset($expect['bytes_prefix_hex'])) {
            // An envelope has a random nonce, so its form is its prefix and its length (COD-5).
            Assert::assertInstanceOf(Bytes::class, $result['value']);
            Assert::assertSame($expect['bytes_length'], strlen($result['value']->bytes));
            Assert::assertStringStartsWith($expect['bytes_prefix_hex'], bin2hex($result['value']->bytes));
            return;
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

    /** A stored cell, which PHP holds as a string of bytes: SQL NULL is null, and bytes or a written cell are their
     * string. */
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

    /** @var array<string, string> the namespace of the models generated from each fixture set, by its md5 */
    private static array $modelNamespaces = [];

    /** Runs one case of the recipe at path on a case database of database, which is removed when the case ends. */
    private static function runDatabase(string $path, array $case, string $database): void
    {
        if (!in_array($database, self::DATABASES, true)) {
            Assert::fail("recipe $path: unknown database $database");
        }
        $root = dirname(__DIR__, 3);
        $recipe = self::document($path);
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
                'schema' => $schema,
                'fixture' => dirname(__DIR__, 3) . '/' . $recipe['fixture'],
                'tablePath' => $recipe['fixture'] !== self::GENERATED_FIXTURE,
                'bound' => ['database' => ['text' => $name]],
                'db' => $db,
                'schema' => $schema,
                'dir' => dirname(__DIR__, 3) . '/' . dirname($path),
                'fields' => [],
                'records' => [],
                'hookBases' => [],
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
                foreach ([$recipe['seed']['after'] ?? null, $case['seed']['after'] ?? null] as $after) {
                    if ($after !== null && (!isset($after['only']) || in_array($database, $after['only'], true))) {
                        self::databaseStep($after, $context);
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
    private static function databaseStep(array $raw, array &$context): void
    {
        // The PHP client names no statement, so a step that a named statement fails holds this outcome here (CFG-28, FCV-4).
        if (isset($raw['expect_unnamed'])) {
            $raw['expect'] = $raw['expect_unnamed'];
        }
        $step = new RecipeStep($raw);
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
            if (isset($expected['message_suffix'])) {
                Assert::assertStringEndsWith($expected['message_suffix'], $error->getMessage(), 'the error message');
            }
            if (isset($expected['message'])) {
                Assert::assertSame($expected['message'], $error->getMessage(), 'the error message');
            }
            if (isset($expected['cause'])) {
                Assert::assertSame($expected['cause'], $error->getPrevious()?->getMessage(), 'the error cause');
            }
            if (isset($expected['message_holds'])) {
                Assert::assertStringContainsString($expected['message_holds'], $error->getMessage(), 'the error message');
            }
            if (($expected['keeps_callback'] ?? false) === true) {
                Assert::assertInstanceOf(CallbackFailed::class, $error->getPrevious(), 'the error of the callback');
            }
            if (isset($expected['rollback'])) {
                Assert::assertSame($expected['rollback'], $error->rollback?->code_, 'the rollback error');
                Assert::assertStringContainsString($error->rollback->getMessage(), $error->getMessage(), 'the error message');
            }
            if (($expected['driver_cause'] ?? false) === true) {
                Assert::assertNotNull($error->getPrevious(), 'the driver cause of the error');
            }
            $step->checkOutcome($expected, 'error', 'message_suffix', 'message', 'cause', 'message_holds', 'rollback', 'driver_cause');
            return;
        } catch (CallbackFailed $failure) {
            // The step ends with its failed callback, so an enclosing transaction goes on (FCV-4).
            if (!is_array($expected) || ($expected['error'] ?? null) !== 'CALLBACK') {
                throw $failure;
            }
            $step->checkOutcome($expected, 'error');
            return;
        }
        if (isset($step['as'])) {
            $context['bound'][$step['as']] = array_key_exists('bind', $actual)
                ? $actual['bind']
                : ($actual['value'] ?? null);
            $context['fields'][$step['as']] = $actual;
        }
        if ($expected === null) {
            $step->check();
            return;
        }
        if (array_key_exists('error', $expected)) {
            Assert::fail("expected {$expected['error']}, and the op succeeded");
        }
        $compared = [];
        foreach (array_keys($expected) as $key) {
            $compared[$key] = $actual[$key] ?? null;
        }
        if (array_key_exists('json', $expected)) {
            // A JSON object has no member order, and a PHP array compares its keys in order.
            $expected['json'] = self::sortedMembers($expected['json']);
            $compared['json'] = self::sortedMembers($compared['json']);
        }
        $want = self::normalizedNull($expected);
        $got = self::normalizedNull($compared);
        if ($want !== $got) {
            Assert::fail(
                'want ' . json_encode($want, JSON_UNESCAPED_UNICODE)
                    . ', got ' . json_encode($got, JSON_UNESCAPED_UNICODE)
            );
        }
        $step->check();
    }

    /** The value with the members of every object sorted by name and each integral number as an integer. */
    private static function sortedMembers(mixed $value): mixed
    {
        if (is_float($value) && floor($value) === $value && abs($value) < 2 ** 53) {
            // JSON has one number form, and getSum returns a binary64 (DSL-66) where the recipe writes 17540.
            return (int) $value;
        }
        if (!is_array($value)) {
            return $value;
        }
        $out = array_map(self::sortedMembers(...), $value);
        if (!array_is_list($out)) {
            ksort($out);
        }
        return $out;
    }

    /** Maps the op of a step to its one call of the public API and returns the fields that its expect compares. */
    private static function databaseOp(RecipeStep $s, array &$context): array
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
            case 'schema.empty':
                return ['value' => ['bool' => $context['db']->utils()->schema()->empty()]];
            case 'schema.exists':
                return ['value' => ['bool' => $context['db']->utils()->schema()->exists(
                    self::inspectedSchema($s['schema'], $context)
                )]];
            case 'schema.installed':
                return ['value' => ['bool' => $context['db']->utils()->schema()->installed(
                    self::inspectedSchema($s['schema'], $context),
                    $s['table']
                )]];
            case 'schema.connect':
                Orm::connectSchema(
                    $context['dsn'],
                    self::schemaArgument($s['schema'], $context),
                    new Config(),
                )->close();
                return ['value' => ['bool' => true]];
            case 'schema.add_tables_and_columns':
                try {
                    $added = $context['db']->utils()->schema()->addTablesAndColumns(
                        self::schemaArgument($s['schema'], $context),
                    );
                } catch (\Throwable $error) {
                    Assert::assertStringContainsString($s['message_contains'] ?? '', $error->getMessage());
                    throw $error;
                }
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
                // The options of the transaction (INT-46): a nested transaction that names one is refused with CONFIG. An
                // absent retry passes 0 unless default_retry leaves it out (INT-43).
                $options = [
                    'isolation' => $s['isolation'] ?? '',
                    'readOnly' => ($s['read_only'] ?? false) === true,
                    'audit' => isset($s['audit']) ? self::mapAssignments($s['audit'], $context) : null,
                ];
                if (($s['default_retry'] ?? false) !== true) {
                    $options['retry'] = $s['retry'] ?? 0;
                }
                if (isset($s['timeout_ms'])) {
                    $options['timeoutMs'] = $s['timeout_ms'];
                }
                $attempts = 0;
                try {
                    self::connectionOf($s, $context)->transaction(
                        function () use ($s, &$context, &$attempts): void {
                            $attempts++;
                            foreach ($s['steps'] as $nested) {
                                self::databaseStep($nested, $context);
                            }
                            if ($s['fail'] ?? false) {
                                throw new CallbackFailed('the transaction callback failed');
                            }
                            if ($attempts <= ($s['conflicts'] ?? 0)) {
                                throw Orm::transactionConflict('the recipe conflict');
                            }
                        },
                        ...$options,
                    );
                } finally {
                    $context['attempts'] = $attempts;
                }
                return ['value' => ['bool' => true]];
            case 'transaction.attempts':
                return ['value' => ['int' => (string) $context['attempts']]];
            case 'transaction.deadlock':
                return self::transactionDeadlock($s, $context);
            case 'events.server_transactions':
                return self::serverTransactions($s, $context);
            case 'catalog.connect':
                return self::connectOp($s, $context);
            case 'catalog.close':
                $catalog->close();
                return [];
            case 'catalog.reconnect':
                $reconnectDsn = isset($s['user_from_database'])
                    ? self::userFromDatabaseDsn($context['dsn'], $s['user_from_database'])
                    : $context['dsn'];
                if (isset($s['refused_message'])) {
                    try {
                        Catalog::connect($reconnectDsn);
                    } catch (OrmException $error) {
                        Assert::assertStringContainsString($s['refused_message'], strtolower($error->getMessage()));
                        Assert::assertSame($s['refused_code'], $error->code_, 'the code of the refused connection');
                        return [];
                    }
                    Assert::fail('the server accepted the connection that the step expects it to refuse');
                }
                $reconnected = Catalog::connect($reconnectDsn);
                $context['namespace'] = $reconnected->currentNamespace();
                $context['catalog'] = $reconnected;
                return [];
            case 'catalog.current_namespace':
                return ['value' => ['text' => $catalog->currentNamespace()]];
            case 'catalog.revision':
                $snapshot = self::stepArgument($s['snapshot'], $context);
                return ['value' => ['text' => $snapshot->revision()]];
            case 'catalog.revision_compare':
                $revision = self::stepArgument($s['snapshot'], $context)->revision();
                return ['json' => [
                    'length' => strlen($revision),
                    'differs' => $revision !== self::stepArgument($s['other'], $context)->revision(),
                ]];
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
                    array_map(self::nativeValue(...), $s['binds'] ?? []),
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
                    if (isset($s['page_with']['column_name'])) {
                        $columns = $page->metadata->columns;
                        $first = $columns[0];
                        $columns[0] = new CatalogColumn(
                            $s['page_with']['column_name'],
                            $first->nativeType,
                            $first->nullable,
                            $first->generated,
                            $first->automaticKey,
                            $first->defaultExpression,
                            $first->expressionDefault,
                            $first->checkPrecision,
                        );
                        $page = new CatalogTablePage(
                            new CatalogTableMetadata(
                                $page->metadata->table,
                                $page->metadata->kind,
                                $columns,
                                $page->metadata->primaryKey,
                                $page->metadata->reliableRowIdentity,
                            ),
                            $page->result,
                            $page->limit,
                            $page->offset,
                            $page->orderBy,
                            $page->hasMore,
                        );
                    }
                    $with = $s['page_with'];
                    if (isset($with['primary_key'])) {
                        $page = new CatalogTablePage(
                            new CatalogTableMetadata(
                                $page->metadata->table,
                                $page->metadata->kind,
                                $page->metadata->columns,
                                $with['primary_key'],
                                $page->metadata->reliableRowIdentity,
                            ),
                            $page->result,
                            $page->limit,
                            $page->offset,
                            $page->orderBy,
                            $page->hasMore,
                        );
                    }
                    if (isset($with['limit']) || isset($with['result_column_name']) || isset($with['drop_last_cell']) || isset($with['fill_last_cell'])) {
                        $columns = $page->result->columns;
                        $rows = $page->result->rows;
                        if (isset($with['result_column_name'])) {
                            $columns[0] = $with['result_column_name'];
                        }
                        if (isset($with['drop_last_cell'])) {
                            array_pop($rows[0]);
                        }
                        if (isset($with['fill_last_cell'])) {
                            $rows[0][array_key_last($rows[0])] = str_repeat($with['fill_last_cell']['fill'], $with['fill_last_cell']['count']);
                        }
                        $page = new CatalogTablePage(
                            $page->metadata,
                            new CatalogResult($columns, $rows),
                            $with['limit'] ?? $page->limit,
                            $page->offset,
                            $page->orderBy,
                            $page->hasMore,
                        );
                    }
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
            case 'fault.next_rollback':
                require_once dirname(__DIR__) . '/testing/Faults.php';
                \Polyspec\Orm\Testing\Faults::failNextRollback(self::connectionOf($s, $context));
                return [];
            case 'events.fail_subscriber':
                $kind = $s['kind'];
                $refusal = $s['refusal'] ?? null;
                $stop = self::connectionOf($s, $context)->subscribe(
                    static function (StatementEvent $e) use ($kind, $refusal): void {
                        if ($e->kind === $kind) {
                            throw $refusal === null
                                ? new RuntimeException('subscriber refused the event')
                                : new OrmException($refusal['code'], $refusal['message']);
                        }
                    }
                );
                return ['bind' => new RecipeSubscription($stop, null)];
            case 'events.stop_failing':
            case 'events.unsubscribe':
                (self::boundValue($s['ref'], $context)->stop)();
                return [];
            case 'utils.run':
                // One Utils::run whose function runs the statements in order on its frame (INT-150); the value is the rows of the last.
                $rows = self::connectionOf($s, $context)->utils()->run(
                    static function (TxFrame $frame) use ($s, $context): array {
                        $last = [];
                        foreach ($s['statements'] as $statement) {
                            $text = is_string($statement['sql']) ? $statement['sql'] : $statement['sql'][$context['database']];
                            $last = $frame->run(
                                $statement['kind'],
                                $statement['tables'],
                                $text,
                                array_map(self::toValue(...), $statement['params'] ?? []),
                            );
                        }
                        if (isset($s['conflict'])) {
                            throw Orm::transactionConflict($s['conflict']);
                        }
                        return $last;
                    }
                );
                return ['value' => ['array' => array_map(static fn (array $row): array => ['array' => array_map(
                    static fn (mixed $cell): array => self::plainWrapper($cell, null),
                    array_values($row),
                )], $rows)]];
            case 'events.captured':
                $subscription = self::boundValue($s['ref'], $context);
                if ($subscription->recording === null) {
                    throw new RuntimeException('the subscription of ref is not a recording subscriber');
                }
                if ($subscription->recording->negative !== []) {
                    throw new RuntimeException('an event has a negative elapsed time');
                }
                $events = self::capturedEvents($subscription->recording->events, $s['compare'] ?? '');
                // A mask replaces a bind that no recipe can fix (FCV-4 events.captured).
                foreach ($s['masks'][$context['database']] ?? [] as $mask) {
                    if (!isset($events[$mask['event']]['object'][1][1]['array'][$mask['bind']])) {
                        Assert::fail('mask ' . json_encode($mask) . ' names no captured bind');
                    }
                    $events[$mask['event']]['object'][1][1]['array'][$mask['bind']] = ['text' => $mask['value']];
                }
                if (($s['compare'] ?? '') === 'statements') {
                    // The bound clock of a soft delete differs on each run, so the sql and the kind are compared.
                    $events = array_map(static fn (array $event): array => ['object' => array_values(array_filter(
                        $event['object'],
                        static fn (array $member): bool => $member[0] === 'sql' || $member[0] === 'kind',
                    ))], $events);
                }
                if (($s['compare'] ?? '') === 'shape') {
                    // The kind and the tables are the shape of a plan, whatever its text and binds on the database.
                    $events = array_map(static fn (array $event): array => ['object' => array_values(array_filter(
                        $event['object'],
                        static fn (array $member): bool => $member[0] === 'kind' || $member[0] === 'tables',
                    ))], $events);
                }
                return ['value' => ['array' => $events]];
            case 'hook.install':
                // Binds the connection of the step to its connection with the hook of the step (FCV-4); a later
                // hook.install on the same connection replaces the hook.
                $base = $context['hookBases'][$s['connection']] ?? self::connectionOf($s, $context);
                $context['records'] = [];
                $hooked = $base->withRequestHook(self::hookFor($s['hooks'], $context));
                // With as, the hooked handle takes that name and the connection keeps its name, unhooked (INT-78).
                if (isset($s['as'])) {
                    $context['hookBases'][$s['as']] = $base;
                    return ['bind' => $hooked];
                }
                $context['hookBases'][$s['connection']] = $base;
                $context['bound'][$s['connection']] = $hooked;
                return [];
            case 'hook.records':
                $counts = [];
                $list = [];
                foreach ($context['records'] as $record) {
                    $counts[$record['entity']] = ($counts[$record['entity']] ?? 0) + 1;
                    $list[] = ['object' => [
                        ['kind', ['text' => $record['kind']]],
                        ['entity', ['text' => $record['entity']]],
                        ...(isset($record['param']) ? [['param', $record['param']]] : []),
                    ]];
                }
                return ['value' => ['array' => $list], 'counts' => $counts];
            case 'utils.aes_status':
                $keyring = self::aesKeyring($s['keyring']);
                $aes = self::connectionOf($s, $context)->utils()->aes();
                $model = self::tableModel($s['model'], self::connectionOf($s, $context), $context);
                $status = $aes->status($model, $keyring);
                $versions = $status->versions;
                ksort($versions);
                $list = [];
                foreach ($versions as $version => $count) {
                    $list[] = [(string) $version, ['int' => (string) $count]];
                }
                return ['value' => ['object' => [
                    ['current', ['int' => (string) $status->current]],
                    ['total', ['int' => (string) $status->total]],
                    ['pending', ['int' => (string) $status->pending]],
                    ['versions', ['object' => $list]],
                ]]];
            case 'utils.aes_rotate':
                $keyring = self::aesKeyring($s['keyring']);
                $aes = self::connectionOf($s, $context)->utils()->aes();
                $model = self::tableModel($s['model'], self::connectionOf($s, $context), $context);
                $rotated = $aes->rotate($model, $keyring);
                return ['value' => ['int' => (string) $rotated]];
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
            case 'session.end':
                // Through the server DSN, not a pooler, which may handle KILL on its own (CFG-15).
                $variable = 'ORM_TEST_' . strtoupper($context['database']) . '_SERVER_DSN';
                $server = (string) getenv($variable);
                Assert::assertNotSame('', $server, "$variable is required; database tests never skip");
                $pdo = case_admin(
                    case_dsn_with_database($server, ltrim((string) parse_url($context['dsn'], PHP_URL_PATH), '/'))
                );
                $postgres = $context['database'] === 'postgres';
                $id = $pdo->query($postgres
                    ? "SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND c.relname = '{$s['table']}' AND l.pid <> pg_backend_pid() LIMIT 1"
                    : "SELECT t.PROCESSLIST_ID FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = '{$s['table']}' LIMIT 1")->fetchColumn();
                Assert::assertNotFalse($id, "the transaction session holds a lock on {$s['table']}");
                $pdo->exec($postgres ? 'SELECT pg_terminate_backend(' . (int) $id . ', 5000)' : 'KILL ' . (int) $id);
                return [];
            case 'dbspec.introspect':
                return RecipeIntrospect::step($s, $context);
            case 'dbspec.ddl_behavior':
                // On one native connection of the case database, the connection rules, the statements of the case for the
                // database, then its behavior steps. A step with dialects runs only on those; a step with fails must fail;
                // a query compares its first value, as text, with want, and a NULL or absent value fails it (DIA-113).
                $vectors = json_decode((string) file_get_contents($context['dir'] . '/' . $s['vectors']), true, 512, JSON_THROW_ON_ERROR);
                $matching = array_values(array_filter($vectors['cases'], static fn(array $c): bool => $c['id'] === $s['case']));
                if ($matching === []) {
                    throw new \RuntimeException("the vectors have no case {$s['case']}");
                }
                $database = $context['database'];
                $pdo = case_admin($context['dsn']);
                $rule = ['mysql' => "SET time_zone = '+00:00'", 'postgres' => "SET TimeZone = 'UTC'", 'sqlite' => 'PRAGMA foreign_keys = ON'][$database];
                foreach ([$rule, ...$matching[0]['statements'][$database]] as $statement) {
                    $pdo->exec($statement);
                }
                foreach ($matching[0]['behavior'] as $step) {
                    if (isset($step['dialects']) && !in_array($database, $step['dialects'], true)) {
                        continue;
                    }
                    if (array_key_exists('sql', $step)) {
                        if (($step['fails'] ?? false) !== true) {
                            $pdo->exec($step['sql']);
                            continue;
                        }
                        try {
                            $pdo->exec($step['sql']);
                        } catch (\PDOException) {
                            continue;
                        }
                        throw new \RuntimeException("{$step['sql']} must fail");
                    }
                    $got = dbspec_value($pdo, $step['query']);
                    if ($got !== $step['want']) {
                        throw new \RuntimeException("{$step['query']}: got $got, want {$step['want']}");
                    }
                }
                return [];
            case 'sql.hold_connection':
                $context['held'] = case_admin(self::userFromDatabaseDsn($context['dsn'], $s['user_from_database']));
                return [];
            case 'sql.release_connection':
                unset($context['held']);
                return [];
            case 'sql.exec':
                // An object form runs only on the databases whose key it holds (FCV-4): an absent key runs nothing.
                $statement = is_string($s['sql']) ? $s['sql'] : ($s['sql'][$context['database']] ?? null);
                if ($statement !== null) {
                    // The native driver of PHP is PDO, opened on the case database.
                    $pdo = case_admin($context['dsn']);
                    if (($s['refused'] ?? false) !== true) {
                        $pdo->exec($statement);
                        return [];
                    }
                    // A native SQLite connection starts with foreign keys off; the runners of the other clients open it with them on.
                    if ($context['database'] === 'sqlite') {
                        $pdo->exec('PRAGMA foreign_keys = ON');
                    }
                    try {
                        $pdo->exec($statement);
                    } catch (\PDOException $error) {
                        // Any driver error of the refused statement passes, unless the step names its text.
                        if (isset($s['refused_message'])) {
                            Assert::assertStringContainsString($s['refused_message'], strtolower($error->getMessage()));
                        }
                        return [];
                    }
                    throw new \RuntimeException("the database accepted the statement that the step expects it to refuse: $statement");
                }
                return [];
            case 'query.search':
                return self::querySearch($s, $context);
            case 'query.search_chain':
                return self::querySearchChain($s, $context);
            // dsn.connect (FCV-4): the DSN of the case database for "case", otherwise the text of the step.
            case 'dsn.connect':
                $dsn = $s['dsn'];
                if ($dsn === 'case') {
                    $dsn = $context['dsn'];
                    if (isset($s['query'])) {
                        $dsn .= (str_contains($dsn, '?') ? '&' : '?') . $s['query'];
                    }
                }
                if (str_starts_with($dsn, 'env:')) {
                    $name = substr($dsn, 4);
                    $dsn = (string) getenv($name);
                    Assert::assertNotSame('', $dsn, "dsn.connect: $name is unset; run make orm-test-servers");
                }
                return ['value' => ['text' => self::connectDriver($dsn, $s['config'] ?? [])]];
            case 'dsn.sqlite_file':
                return ['value' => ['text' => self::sqliteFileNames($s['name'], $s['query'])]];
        }
        if (in_array($s['op'], self::MODEL_OPS, true)) {
            return self::modelOp($s, $context);
        }
        if (in_array($s['op'], RecipeApply::OPS, true)) {
            return RecipeApply::op($s, $context, static function (array $nested) use (&$context): void {
                // A nested step with only runs on the databases it names, as a step of the case does.
                if (!isset($nested['only']) || in_array($context['database'], $nested['only'], true)) {
                    self::databaseStep($nested, $context);
                }
            });
        }
        Assert::fail("OP_UNKNOWN {$s['op']}");
    }

    /**
     * Connects the DSN of the op. An unsupported URL or an absent SQLite file fails with CONFIG, and the expect may
     * name file_created: the file is created by no failing connection.
     */
    private static function connectOp(RecipeStep $s, array &$context): array
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

    /** A new model of the table, connected to db, whose entity is the one that the fixture gives the table. */
    private static function newRow(string $table, Db $db, array $context): Model
    {
        $class = self::modelClass($context, $table);
        return (new $class())->connect($db);
    }

    /** Writes each column of the assignments on the row by its generated setter, and returns the row. */
    private static function setColumns(Model $row, array $assignments): Model
    {
        foreach ($assignments as $column => $value) {
            $set = 'set' . self::pascal((string) $column);
            $row->$set($value);
        }
        return $row;
    }

    /** The request ops of FCV-4 (T334-3-4): the same semantics as the Go core (packages/go/internal/recipe/requests.go). */
    private const READS = ['one', 'all', 'count', 'group_count', 'sum', 'avg', 'paginate'];

    /** The class that the PHP generator gives a table of the fixture (FCV-4): a relation read needs one class per table. */
    private static function modelClass(array $context, string $table): string
    {
        $class = self::modelNamespace($context['fixture']) . '\\' . self::pascal($table);
        if (!class_exists($class)) {
            Assert::fail("the schema has no table $table");
        }
        return $class;
    }

    /** The namespace of the models generated from a fixture set, generated once per process. */
    private static function modelNamespace(string $setPath): string
    {
        $key = md5($setPath);
        if (isset(self::$modelNamespaces[$key])) {
            return self::$modelNamespaces[$key];
        }
        $set = json_decode(file_get_contents($setPath), true, 512, JSON_THROW_ON_ERROR);
        $documents = [];
        foreach ($set['documents'] as $name) {
            $documents[$name] = (string) file_get_contents(dirname($setPath) . '/' . $name);
        }
        $external = [];
        foreach ($set['external'] ?? [] as $name) {
            $external[$name] = (string) file_get_contents(dirname($setPath) . '/' . $name);
        }
        $work = sys_get_temp_dir() . '/orm-php-recipe-models-' . getmypid() . '-' . $key;
        is_dir($work) || mkdir($work, 0o700, true);
        register_shutdown_function(static function () use ($work): void {
            exec('rm -rf ' . escapeshellarg($work));
        });
        $namespace = 'Polyspec\\Orm\\Tests\\RecipeModels\\F' . substr($key, 0, 12);
        generateModels($documents, "$work/source", "$work/models", $namespace, $external);
        // A set that the process already loaded keeps its classes: the registry holds one class per entity of a manifest.
        $declarations = (string) file_get_contents("$work/models/schema_declarations.php");
        if (preg_match("/^const MANIFEST_HASH = '([^']+)';$/m", $declarations, $match) !== 1) {
            Assert::fail("the generated models of $setPath declare no manifest hash");
        }
        if (Registry::loaded($match[1])) {
            $loaded = (new \ReflectionClass(array_values(Registry::models($match[1]))[0]))->getNamespaceName();
            return self::$modelNamespaces[$key] = $loaded;
        }
        requireGeneratedClasses("$work/models");
        require_once "$work/models/bootstrap.php";
        return self::$modelNamespaces[$key] = $namespace;
    }

    /** The PascalCase name of a table or column: hook_item is HookItem. */
    private static function pascal(string $name): string
    {
        return implode('', array_map(ucfirst(...), explode('_', $name)));
    }

    /** The cells of the columns of a loaded model, each with the recipe wrapper of its value (FCV-4). */
    private static function project(Model $model, array $columns): array
    {
        $values = $model->toArray();
        return array_map(static function (string $column) use ($values): array {
            if (!array_key_exists($column, $values)) {
                Assert::fail("the row has no column $column");
            }
            return self::cellOf($values[$column]);
        }, $columns);
    }

    /** The recipe wrapper of a value read by a request op. */
    private static function cellOf(mixed $value): array
    {
        if ($value === null) {
            return ['null' => true];
        }
        if (is_string($value)) {
            return ['text' => $value];
        }
        if (is_int($value)) {
            return ['int' => (string) $value];
        }
        Assert::fail('a read value of type ' . get_debug_type($value) . ' has no recipe wrapper in a request op');
    }

    /**
     * The hook of the default connection: runs the actions in order on each request whose kind they name (FCV-4). The
     * records of the record actions are kept in the request state of the case.
     *
     * @param list<array<string, mixed>> $hooks
     */
    private static function hookFor(array $hooks, array &$context): \Closure
    {
        $actions = array_map(static fn (array $a): array => [
            'action' => $a['action'],
            'kinds' => $a['kinds'],
            'column' => $a['column'] ?? '',
            'value' => array_key_exists('value', $a) ? self::nativeValue($a['value']) : null,
            'nested' => ($a['nested'] ?? false) === true,
            'code' => $a['error'] ?? '',
        ], $hooks);
        return static function (Request $r) use (&$context, $actions): void {
            foreach ($actions as $a) {
                if (!self::kindMatches($a['kinds'], $r->ir['kind'])) {
                    continue;
                }
                switch ($a['action']) {
                    case 'scope':
                        if ($a['nested']) {
                            self::scopeTree($r->ir, $a['column'], $a['value'], $r);
                        } else {
                            self::andWhere($r->ir, self::equalPred($r, $a['column'], $a['value']));
                        }
                        break;
                    case 'assign':
                        $r->ir['set'][] = ['column' => $a['column'], 'p' => $r->param($a['value'])];
                        foreach (array_keys($r->ir['rows'] ?? []) as $i) {
                            $r->ir['rows'][$i][] = $r->param($a['value']);
                        }
                        break;
                    case 'assign_first':
                        array_unshift($r->ir['set'], ['column' => $a['column'], 'p' => $r->param($a['value'])]);
                        break;
                    case 'rewrite':
                        foreach (array_keys($r->ir['set'] ?? []) as $i) {
                            if ($r->ir['set'][$i]['column'] === $a['column']) {
                                $r->ir['set'][$i]['p'] = $r->param($a['value']);
                            }
                        }
                        break;
                    case 'invalid_param':
                        self::andWhere($r->ir, ['column' => $a['column'], 'op' => 'eq', 'p' => count($r->params) + 5]);
                        break;
                    case 'record':
                        $context['records'][] = [
                            'kind' => $r->ir['kind'],
                            'entity' => $r->ir['entity'] ?? '',
                        ];
                        break;
                    case 'record_param':
                        foreach ($r->ir['set'] ?? [] as $assignment) {
                            if ($assignment['column'] === $a['column']) {
                                $context['records'][] = [
                                    'kind' => $r->ir['kind'],
                                    'entity' => $r->ir['entity'] ?? '',
                                    'param' => self::plainWrapper($r->params[$assignment['p']], null),
                                ];
                            }
                        }
                        break;
                    case 'fail':
                        throw new OrmException($a['code'], "request hook refused {$r->ir['kind']}");
                    default:
                        Assert::fail("hook action {$a['action']} is unknown");
                }
            }
        };
    }

    /** Whether a kind list (or one of the names reads, reads+restore, every) holds kind. */
    private static function kindMatches(mixed $kinds, string $kind): bool
    {
        if (is_string($kinds)) {
            return match ($kinds) {
                'every' => true,
                'reads' => in_array($kind, self::READS, true),
                'reads+restore' => in_array($kind, self::READS, true) || $kind === 'restore',
                default => false,
            };
        }
        return is_array($kinds) && in_array($kind, $kinds, true);
    }

    private static function equalPred(Request $r, string $column, mixed $value): array
    {
        return ['column' => $column, 'op' => 'eq', 'p' => $r->param($value)];
    }

    /** Adds pred to the where of query with and; an existing where is wrapped in one group item. */
    private static function andWhere(array &$query, array $pred): void
    {
        if (!isset($query['where']) || $query['where']['items'] === []) {
            $query['where'] = ['items' => [['pred' => $pred]]];
            return;
        }
        $query['where'] = ['items' => [['group' => $query['where']], ['pred' => ['conn' => 'and'] + $pred]]];
    }

    /** Adds column = value to the where of query and of each of its relation queries, nested ones included. */
    private static function scopeTree(array &$query, string $column, mixed $value, Request $r): void
    {
        self::andWhere($query, self::equalPred($r, $column, $value));
        foreach (array_keys($query['relations'] ?? []) as $i) {
            self::scopeTree($query['relations'][$i]['query'], $column, $value, $r);
        }
    }

    /** The keys of a recipe keyring (FCV-4 aesKeyring) as int versions. */
    private static function aesKeys(array $raw): array
    {
        $keys = [];
        foreach ($raw['versions'] as $version => $key) {
            $keys[(int) $version] = $key;
        }
        return $keys;
    }

    /** The keyring of a recipe, by the public constructor: a refused keyring fails the step with its code. */
    private static function aesKeyring(array $raw): AesKeyring
    {
        return new AesKeyring(self::aesKeys($raw), $raw['current']);
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

    /** A field that holds SQL or a database-decided value: the string itself, or the entry of the database. */
    private static function sqlField(string|array $field, array $context): string
    {
        return is_string($field) ? $field : $field[$context['database']];
    }

    /**
     * query.search (FCV-4, PRT-75): the count of a fulltext_boolean chain over the columns, through the fulltext
     * chain of the model. The request is compiled on the dialect of the case connection (DIA-187 refuses SQLite), and
     * its bind values are those of the statement: the DIA-6 transform on MySQL, which refuses a blank text with
     * IR_INVALID, and the text as it is on PostgreSQL.
     */
    private static function querySearch(RecipeStep $s, array $context): array
    {
        if ($s['model'] !== 'Author') {
            Assert::fail("model {$s['model']} has no query.search entry");
        }
        $db = self::connectionOf($s, $context);
        $chain = 'fulltextBoolean'
            . implode('With', array_map(static fn(string $c): string => ucfirst($c), $s['columns']));
        $author = (new \Polyspec\Orm\Tests\Model\Author())->connect($db)->{$chain}($s['text']);
        $request = (new \ReflectionMethod(Model::class, 'build'))->invoke($author, 'count', $db);
        $statement = $db->statement($request);
        return self::statementFields($statement);
    }

    /** query.search_chain (FCV-4): the statement of the generated fulltext method of the mode, through getQuery. */
    private static function querySearchChain(RecipeStep $s, array $context): array
    {
        if ($s['model'] !== 'Author') {
            Assert::fail("model {$s['model']} has no query.search_chain entry");
        }
        $author = (new \Polyspec\Orm\Tests\Model\Author())->connect(self::connectionOf($s, $context));
        $chain = match ($s['mode']) {
            'fulltext_boolean' => $author->fulltextBooleanNameWithDescription($s['text']),
            'fulltext' => $author->fulltextNameWithDescription($s['text']),
        };
        $statement = $chain->getQuery();
        return self::statementFields($statement);
    }

    /** The fields of query.search and query.search_chain: the text of a statement and its bind values. */
    private static function statementFields(array $statement): array
    {
        return [
            'sql' => $statement['sql'],
            'params' => array_map(static fn(mixed $v): array => ['text' => $v], $statement['binds']),
        ];
    }

    /** The connection that an op names, or the case connection when the op names none (FCV-4). */
    private static function connectionOf(RecipeStep $s, array $context): Db
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

    /** The one recipe fixture that generates models. A model op of any other fixture names a model of a table of its own (FCV-4). */
    private const GENERATED_FIXTURE = 'contracts/fixtures/bench/dbspec-set.json';

    /** The chain name of a predicate operator of FCV-4, written before its column. */
    private const OPERATOR_NAMES = [
        'eq' => '', 'ne' => 'Ne', 'gt' => 'Gt', 'ge' => 'Ge', 'lt' => 'Lt', 'le' => 'Le', 'in' => '', 'not_in' => 'Ne',
        'between' => 'Between', 'like' => 'Lk', 'binary_like' => 'Lb', 'is_null' => '', 'not_null' => 'Ne',
    ];

    /** A new model of a model name of the fixture, on no connection (FCV-4). */
    private static function chainModel(string $model, array $context): Model
    {
        $class = self::modelClass($context, Chain::snake($model));
        return new $class();
    }

    /** A model of a model name, connected to db. */
    private static function tableModel(string $model, Db $db, array $context): Model
    {
        return self::chainModel($model, $context)->connect($db);
    }

    /**
     * events.server_transactions (FCV-4, INT-149): the nested steps run twice, and the difference of the probe counts the
     * server transactions of each run. The probe runs in a frame of its own, so its cost is measured first.
     *
     * @param array<string, mixed> $s
     * @param array<string, mixed> $context
     * @return array<string, mixed>
     */
    private static function serverTransactions(RecipeStep $s, array &$context): array
    {
        $db = self::connectionOf($s, $context);
        $frameRows = static fn (string $text): array => $db->utils()->run(
            static fn (TxFrame $frame): array => $frame->run('utility', [], $text, [])
        );
        $probe = static fn (): int => (int) array_values($frameRows($s['probe'])[0])[0];
        $client = getenv('ORM_PHP_MODE') === 'extension' ? 'php-extension' : 'php';
        $fields = [];
        if ($context['database'] === 'postgres') {
            [$setting, $source] = array_values(
                $frameRows("SELECT setting, source FROM pg_settings WHERE name = 'TimeZone'")[0]
            );
            // Through a pooler the pooler applies the startup parameters with SET, so the source says nothing about the client.
            $pooled = getenv('ORM_TEST_POSTGRES_DSN') !== getenv('ORM_TEST_POSTGRES_SERVER_DSN');
            $fields['time_zone'] = $setting;
            $fields['time_zone_from_startup'] = $pooled || $source === 'client';
        }
        $first = $probe();
        $before = $probe();
        $cost = $before - $first;
        foreach (['first', 'second'] as $run) {
            $texts = [];
            $stop = $db->subscribe(static function (StatementEvent $e) use (&$texts): void {
                $texts[] = $e->sql;
            });
            try {
                foreach ($s['steps'] as $nested) {
                    self::databaseStep($nested, $context);
                }
            } finally {
                $stop();
            }
            $after = $probe();
            $spent = $after - $before - $cost;
            $before = $after;
            $distinct = count(array_unique($texts));
            $prepares = $run === 'first' && in_array($client, $s['first_run_prepare_clients'], true);
            $fields[$run . '_excess'] = $spent - count($texts) - ($prepares ? $distinct : 0);
            $fields['events'] = count($texts);
            $fields['texts'] = $distinct;
        }
        $fields['probe_cost'] = $cost;
        return $fields;
    }

    /**
     * Two flows write two rows in opposite order (PLN-24), each a child process, as the request of PHP is one flow: each
     * holds its first row until the other holds its own, so the database ends one flow with its deadlock error, the client
     * retries it, and both commit.
     */
    private static function transactionDeadlock(RecipeStep $s, array $context): array
    {
        $key = static fn(array $row): array => [
            (string) self::chainValue($row['tenant_id'], $context),
            (string) self::chainValue($row['account_id'], $context),
        ];
        $extension = getenv('POLYSPEC_ORM_EXTENSION');
        $php = is_string($extension) && $extension !== '' && extension_loaded('polyspec_orm')
            ? [PHP_BINARY, '-d', 'extension=' . $extension]
            : [PHP_BINARY];
        $children = [];
        foreach ([0, 1] as $index) {
            $process = proc_open(
                [
                    ...$php,
                    __DIR__ . '/transaction_deadlock_child.php',
                    $context['dsn'],
                    ...$key($s['rows'][$index]),
                    ...$key($s['rows'][1 - $index]),
                    "flow-$index",
                ],
                [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                $pipes,
            );
            Assert::assertIsResource($process, 'the flow process starts');
            $children[] = [$process, $pipes];
        }
        // The schema of the case reaches each flow on its first line of input.
        $schema = $context['schema'];
        $line = json_encode([$schema->manifestText, $schema->manifestHash, $schema->externalText], JSON_THROW_ON_ERROR) . "\n";
        foreach ($children as [, $pipes]) {
            fwrite($pipes[0], $line);
        }
        foreach ($children as [, $pipes]) {
            Assert::assertSame('locked', trim((string) fgets($pipes[1])), 'the flow holds its first row');
        }
        foreach ($children as [, $pipes]) {
            fwrite($pipes[0], "go\n");
            fclose($pipes[0]);
        }
        $attempts = 0;
        $deadlocks = 0;
        foreach ($children as [$process, $pipes]) {
            $output = trim((string) stream_get_contents($pipes[1]));
            $errors = (string) stream_get_contents($pipes[2]);
            $status = proc_close($process);
            Assert::assertSame(0, $status, "the flow process: $output $errors");
            [, $runs, $deadlocked] = explode(' ', $output);
            $attempts += (int) $runs;
            $deadlocks += (int) $deadlocked;
        }
        $db = self::connectionOf(new RecipeStep(['connection' => $s['connections'][0]]), $context);
        $names = [];
        foreach ($s['rows'] as $row) {
            $read = (new \Polyspec\Orm\Tests\Model\CompositeAccount())($db)
                ->getByTenantIdAndAccountId(...array_map(intval(...), $key($row)));
            $names[] = $read->{'get' . self::pascal($s['column'])}();
        }
        return [
            'attempts' => $attempts,
            'deadlocks' => $deadlocks,
            'same_flow' => $names[0] === $names[1] && in_array($names[0], ['flow-0', 'flow-1'], true),
        ];
    }

    /** The native argument of a value wrapper: null, the list of an array, or one value. */
    private static function chainValue(array $raw, array $context): mixed
    {
        return self::nativeValue(self::databaseValue(self::stepArgument($raw, $context), $context));
    }

    /** The public function of a function call (F5). */
    private static function chainFunc(array $call): Func
    {
        $name = lcfirst(self::pascal($call['fn']));
        if (!method_exists(Orm::class, $name)) {
            Assert::fail("function {$call['fn']} has no recipe entry");
        }
        $numbers = [];
        foreach ($call['args'] ?? [] as $arg) {
            if (isset($arg['int'])) {
                $numbers[] = (int) $arg['int'];
            }
        }
        return $numbers === [] ? Orm::$name() : Orm::$name($numbers[count($numbers) - 1]);
    }

    /** The column of a function call on a column. */
    private static function fnColumn(array $call): string
    {
        foreach ($call['args'] ?? [] as $arg) {
            if (isset($arg['column'])) {
                return $arg['column'];
            }
        }
        Assert::fail("function {$call['fn']} names no column");
    }

    /** Calls the chain method of a condition: its connector, then its key. */
    private static function chainCall(Model $model, string $conn, string $key, array $args): void
    {
        $model->{$conn === '' ? lcfirst($key) : $conn . $key}(...$args);
    }

    /**
     * Adds the predicate raw to model, joined by conn. $build holds the joined models that its predicates name, and the
     * enclosing model that an outer reference names.
     */
    private static function chainPredicate(Model $model, string $conn, array $raw, object $build, array $context): void
    {
        if (count($raw) === 1) {
            $name = array_key_first($raw);
            $value = $raw[$name];
            switch ($name) {
                case 'chain':
                    foreach ($value as $i => $item) {
                        $itemConn = $i === 0 && $item[0] === '' ? $conn : $item[0];
                        if (count($item) === 1) {
                            $model->$itemConn();
                        } else {
                            self::chainNested($model, $itemConn, $item[1], $build, $context);
                        }
                    }
                    return;
                case 'and':
                case 'or':
                    foreach ($value as $i => $item) {
                        self::chainNested($model, $i === 0 ? $conn : $name, $item, $build, $context);
                    }
                    return;
                case 'not':
                    $negated = $conn === '' ? 'not' : $conn . 'Not';
                    $model->$negated(static function (Model $group) use ($value, $build, $context): void {
                        self::chainPredicate($group, '', $value, $build, $context);
                    });
                    return;
                case 'placed':
                    if (is_array($value)) {
                        $model->{$conn === '' ? 'and' : $conn}(self::chainModel($value['model'], $context));
                        return;
                    }
                    if (!isset($build->joined[$value])) {
                        Assert::fail("placed $value names no join");
                    }
                    $model->{$conn === '' ? 'and' : $conn}($build->joined[$value]);
                    return;
                case 'tuple':
                    [$columns, $rows] = $value;
                    $key = 'Tuple' . implode('With', array_map(self::pascal(...), $columns));
                    $values = array_map(static fn (array $row): array => array_map(
                        static fn (array $item): mixed => self::chainValue($item, $context),
                        $row,
                    ), $rows);
                    self::chainCall($model, $conn, $key, [$values]);
                    return;
                case 'fulltext_boolean':
                    $key = 'FulltextBoolean' . implode('With', array_map(self::pascal(...), $value['columns']));
                    self::chainCall($model, $conn, $key, [$value['text']]);
                    return;
            }
        }
        if (isset($raw['expr'], $raw['cmp'])) {
            $operator = array_key_first($raw['cmp']);
            $key = self::OPERATOR_NAMES[$operator] . self::pascal(self::fnColumn($raw['expr']));
            $args = [self::chainFunc($raw['expr']), self::chainValue($raw['cmp'][$operator], $context)];
            self::chainCall($model, $conn, $key, $args);
            return;
        }
        $first = true;
        foreach ($raw as $column => $value) {
            self::chainLeaf($model, $first ? $conn : 'and', (string) $column, $value, $build, $context);
            $first = false;
        }
    }

    /** A predicate inside a list: an and, an or or a chain opens a group callback of the model. */
    private static function chainNested(Model $model, string $conn, array $raw, object $build, array $context): void
    {
        if (count($raw) === 1 && in_array(array_key_first($raw), ['and', 'or', 'chain'], true)) {
            $model->{$conn === '' ? 'and' : $conn}(static function (Model $group) use ($raw, $build, $context): void {
                self::chainPredicate($group, '', $raw, $build, $context);
            });
            return;
        }
        self::chainPredicate($model, $conn, $raw, $build, $context);
    }

    /** Adds {column: value} or {column: {operator: operand}}. */
    private static function chainLeaf(
        Model $model,
        string $conn,
        string $column,
        array $raw,
        object $build,
        array $context,
    ): void {
        $name = self::pascal($column);
        if (count($raw) === 1 && array_key_exists(array_key_first($raw), self::OPERATOR_NAMES)) {
            $operator = array_key_first($raw);
            $operand = $raw[$operator];
            $prefix = self::OPERATOR_NAMES[$operator];
            if ($operator === 'is_null' || $operator === 'not_null') {
                self::chainCall($model, $conn, $prefix . $name, [null]);
            } elseif ($operator === 'between') {
                $pair = [self::chainValue($operand[0], $context), self::chainValue($operand[1], $context)];
                self::chainCall($model, $conn, $prefix . $name, [$pair]);
            } elseif (isset($operand['column'])) {
                [$ref, $right] = explode('.', $operand['column'], 2);
                if (!isset($build->joined[$ref])) {
                    Assert::fail("column operand {$operand['column']} names no join");
                }
                $compare = $prefix === '' ? 'Eq' : $prefix;
                self::chainCall($model, $conn, $name . $compare . self::pascal($right), [$build->joined[$ref]]);
            } elseif (isset($operand['outer'])) {
                if ($build->outer === null) {
                    Assert::fail("outer {$operand['outer']} has no enclosing query");
                }
                $compare = $prefix === '' ? 'Eq' : $prefix;
                self::chainCall($model, $conn, $name . $compare . self::pascal($operand['outer']), [$build->outer]);
            } elseif (isset($operand['sub'])) {
                $child = self::chainModel($operand['sub']['model'], $context);
                self::chainQuery($child, $operand['sub'], self::chainState($build->outer), $context);
                self::chainCall($model, $conn, $prefix . $name, [$child]);
            } elseif (isset($operand['fn'])) {
                self::chainCall($model, $conn, $prefix . $name, [self::chainFunc($operand)]);
            } else {
                self::chainCall($model, $conn, $prefix . $name, [self::chainValue($operand, $context)]);
            }
            return;
        }
        self::chainCall($model, $conn, $name, [self::chainValue($raw, $context)]);
    }

    /** The state of building one query. */
    private static function chainState(?Model $outer = null): object
    {
        return (object) ['joined' => [], 'outer' => $outer, 'db' => null];
    }

    /** One entry of columns or add_columns: a name, a function of a column under a name, or a scalar subquery under a name. */
    private static function chainColumn(Model $model, mixed $entry, array $context): void
    {
        if (is_string($entry)) {
            $model->{'addColumn' . self::pascal($entry)}();
            return;
        }
        $expr = $entry['expr'];
        if (isset($expr['sub'])) {
            $sub = $expr['sub'];
            $method = 'addColumn' . self::pascal($entry['as']);
            $model->{$method}(static function (Model $outer) use ($sub, $context): Model {
                $child = self::chainModel($sub['model'], $context);
                self::chainQuery($child, $sub, self::chainState($outer), $context);
                return $child;
            });
            return;
        }
        $method = 'addColumn' . self::pascal(self::fnColumn($expr)) . 'Alias' . self::pascal($entry['as']);
        $model->{$method}(self::chainFunc($expr));
    }

    /** Applies the fields of q to model, in the order that a chain writes them. */
    private static function chainQuery(
        Model $model,
        array|RecipeStep $q,
        object $build,
        array $context,
        bool $withLimit = true,
    ): void {
        $columns = $q['columns'] ?? null;
        if ($columns === 'all') {
            $model->addAllColumns();
        } elseif ($columns !== null) {
            $model->removeAllColumns();
            foreach ($columns as $entry) {
                self::chainColumn($model, $entry, $context);
            }
        }
        foreach ($q['add_columns'] ?? [] as $entry) {
            self::chainColumn($model, $entry, $context);
        }
        foreach ($q['remove_columns'] ?? [] as $column) {
            $model->{'removeColumn' . self::pascal($column)}();
        }
        if (isset($q['aggregate'])) {
            if (isset($q['aggregate']['column'])) {
                $model->{$q['aggregate']['agg'] . self::pascal($q['aggregate']['column'])}();
            }
            foreach ($q['aggregate']['group_by'] ?? [] as $column) {
                $model->{'groupBy' . self::pascal($column)}();
            }
        }
        foreach ($q['joins'] ?? [] as $join) {
            $child = self::chainModel($join['model'], $context);
            $inner = self::chainState($build->outer);
            if (isset($join['alias'])) {
                $child->{'alias' . self::pascal($join['alias'])}();
            }
            if (isset($join['on'])) {
                $on = $join['on'];
                $child->on(static function (Model $group) use ($on, $inner, $context): void {
                    self::chainPredicate($group, '', $on, $inner, $context);
                });
            }
            self::chainQuery($child, $join, $inner, $context);
            if (($join['connect'] ?? false) === true) {
                $child->connect($build->db);
            }
            $method = (($join['kind'] ?? 'inner') === 'left' ? 'leftJoin' : 'join')
                . self::pascal($join['match'][0]) . 'With' . self::pascal($join['match'][1]);
            $model->$method($child);
            if (isset($join['as'])) {
                $build->joined[$join['as']] = $child;
            }
        }
        foreach ($q['relations'] ?? [] as $relation) {
            $child = self::chainRelation($relation, $build, $context);
            ($relation['many'] ?? false) === true ? $model->relations($child) : $model->relation($child);
        }
        if (isset($q['where'])) {
            self::chainPredicate($model, '', $q['where'], $build, $context);
        }
        foreach ($q['order'] ?? [] as $entry) {
            if (is_array($entry) && ($entry['random'] ?? false) === true) {
                $model->orderByRandom();
                continue;
            }
            if (is_string($entry)) {
                $descending = str_starts_with($entry, '-');
                $model->{'orderBy' . self::pascal(ltrim($entry, '-')) . ($descending ? 'Desc' : 'Asc')}();
                continue;
            }
            $direction = ($entry['dir'] ?? 'asc') === 'desc' ? 'Desc' : 'Asc';
            if (isset($entry['fn'])) {
                $method = 'orderBy' . self::pascal(self::fnColumn($entry['fn'])) . $direction;
                $model->{$method}(self::chainFunc($entry['fn']));
            } else {
                $model->{'orderBy' . self::pascal($entry['column']) . $direction}();
            }
        }
        if ($withLimit && isset($q['limit'])) {
            is_int($q['limit'])
                ? $model->limit(0, $q['limit'])
                : $model->limit($q['limit']['offset'] ?? 0, $q['limit']['count']);
        }
        if (isset($q['force_index'])) {
            $model->{'forceIndex' . self::pascal($q['force_index'])}();
        }
        if (isset($q['key_by'])) {
            $model->{'keyName' . self::pascal($q['key_by'])}();
        }
        if (isset($q['lock'])) {
            $model->{match ($q['lock']) {
                'update' => 'forUpdate',
                'share' => 'forShare',
                'update_nowait' => 'forUpdateNoWait',
                'share_nowait' => 'forShareNoWait',
            }}();
        }
    }

    /** The child model of a relation. */
    private static function chainRelation(array $relation, object $build, array $context): Model
    {
        $child = self::chainModel($relation['model'], $context);
        foreach ($relation['match'] ?? [] as [$left, $right]) {
            $child->{'match' . self::pascal($left) . 'With' . self::pascal($right)}();
        }
        if (isset($relation['alias'])) {
            $child->{'alias' . self::pascal($relation['alias'])}();
        }
        foreach ($relation['possible'] ?? [] as $column => $value) {
            $child->{'possible' . self::pascal((string) $column)}(self::chainValue($value, $context));
        }
        if (($relation['parent_node'] ?? false) === true) {
            $child->parentNode();
        }
        self::chainQuery($child, $relation, self::chainState($build->outer), $context);
        if (($relation['group_limit'] ?? 0) > 0) {
            $child->groupLimit($relation['group_limit']);
        }
        if (isset($relation['key_by'])) {
            $child->{'keyName' . self::pascal($relation['key_by'])}();
        }
        if (($relation['delete_lock'] ?? false) === true) {
            $child->deleteLock();
        }
        return $child;
    }

    /** The model of a read: the fields of the step applied. A terminal by runs through chainKey. */
    private static function chainBuilt(RecipeStep $s, array $context): Model
    {
        // A bound chain is read again: a terminal leaves it as it was (DSL-98).
        if (isset($s['from'])) {
            return self::boundValue($s['from'], $context);
        }
        $db = self::connectionOf($s, $context);
        $model = ($s['unconnected'] ?? false) === true
            ? self::chainModel($s['model'], $context)
            : self::tableModel($s['model'], $db, $context);
        $build = self::chainState();
        $build->db = $db;
        $paged = ($s['page'] ?? false) === true;
        self::chainQuery($model, $s, $build, $context, !$paged && !isset($s['offset']));
        if (!$paged && isset($s['offset'], $s['limit'])) {
            $model->limit($s['offset'], is_int($s['limit']) ? $s['limit'] : $s['limit']['count']);
        }
        if (isset($s['relation'])) {
            // The columns of this relation are read of each child row; they do not narrow its statement.
            $relation = $s['relation'];
            unset($relation['columns']);
            $child = self::chainRelation($relation, $build, $context);
            // Only a relation that names connect runs on the connection of the query; without it the child has no handle and takes the connection of its parent (INT-87).
            if (($relation['connect'] ?? false) === true) {
                $child->connect($db);
            }
            ($relation['many'] ?? false) === true ? $model->relations($child) : $model->relation($child);
        }
        return $model;
    }

    /** The name and the arguments of the keys of a terminal by, in the written order. */
    private static function chainKey(RecipeStep $s, array $context): array
    {
        $names = [];
        $args = [];
        foreach ($s['key'] as $column => $value) {
            $names[] = self::pascal((string) $column);
            $args[] = self::chainValue($value, $context);
        }
        return [implode('And', $names), $args];
    }

    /** The JSON of a row, narrowed to pick when it is named; a missing row is null. */
    private static function chainRow(?Model $row, ?array $pick): mixed
    {
        if ($row === null) {
            return null;
        }
        $values = json_decode($row->toJson(), true, 512, JSON_THROW_ON_ERROR);
        if ($pick === null || $pick === []) {
            return $values;
        }
        $out = [];
        foreach ($pick as $name) {
            if (!array_key_exists($name, $values)) {
                Assert::fail("the row has no field $name");
            }
            $out[$name] = $values[$name];
        }
        return $out;
    }

    /** The expect of the database of the case compares rows of wrappers. */
    private static function chainWantsRows(RecipeStep $s, array $context): bool
    {
        return isset($s['expect'][$context['database']]['rows']);
    }

    /** The rows of wrappers of the columns of a step, each followed by the columns of each related row of its relation. */
    private static function chainCells(iterable $parents, RecipeStep $s): array
    {
        $rel = $s['relation'] ?? null;
        $rows = [];
        foreach ($parents as $row) {
            $own = self::project($row, $s['columns']);
            if ($rel === null) {
                $rows[] = $own;
                continue;
            }
            foreach (self::relatedRows($row, $rel) as $childRow) {
                $rows[] = [...$own, ...self::project($childRow, $rel['columns'])];
            }
        }
        return $rows;
    }

    /** The child rows that the relation of a parent read attached: each child of a many relation, or the one child. */
    private static function relatedRows(Model $parent, array $rel): array
    {
        $name = self::pascal(Chain::snake($rel['model']));
        if ($rel['many']) {
            $get = 'get' . $name . 'Models';
            $out = [];
            foreach ($parent->$get() as $child) {
                $out[] = $child;
            }
            return $out;
        }
        $get = 'get' . $name . 'Model';
        $child = $parent->$get();
        return $child === null ? [] : [$child];
    }

    /** Sets the members of an object of values on a model, in the written order: an arith entry is plus or minus. */
    private static function chainAssign(Model $model, array $values, array $context): Model
    {
        foreach ($values as $column => $value) {
            $name = self::pascal((string) $column);
            if (isset($value['arith'])) {
                $call = ($value['arith']['operation'] === 'minus' ? 'minus' : 'plus') . $name;
                $model->$call(self::chainValue($value['arith']['amount'], $context));
            } elseif (isset($value['styled'])) {
                $model->{'set' . $name}(StyledValue::value(self::chainValue($value['styled'], $context)));
            } elseif (array_key_exists('null', $value) && RuntimeModel::styled($model::meta()['columns'][$column] ?? ['codec' => []])) {
                // A null of a styled column is SQL NULL, the styled value its typed setter takes.
                $model->{'set' . $name}(StyledValue::sqlNull());
            } elseif (isset($value['object'])) {
                $codec = $model::meta()['columns'][$column]['codec'] ?? [];
                $model->{'set' . $name}(self::styledArgument($value, $codec, []));
            } else {
                $argument = self::chainValue($value, $context);
                if ($argument === null && !(new \ReflectionMethod($model, 'set' . $name))->getParameters()[0]->allowsNull()) {
                    // The typed setter of a non-null column takes no NULL, so the row writes it through the column writer.
                    (new \ReflectionMethod($model, 'writeColumn'))->invoke($model, $column, null);
                } else {
                    $model->{'set' . $name}($argument);
                }
            }
        }
        return $model;
    }

    /** A write through a model set from values, then its terminal; the written model is bound, and its JSON is the result. */
    private static function chainWrite(RecipeStep $s, array $context, \Closure $terminal): array
    {
        $table = ($s['unconnected'] ?? false) === true
            ? self::chainModel($s['model'], $context)
            : self::tableModel($s['model'], self::connectionOf($s, $context), $context);
        $model = self::chainAssign($table, $s['values'] ?? [], $context);
        foreach ($s['attached'] ?? [] as $name => $value) {
            $model->{'new' . self::pascal((string) $name)}(self::chainValue($value, $context));
        }
        if (isset($s['duplication'])) {
            $duplicate = self::chainModel($s['model'], $context);
            $model->duplication(self::chainAssign($duplicate, $s['duplication'], $context));
        }
        $row = $terminal($model);
        $fields = ['bind' => $row, 'json' => self::chainRow($row, $s['pick'] ?? null)];
        // With columns, the rows expect compares the row that the write returns (INT-38).
        if (isset($s['columns'])) {
            $fields['rows'] = self::chainCells([$row], $s);
        }
        return $fields;
    }

    /** The model that an update or a delete writes through: the bound row, or a new model set from values, which writes with no read. */
    private static function chainTarget(RecipeStep $s, array $context): Model
    {
        $model = isset($s['row'])
            ? self::boundValue(is_string($s['row']) ? $s['row'] : $s['row']['ref'], $context)
            : self::chainAssign(
                self::tableModel($s['model'], self::connectionOf($s, $context), $context),
                // The key form sets the key on a new model, with no read before it (FCV-4).
                $s['key'] ?? $s['values'] ?? [],
                $context,
            );
        if (isset($s['revision'])) {
            $model->expectRevision($s['revision']['column'], self::chainValue($s['revision']['value'], $context));
        }
        return $model;
    }

    private static function countFields(int $n): array
    {
        return ['json' => $n, 'value' => ['int' => (string) $n]];
    }

    /** A model op of a fixture that generates no models: each field maps to one call of the public builder (FCV-4). */
    private static function tableModelOp(RecipeStep $s, array $context): array
    {
        switch ($s['op']) {
            case 'model.chain':
                return ['bind' => self::chainBuilt($s, $context)];
            case 'model.query':
                return self::chainGets($s, $context);
            case 'model.count':
                $model = self::chainBuilt($s, $context);
                if (isset($s['key'])) {
                    [$name, $args] = self::chainKey($s, $context);
                    return self::countFields($model->{'getCountBy' . $name}(...$args));
                }
                return self::countFields($model->getCount());
            case 'model.get_by':
                $model = self::chainBuilt($s, $context);
                if (isset($s['key'])) {
                    [$name, $args] = self::chainKey($s, $context);
                    $row = $model->{'getBy' . $name}(...$args);
                } else {
                    $row = $model->get();
                }
                if (($s['json_output'] ?? false) === true && $row !== null) {
                    return ['json' => $row->toJson()];
                }
                if (isset($s['ordered_text']) && $row !== null) {
                    return ['json' => $row->{'get' . self::pascal($s['ordered_text'])}()->payload()->raw()];
                }
                $fields = ['json' => self::chainRow($row, $s['pick'] ?? null)];
                return $row === null ? $fields : ['bind' => $row] + $fields;
            case 'model.create':
                $restore = ($s['restore_or_create'] ?? false) === true;
                return self::chainWrite(
                    $s,
                    $context,
                    static fn (Model $m): Model => $restore ? $m->restoreOrCreate() : $m->create(),
                );
            case 'model.duplicate_create':
                return self::chainWrite($s, $context, static fn (Model $m): Model => $m->create());
            case 'model.save':
                return self::chainWrite($s, $context, static fn (Model $m): Model => $m->save());
            case 'model.restore':
                return self::chainWrite($s, $context, static fn (Model $m): Model => $m->restore());
            case 'model.creates':
                $db = self::connectionOf($s, $context);
                $models = [];
                if (isset($s['rows_sequence'])) {
                    $sequence = $s['rows_sequence'];
                    for ($i = 0; $i < $sequence['count']; $i++) {
                        $row = self::chainModel($s['model'], $context);
                        $row->{'set' . self::pascal($sequence['column'])}($sequence['from'] + $i);
                        $models[] = self::chainAssign($row, $sequence['values'] ?? [], $context);
                    }
                } else {
                    foreach ($s['rows'] as $values) {
                        $models[] = self::chainAssign(self::chainModel($s['model'], $context), $values, $context);
                    }
                }
                $table = self::tableModel($s['model'], $db, $context);
                return self::countFields($table->creates($models, $s['batch'] ?? count($models)));
            case 'model.update':
                $model = self::chainTarget($s, $context);
                self::chainAssign($model, $s['set'] ?? [], $context)->update(($s['optimistic'] ?? false) === true);
                return [];
            case 'model.delete':
                $recursive = ($s['recursive'] ?? false) === true;
                if (isset($s['row'])) {
                    $bound = self::boundValue(is_string($s['row']) ? $s['row'] : $s['row']['ref'], $context);
                    if ($bound instanceof Collection) {
                        $bound->delete($recursive);
                        return [];
                    }
                }
                if (isset($s['where'])) {
                    // A delete by where loads the rows and deletes each one (FCV-4).
                    foreach (self::chainBuilt($s, $context)->gets() as $row) {
                        $row->delete();
                    }
                    return [];
                }
                self::chainTarget($s, $context)->delete($recursive);
                return [];
            case 'db.last_affected':
                require_once dirname(__DIR__) . '/testing/Faults.php';
                return ['value' => ['int' => (string) \Polyspec\Orm\Testing\Faults::lastAffected(self::connectionOf($s, $context))]];
            case 'db.notify':
                self::connectionOf($s, $context)->notify($s['channel'], $s['payload']);
                return [];
            case 'utils.lock':
                self::connectionOf($s, $context)->utils()->lock($s['name']);
                return [];
            case 'utils.set_local':
                $utils = self::connectionOf($s, $context)->utils();
                $utils->setLocal($s['name'], self::chainValue($s['value'], $context));
                return [];
            case 'utils.local':
                return ['json' => self::connectionOf($s, $context)->utils()->local($s['name'])];
            case 'utils.was_inserted':
                $utils = self::connectionOf($s, $context)->utils();
                return ['value' => ['bool' => $utils->wasInserted($s['table'], $s['sequence'])]];
            case 'utils.backend_waiting_for_lock':
                return ['value' => ['bool' => self::connectionOf($s, $context)->utils()->backendWaitingForLock()]];
            case 'utils.groups':
                // The names of the groups that the value of utils() holds (INT-134), each read through its own call.
                $utils = self::connectionOf($s, $context)->utils();
                $held = [
                    'aes' => $utils->aes(),
                    'privileges' => $utils->privileges(),
                    'schema' => $utils->schema(),
                    'stats' => $utils->stats(),
                ];
                return ['value' => ['array' => array_map(
                    static fn(string $text): array => ['text' => $text],
                    array_keys(array_filter($held, static fn(mixed $group): bool => $group !== null))
                )]];
        }
        Assert::fail("OP_UNKNOWN {$s['op']}");
    }

    /** The terminal of a model.query: gets, or the terminal of its aggregate, its page or its compile. */
    private static function chainGets(RecipeStep $s, array $context): array
    {
        $model = self::chainBuilt($s, $context);
        if (($s['compile'] ?? false) === true) {
            return ['json' => $model->getQuery()];
        }
        if (($s['plan'] ?? false) === true) {
            $steps = isset($s['plan_page'])
                ? $model->getPagePlanSteps($s['plan_page']['page'], $s['plan_page']['per_page'])
                : $model->getPagePlanSteps(intdiv($s['limit']['offset'], $s['limit']['count']) + 1, $s['limit']['count']);
            return ['json' => array_map(static function (array $step) use ($s): array {
                $count = [];
                foreach ($s['plan_count'] as $text) {
                    $count[$text] = substr_count(strtoupper($step['sql']), $text);
                }
                $shown = ['role' => $step['role'], 'tables' => $step['tables'], 'count' => $count];
                return ($s['plan_sql'] ?? false) === true ? $shown + ['sql' => $step['sql']] : $shown;
            }, $steps)];
        }
        $aggregate = $s['aggregate'] ?? null;
        if (isset($s['group_value'])) {
            $groups = $model->getsCount()->all();
            if ($groups === []) {
                Assert::fail("group_value {$s['group_value']}: the aggregate has no group row");
            }
            return ['json' => $groups[0]->value($s['group_value'])];
        }
        if ($aggregate !== null) {
            return ['json' => match ($aggregate['agg']) {
                'sum' => json_decode(json_encode($model->getSum())),
                'avg' => json_decode(json_encode($model->getAvg())),
                default => $model->getsCount()->toArray(),
            }];
        }
        if (($s['page'] ?? false) === true || isset($s['plan_page'])) {
            $limit = $s['limit'] ?? 0;
            $count = is_int($limit) ? $limit : $limit['count'];
            if ($count <= 0 && !isset($s['plan_page'])) {
                Assert::fail('a page needs a limit count above 0');
            }
            $offset = ($s['offset'] ?? 0) + (is_array($limit) ? ($limit['offset'] ?? 0) : 0);
            $page = isset($s['plan_page'])
                ? $model->getsPage($s['plan_page']['page'], $s['plan_page']['per_page'])
                : $model->getsPage(intdiv($offset, $count) + 1, $count);
            $fields = ['json' => [
                'total' => $page->totalCount,
                'pages' => $page->totalPages,
                'page' => $page->page,
                'per_page' => $page->perPage,
                'keys' => $page->items->keys(),
            ], 'total' => $page->totalCount];
            if (($s['items'] ?? false) === true) {
                $fields['json']['items'] = [];
                foreach ($page->items as $row) {
                    $fields['json']['items'][] = self::chainRow($row, $s['pick'] ?? null);
                }
            }
            if (self::chainWantsRows($s, $context)) {
                $fields['rows'] = self::chainCells($page->items, $s);
            }
            return $fields;
        }
        if (isset($s['key'])) {
            [$name, $args] = self::chainKey($s, $context);
            $rows = $model->{'getsBy' . $name}(...$args);
        } else {
            $rows = $model->gets();
        }
        $list = [];
        foreach ($rows as $row) {
            $list[] = self::chainRow($row, $s['pick'] ?? null);
        }
        $fields = ['bind' => $rows, 'json' => $list];
        if (self::chainWantsRows($s, $context)) {
            $fields['rows'] = self::chainCells($rows, $s);
        }
        return $fields;
    }

    /** A bound value of {"ref": "<name>"} or {"ref": "<name>.<path>"}. */
    private static function boundValue(string $ref, array $context): mixed
    {
        $path = explode('.', $ref);
        $head = array_shift($path);
        if (!array_key_exists($head, $context['bound'])) {
            Assert::fail("no bound value $head");
        }
        if ($path === []) {
            return $context['bound'][$head];
        }
        $value = $context['fields'][$head];
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
            // An array is a list of values (an IN list of where); a sequence item adds its integers in place (FCV-4).
            case 'array':
                $list = [];
                foreach ($w['array'] as $item) {
                    if (array_key_first($item) === 'sequence') {
                        array_push($list, ...self::sequenceValues($item['sequence']));
                    } else {
                        $list[] = self::nativeValue($item);
                    }
                }
                return $list;
            case 'sequence':
                return self::sequenceValues($w['sequence']);
        }
        Assert::fail("unknown recipe wrapper $kind");
    }

    /** The integer values from, from + 1, ... of a {"sequence": {"from", "count"}} wrapper (FCV-4). */
    private static function sequenceValues(array $sequence): array
    {
        return array_map(static fn(int $index): int => $sequence['from'] + $index, range(0, $sequence['count'] - 1));
    }

    /** The recipe wrapper of a plain value; a string takes the wrapper of the native type of its column when one is
     * known. */
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
        if (is_string($value) && $nativeType === null && ctype_digit($value) && strlen($value) >= 19
            && filter_var($value, FILTER_VALIDATE_INT) === false) {
            // PHP holds a MySQL unsigned value beyond its integer as its digits (INT-102).
            return ['int' => $value];
        }
        if (is_string($value) && preg_match('/binary|bytea|blob/i', $nativeType ?? '') === 1) {
            return ['bytes_hex' => bin2hex($value)];
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

    /** The fields of a mutation result: its rows, each cell wrapped by the native type of its column in the
     * metadata. */
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
