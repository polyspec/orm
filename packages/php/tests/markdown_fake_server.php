<?php

declare(strict_types=1);

/*
 * The server MarkdownTest.php uses instead of the flowmark server. It accepts one connection on an empty port on 127.0.0.1
 * and writes the chosen answers in turn for each message line it receives. When it starts listening, it writes the port on one line; when the connection
 * ends or the answers run out, it closes the connection, writes the lines it received as one line of a JSON array, and ends.
 *
 *   php markdown_fake_server.php <answer>...
 *
 * With --keyed and a JSON object, it answers connect with {"ok":true} and every later message with the member of the
 * object named by the op of a control message or the kind of a request, until the connection ends; a message without
 * a member is answered IR_INVALID.
 *
 *   php markdown_fake_server.php --keyed <answers object>
 */

$answers = array_slice($argv, 1);
$keyed = ($answers[0] ?? '') === '--keyed' ? json_decode($answers[1] ?? '{}', true, 512, JSON_THROW_ON_ERROR) : null;
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
if ($conn !== false && $keyed !== null) {
    while (($line = fgets($conn)) !== false) {
        $received[] = rtrim($line, "\n");
        if (count($received) === 1) {
            $answer = '{"ok":true}';
        } else {
            $message = json_decode($line, true);
            $key = is_array($message) ? ($message['op'] ?? $message['request']['kind'] ?? 'unreadable') : 'unreadable';
            $answer = array_key_exists($key, $keyed)
                ? json_encode($keyed[$key], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION)
                : json_encode(['error' => ['code' => 'IR_INVALID', 'message' => "the case has no answer for $key"]]);
        }
        if (fwrite($conn, $answer . "\n") === false) {
            break;
        }
    }
    fclose($conn);
} elseif ($conn !== false) {
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
