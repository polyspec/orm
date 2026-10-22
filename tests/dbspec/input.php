<?php

declare(strict_types=1);

// The tests/dbspec runners read input files. An unreadable input does not become empty text,
// but writes "<path>: <reason>" to stderr and exits 1.

/** Returns the content of $path. If it is a directory or an unreadable file, it writes that path and the reason and ends. */
function dbspec_read_input(string $path): string
{
    // PHP can open a directory and returns empty text when reading it, so it rejects that first.
    if (is_dir($path)) {
        fwrite(STDERR, "$path: is a directory\n");
        exit(1);
    }
    // phpcs:ignore Generic.PHP.NoSilencedErrors.Discouraged -- the warning text is the reason that the runner prints, read by error_get_last
    $text = @file_get_contents($path);
    if ($text === false) {
        $reason = error_get_last()['message'] ?? 'cannot be read';
        fwrite(STDERR, "$path: $reason\n");
        exit(1);
    }
    return $text;
}
