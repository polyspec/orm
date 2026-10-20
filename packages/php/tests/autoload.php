<?php

declare(strict_types=1);

// Test autoloader: the Composer autoloader of the repository root, which maps Polyspec\Orm\ to packages/php/src by the
// PSR-4 of the library and the test models Polyspec\Orm\Tests\Model\ (packages/php/gen) and
// Polyspec\Orm\Tests\MarkdownModel\ (packages/php/markdownmodel) by its autoload-dev, which also loads
// packages/php/gen/bootstrap.php, the registration of the generated test models.
require_once dirname(__DIR__, 3) . '/vendor-php/autoload.php';
require_once __DIR__ . '/bench.php';
