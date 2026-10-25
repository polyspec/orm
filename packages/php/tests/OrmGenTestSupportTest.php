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

    public function testRunProcessReturnsTheStatusAndBothStreams(): void
    {
        self::assertSame(
            [3, 'out', 'err'],
            OrmGenTestSupport::runProcess(
                [PHP_BINARY, '-n', '-r', 'fwrite(STDOUT, "out"); fwrite(STDERR, "err"); exit(3);']
            )
        );
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

    public function testRunReturnsTheStatusAndTheOutputOfOrmGen(): void
    {
        [$code, $stdout, $stderr] = OrmGenTestSupport::run(['--no-such-option']);
        self::assertNotSame(0, $code, 'an unknown option fails');
        self::assertSame('', $stdout);
        self::assertNotSame('', $stderr, 'the failure is written to the error stream');
    }
}
