<?php

declare(strict_types=1);

// The PHPUnit bootstrap of packages/php (phpunit.xml.dist): the Composer autoloader of the development root (vendor-php),
// which maps Polyspec\Orm\ to src through the path repository of packages/php, and by its autoload-dev the test models
// Polyspec\Orm\Tests\Model\ (gen) and Polyspec\Orm\Tests\MarkdownModel\ (markdownmodel) and gen/bootstrap.php, the
// registration of the generated test models.
require_once dirname(__DIR__, 3) . '/vendor-php/autoload.php';
require_once __DIR__ . '/bench.php';
