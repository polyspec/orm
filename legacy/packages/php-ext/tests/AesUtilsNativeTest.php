<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\Model;
use Polyspec\Orm\Orm;

#[Medium]
final class AesUtilsNativeTest extends TestCase
{
    // Requirements: INT-156b.
    public function testStatusAndRotateCheckKeyringTypeBeforeModelMetadata(): void
    {
        self::assertTrue((new \ReflectionClass(\Polyspec\Orm\AesUtils::class))->isInternal());
        $path = tempnam(sys_get_temp_dir(), 'orm-aes-rotate-type-');
        self::assertIsString($path);
        try {
            $db = Orm::connect('sqlite:///' . $path, new Config());
            $model = new class extends Model {
                public static function meta(): array
                {
                    return [];
                }
            };
            $events = [];
            $unsubscribe = $db->subscribe(static function ($event) use (&$events): void {
                $events[] = $event;
            });
            $aes = $db->utils()->aes();
            foreach (['status', 'rotate'] as $method) {
                for ($attempt = 0; $attempt < 2; $attempt++) {
                    try {
                        $aes->$method($model, new \stdClass());
                        self::fail("$method accepted an object that is not an AesKeyring");
                    } catch (\TypeError $error) {
                        self::assertSame("AesUtils::$method expects an AesKeyring", $error->getMessage());
                    }
                    self::assertSame([], $events);
                }
            }
            $unsubscribe();
            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }
}
