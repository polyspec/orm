<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal Loads the SQLite progress callback packaged for this platform. */
final class SqliteCancellation
{
    private static ?string $extension = null;

    public static function attach(\PDO $pdo, string $statePath, int $slot): void
    {
        if (!$pdo instanceof \Pdo\Sqlite) {
            throw new OrmException(Code::CAPABILITY_UNSUPPORTED, 'SQLite cancellation needs PHP 8.4 Pdo\\Sqlite');
        }
        $extension = self::extension();
        static $loaded = new \WeakMap();
        if (!isset($loaded[$pdo])) {
            $pdo->loadExtension($extension);
            $loaded[$pdo] = true;
        }
        $statement = $pdo->prepare('SELECT orm_cancel_attach(?, ?)');
        $statement->execute([$statePath, $slot]);
        $statement->fetchColumn();
        $statement->closeCursor();
    }

    private static function extension(): string
    {
        if (self::$extension !== null) {
            return self::$extension;
        }
        $package = \Composer\InstalledVersions::getInstallPath('polyspec/orm');
        if ($package === null) {
            throw new OrmException(Code::CONFIG, 'Composer does not declare the polyspec/orm package install path');
        }
        $platform = strtolower(PHP_OS_FAMILY) . '-' . strtolower(php_uname('m'));
        $suffix = PHP_OS_FAMILY === 'Darwin' ? '.dylib' : (PHP_OS_FAMILY === 'Windows' ? '.dll' : '.so');
        $extension = $package . '/src/native/bin/' . $platform . '/orm_cancel' . $suffix;
        if (!is_file($extension)) {
            throw new OrmException(
                Code::CAPABILITY_UNSUPPORTED,
                "SQLite cancellation helper for $platform is not installed in the polyspec/orm package"
            );
        }
        self::$extension = $extension;
        return $extension;
    }
}
