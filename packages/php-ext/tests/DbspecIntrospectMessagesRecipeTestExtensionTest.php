<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\DbspecIntrospectMessagesRecipeTest;

// The SQLite unsupported column reason of tests/dbspec/introspect-messages.json on a memory connection, through the PHP extension (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DIA-191.
#[\PHPUnit\Framework\Attributes\Medium]
final class DbspecIntrospectMessagesRecipeTestExtensionTest extends DbspecIntrospectMessagesRecipeTest
{
}
