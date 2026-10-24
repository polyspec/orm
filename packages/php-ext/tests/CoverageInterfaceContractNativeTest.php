<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\TestCase;

final class CoverageInterfaceContractNativeTest extends TestCase
{
    // Requirements: INT-17, INT-18, INT-19, INT-57, INT-61, INT-64.
    public function testInterfaceSymbols(): void
    {
        $symbols = json_decode(
            (string) file_get_contents(dirname(__DIR__, 3) . '/contracts/symbols/php-extension.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        foreach ($symbols as $key => $symbol) {
            if (!$symbol['exported']) {
                continue;
            }
            $name = substr($key, strpos($key, '::') + 2);
            $memberAt = strrpos($name, '::');
            if ($memberAt === false) {
                $registered = class_exists($name, false)
                    || interface_exists($name, false)
                    || trait_exists($name, false);
                Assert::assertTrue(
                    $registered,
                    "$name was not registered by polyspec_orm"
                );
                $class = new \ReflectionClass($name);
                Assert::assertTrue($class->isInternal(), "$name is not internal");
                Assert::assertSame('polyspec_orm', $class->getExtensionName(), "$name is not owned by polyspec_orm");
                continue;
            }

            $className = substr($name, 0, $memberAt);
            $member = substr($name, $memberAt + 2);
            $registered = class_exists($className, false)
                || interface_exists($className, false)
                || trait_exists($className, false);
            Assert::assertTrue(
                $registered,
                "$className was not registered by polyspec_orm"
            );
            $class = new \ReflectionClass($className);
            if (str_starts_with($member, '$')) {
                $property = $class->getProperty(substr($member, 1));
                Assert::assertTrue($property->getDeclaringClass()->isInternal(), "$className::$member is not internal");
                continue;
            }
            if (str_starts_with($symbol['signature'], 'public const')) {
                $constant = $class->getReflectionConstant($member);
                Assert::assertNotFalse($constant, "$className::$member is missing");
                Assert::assertTrue($constant->getDeclaringClass()->isInternal(), "$className::$member is not internal");
                continue;
            }

            $method = $class->getMethod($member);
            Assert::assertTrue($method->isInternal(), "$className::$member is not internal");
            Assert::assertSame(
                'polyspec_orm',
                $method->getExtensionName(),
                "$className::$member is not owned by polyspec_orm"
            );
        }
    }
}
