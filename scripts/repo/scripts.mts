// Check of the repository paths used by root npm scripts. A word that contains `/` is a repository path,
// and must be a tracked file or a directory that has tracked files.

// scriptPathErrors returns one error for each path in scripts({name: command}) that is not tracked.
// tracked is the list of tracked file paths relative to the repository root.
export function scriptPathErrors(scripts: Record<string, string>, tracked: string[]): string[] {
  const files = new Set(tracked);
  const directories = new Set<string>();
  for (const file of tracked) {
    for (let i = file.indexOf('/'); i !== -1; i = file.indexOf('/', i + 1)) directories.add(file.slice(0, i));
  }
  const errors: string[] = [];
  for (const [name, command] of Object.entries(scripts)) {
    for (const word of command.split(/\s+/)) {
      if (!word.includes('/')) continue;
      const path = word.replace(/^\.\//, '').replace(/\/$/, '');
      if (!files.has(path) && !directories.has(path)) errors.push(`package.json script ${name} names ${word}, which is not a tracked file or directory`);
    }
  }
  return errors;
}

// otherLanguages is the extensions of programs outside the repository's tool languages (Go, PHP, Rust, TypeScript and JavaScript, shell).
// If one tool used another language, that runtime would become a dependency of every machine and runner.
const otherLanguages = /\.(?:py|rb|pl|pm|lua|java|kt|cs|swift|scala|r)$/i;

// pythonRunners is the exact list of Python files that test the Python implementation. The spec (polyspec Python implementation and tool-language unification spec)
// sets that the runner testing the Python implementation is written in Python. The list is only these five places:
//   packages/python (the Python client and its tools)
//   packages/python/testing/interfaces/python.py and tests/interfaces/test_*.py
//   the python runner in tests/conformance (file names containing python)
//   the python runner in tests/dbspec/compare (file names containing python)
// Other Python programs are not exempt.
const pythonRunners = /^(?:packages\/python\/|tests\/interfaces\/(?:test_[^/]*|python)\.py$|tests\/conformance\/[^/]*python[^/]*\.py$|tests\/dbspec\/compare\/[^/]*python[^/]*\.py$)/;

// toolingLanguageErrors returns one error for each program file of another language among the tracked files.
export function toolingLanguageErrors(tracked: string[]) {
  return tracked.filter((path: string) => otherLanguages.test(path) && !pythonRunners.test(path))
    .map((path: string) => `${path} is a program in a language outside Go, PHP, Rust and TypeScript; write the tool in one of them`);
}
