<?php

declare(strict_types=1);

use function Polyspec\Orm\Tests\dbspec_behaviour_cases;

// Records the outcomes of the dbspec behaviour cases (packages/php/tests/dbspec_behaviour.php) that the PHP library
// gives into packages/php/tests/fixtures/dbspec-behaviour.json, which DbspecBehaviourTest compares with. It runs the
// PHP library only: a process with the extension loaded is refused, since the record is the PHP client's.
//
// Usage: php packages/php/testing/dbspec/behaviour.php

if (extension_loaded('polyspec_orm')) {
    fwrite(
        STDERR,
        "behaviour.php: the extension polyspec_orm is loaded; record with the PHP library, without the extension\n"
    );
    exit(1);
}
$root = dirname(__DIR__, 4);
require "$root/vendor-php/autoload.php";
require "$root/packages/php/tests/case_clock.php";
require "$root/tests/dbspec/vectors.php";
require "$root/tests/dbspec/cases.php";
require "$root/packages/php/tests/dbspec_cases.php";
require "$root/packages/php/tests/dbspec_plan_cases.php";
require "$root/packages/php/tests/dbspec_behaviour.php";

$cases = [];
foreach (dbspec_behaviour_cases() as $name => $case) {
    $cases[$name] = $case();
}
$path = "$root/packages/php/tests/fixtures/dbspec-behaviour.json";
if (!is_dir(dirname($path)) && !mkdir(dirname($path), 0o755, true)) {
    fwrite(STDERR, "behaviour.php: cannot create " . dirname($path) . "\n");
    exit(1);
}
$text = json_encode(
    [
        'comment' => 'The outcomes of the PHP dbspec behaviour cases (packages/php/tests/dbspec_behaviour.php), '
            . 'recorded from the PHP library by packages/php/testing/dbspec/behaviour.php. DbspecBehaviourTest '
            . 'compares the PHP library and the extension with them.',
        'cases' => $cases
    ],
    JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
        | JSON_THROW_ON_ERROR
) . "\n";
file_put_contents("$path.tmp", $text);
rename("$path.tmp", $path);
fwrite(
    STDERR,
    'behaviour.php: ' . count($cases) . " cases recorded into packages/php/tests/fixtures/dbspec-behaviour.json\n"
);
