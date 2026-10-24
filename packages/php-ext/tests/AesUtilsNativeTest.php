<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\AesKeyring;
use Polyspec\Orm\Code;
use Polyspec\Orm\Codec;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\Model\Author;

#[Medium]
final class AesUtilsNativeTest extends TestCase
{
    public function testNativeStatusRotationAndTransactionRollback(): void
    {
        self::assertTrue(
            (new ReflectionClass(\Polyspec\Orm\AesUtils::class))->isInternal(),
        );
        $path = tempnam(sys_get_temp_dir(), 'orm-aes-native-');
        self::assertIsString($path);
        try {
            $db = Orm::connect(
                'sqlite:///' . $path,
                new Config(aesVersion: 2, aesKeys: [1 => 'old-key', 2 => 'new-key']),
            );
            $pdo = $db->pdo();
            $pdo->exec(
                'CREATE TABLE author (seq INTEGER PRIMARY KEY, aes_key_version INTEGER NOT NULL, '
                . 'aes_hex_email TEXT, aes_hex_phone TEXT)',
            );
            $insert = $pdo->prepare(
                'INSERT INTO author (seq, aes_key_version, aes_hex_email, aes_hex_phone) '
                . 'VALUES (?, ?, ?, ?)',
            );
            $insert->execute([
                1,
                1,
                Codec::hostEncode('first@example.test', ['aes', 'hex'], 'old-key'),
                Codec::hostEncode('+1-555-0100', ['aes', 'hex'], 'old-key'),
            ]);
            $keyring = new AesKeyring([1 => 'old-key', 2 => 'new-key'], 2);
            $aes = $db->utils()->aes();

            $before = $aes->status(new Author(), $keyring);
            self::assertSame(1, $before->total);
            self::assertSame(1, $before->pending);
            self::assertSame([1 => 1], $before->versions);
            self::assertSame(1, $aes->rotate(new Author(), $keyring));
            $after = $aes->status(new Author(), $keyring);
            self::assertSame(0, $after->pending);
            self::assertSame([2 => 1], $after->versions);

            $insert->execute([
                2,
                1,
                Codec::hostEncode('rollback@example.test', ['aes', 'hex'], 'old-key'),
                null,
            ]);
            $pdo->exec(
                'CREATE TRIGGER reject_aes_rotation BEFORE UPDATE ON author '
                . 'BEGIN SELECT RAISE(IGNORE); END',
            );
            try {
                $aes->rotate(new Author(), $keyring);
                self::fail(
                    'an ignored optimistic update did not abort the rotation transaction',
                );
            } catch (OrmException $error) {
                self::assertSame(Code::DEADLOCK, $error->code_);
            }
            self::assertSame(1, (int) $pdo->query('SELECT aes_key_version FROM author WHERE seq = 2')->fetchColumn());
            $pdo->exec('DROP TRIGGER reject_aes_rotation');
            $db->close();
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }
}
