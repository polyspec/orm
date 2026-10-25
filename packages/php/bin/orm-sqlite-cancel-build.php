#!/usr/bin/env php
<?php

declare(strict_types=1);

use Composer\InstalledVersions;

// The script declares no symbol (PSR-1): a failure ends it through this closure, which prints the message and exits 1.
$stop = static function (string $message): never {
    fwrite(STDERR, "orm-sqlite-cancel-build: $message\n");
    exit(1);
};

$package = getenv('POLYSPEC_ORM_PACKAGE_ROOT');
if ($package === false || $package === '') {
    if (!class_exists(InstalledVersions::class)) {
        $stop('Composer autoload is unavailable; run this command as vendor/bin/orm-sqlite-cancel-build.php');
    }
    $package = InstalledVersions::getInstallPath('polyspec/orm');
}
if (!is_string($package) || $package === '') {
    $stop('Composer has no install path for polyspec/orm; install the PHP package before building its helper');
}

$source = $package . '/src/native/sqlite_cancel.c';
if (!is_file($source)) {
    $stop('the installed polyspec/orm package has no src/native/sqlite_cancel.c');
}
$include = trim(shell_exec('pkg-config --variable=includedir sqlite3 2>/dev/null') ?: '');
if ($include === '') {
    $stop(
        'pkg-config cannot find SQLite development headers; install the sqlite3 development package and rerun '
            . 'this command',
    );
}

$platform = strtolower(PHP_OS_FAMILY) . '-' . strtolower(php_uname('m'));
$suffix = PHP_OS_FAMILY === 'Darwin' ? '.dylib' : (PHP_OS_FAMILY === 'Windows' ? '.dll' : '.so');
$directory = $package . '/src/native/bin/' . $platform;
if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
    $stop("cannot create helper directory $directory");
}
$output = $directory . '/orm_cancel' . $suffix;
$temporary = $output . '.next-' . getmypid();
register_shutdown_function(static function () use (&$temporary): void {
    if (is_file($temporary)) {
        unlink($temporary);
    }
});
$compiler = getenv('CC') ?: (PHP_OS_FAMILY === 'Windows' ? 'cl' : 'cc');
$command = match (PHP_OS_FAMILY) {
    'Darwin' => [
        $compiler,
        '-fPIC',
        '-dynamiclib',
        '-undefined',
        'dynamic_lookup',
        '-I' . $include,
        $source,
        '-o',
        $temporary,
    ],
    'Linux' => [$compiler, '-fPIC', '-shared', '-I' . $include, $source, '-o', $temporary],
    'Windows' => [
        $compiler,
        '/nologo',
        '/LD',
        '/I' . $include,
        $source,
        '/link',
        '/NOIMPLIB',
        '/NOEXP',
        '/OUT:' . $temporary,
    ],
    default => null,
};
if ($command === null) {
    $stop('this platform has no declared SQLite loadable-extension build command');
}

fwrite(STDOUT, "BUILD $platform SQLite cancellation helper\n");
$pipes = [];
$process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
if (!is_resource($process)) {
    $stop('the C compiler did not start; install a C compiler and rerun this command');
}
fclose($pipes[0]);
$stdout = stream_get_contents($pipes[1]);
fclose($pipes[1]);
$stderr = stream_get_contents($pipes[2]);
fclose($pipes[2]);
$status = proc_close($process);
if ($stdout !== '') {
    fwrite(STDOUT, $stdout);
}
if ($stderr !== '') {
    fwrite(STDERR, $stderr);
}
if ($status !== 0) {
    if (is_file($temporary)) {
        unlink($temporary);
    }
    $stop("the C compiler exited with status $status; verify the SQLite development headers and rerun this command");
}
if (!is_file($temporary) || !chmod($temporary, 0700) || !rename($temporary, $output)) {
    if (is_file($temporary)) {
        unlink($temporary);
    }
    $stop("cannot atomically publish $output");
}
fwrite(STDOUT, "READY $output\n");
