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

    // Requirements: DBS-112, DBS-121, INT-2, INT-3, INT-4, INT-5, INT-6, INT-7, INT-8.
    public function testGeneratedFieldTypesFollowTheRuntimeModel(): void
    {
        $dir = self::$work . '/field-types';
        $namespace = 'Polyspec\\Orm\\Tests\\GeneratedFieldTypes';
        $set = OrmGenTestSupport::setFile($dir, ['typed.dbs']);
        file_put_contents(
            "$dir/typed.dbs",
            "dbspec 1 typed\n\ntable item {\n  seq i64 identity\n  ratio f64\n  enabled bool\n  body text\n  payload bytes null\n  moment datetime(3) null\n  json_value text null\n  primary key (seq)\n  settings {\n    codec json_value ordered_json\n  }\n}\n"
        );
        [$code, $out, $err] = self::tool([
            'gen', '--set', $set, '--out', "$dir/model", '--namespace', $namespace
        ]);
        self::assertSame(0, $code, "$out $err");
        require_once "$dir/model/Item.php";
        $class = "$namespace\\Item";
        foreach ([
            'getRatio' => 'float',
            'getEnabled' => 'bool',
            'getBody' => 'string',
            'getPayload' => '?string',
            'getMoment' => '?DateTimeImmutable',
            'getJsonValue' => 'Polyspec\\Orm\\StyledValue',
        ] as $method => $expected) {
            self::assertSame($expected, (string) (new \ReflectionMethod($class, $method))->getReturnType(), "$class::$method");
        }
        foreach ([
            'setRatio' => 'float',
            'setEnabled' => 'bool',
            'setBody' => 'string',
            'setPayload' => '?string',
            'setMoment' => '?string',
            'setJsonValue' => 'Polyspec\\Orm\\StyledValue',
        ] as $method => $expected) {
            self::assertSame($expected, (string) (new \ReflectionMethod($class, $method))->getParameters()[0]->getType(), "$class::$method");
        }
    }

}
