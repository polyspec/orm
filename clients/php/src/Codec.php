<?php
declare(strict_types=1);

namespace Orm;

/** Column-style codecs (docs/codec.md). Styles are in write order; decode applies them in reverse. */
final class Codec
{
    /** @param list<string> $styles */
    public static function decode(array $styles, mixed $raw): mixed
    {
        if ($raw === null || $raw === '') {
            return null;
        }
        if (!is_string($raw)) {
            throw new OrmException('CODEC_DECODE', 'cell is not a string');
        }
        $v = $raw;
        for ($i = count($styles) - 1; $i >= 0; $i--) {
            switch ($styles[$i]) {
                case 'gz':
                    $v = @gzuncompress($v);
                    if ($v === false) {
                        throw new OrmException('CODEC_DECODE', 'gz: bad zlib stream');
                    }
                    break;
                case 'base64':
                    $v = base64_decode(trim($v), true);
                    if ($v === false) {
                        throw new OrmException('CODEC_DECODE', 'base64: bad input');
                    }
                    break;
                case 'serialize':
                    if (preg_match('/^(O|C|r|R):/', $v) === 1 || str_contains($v, ';O:') || str_contains($v, ';C:')) {
                        throw new OrmException('CODEC_UNSUPPORTED', 'serialize: objects and references are not supported');
                    }
                    $v = @unserialize($v, ['allowed_classes' => false]);
                    if ($v === false && $raw !== serialize(false)) {
                        throw new OrmException('CODEC_DECODE', 'serialize: bad format');
                    }
                    $v = self::normalize($v);
                    break;
                case 'json':
                case 'jsons':
                    try {
                        $v = json_decode($v, true, 512, JSON_THROW_ON_ERROR);
                    } catch (\JsonException $e) {
                        throw new OrmException('CODEC_DECODE', 'json: ' . $e->getMessage());
                    }
                    break;
                default:
                    throw new OrmException('CODEC_UNSUPPORTED', "style {$styles[$i]}");
            }
        }
        return $v;
    }

    /** @param list<string> $styles */
    public static function encode(array $styles, mixed $v): ?string
    {
        if ($v === null) {
            return null;
        }
        $cur = null;
        foreach ($styles as $i => $st) {
            switch ($st) {
                case 'serialize':
                    $cur = serialize($v);
                    break;
                case 'json':
                case 'jsons':
                    $cur = json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
                    break;
                case 'base64':
                    $cur = base64_encode($cur);
                    break;
                case 'gz':
                    $cur = gzcompress($cur, 9);
                    break;
                default:
                    throw new OrmException('CODEC_UNSUPPORTED', "style $st");
            }
        }
        return $cur;
    }

    /** Decodes every styled cell of a positional row in place (joins included). */
    public static function decodeRow(array &$vals, array $asm): void
    {
        foreach ($asm['columns'] as $c) {
            if (!empty($c['styles'])) {
                $vals[$c['index']] = self::decode($c['styles'], $vals[$c['index']]);
            }
        }
        foreach ($asm['children'] ?? [] as $ch) {
            if ($ch['kind'] === 'join') {
                self::decodeRow($vals, $ch['assemble']);
            }
        }
    }

    /** @param array $asm */
    public static function hasStyled(array $asm): bool
    {
        foreach ($asm['columns'] as $c) {
            if (!empty($c['styles'])) {
                return true;
            }
        }
        foreach ($asm['children'] ?? [] as $ch) {
            if ($ch['kind'] === 'join' && self::hasStyled($ch['assemble'])) {
                return true;
            }
        }
        return false;
    }

    /** unserialize gives PHP arrays as-is; nothing to change in the value model (int keys stay int keys). */
    private static function normalize(mixed $v): mixed
    {
        return $v;
    }
}
