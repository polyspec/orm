<?php

declare(strict_types=1);

// The guarantee of a run against the extension polyspec_orm (ORM_PHP_MODE=extension, T182-6-19): it tests the
// classes of the extension, so no class that the extension provides may load from the PHP library (packages/php/src).
// The Composer autoloader of the run still maps Polyspec\Orm\ to src, and it loads a file only for a class the
// extension does not define. A loaded file is a fallback when its class is one the extension declares, as the symbol
// record contracts/symbols/php-extension.json lists it; a file of the library that the extension does not provide,
// such as the generator OrmGen, is no fallback (T302). The bootstrap registers guardExtensionRun, which fails the run
// at its end and names the files.

/**
 * The classes that the symbol record $symbols declares: its keys of the form <file>::<class>, without a member.
 *
 * @param array<string, mixed> $symbols
 * @return array<string, true>
 */
function extensionClasses(array $symbols): array
{
    $classes = [];
    foreach (array_keys($symbols) as $key) {
        $parts = explode('::', $key);
        if (count($parts) === 2) {
            $classes[$parts[1]] = true;
        }
    }
    return $classes;
}

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
 * Fails the run at its end, with exit status 1, when it loaded a file of the folder $source that holds a class the
 * symbol record $symbolsFile declares.
 */
function guardExtensionRun(string $source, string $symbolsFile): void
{
    $text = file_get_contents($symbolsFile);
    if ($text === false) {
        throw new RuntimeException("$symbolsFile is missing; the extension run guard reads it");
    }
    $symbols = json_decode($text, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($symbols)) {
        throw new RuntimeException("$symbolsFile is not a symbol record");
    }
    $classes = extensionClasses($symbols);
    register_shutdown_function(static function () use ($source, $classes): void {
        $loaded = librarySourcesLoaded(get_included_files(), $source, $classes);
        if ($loaded !== []) {
            fwrite(STDERR, 'an extension run loaded ' . count($loaded) . ' file(s) of the PHP library, so a fallback '
                . 'class stood in for the extension: ' . implode(', ', $loaded) . "\n");
            exit(1);
        }
    });
}
