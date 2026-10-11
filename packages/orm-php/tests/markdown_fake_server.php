<?php
declare(strict_types=1);

/*
 * markdown_test.php가 flowmark server 대신 쓰는 server다. 127.0.0.1의 빈 port에서 연결 하나를
 * 받고, 받은 message 줄마다 인자의 답을 차례로 쓴다. 듣기 시작하면 port를 한 줄로 쓰고, 연결이
 * 끝나거나 답이 떨어지면 연결을 닫고 받은 줄들을 JSON 배열 한 줄로 쓰고 끝난다.
 *
 *   php markdown_fake_server.php <answer>...
 */

$answers = array_slice($argv, 1);
$server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
if ($server === false) {
    fwrite(STDERR, "listen: $errstr\n");
    exit(1);
}
$name = (string) stream_socket_get_name($server, false);
fwrite(STDOUT, substr($name, strrpos($name, ':') + 1) . "\n");
fflush(STDOUT);
$received = [];
$conn = stream_socket_accept($server, -1);
if ($conn !== false) {
    foreach ($answers as $answer) {
        $line = fgets($conn);
        if ($line === false) {
            break;
        }
        $received[] = rtrim($line, "\n");
        if (fwrite($conn, $answer . "\n") === false) {
            break;
        }
    }
    fclose($conn);
}
fclose($server);
fwrite(STDOUT, json_encode($received, JSON_UNESCAPED_SLASHES) . "\n");
