<?php

declare(strict_types=1);

// The guarantee of a run against the extension polyspec_orm (ORM_PHP_MODE=extension, T182-6-19): it tests the
// classes of the extension, so no class that the extension provides may load from the PHP library (packages/php/src).
// The Composer autoloader of the run still maps Polyspec\Orm\ to src, and it loads a file only for a class the
// extension does not define. A loaded file is a fallback when its class is one the extension registers, as
// ReflectionExtension of the loaded polyspec_orm names it; a file of the library that the extension does not provide,
// such as the generator OrmGen, is no fallback (T302). The bootstrap registers guardExtensionRun, which fails the run
// at its end and names the files.

/**
 * The files of $files that lie in the folder $source and hold, by the PSR-4 map of Polyspec\Orm\ to that folder, a
 * class of $classes.
 *
 * @param list<string> $files
 * @param array<string, true> $classes
 * @return list<string>
 */
function librarySourcesLoaded(array $files, string $source, array $classes): array
{
    $prefix = rtrim($source, '/') . '/';
    return array_values(array_filter($files, static function (string $file) use ($prefix, $classes): bool {
        if (!str_starts_with($file, $prefix) || !str_ends_with($file, '.php')) {
            return false;
        }
        $class = 'Polyspec\\Orm\\' . str_replace('/', '\\', substr($file, strlen($prefix), -strlen('.php')));
        return isset($classes[$class]);
    }));
}

/**
 * Fails the run at its end, with exit status 1, when it loaded a file of the folder $source that holds a class of
 * $classNames, the classes that the extension registers.
 *
 * @param list<string> $classNames
 */
function guardExtensionRun(string $source, array $classNames): void
{
    if ($classNames === []) {
        throw new RuntimeException('the extension run guard has no class of the extension to guard');
    }
    $classes = array_fill_keys($classNames, true);
    register_shutdown_function(static function () use ($source, $classes): void {
        $loaded = librarySourcesLoaded(get_included_files(), $source, $classes);
        if ($loaded !== []) {
            fwrite(STDERR, 'an extension run loaded ' . count($loaded) . ' file(s) of the PHP library, so a fallback '
                . 'class stood in for the extension: ' . implode(', ', $loaded) . "\n");
            exit(1);
        }
    });
}
