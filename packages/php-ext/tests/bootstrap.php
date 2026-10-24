<?php

declare(strict_types=1);

// The PHPUnit bootstrap of packages/php-ext (phpunit.xml.dist): the test package owns native extension cases and reuses
// the PHP client's fixture helpers, while PHPUnit loads the development root Composer autoloader first.
if (getenv('ORM_PHP_MODE') !== 'extension') {
    throw new RuntimeException('ORM_PHP_MODE must be extension for the PHP extension test package');
}
if (!extension_loaded('polyspec_orm')) {
    throw new RuntimeException(
        'the extension polyspec_orm is not loaded; run make dbspec-php-extension-check, which builds and loads it'
    );
}
require_once dirname(__DIR__, 2) . '/php/tests/bootstrap.php';
require_once dirname(__DIR__, 2) . '/php/tests/MarkdownConformanceTest.php';
// The functions that DeclarationsTest.php shares with declarations.php, which it runs as a child process.
require_once __DIR__ . '/declarations_functions.php';
require_once __DIR__ . '/UninitializedRecordingPdo.php';
require_once __DIR__ . '/NativeTestEventLog.php';
require_once dirname(__DIR__, 2) . '/php/tests/FailingStatement.php';
require_once dirname(__DIR__, 2) . '/php/tests/FailingPdo.php';
require_once dirname(__DIR__, 2) . '/php/tests/ModelTestFailingPdo.php';
require_once dirname(__DIR__, 2) . '/php/tests/TransactionFailureCases.php';
require_once dirname(__DIR__, 2) . '/php/tests/CoverageConformanceVerificationTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/CoverageConstraintsAndRelationsTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/CoverageDsnTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/CoverageTransactionsTest.php';
require_once dirname(__DIR__, 2) . '/php/tests/dbspec_verify_errors_case.php';
