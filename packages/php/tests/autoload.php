<?php

declare(strict_types=1);

// Test autoloader: the Composer autoloader of the repository root, which maps Polyspec\Orm\ to packages/php/src by the
// PSR-4 of the library and the test models Polyspec\Orm\Tests\Model\ (packages/php/gen) and
// Polyspec\Orm\Tests\MarkdownModel\ (packages/php/markdownmodel) by its autoload-dev. The generated models are written
// by make php-models (P34), and packages/php/gen/bootstrap.php, the registration of the generated test models, is
// required here.
require_once dirname(__DIR__, 3) . '/vendor-php/autoload.php';
require_once __DIR__ . '/bench.php';
require_once dirname(__DIR__) . '/gen/bootstrap.php';
