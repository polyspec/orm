<?php

declare(strict_types=1);

// The focused syntax analysis case shared by the PHP client and the extension (docs/spec/dbspec.md "Syntax analysis"):
// [text, expected tokens as [line, start, end, class]] of the one main document "d". Its text holds an invalid UTF-8
// byte, which a recipe text (a JSON string) cannot hold; the other focused cases are cases of
// tests/dbspec/canonical.json and tests/dbspec/invalid.json.

/** @return array<string, array{0: string, 1: list<array{0:int,1:int,2:int,3:string}>}> */
function dbspec_analysis_focused_cases(): array
{
    $focused = [
    // R15 and R7: an invalid UTF-8 byte is one column and gives no token; the stop line is lexical.
    'invalid-byte-stop-line' => [
        "dbspec 1 d\n table \xff t {\n",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [2, 1, 6, 'word'], [2, 9, 10, 'word'], [2, 11, 12, 'punctuation']],
    ],
    ];
    return $focused;
}
