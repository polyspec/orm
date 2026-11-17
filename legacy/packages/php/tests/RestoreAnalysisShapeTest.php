<?php

// Requirements: INT-191, PRT-91. Dynamic request shape before schema lookup.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\OrmException;

#[Medium]
class RestoreAnalysisShapeTest extends TestCase
{
    public static function cases(): iterable
    {
        $path = ormLegacyRoot() . '/tests/ir/restore-analysis-shape.json';
        $cases = json_decode((string) file_get_contents($path), true, 32, JSON_THROW_ON_ERROR);
        foreach ($cases as $case) {
            yield $case['id'] => [$case];
        }
    }

    #[DataProvider('cases')]
    public function testShape(array $fixture): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-restore-shape-');
        self::assertIsString($path);
        $db = \Polyspec\Orm\Tests\Model\connect('sqlite://' . $path, new Config());
        $request = $fixture['request'];
        if ($fixture['use_fixture_hash'] ?? false) {
            $request['manifest_hash'] = \Polyspec\Orm\Tests\Model\MANIFEST_HASH;
        }
        $before = $request;
        try {
            if (isset($fixture['analysis'])) {
                self::assertSame($fixture['analysis'], $db->analyzeRestore($request));
            } else {
                try {
                    $db->analyzeRestore($request);
                    self::fail('restore analysis accepted the malformed or unregistered request');
                } catch (\Throwable $error) {
                    self::assertInstanceOf(OrmException::class, $error);
                    self::assertSame($fixture['code'], $error->code_);
                    self::assertSame($fixture['message'], $error->getMessage());
                }
            }
            self::assertSame($before, $request, 'analysis preserves the raw request');
        } finally {
            $db->close();
            unlink($path);
        }
    }
}
