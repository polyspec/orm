<?php
declare(strict_types=1);

// stubs/orm_dbspec.stub.php에서 gen_stub.php로 src/orm_dbspec_arginfo.h를 만든다. gen_stub은 비어 있지 않은 배열
// 상수를 쓰지 못하므로 `public const array` 줄을 뺀 사본에서 만들고, 그 상수는 src/orm_dbspec.c가 등록한다
// (선언 검사가 stub 전체와 확장의 Reflection을 비교한다).
//
// Usage: php clients/php-extension/scripts/arginfo.php <gen_stub.php> write|check
// write는 header를 다시 쓰고, check는 다시 만든 header가 저장된 것과 다르면 1로 끝난다. gen_stub.php는 같은
// directory의 PHP-Parser를 쓰며, 그것이 없으면 내려받으므로 미리 있는지 확인한다(make install-php-extension-tools).

[, $genStub, $mode] = $argv + [null, '', ''];
if ($genStub === '' || !in_array($mode, ['write', 'check'], true)) {
    fwrite(STDERR, "usage: php clients/php-extension/scripts/arginfo.php <gen_stub.php> write|check\n");
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
    fwrite(STDERR, "the stub declares no array constant; update clients/php-extension/scripts/arginfo.php and src/orm_dbspec.c together\n");
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
