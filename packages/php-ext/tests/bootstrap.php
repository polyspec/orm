<?php

declare(strict_types=1);

// The PHPUnit bootstrap of packages/php-ext (phpunit.xml.dist): the test package owns native extension cases and reuses
// the PHP client's fixture helpers, while PHPUnit loads the development root Composer autoloader first.
if (getenv('ORM_PHP_MODE') !== 'extension') {
    throw new RuntimeException('ORM_PHP_MODE must be extension for the PHP extension test package');
}
require_once __DIR__ . '/PhpExtensionBootstrapAssertions.php';
\Polyspec\Orm\Extension\Tests\PhpExtensionBootstrapAssertions::requireLoaded();
require_once dirname(__DIR__, 2) . '/php/tests/bootstrap.php';
require_once dirname(__DIR__, 2) . '/php/tests/MarkdownConformanceTest.php';
require_once __DIR__ . '/ModelAssemblyFixture.php';
require_once __DIR__ . '/ModelAssemblyTestSupport.php';
require_once __DIR__ . '/ModelTypesPendingFixture.php';
// The functions that DeclarationsTest.php shares with declarations.php, which it runs as a child process.
require_once __DIR__ . '/declarations_functions.php';
require_once __DIR__ . '/NativeTestEventLog.php';
require_once dirname(__DIR__, 2) . '/php/tests/FailingStatement.php';
require_once dirname(__DIR__, 2) . '/php/tests/FailingPdo.php';
require_once dirname(__DIR__, 2) . '/php/tests/ModelTestFailingPdo.php';
require_once dirname(__DIR__, 2) . '/php/tests/TransactionFailureCases.php';
require_once dirname(__DIR__, 2) . '/php/tests/CoverageConformanceVerificationTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/CoverageConstraintsAndRelationsTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/CoverageDsnTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/CoverageTransactionsTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/CoverageAuditTriggersTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/CoverageAuditColumnsTest.php';
require_once __DIR__ . '/NativeMethodAssertions.php';
require_once dirname(__DIR__, 2) . '/php/tests/dbspec_verify_errors_case.php';
// The library tests that the extension tests extend or call, and the helper classes of the extension tests, one
// class per file (PSR-1).
require_once dirname(__DIR__, 2) . '/php/tests/SchemaSetTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/CoverageSchemaDefinitionTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/CoverageRequestHookTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/AggregateNumericTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/DecimalModelTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/IdentityLoadTest.php';
require_once __DIR__ . '/model-weak-caller.php';
require_once __DIR__ . '/AuditLazyFakePdo.php';
require_once __DIR__ . '/AuditLazyFakeStatement.php';
require_once __DIR__ . '/ChainNativeRegistryFixture.php';
require_once __DIR__ . '/CollectionFakePdo.php';
require_once __DIR__ . '/CollectionFixtureModel.php';
require_once __DIR__ . '/ConnectionTimeoutCleanupPdo.php';
require_once __DIR__ . '/ConnectionTimeoutCleanupStatement.php';
require_once __DIR__ . '/CoverageNativeDecimalModel.php';
require_once __DIR__ . '/NativeModelFixture.php';
require_once __DIR__ . '/ModelReadShapeFixture.php';
require_once __DIR__ . '/ModelReadWarningStream.php';
require_once __DIR__ . '/ModelStreamFixture.php';
require_once __DIR__ . '/ModelStreamWarningWrapper.php';
require_once __DIR__ . '/RuntimeModelGeneratedFixture.php';
require_once __DIR__ . '/RuntimeModelBadGeneratedFixture.php';
require_once __DIR__ . '/DslFixture.php';
