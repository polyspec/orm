// Failure message check. When checks and tests fail for lack of a run condition (environment variable, argument, installed tool), the message states the cause
// and the way to fix it together, as in "<cause>; run make <target>, which ...": after the cause comes "; run", "; set", "; install",
// "; give", or an explanation starting with ", which". The checked code is that of checks and tests (scripts, tests, bench,
// examples, client tests), and the lines that raise a failure (throw, t.Fatal, panic, expect, output to stderr, errors.New,
// fmt.Errorf, shell :?) that state "is required", "is unset", "is not set", "is not installed".

export const MESSAGE_SCOPE = /^(scripts|tests|bench|examples)\/|\/tests\/|_test\.go$|^Makefile$|^packages\/rust\/tests\//;
const MESSAGE_FILE = /\.(mjs|mts|js|sh|php|go|rs|ts)$|^Makefile$/;
const ERROR_CALL = /throw new \w*(?:Error|Exception)|t\.Fatalf?|panic!?\(|\.expect\(|eprintln!|fmt\.Fprintln\(os\.Stderr|fwrite\(STDERR|errors\.New|fmt\.Errorf|Err\(|>&2|:\?|console\.error|unwrap_or_else/;
const CONDITION = /is required|is unset|is not set|is not installed/;
const FIX = /;\s*(?:run|set|install|give|declare|write|add|use|start|pass|build|create|export|make)\b|, which /i;

// messageFiles is the files among the tracked paths that this check reads.
export const messageFiles = (paths: string[]) => paths.filter((path: string) => MESSAGE_FILE.test(path) && MESSAGE_SCOPE.test(path) && !path.includes('node_modules'));

// fixlessMessageErrors returns one error for each line of a failure message about a missing run condition that has no way to fix it. files is
// {path: text}. Comment lines are not checked.
export function fixlessMessageErrors(files: Record<string, string>) {
  const errors: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    text.split('\n').forEach((line: string, index) => {
      if (/^\s*(?:\/\/|#|\*)/.test(line)) return;
      if (ERROR_CALL.test(line) && CONDITION.test(line) && !FIX.test(line))
        errors.push(`${path}:${index + 1}: a failure message names a missing condition without the fix; add "; run make <target>, which ..." or the step that provides it after the cause: ${line.trim()}`);
    });
  }
  return errors;
}
