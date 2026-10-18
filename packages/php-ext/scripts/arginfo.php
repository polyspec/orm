<?php
declare(strict_types=1);

// Makes src/orm_dbspec_arginfo.h from stubs/orm_dbspec.stub.php with gen_stub.php. gen_stub cannot
// write array constants, so it is made from a copy without the `public const array` line; that constant is registered by src/orm_dbspec.c
// (the declaration check compares the whole stub with the extension's Reflection).
//
// Usage: php packages/php-ext/scripts/arginfo.php <gen_stub.php> write|check
// write rewrites the header, and check exits with 1 if the regenerated header differs from the saved one. gen_stub.php uses the
// PHP-Parser in the same directory, and downloads it if it is absent, so check that it is present first (make install-php-extension-tools).

[, $genStub, $mode] = $argv + [null, '', ''];
if ($genStub === '' || !in_array($mode, ['write', 'check'], true)) {
    fwrite(STDERR, "usage: php packages/php-ext/scripts/arginfo.php <gen_stub.php> write|check\n");
    exit(2);
}
if (!is_file($genStub)) {
    fwrite(STDERR, "$genStub does not exist; run make install-php-extension-tools, which copies gen_stub.php of the PHP installation and its PHP-Parser\n");
    exit(1);
}
if (glob(dirname($genStub) . '/PHP-Parser-*', GLOB_ONLYDIR) === []) {
    fwrite(STDERR, dirname($genStub) . " has no PHP-Parser, which gen_stub.php would download; run make install-php-extension-tools\n");
    exit(1);
}
$root = dirname(__DIR__);
$stub = file_get_contents("$root/stubs/orm_dbspec.stub.php");
$filtered = preg_replace('/^    public const array [A-Z_]+ = .*;\n/m', '', $stub, -1, $removed);
if ($removed === 0) {
    fwrite(STDERR, "the stub declares no array constant; update packages/php-ext/scripts/arginfo.php and src/orm_dbspec.c together\n");
    exit(1);
}
$work = sys_get_temp_dir() . '/orm-dbspec-arginfo-' . getmypid();
if (!mkdir($work)) {
    fwrite(STDERR, "cannot create $work\n");
    exit(1);
}
try {
    file_put_contents("$work/orm_dbspec.stub.php", $filtered);
    $command = [PHP_BINARY, $genStub, "$work/orm_dbspec.stub.php"];
    $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    $out = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    if (proc_close($process) !== 0 || !is_file("$work/orm_dbspec_arginfo.h")) {
        fwrite(STDERR, implode(' ', $command) . " failed:\n$out$err");
        exit(1);
    }
    $generated = file_get_contents("$work/orm_dbspec_arginfo.h");
} finally {
    foreach (glob("$work/*") as $file) {
        unlink($file);
    }
    rmdir($work);
}
$target = "$root/src/orm_dbspec_arginfo.h";
if ($mode === 'write') {
    file_put_contents("$target.tmp", $generated);
    rename("$target.tmp", $target);
    echo "wrote src/orm_dbspec_arginfo.h ($removed array constants left to src/orm_dbspec.c)\n";
    exit(0);
}
if (!is_file($target) || file_get_contents($target) !== $generated) {
    fwrite(STDERR, "src/orm_dbspec_arginfo.h differs from the stub; run make php-extension-arginfo, which writes it with gen_stub.php\n");
    exit(1);
}
echo "src/orm_dbspec_arginfo.h is generated from the stub ($removed array constants left to src/orm_dbspec.c)\n";
