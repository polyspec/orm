<?php

declare(strict_types=1);

/**
 * Requires the generated model classes of the folder $dir, every PHP file of it except bootstrap.php and
 * schema_declarations.php, so a test loads the models that it generated without an autoloader of its own (S2). A model
 * class extends Model of the library only, so the order of the files does not matter; the test requires bootstrap.php
 * itself, when its case needs the registration. A folder that cannot be listed or holds no class fails the test.
 */
function requireGeneratedClasses(string $dir): void
{
    $files = glob("$dir/*.php");
    if ($files === false) {
        throw new RuntimeException("the generated models of $dir cannot be listed");
    }
    $classes = array_values(array_filter(
        $files,
        static fn(string $file): bool => !in_array(basename($file), ['bootstrap.php', 'schema_declarations.php'], true)
    ));
    if ($classes === []) {
        throw new RuntimeException("$dir holds no generated model class");
    }
    foreach ($classes as $file) {
        require_once $file;
    }
}
