<?php

// The peak of one parse of the limit/columns document, measured in a process of its own with PHP's default memory
// limit, so that the memory held by the test run does not change the measurement (KSTD-5-58). It reads the document
// from stdin and prints one JSON line with whether the parse returned a document and the baseline and peak memory.
declare(strict_types=1);

require dirname(__DIR__, 3) . '/vendor-php/autoload.php';

$text = (string) stream_get_contents(STDIN);
$baseline = memory_get_usage();
$result = \Polyspec\Orm\Dbspec\Dbspec::parse($text, []);
echo json_encode(
    ['document' => $result->document !== null, 'baseline' => $baseline, 'peak' => memory_get_peak_usage()],
    JSON_THROW_ON_ERROR,
), "\n";
