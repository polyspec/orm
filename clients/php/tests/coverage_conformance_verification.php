<?php
declare(strict_types=1);
// conformance_verification feature coverage: PHP conformance runner를 고른
// database에서 읽기 전용 vector conditions_values와 relations만으로 실행하고,
// 각 출력이 그 database의 기록된 expect와 JSON 값으로 같은지 확인한다
// (tests/conformance/vectors.json은 MySQL, vectors.<database>.json은 나머지).

require __DIR__ . '/coverage_cases.php';

const CONFORMANCE_VECTORS = ['conditions_values', 'relations'];

/** 두 JSON 값이 같은지 비교한다: 배열은 순서대로, object는 key 집합과 값으로, 수는 값으로. */
function sameJson(mixed $a, mixed $b): bool
{
    if ($a instanceof stdClass || $b instanceof stdClass) {
        if (!$a instanceof stdClass || !$b instanceof stdClass) {
            return false;
        }
        $left = get_object_vars($a);
        $right = get_object_vars($b);
        if (count($left) !== count($right)) {
            return false;
        }
        foreach ($left as $key => $value) {
            if (!array_key_exists($key, $right) || !sameJson($value, $right[$key])) {
                return false;
            }
        }
        return true;
    }
    if (is_array($a) || is_array($b)) {
        if (!is_array($a) || !is_array($b) || count($a) !== count($b)) {
            return false;
        }
        foreach ($a as $i => $value) {
            if (!sameJson($value, $b[$i])) {
                return false;
            }
        }
        return true;
    }
    if ((is_int($a) || is_float($a)) && (is_int($b) || is_float($b))) {
        return $a == $b;
    }
    return $a === $b;
}

runCoverageCases($argv, [
    'conformance_vector' => function (): void {
        [$driver, $dsn] = coverageDatabase();
        $root = dirname(__DIR__, 3);
        $file = $driver === 'mysql' ? 'vectors.json' : "vectors.$driver.json";
        $recorded = coverageJson("$root/tests/conformance/$file", false);
        $expect = [];
        foreach ($recorded->vectors as $vector) {
            if (in_array($vector->name, CONFORMANCE_VECTORS, true)) {
                $expect[$vector->name] = $vector->expect;
            }
        }
        coverageWant(count($expect) === count(CONFORMANCE_VECTORS), "$file lacks a selected vector");
        $command = [PHP_BINARY, "$root/tests/conformance/runner.php", '--dsn', $dsn];
        foreach (CONFORMANCE_VECTORS as $name) {
            array_push($command, '--vector', $name);
        }
        [$status, $stdout, $stderr] = coverageProcess($command, $root);
        if ($status !== 0) {
            throw new RuntimeException(str_replace($dsn, '[dsn]', "conformance runner exited $status: $stderr$stdout"));
        }
        $output = json_decode($stdout, false, 512, JSON_THROW_ON_ERROR);
        $names = array_keys(get_object_vars($output));
        coverageWant($names === CONFORMANCE_VECTORS, 'runner output vectors ' . json_encode($names));
        foreach (CONFORMANCE_VECTORS as $name) {
            coverageWant(sameJson($output->$name, $expect[$name]), "vector $name differs from $file: " . json_encode($output->$name));
        }
    },
]);
