<?php

// Prints the comment tokens of PHP source files, which token_get_all reads: T_COMMENT (// and #, and /* */) and
// T_DOC_COMMENT (/** */). An attribute (#[...]) is its own token and is not a comment. The file paths come one per
// line on standard input. The output is one JSON array per path, in input order; each entry holds the line, the
// column (always 0: token_get_all gives lines only) and the text of one token, and a multi-line token keeps its
// newlines in text.

declare(strict_types=1);

$paths = array_values(array_filter(array_map('trim', explode("\n", stream_get_contents(STDIN))), 'strlen'));
$out = [];
$failed = false;
foreach ($paths as $path) {
    $source = file_get_contents($path);
    if ($source === false) {
        fwrite(STDERR, "php-comments: cannot read $path\n");
        $failed = true;
        $out[] = [];
        continue;
    }
    $entries = [];
    foreach (token_get_all($source) as $token) {
        if (is_array($token)) {
            [$id, $text, $tokenLine] = $token;
            if ($id === T_COMMENT || $id === T_DOC_COMMENT) {
                $entries[] = ['line' => $tokenLine, 'col' => 0, 'text' => $text];
            }
        }
    }
    $out[] = $entries;
}
if ($failed) {
    exit(1);
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), "\n";
