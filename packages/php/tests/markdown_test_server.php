<?php

declare(strict_types=1);

/*
 * The server the recipe listeners use instead of the flowmark server. It accepts one connection on an empty port on
 * 127.0.0.1 and writes the chosen answers in turn for each message line it receives. When it starts listening, it
 * writes the port on one line; when the connection ends or the answers run out, it closes the connection, writes the
 * lines it received as one line of a JSON array, and ends.
 *
 *   php markdown_test_server.php <answer>...
 *
 * With --send and an answer, it answers connect with {"ok":true}, a setup statement of orm's SQLite dialect (a
 * CREATE TABLE IF NOT EXISTS of an orm__ table, such as the row lock table that a transaction needs) as done without
 * recording it, and every other message with the answer, until the connection ends.
 *
 *   php markdown_test_server.php --send <answer>
 */

$answers = array_slice($argv, 1);
$send = ($answers[0] ?? '') === '--send' ? ($answers[1] ?? '') : null;
$server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
if ($server === false) {
    fwrite(STDERR, "listen: $errstr\n");
    exit(1);
}
$name = (string) stream_socket_get_name($server, false);
fwrite(STDOUT, substr($name, strrpos($name, ':') + 1) . "\n");
fflush(STDOUT);
$receivedMessages = [];
$conn = stream_socket_accept($server, -1);
if ($conn !== false && $send !== null) {
    while (($line = fgets($conn)) !== false) {
        $message = json_decode($line, true);
        $setup = is_array($message) && ($message['op'] ?? null) === 'statement' && is_string($message['sql'] ?? null)
            && str_starts_with($message['sql'], 'CREATE TABLE IF NOT EXISTS "orm__');
        if (!$setup) {
            $receivedMessages[] = rtrim($line, "\n");
        }
        $answer = match (true) {
            $setup => '{"columns":[],"rows":[],"affected":0,"last_insert_id":0}',
            count($receivedMessages) === 1 => '{"ok":true}',
            default => $send,
        };
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
        $receivedMessages[] = rtrim($line, "\n");
        if (fwrite($conn, $answer . "\n") === false) {
            break;
        }
    }
    fclose($conn);
}
fclose($server);
fwrite(STDOUT, json_encode($receivedMessages, JSON_UNESCAPED_SLASHES) . "\n");
