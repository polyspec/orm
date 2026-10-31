<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class OrmGenTest extends TestCase
{
    private static string $work;

    public static function setUpBeforeClass(): void
    {
        self::$work = OrmGenTestSupport::createWorkDirectory('orm-php-orm-gen-client-');
    }

    public static function tearDownAfterClass(): void
    {
        OrmGenTestSupport::removeWorkDirectory(self::$work);
    }

    private static function tool(array $args): array
    {
        return OrmGenTestSupport::run($args);
    }

    // A make run starts orm-gen gen for an output directory while PHP tests of the same run read it,
    // so a rerun replaces each file whole: an unchanged file is left as it is, a changed file is
    // replaced by a rename, a generated file the model no longer makes is removed, and no temporary
    // file remains. A rewrite in place shows a reader a missing or partial file.
    public function testGenReplacesEachFileWholeAndLeavesUnchangedFiles(): void
    {
        $dir = self::$work . '/whole-files';
        $namespace = 'Polyspec\\Orm\\Tests\\GeneratedWholeFiles';
        $set = OrmGenTestSupport::setFile($dir, ['whole.dbs']);
        $gen = function (string $tables) use ($dir, $set, $namespace): void {
            file_put_contents("$dir/whole.dbs", "dbspec 1 whole\n$tables");
            [$code, $out, $err] = self::tool(['gen', '--set', $set, '--out', "$dir/model", '--namespace', $namespace]);
            self::assertSame(0, $code, "$out $err");
        };
        $item = "\ntable item {\n  id i32\n  primary key (id)\n}\n";
        $gen($item . "\ntable note {\n  id i32\n  primary key (id)\n}\n");
        $inodes = static function () use ($dir): array {
            clearstatcache();
            $map = [];
            foreach (scandir("$dir/model") as $name) {
                if ($name !== '.' && $name !== '..') {
                    $map[$name] = fileinode("$dir/model/$name");
                }
            }
            return $map;
        };
        $before = $inodes();
        self::assertArrayHasKey('Note.php', $before);

        $gen($item . "\ntable note {\n  id i32\n  primary key (id)\n}\n");
        self::assertSame($before, $inodes(), 'a rerun with the same model rewrote an unchanged file');

        $gen($item);
        $after = $inodes();
        self::assertSame(['Item.php', 'bootstrap.php', 'schema_declarations.php'], array_keys($after));
        // Each remaining file changed, since every file carries the manifest hash of the document set.
        foreach ($after as $changed => $inode) {
            self::assertNotSame($before[$changed], $inode, "$changed was not replaced by a rename");
        }
    }

    // Requirements: DBS-104, DBS-112, DBS-114, INT-66.
    public function testGeneratedTypedGetterUsesPrivateModelStorageAndRejectsUnselectedRead(): void
    {
        $dir = self::$work . '/typed-getter';
        $namespace = 'Polyspec\\Orm\\Tests\\GeneratedTypedGetter';
        $set = OrmGenTestSupport::setFile($dir, ['typed.dbs']);
        file_put_contents(
            "$dir/typed.dbs",
            "dbspec 1 typed\n\ntable item {\n  price i32\n  primary key (price)\n}\n"
        );
        [$code, $out, $err] = self::tool([
            'gen', '--set', $set, '--out', "$dir/model", '--namespace', $namespace
        ]);
        self::assertSame(0, $code, "$out $err");
        $source = file_get_contents("$dir/model/Item.php");
        self::assertIsString($source);
        foreach (['@phpstan-ignore', 'phpcs:ignore'] as $suppression) {
            self::assertStringNotContainsString($suppression, $source, "generated PHP carries $suppression");
        }
        require_once "$dir/model/Item.php";

        $class = "$namespace\\Item";
        self::assertSame(
            'sha256:' . hash('sha256', file_get_contents("$dir/typed.dbs")),
            $class::meta()['manifest_hash']
        );
        $model = new $class();
        $getter = new \ReflectionMethod($class, 'getPrice');
        self::assertSame('int', $getter->getReturnType()->getName());
        self::assertFalse($getter->isInternal());
        self::assertSame([], (new \ReflectionClass($class))->getProperties());
        self::assertTrue((new \ReflectionProperty(\Polyspec\Orm\Model::class, 'values'))->isPrivate());

        OrmGenTestSupport::assertGeneratedTypedGetter(
            $this,
            $model,
            'getPrice',
            'setPrice',
            \Polyspec\Orm\Code::COLUMN_UNSELECTED
        );
    }

    // Requirements: DBS-112, DBS-116, DBS-121, INT-2, INT-3, INT-4, INT-5, INT-6, INT-7, INT-8.
    public function testGeneratedFieldTypesFollowTheRuntimeModel(): void
    {
        $class = OrmGenTestSupport::generateItemModel(
            self::$work . '/field-types',
            'Polyspec\\Orm\\Tests\\GeneratedFieldTypes',
            OrmGenTestSupport::FIELD_TYPES_DOCUMENT
        );
        OrmGenTestSupport::assertGeneratedFieldTypes($this, $class);
    }
}
