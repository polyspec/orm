<?php

declare(strict_types=1);

// The guarantee of a run against the extension polyspec_orm (ORM_PHP_MODE=extension, T182-6-19): it tests the
// classes of the extension, so no file of the PHP library (packages/php/src) may load in it. The Composer autoloader
// of the run still maps Polyspec\Orm\ to src, and it loads a file only for a class the extension does not define, so
// a loaded source file is a fallback class that stood in for the extension. The bootstrap registers
// guardExtensionRun, which fails the run at its end and names the files.

/**
 * The files of $files that lie in the folder $source.
 *
 * @param list<string> $files
 * @return list<string>
 */
function librarySourcesLoaded(array $files, string $source): array
{
    $prefix = rtrim($source, '/') . '/';
    return array_values(array_filter($files, static fn(string $file): bool => str_starts_with($file, $prefix)));
}

/** Fails the run at its end, with exit status 1, when it loaded a file of the folder $source. */
function guardExtensionRun(string $source): void
{
    register_shutdown_function(static function () use ($source): void {
        $loaded = librarySourcesLoaded(get_included_files(), $source);
        if ($loaded !== []) {
            fwrite(STDERR, 'an extension run loaded ' . count($loaded) . ' file(s) of the PHP library, so a fallback '
                . 'class stood in for the extension: ' . implode(', ', $loaded) . "\n");
            exit(1);
        }
    });
}
