<?php

// Unit test of the orm-gen test support (packages/php/tests/OrmGenTestSupport.php). The support is shared by the
// orm-gen, scan, scan parity, Markdown conformance and PHPStan runner tests, so a change to it is checked by this test
// (the helpers in contracts/features.json), not by the features that use it; make orm-check runs those.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;

#[Small]
final class OrmGenTestSupportTest extends TestCase
{
    public function testPhpSourceWritesTheNamespaceTheImportsAndTheBody(): void
    {
        self::assertSame("<?php\n\$x = 1;\n", OrmGenTestSupport::phpSource([], "\$x = 1;\n"));
        self::assertSame(
            "<?php\nnamespace App;\n\nuse A\\B;\nuse C;\n\n\$x = 1;\n",
            OrmGenTestSupport::phpSource(['A\\B', 'C'], "\$x = 1;\n", 'App')
        );
    }

    public function testModelSourceAndScanFixtureStartWithTheModel(): void
    {
        self::assertSame(
            "<?php\nuse App\\User;\n\n\$user = new User();\n\$user->get();\n",
            OrmGenTestSupport::phpModelSource('User', 'user', ['App\\User'], "\$user->get();\n")
        );
        self::assertSame(
            "<?php\n\$db = null;\n\$m = new \\App\\User();\n\$m->get();\n",
            OrmGenTestSupport::phpScanFixture('\\App\\User', "\$m->get();\n")
        );
        self::assertSame(
            "<?php\nuse App\\User;\n\n\$db = null;\n\$m = new User();\n\$m->get();\n",
            OrmGenTestSupport::phpScanFixture('User', "\$m->get();\n", 'App\\User')
        );
    }

    public function testRelationCallAndTryCatchWriteTheStatements(): void
    {
        self::assertSame(
            '$a->relation((new User())->matchSeq())->gets();',
            OrmGenTestSupport::phpRelationCall('$a', 'relation', 'User', 'matchSeq()', 'gets')
        );
        self::assertSame(
            '$a->relations((new User())->matchSeq());',
            OrmGenTestSupport::phpRelationCall('$a', 'relations', 'User', 'matchSeq()', null)
        );
        self::assertSame(
            "    try {\n        f();\n    } catch (\\Exception \$e) {\n        g();\n    }\n",
            OrmGenTestSupport::phpTryCatch('f();', 'g();')
        );
    }

    public function testWorkDirectorySetFileAndMethodNamesUseTheFiles(): void
    {
        $dir = OrmGenTestSupport::createWorkDirectory('orm-gen-test-support-');
        try {
            self::assertDirectoryExists($dir);
            $set = OrmGenTestSupport::setFile("$dir/set", ['a.dbs']);
            self::assertSame(
                ['schema' => 1, 'documents' => ['a.dbs'], 'external' => []],
                json_decode((string) file_get_contents($set), true)
            );
            $own = OrmGenTestSupport::setFile("$dir/own", ['b.dbs'], null);
            self::assertSame(
                ['schema' => 1, 'documents' => ['b.dbs']],
                json_decode((string) file_get_contents($own), true)
            );
            $model = "$dir/Model.php";
            file_put_contents($model, "/**\n * @method static matchSeq(int \$seq)\n * @method User getUser()\n */\n");
            self::assertSame(['matchSeq', 'getUser'], OrmGenTestSupport::phpMethodNames($model));
        } finally {
            OrmGenTestSupport::removeWorkDirectory($dir);
        }
        self::assertDirectoryDoesNotExist($dir);
    }

    public function testScanVectorCasesAreKeyedByIdAndParityLeavesOutTheNodeExceptions(): void
    {
        $file = dirname(__DIR__, 3) . '/tests/generator/php-scan-vectors.json';
        $recorded = json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR)['cases'];
        $all = OrmGenTestSupport::phpScanVectorCases();
        self::assertSame(array_column($recorded, 'id'), array_keys($all));
        foreach ($recorded as $case) {
            self::assertSame([$case], $all[$case['id']]);
        }
        $parity = OrmGenTestSupport::phpScanParityVectorCases();
        $shared = array_values(array_filter(
            $recorded,
            static fn(array $case): bool => ($case['parity'] ?? true) === true
        ));
        self::assertSame(array_column($shared, 'id'), array_keys($parity));
        self::assertLessThan(count($all), count($parity), 'the vectors hold cases that the node scan does not share');
    }

    public function testRunProcessReturnsTheStatusAndBothStreams(): void
    {
        self::assertSame(
            [3, 'out', 'err'],
            OrmGenTestSupport::runProcess(
                [PHP_BINARY, '-n', '-r', 'fwrite(STDOUT, "out"); fwrite(STDERR, "err"); exit(3);']
            )
        );
    }

    public function testRunProcessLetsNativePhpChildrenInheritTheExtensionScan(): void
    {
        $dir = OrmGenTestSupport::createWorkDirectory('orm-gen-native-child-');
        $oldMode = getenv('ORM_PHP_MODE');
        $oldScan = getenv('PHP_INI_SCAN_DIR');
        $module = "$dir/mock.so";
        $script = "$dir/child.php";
        try {
            mkdir("$dir/scan");
            file_put_contents($module, '');
            file_put_contents("$dir/scan/extension.ini", "extension=$module\n");
            file_put_contents($script, "<?php fwrite(STDOUT, 'native-child');\n");
            putenv('ORM_PHP_MODE=extension');
            putenv("PHP_INI_SCAN_DIR=$dir/scan");
            $command = [PHP_BINARY, $script];
            $method = new \ReflectionMethod(OrmGenTestSupport::class, 'nativePhpCommand');
            $actual = $method->invoke(null, $command);
            $expected = [PHP_BINARY];
            $prepend = ini_get('auto_prepend_file');
            if (is_string($prepend) && $prepend !== '') {
                array_push($expected, '-d', "auto_prepend_file=$prepend");
            }
            $expected[] = $script;
            self::assertSame($expected, $actual, 'the command names no extension; the child inherits the scan');

            [$code, $stdout, $stderr] = OrmGenTestSupport::runProcess($actual);
            self::assertSame(0, $code);
            self::assertStringContainsString('native-child', $stdout);
            self::assertStringContainsString($module, $stderr, 'the child loaded the extension of the inherited scan');
        } finally {
            $oldMode === false ? putenv('ORM_PHP_MODE') : putenv("ORM_PHP_MODE=$oldMode");
            $oldScan === false ? putenv('PHP_INI_SCAN_DIR') : putenv("PHP_INI_SCAN_DIR=$oldScan");
            OrmGenTestSupport::removeWorkDirectory($dir);
        }
    }

    public function testTypedGetterAssertionPassesForAModelWithPrivateStorage(): void
    {
        $model = new class {
            private ?int $value = null;

            public function getSeq(): int
            {
                return $this->value ?? throw new OrmException(Code::COLUMN_UNSELECTED, 'seq is not selected');
            }

            public function setSeq(int $value): static
            {
                $this->value = $value;
                return $this;
            }
        };
        OrmGenTestSupport::assertGeneratedTypedGetter($this, $model, 'getSeq', 'setSeq', Code::COLUMN_UNSELECTED);
        self::assertSame(17, $model->getSeq());
    }

    public function testGenerateItemModelLoadsTheModelWhoseFieldTypesFollowTheColumns(): void
    {
        $dir = OrmGenTestSupport::createWorkDirectory('orm-gen-test-support-item-');
        try {
            $class = OrmGenTestSupport::generateItemModel(
                $dir,
                'Polyspec\\Orm\\Tests\\SupportGeneratedItem',
                OrmGenTestSupport::FIELD_TYPES_DOCUMENT
            );
            self::assertSame('Polyspec\\Orm\\Tests\\SupportGeneratedItem\\Item', $class);
            self::assertTrue(class_exists($class, false), 'the generated Item class is loaded');
            OrmGenTestSupport::assertGeneratedFieldTypes($this, $class);
            try {
                OrmGenTestSupport::generateItemModel(
                    "$dir/broken",
                    'Polyspec\\Orm\\Tests\\SupportBrokenItem',
                    "dbspec 1 broken\n\ntable {\n"
                );
                self::fail('a document that does not parse must not generate');
            } catch (\RuntimeException $error) {
                self::assertStringStartsWith('orm-gen exited with ', $error->getMessage());
            }
        } finally {
            OrmGenTestSupport::removeWorkDirectory($dir);
        }
    }

    public function testRunReturnsTheStatusAndTheOutputOfOrmGen(): void
    {
        [$code, $stdout, $stderr] = OrmGenTestSupport::run(['--no-such-option']);
        self::assertNotSame(0, $code, 'an unknown option fails');
        self::assertSame('', $stdout);
        self::assertNotSame('', $stderr, 'the failure is written to the error stream');
    }
}
