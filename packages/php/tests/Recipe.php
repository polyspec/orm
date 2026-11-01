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
use Polyspec\Orm\CatalogTableMetadata;
use Polyspec\Orm\Codec;
use Polyspec\Orm\Config;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;
use Polyspec\Orm\StyledValue;
use Polyspec\Orm\Validator;

final class Recipe
{
    use RecipeModel;

    /** The database part of a recipe without a database (FCV-3). */
    public const NONE = 'none';

    /** @return iterable<string, array{array<string, mixed>}> each case of the recipe at path, relative to the repository root */
    public static function cases(string $path): iterable
    {
        $recipe = json_decode(file_get_contents(dirname(__DIR__, 3) . '/' . $path), true, 512, JSON_THROW_ON_ERROR);
        foreach ($recipe['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    /** Runs the steps of one case on database. */
    public static function run(string $path, array $case, string $database): void
    {
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
     * Runs the chain of an ir.answer step (a case of MarkdownConformanceTest::conformanceCases) on a connection whose
     * listener answers connect with {"ok":true} and then the one request with answer. A step with answers instead
     * gets the keyed listener (--keyed), which answers each control message by its op and each request by its
     * request.kind. The normalized result of the chain must equal the normalized expect.none.value. An OrmException
     * of the chain is the result {error: CODE}; any other exception fails the case.
     */
    private static function answerStep(array $step): void
    {
        if (!array_key_exists('value', $step['expect']['none'] ?? [])) {
            Assert::fail('ir.answer has no expect.none.value');
        }
        $want = $step['expect']['none']['value'];
        $chain = MarkdownConformanceTest::conformanceCases()[$step['chain']] ?? null;
        if ($chain === null) {
            Assert::fail("chain {$step['chain']} is no markdown conformance case");
        }
        $flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR;
        $server = array_key_exists('answers', $step)
            ? start_markdown_test_server(['--keyed', json_encode($step['answers'], $flags)])
            : start_markdown_test_server(['{"ok":true}', json_encode($step['answer'], $flags)]);
        $served = new Served();
        $served->db = \Polyspec\Orm\Tests\MarkdownModel\connect($server[2], new Config());
        try {
            $got = $chain($served);
        } catch (OrmException $error) {
            $got = ['error' => $error->code_];
        } finally {
            $served->db->close();
            markdown_test_server_received_messages($server);
        }
        $actual = MarkdownConformanceTest::normalize($got);
        $expect = MarkdownConformanceTest::normalize($want);
        Assert::assertSame(
            $expect,
            $actual,
            'got ' . MarkdownConformanceTest::jsonText($actual) . ', want ' . MarkdownConformanceTest::jsonText($expect)
        );
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
            if ($schema !== null) {
                foreach ([...$installFirst, $schema] as $shared) {
                    $db->utils()->schema()->install($shared);
                }
            }
            $catalog = Catalog::connect($dsn);
            try {
                $namespace = $catalog->currentNamespace();
                $context = [
                    'catalog' => $catalog,
                    'namespace' => $namespace,
                    'database' => $database,
                    'dsn' => $dsn,
                    'bound' => ['database' => ['text' => $name]],
                    'db' => $db,
                    'dir' => dirname(__DIR__, 3) . '/' . dirname($path),
                ];
                foreach ([$recipe['seed']['rows'] ?? [], $case['seed']['rows'] ?? []] as $rows) {
                    foreach ($rows as $table => $values) {
                        $metadata = $catalog->describeTable(['namespace' => $namespace, 'name' => $table]);
                        foreach ($values as $row) {
                            $catalog->insertRow($metadata, self::assignments($row, $context));
                        }
                    }
                }
                foreach ($case['steps'] as $index => $step) {
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
                $catalog->close();
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
        }
        if (isset($step['as'])) {
            $context['bound'][$step['as']] = array_key_exists('bind', $actual)
                ? $actual['bind']
                : ($actual['value'] ?? null);
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
        Assert::assertSame(self::normalizedNull($expected), self::normalizedNull($compared));
    }

    /** Maps the op of a step to its one call of the public API and returns the fields that its expect compares. */
    private static function databaseOp(array $s, array $context): array
    {
        $catalog = $context['catalog'];
        $table = static fn (): array => ['namespace' => $context['namespace'], 'name' => $s['table']];
        switch ($s['op']) {
            case 'schema.install':
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
                $context['db']->transaction(static function () use ($s, &$context): void {
                    foreach ($s['steps'] as $nested) {
                        self::databaseStep($nested, $context);
                    }
                });
                return ['value' => ['bool' => true]];
            case 'catalog.current_namespace':
                return ['value' => ['text' => $catalog->currentNamespace()]];
            case 'catalog.describe_table':
                $metadata = $catalog->describeTable($table());
                return [
                    'bind' => $metadata,
                    'columns' => array_map(static fn ($column): string => $column->name, $metadata->columns),
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
                    [],
                    $s['max_rows'] ?? 0,
                    $s['max_bytes'] ?? 0
                );
                return ['rows' => array_map(
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
                return ['bind' => $catalog->rowSnapshotFromPage(self::stepArgument($s['page'], $context), $s['index'])];
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
            case 'sql.exec':
                // The native driver of PHP is PDO, opened on the case database.
                $pdo = case_admin($context['dsn']);
                $pdo->exec(self::sqlField($s['sql'], $context));
                return [];
            // dsn.connect (FCV-4): the DSN of the case database for "case", otherwise the text of the step.
            case 'dsn.connect':
                $dsn = $s['dsn'] === 'case' ? $context['dsn'] : $s['dsn'];
                $db = Orm::connect($dsn, new Config());
                try {
                    return ['value' => ['text' => $db->driver()]];
                } finally {
                    $db->close();
                }
        }
        if (str_starts_with($s['op'], 'model.')) {
            return self::modelOp($s, $context);
        }
        Assert::fail("OP_UNKNOWN {$s['op']}");
    }

    /** A field that holds SQL or a database-decided value: the string itself, or the entry of the database. */
    private static function sqlField(string|array $field, array $context): string
    {
        return is_string($field) ? $field : $field[$context['database']];
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
    private static function assignments(array $values, array $context): array
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
            'integer', 'unsigned' => ['int' => (string) $cell->value],
            'decimal', 'text', 'date', 'time', 'datetime' => [$cell->kind => $cell->value],
            'boolean' => ['bool' => $cell->value],
            'binary' => ['bytes_hex' => bin2hex($cell->value)],
            default => Assert::fail("no recipe wrapper for the grid cell {$cell->kind}"),
        };
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
