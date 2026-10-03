<?php

declare(strict_types=1);

// tests/dbspec runner가 input file을 읽는다. 읽을 수 없는 input은 빈 text가 되지 않고
// "<path>: <reason>"을 stderr에 쓰고 1로 끝난다.

/** $path의 내용을 돌려준다. directory나 읽을 수 없는 file이면 그 경로와 이유를 쓰고 끝낸다. */
function dbspec_read_input(string $path): string
{
    // PHP는 directory를 열 수 있고 읽기에서 빈 text를 돌려주므로 먼저 거부한다.
    if (is_dir($path)) {
        fwrite(STDERR, "$path: is a directory\n");
        exit(1);
    }
    $text = @file_get_contents($path);
    if ($text === false) {
        $reason = error_get_last()['message'] ?? 'cannot be read';
        fwrite(STDERR, "$path: $reason\n");
        exit(1);
    }
    return $text;
}
