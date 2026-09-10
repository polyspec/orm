<?php
// S0: PHP boundary costs — persistent UDS round-trip to ormd, per-request connect,
// APCu plan-cache hit, JSON vs msgpack decode of a 100x20 result.
// Usage: php boundary.php /abs/path/ormd.sock [iters]
declare(strict_types=1);

$sock  = $argv[1] ?? die("socket path required\n");
$iters = (int)($argv[2] ?? 20000);

$irList = '{"ir_version":1,"schema_hash":"s0-battle-v1","entity":"battle","where":{"items":[{"pred":{"column":"service_seq","op":"eq","value":5}},{"pred":{"conn":"and","column":"is_close","op":"eq","value":0}},{"group":{"conn":"and","items":[{"pred":{"column":"is_display","op":"eq","value":1}},{"group":{"conn":"or","items":[{"pred":{"column":"is_display","op":"eq","value":2}},{"pred":{"conn":"and","column":"display_start_dt","op":"lt","value":"2026-09-11 00:00:00"}},{"pred":{"conn":"and","column":"display_end_dt","op":"gt","value":"2026-09-11 00:00:00"}}]}}]}},{"pred":{"conn":"and","column":"seq","op":"in","value":[1,2,3]}}]},"order":[{"column":"seq","dir":"desc"}],"limit":{"offset":0,"count":100}}';
$irPK = '{"ir_version":1,"schema_hash":"s0-battle-v1","entity":"battle","where":{"items":[{"pred":{"column":"seq","op":"eq","value":42}}]},"limit":{"offset":0,"count":1}}';

function stats(string $name, array $s): void {
    sort($s); $n = count($s);
    $p = fn(float $q) => $s[(int)(($n - 1) * $q)];
    printf("%-34s n=%-7d mean=%8.0fns p50=%7dns p90=%7dns p99=%7dns max=%8dns\n",
        $name, $n, array_sum($s) / $n, $p(0.5), $p(0.9), $p(0.99), $s[$n - 1]);
}

function connect(string $sock, bool $persistent) {
    $flags = STREAM_CLIENT_CONNECT | ($persistent ? STREAM_CLIENT_PERSISTENT : 0);
    $fp = @stream_socket_client("unix://$sock", $errno, $errstr, 1.0, $flags);
    if (!$fp) { throw new RuntimeException("connect: $errstr"); }
    stream_set_blocking($fp, true);
    return $fp;
}

function call($fp, string $frame): string {
    $out = pack('N', strlen($frame)) . $frame;
    for ($w = 0; $w < strlen($out); ) {
        $n = fwrite($fp, substr($out, $w));
        if ($n === false || $n === 0) { throw new RuntimeException('write failed'); }
        $w += $n;
    }
    $hdr = stream_get_contents($fp, 4);
    if (strlen($hdr) !== 4) { throw new RuntimeException('short header'); }
    $len = unpack('N', $hdr)[1];
    $body = '';
    while (strlen($body) < $len) {
        $chunk = fread($fp, $len - strlen($body));
        if ($chunk === false || $chunk === '') { throw new RuntimeException('short body'); }
        $body .= $chunk;
    }
    return $body;
}

echo "== persistent UDS round-trip (compile) ==\n";
$fp = connect($sock, true);
$resp = call($fp, '{"op":"compile","ir":' . $irList . '}');
printf("plan bytes: %d (list)\n", strlen($resp));
if (!str_contains($resp, '"plan"')) { die("unexpected: $resp\n"); }
foreach (['uds compile list' => $irList, 'uds compile pk' => $irPK] as $name => $ir) {
    $frame = '{"op":"compile","ir":' . $ir . '}';
    for ($i = 0; $i < 2000; $i++) { call($fp, $frame); }
    $s = [];
    for ($i = 0; $i < $iters; $i++) {
        $t = hrtime(true); call($fp, $frame); $s[] = hrtime(true) - $t;
    }
    stats($name, $s);
}
$err = call($fp, '{"op":"compile","ir":{"ir_version":1,"schema_hash":"x","entity":"battle"}}');
echo "error path: $err\n";

echo "== per-request connect (non-persistent) x2000 ==\n";
$s = [];
for ($i = 0; $i < 2000; $i++) {
    $t = hrtime(true);
    $c = connect($sock, false);
    call($c, '{"op":"compile","ir":' . $irPK . '}');
    fclose($c);
    $s[] = hrtime(true) - $t;
}
stats('connect+compile pk+close', $s);

echo "== APCu plan-cache hit path ==\n";
$plan = call($fp, '{"op":"compile","ir":' . $irList . '}');
$key = 'orm:s0-battle-v1:' . hash('xxh3', $irList);
apcu_store($key, $plan);
$s = [];
for ($i = 0; $i < $iters; $i++) {
    $t = hrtime(true);
    $k = 'orm:s0-battle-v1:' . hash('xxh3', $irList);
    $v = apcu_fetch($k);
    $s[] = hrtime(true) - $t;
}
if ($v !== $plan) { die("apcu mismatch\n"); }
stats('xxh3(ir)+apcu_fetch', $s);
$s = [];
for ($i = 0; $i < $iters; $i++) { $t = hrtime(true); $d = json_decode($plan, true); $s[] = hrtime(true) - $t; }
stats('json_decode(plan 1.9KB)', $s);

echo "== result decode: 100 rows x 20 cols ==\n";
$cols = []; for ($c = 0; $c < 20; $c++) { $cols[] = "col_$c"; }
$rows = [];
for ($r = 0; $r < 100; $r++) {
    $row = [];
    for ($c = 0; $c < 20; $c++) { $row[] = $c % 3 === 0 ? $r * 1000 + $c : ($c % 3 === 1 ? "value-$r-$c" : null); }
    $rows[] = $row;
}
$payload = ['columns' => $cols, 'rows' => $rows];
$json = json_encode($payload); $mp = msgpack_pack($payload);
printf("bytes: json=%d msgpack=%d\n", strlen($json), strlen($mp));
foreach (['json_decode 100x20' => fn() => json_decode($json, true), 'msgpack_unpack 100x20' => fn() => msgpack_unpack($mp)] as $name => $f) {
    for ($i = 0; $i < 1000; $i++) { $f(); }
    $s = [];
    for ($i = 0; $i < $iters; $i++) { $t = hrtime(true); $f(); $s[] = hrtime(true) - $t; }
    stats($name, $s);
}
// what an executing ormd would also have to send: the same rows as objects keyed by column (compatibility shape)
$assoc = []; foreach ($rows as $row) { $assoc[] = array_combine($cols, $row); }
$jsonA = json_encode($assoc); $mpA = msgpack_pack($assoc);
printf("assoc bytes: json=%d msgpack=%d\n", strlen($jsonA), strlen($mpA));
$s = []; for ($i = 0; $i < $iters; $i++) { $t = hrtime(true); json_decode($jsonA, true); $s[] = hrtime(true) - $t; } stats('json_decode assoc 100x20', $s);
$s = []; for ($i = 0; $i < $iters; $i++) { $t = hrtime(true); msgpack_unpack($mpA); $s[] = hrtime(true) - $t; } stats('msgpack_unpack assoc 100x20', $s);
// positional -> assoc conversion cost (columnar wire + client-side combine)
$s = []; for ($i = 0; $i < $iters; $i++) { $t = hrtime(true); $d = json_decode($json, true); $o = []; foreach ($d['rows'] as $row) { $o[] = array_combine($d['columns'], $row); } $s[] = hrtime(true) - $t; } stats('json positional + array_combine', $s);
