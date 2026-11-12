<?php

// The parsed runtime model of generated PHP code: a new process that reads the generated bootstrap does not parse the
// manifest, and it parses when the data is not the data of the manifest it reads.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist \
//   packages/php/tests/OrmGenParsedModelTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\RuntimeModel;

// Requirements: DBS-177.
// Each case changes the generated files, then reads the generated bootstrap in a new process. The manifest text of a
// case that must not parse is no dbspec document, so a parse of it fails with SCHEMA_INVALID on either PHP runtime.
#[Small]
class OrmGenParsedModelTest extends TestCase
{
    use OrmGenProcessCase;

    private const NAMESPACE = 'Polyspec\\Orm\\Tests\\ParsedModel';
    private const UNPARSABLE = 'not a dbspec document';
    /** The sha256 of the JSON of the entities of the bench set, in RuntimeModel::FORMAT 2. */
    private const FORMAT_FINGERPRINT = '96cc255f4afe940744a6421ab0180dbf161897175a175cfed19742629e773717';
    /** Reads the runtime model of the set in the directory of the first argument and prints the result as JSON. */
    private const READER = <<<'READER'
    <?php
    declare(strict_types=1);
    require $argv[1];
    require $argv[2] . '/Item.php';
    require $argv[2] . '/bootstrap.php';
    try {
        $model = Polyspec\Orm\Registry::model(constant($argv[3] . '\MANIFEST_HASH'));
        echo json_encode([
            'entities' => array_keys($model->entities),
            'same' => $model->entities === constant($argv[3] . '\PARSED_ENTITIES'),
            'parser' => class_exists(Polyspec\Orm\Dbspec\Parser::class, false),
        ]);
    } catch (Polyspec\Orm\OrmException $e) {
        echo json_encode(['code' => $e->code_, 'message' => $e->getMessage()]);
    }
    READER;

    protected static function workPrefix(): string
    {
        return 'orm-php-parsed-model-';
    }

    /** Generates the models of a set of one document into a new directory and returns the directory of the models. */
    private static function generate(string $name): string
    {
        return self::generateDocument(
            $name,
            'parsed.dbs',
            "dbspec 1 parsed\n\ntable item {\n  seq i64\n  name varchar(32)\n  primary key (seq)\n}\n",
            self::NAMESPACE
        );
    }

    /** Reads the generated models of $model in a new process and returns what the reader printed. */
    private static function read(string $model): array
    {
        return self::readInProcess($model, self::READER, [self::NAMESPACE]);
    }

    /**
     * Makes the manifest of the generated files text that does not parse, under its own hash, and writes the hash of
     * the parsed data as $parsedHash, by default the same new hash.
     */
    private static function replaceManifest(string $model, ?string $parsedHash = null): void
    {
        $declarations = "$model/schema_declarations.php";
        $source = (string) file_get_contents($declarations);
        self::assertSame(1, preg_match("/const MANIFEST_HASH = '([^']+)';/", $source, $found));
        $old = $found[1];
        $new = 'sha256:' . hash('sha256', self::UNPARSABLE);
        $source = (string) preg_replace(
            "/const MANIFEST_TEXT = .*?;\n/s",
            "const MANIFEST_TEXT = '" . self::UNPARSABLE . "';\n",
            $source,
            1
        );
        file_put_contents($declarations, $source);
        foreach ((array) glob("$model/*.php") as $file) {
            file_put_contents($file, str_replace($old, $new, (string) file_get_contents($file)));
        }
        if ($parsedHash !== null) {
            file_put_contents($declarations, (string) preg_replace(
                "/const PARSED_HASH = '[^']+';/",
                "const PARSED_HASH = '$parsedHash';",
                (string) file_get_contents($declarations)
            ));
        }
    }

    public function testAGeneratedSetIsReadWithoutParsingItsManifest(): void
    {
        $model = self::generate('valid');
        $result = self::read($model);
        self::assertSame(['item'], $result['entities'] ?? null, json_encode($result));
        self::assertTrue($result['same']);
        if (getenv('ORM_PHP_MODE') !== 'extension') {
            self::assertFalse($result['parser'], 'the process loaded the dbspec parser');
        }
    }

    public function testAManifestThatDoesNotParseIsNotParsedThroughItsOwnData(): void
    {
        $model = self::generate('unparsable');
        self::replaceManifest($model);
        self::assertSame(['item'], self::read($model)['entities'] ?? null);
    }

    public function testDataOfAnotherManifestMakesTheProcessParse(): void
    {
        $model = self::generate('changed');
        self::replaceManifest($model, 'sha256:' . str_repeat('0', 64));
        self::assertSame(Code::SCHEMA_INVALID, self::read($model)['code'] ?? null);
    }

    public function testDataOfAnotherFormatMakesTheProcessParse(): void
    {
        $model = self::generate('format');
        self::replaceManifest($model);
        $declarations = "$model/schema_declarations.php";
        file_put_contents($declarations, str_replace(
            'const PARSED_FORMAT = ' . RuntimeModel::FORMAT . ';',
            'const PARSED_FORMAT = ' . (RuntimeModel::FORMAT + 1) . ';',
            (string) file_get_contents($declarations)
        ));
        self::assertSame(Code::SCHEMA_INVALID, self::read($model)['code'] ?? null);
    }

    public function testTheFormatNamesWhatBuildMakes(): void
    {
        $set = dirname(__DIR__, 3) . '/contracts/fixtures/bench/dbspec-set.json';
        self::assertSame(2, RuntimeModel::FORMAT);
        self::assertSame(
            self::FORMAT_FINGERPRINT,
            hash('sha256', json_encode(RuntimeModel::build(RuntimeModel::set($set))->entities, JSON_THROW_ON_ERROR)),
            'what RuntimeModel::build makes changed: raise RuntimeModel::FORMAT and record this fingerprint under it'
        );
    }
}
