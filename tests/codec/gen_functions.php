<?php

// The functions of the codec vector generator (gen.php), which requires this file.
declare(strict_types=1);

use Symfony\Component\Yaml\Yaml;

function encode(array $styles, mixed $v): ?string
{
    if ($v === null) {
        return null;
    }
    $cur = null;
    $value = $v;
    foreach ($styles as $st) {
        $cur = match ($st) {
            'serialize' => serialize($value),
            'yaml' => Yaml::dump(
                $value,
                20,
                2,
                Yaml::DUMP_EXCEPTION_ON_INVALID_TYPE | Yaml::DUMP_EMPTY_ARRAY_AS_SEQUENCE
                    | Yaml::DUMP_NUMERIC_KEY_AS_STRING
            ),
            'json', 'jsons' => json_encode(
                $value,
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR
            ),
            'base64' => base64_encode($cur),
            'gz' => gzcompress($cur, 9),
        };
    }
    return $cur;
}
