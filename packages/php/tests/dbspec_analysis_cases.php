<?php

declare(strict_types=1);

// The focused syntax analysis cases shared by the PHP client and the extension (docs/spec/dbspec.md "Syntax analysis"):
// each is [text, expected tokens as [line, start, end, class]] of the one main document "d".

/** @return array<string, array{0: string, 1: list<array{0:int,1:int,2:int,3:string}>}> */
function dbspec_analysis_focused_cases(): array
{
    $focused = [];
    $focused = [
    'header-and-table' => [
        "dbspec 1 d\ntable t {\n  id i64\n}\n",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [2, 0, 5, 'keyword'], [2, 6, 7, 'name'], [2, 8, 9, 'punctuation'],
            [3, 2, 4, 'name'], [3, 5, 8, 'type'],
            [4, 0, 1, 'punctuation']],
    ],
    // R1: a line with a syntax diagnostic has only word tokens; its punctuation and operators keep their class.
    'abandoned-column-line' => [
        "dbspec 1 d\ntable t {\n  id i64 bogus\n}\n",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [2, 0, 5, 'keyword'], [2, 6, 7, 'name'], [2, 8, 9, 'punctuation'],
            [3, 2, 4, 'word'], [3, 5, 8, 'word'], [3, 9, 14, 'word'],
            [4, 0, 1, 'punctuation']],
    ],
    // Lexical classes on an abandoned line: operators, a dotted word, a number and a string.
    'abandoned-lexical-classes' => [
        "dbspec 1 d\n-> <> <= >= = a.b 1.5 'x''y' \n",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [2, 0, 1, 'operator'], [2, 1, 2, 'operator'], [2, 3, 5, 'operator'], [2, 6, 8, 'operator'],
            [2, 9, 11, 'operator'], [2, 12, 13, 'operator'], [2, 14, 17, 'word'], [2, 18, 21, 'number'],
            [2, 22, 28, 'string']],
    ],
    // A comment line: one comment token from its # to the line end, after its leading spaces.
    'comment-line' => [
        "dbspec 1 d\n  # a note\n",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [2, 2, 10, 'comment']],
    ],
    // R2 and R7: a tab is an offending character and its line is abandoned; the rest of the line is lexed.
    'tab-abandons-line' => [
        "dbspec 1 d\n\tuse x\n",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [2, 1, 4, 'word'], [2, 5, 6, 'word']],
    ],
    // The shared encoding case: the lines before the encoding stop keep their parse classes, and the
    // stop line and the lines after it are lexical (R8, R17).
    'encoding-after-a-syntax-error' => [
        "dbspec 1 d\n\ntable t {\n  id i64 bogus\n  primary key (id)\n}\n\n# x\ry",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [3, 0, 5, 'keyword'], [3, 6, 7, 'name'], [3, 8, 9, 'punctuation'],
            [4, 2, 4, 'word'], [4, 5, 8, 'word'], [4, 9, 14, 'word'],
            [5, 2, 9, 'keyword'], [5, 10, 13, 'keyword'], [5, 14, 15, 'punctuation'], [5, 15, 17, 'name'], [5, 17, 18, 'punctuation'],
            [6, 0, 1, 'punctuation'],
            [8, 0, 5, 'comment']],
    ],
    // R15 and R7: an invalid UTF-8 byte is one column and gives no token; the stop line is lexical.
    'invalid-byte-stop-line' => [
        "dbspec 1 d\n table \xff t {\n",
        [[1, 0, 6, 'keyword'], [1, 7, 8, 'number'], [1, 9, 10, 'name'],
            [2, 1, 6, 'word'], [2, 9, 10, 'word'], [2, 11, 12, 'punctuation']],
    ],
    // R21: a byte order mark is an offending character that counts one column; the stop line is lexical.
    'byte-order-mark-stop' => [
        "\xEF\xBB\xBFdbspec 1 d\n",
        [[1, 1, 7, 'word'], [1, 8, 9, 'number'], [1, 10, 11, 'word']],
    ],
    ];
    return $focused;
}
