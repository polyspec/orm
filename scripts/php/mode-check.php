<?php

// Asserts that the declared PHP mode agrees with the runtime: ORM_PHP_MODE is `library` when the PHP client runs without its
// extension and `extension` when the extension polyspec_orm is loaded. The make targets that run PHP tests set the mode and run
// this check first; a test and an implementation read ORM_PHP_MODE and never ask extension_loaded themselves. It exits 1 and
// names both values when they disagree, and it reports nothing else. Usage: php scripts/php/mode-check.php

$mode = getenv('ORM_PHP_MODE');
if ($mode !== 'library' && $mode !== 'extension') {
    fwrite(STDERR, "mode-check: ORM_PHP_MODE must be library or extension, not " . var_export($mode, true) . "\n");
    exit(1);
}
$loaded = extension_loaded('polyspec_orm');
if ($loaded !== ($mode === 'extension')) {
    fwrite(
        STDERR,
        'mode-check: ORM_PHP_MODE is ' . $mode . ' but extension polyspec_orm is ' . ($loaded ? 'loaded' : 'not loaded') . "\n"
    );
    exit(1);
}
exit(0);
