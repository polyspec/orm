// test-names reads, without running anything, the test files, test symbols and name filters that the commands of the Makefile,
// contracts/features.json and contracts/check-inputs.json name, and reports each name that no test of the tree holds.
// A runner reports such a name one at a time, or not at all where another alternative of the filter still selects a test.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, dirname, join, normalize } from 'node:path';
import { minimatch } from 'minimatch';

// must is an item that the form of its list or match holds: a capture group that matched, or an index inside the bounds. A missing one is
// a fault of this checker.
const must = (value: string | undefined): string => {
  if (value === undefined) throw new Error('test-names: a match or a list does not hold the item its form states');
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export type NamedCommand = { place: string; command: string };
export type Tree = { files: string[]; read: (path: string) => string; ignored: (path: string) => boolean };

export const readTree = (root: string): Tree => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n').filter(path => path !== '' && existsSync(join(root, path)));
  const texts = new Map<string, string>();
  const read = (path: string) => {
    let text = texts.get(path);
    if (text === undefined) {
      text = readFileSync(join(root, path), 'utf8');
      texts.set(path, text);
    }
    return text;
  };
  // git check-ignore exits 0 for an ignored path; any other exit leaves the path not ignored, so that a name it holds is reported.
  const ignored = (path: string) => {
    const check = spawnSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: root, stdio: 'ignore' });
    if (check.error !== undefined) throw check.error;
    return check.status === 0;
  };
  return { files, read, ignored };
};

// memoryTree is a tree of the given files, for the cases of the checker itself.
export const memoryTree = (contents: Record<string, string>): Tree => ({
  files: Object.keys(contents),
  read: path => contents[path] ?? '',
  ignored: () => false,
});

// recipeCases lists the case ids of the recipes a test source names: a recipe case is a test name of every runner.
const recipeCases = (tree: Tree, text: string): string[] => [...new Set(text.match(/\b(?:contracts\/fixtures|tests|testing)\/[\w./-]+\.json/g) ?? [])]
  .flatMap(path => tree.files.filter(file => file === path || file.endsWith(`/${path}`)))
  .flatMap(path => {
    const recipe: unknown = JSON.parse(tree.read(path));
    const cases = isRecord(recipe) ? recipe.cases : recipe;
    return Array.isArray(cases) ? cases.flatMap((item: unknown) => isRecord(item) && typeof item.id === 'string' ? [item.id] : []) : [];
  });

// alternatives enumerates the branches of a regular expression, so that each name of `^(TestA|TestB)$` is judged by itself: a filter that
// still selects TestB would hide a TestA that is gone. An expression with a lookaround is one branch, because its branches do not stand alone.
export const alternatives = (pattern: string): string[] => {
  if (/\(\?[!=<]/.test(pattern)) return [pattern];
  let at = 0;
  const parseAlternation = (): string[] => {
    const branches: string[] = [];
    let current = [''];
    while (at < pattern.length && pattern[at] !== ')') {
      const char = pattern[at];
      if (char === '|') {
        at += 1;
        branches.push(...current);
        current = [''];
      } else if (char === '(') {
        at += 1;
        if (pattern.startsWith('?:', at)) at += 2;
        const inner = parseAlternation();
        at += 1;
        const optional = pattern[at] === '?';
        if (optional) at += 1;
        current = current.flatMap(head => [...inner.map(tail => head + tail), ...(optional ? [head] : [])]);
      } else if (char === '[') {
        const end = pattern.indexOf(']', at + 2);
        const part = pattern.slice(at, end + 1);
        at = end + 1;
        current = current.map(head => head + part);
      } else if (char === '\\') {
        const part = pattern.slice(at, at + 2);
        at += 2;
        current = current.map(head => head + part);
      } else {
        at += 1;
        current = current.map(head => head + char);
      }
    }
    branches.push(...current);
    return branches;
  };
  return parseAlternation();
};

const selects = (pattern: string, names: Iterable<string>): boolean => {
  const expression = new RegExp(pattern);
  for (const name of names) if (expression.test(name)) return true;
  return false;
};

// shellSegments splits a command at its shell operators, outside quotes, into words with their quotes removed.
export const shellSegments = (command: string): string[][] => {
  const segments: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  let quote = '';
  const endWord = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let at = 0; at < command.length; at += 1) {
    const char = command.charAt(at);
    if (quote !== '') {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"' && /["\\$`]/.test(command[at + 1] ?? '')) {
        at += 1;
        word = (word ?? '') + command[at];
      } else word = (word ?? '') + char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word = word ?? '';
    } else if (char === '\\') {
      at += 1;
      word = (word ?? '') + (command[at] ?? '');
    } else if (/\s/.test(char)) endWord();
    else if (char === '(' || char === ')') {
      endSegment();
      segments.push([char]);
    } else if (char === ';' || char === '&' || char === '|' || char === '{' && /\s/.test(command[at + 1] ?? '') || char === '}' && word === undefined) endSegment();
    else word = (word ?? '') + char;
  }
  endSegment();
  return segments;
};

const unresolved = (word: string) => /\$|`|@OUT@/.test(word);
// In a regular expression `$` is an anchor at the end of a branch; elsewhere it is a shell reference.
const unresolvedPattern = (pattern: string) => /\$(?![|)/]|$)|`/.test(pattern);

const wordValue = (words: string[], flag: string): string[] => {
  const values: string[] = [];
  words.forEach((word, index) => {
    if (word === flag && index + 1 < words.length) values.push(must(words[index + 1]));
    else if (word.startsWith(`${flag}=`)) values.push(word.slice(flag.length + 1));
  });
  return values;
};

type Report = (kind: string, name: string) => void;

// goNames lists the top-level test functions of the test files of a package directory.
const goNames = (tree: Tree, directory: string, recursive: boolean): string[] => tree.files
  .filter(path => path.endsWith('_test.go') && (recursive ? path.startsWith(`${directory}/`) : dirname(path) === directory))
  .flatMap(path => [...tree.read(path).matchAll(/^func ((?:Test|Fuzz|Benchmark|Example)\w*)\(/gm)].map(match => must(match[1])));

const checkGo = (tree: Tree, words: string[], cwd: string, report: Report) => {
  const start = words.findIndex((word, index) => word.endsWith('go-test.mts') || word === 'go' && words[index + 1] === 'test');
  if (start < 0) return;
  const packages = words.slice(start).filter(word => /^\.{1,2}(\/|$)/.test(word) && !word.endsWith('.mts')).map(word => {
    const recursive = word.endsWith('/...');
    return { directory: normalize(join(cwd, recursive ? word.slice(0, -4) : word)).replace(/\/$/, ''), recursive };
  });
  const names = packages.flatMap(({ directory, recursive }) => goNames(tree, directory, recursive));
  for (const { directory, recursive } of packages) {
    if (goNames(tree, directory, recursive).length === 0) report('go package', `${directory} holds no test`);
  }
  if (packages.length === 0) return;
  for (const flag of ['-run', '-fuzz', '-bench']) {
    for (const value of wordValue(words, flag)) {
      if (unresolvedPattern(value)) continue;
      for (const branch of alternatives(value)) {
        const [name = '', ...subtests] = branch.split('/');
        if (name === '^$' || name === '') continue;
        if (!selects(name, names)) report('go test', `${flag} ${name} in ${packages.map(item => item.directory).join(' ')}`);
        const text = tree.files.filter(path => path.endsWith('_test.go') && packages.some(({ directory }) => dirname(path) === directory)).map(path => tree.read(path)).join('\n');
        const cases = recipeCases(tree, text);
        for (const subtest of subtests) {
          if (!selects(subtest, cases) && !text.includes(subtest.replace(/^\^|\$$/g, ''))) report('go test', `${flag} ${branch} in ${packages.map(item => item.directory).join(' ')}`);
        }
      }
    }
  }
};

type PhpScope = { names: string[]; text: string; cases: string[] };

const phpFiles = (tree: Tree) => tree.files.filter(path => path.endsWith('.php') && /^packages\/php(-ext)?\/tests\//.test(path));

// phpScope lists `Namespace\Class::method` of the files and of each class they extend, trait they use or file they require.
export const phpScope = (tree: Tree, paths: string[]): PhpScope => {
  const all = phpFiles(tree);
  const seen = new Set<string>();
  const names: string[] = [];
  let text = '';
  const visit = (path: string, owner?: string) => {
    if (seen.has(`${path} ${owner ?? ''}`)) return;
    seen.add(`${path} ${owner ?? ''}`);
    if (!tree.files.includes(path)) return;
    const source = tree.read(path);
    text += source;
    const namespace = /^namespace ([\w\\]+);/m.exec(source)?.[1] ?? '';
    const classes = [...source.matchAll(/^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|trait)\s+(\w+)/gm)].map(match => must(match[1]));
    const prefix = owner ?? `${namespace}\\${classes[0] ?? basename(path, '.php')}`;
    for (const match of source.matchAll(/function\s+(\w+)\s*\(/g)) names.push(`${prefix}::${match[1]}`);
    for (const match of source.matchAll(/\brequire(?:_once)?\s+__DIR__\s*\.\s*'\/([^']+)'/g)) visit(normalize(join(dirname(path), must(match[1]))), prefix);
    const related = [...source.matchAll(/\bextends\s+\\?([\w\\]+)/g), ...source.matchAll(/^\s+use\s+\\?([\w\\, ]+);/gm)]
      .flatMap(match => must(match[1]).split(',')).map(name => name.trim().split('\\').at(-1) ?? '');
    for (const name of related) {
      for (const candidate of all.filter(file => basename(file, '.php') === name || new RegExp(`^\\s*(?:(?:abstract|final|readonly)\\s+)*(?:class|trait)\\s+${name}\\b`, 'm').test(tree.read(file)))) visit(candidate, prefix);
    }
  };
  for (const path of paths) visit(path);
  return { names, text, cases: recipeCases(tree, text) };
};

const checkPhp = (tree: Tree, words: string[], cwd: string, report: Report) => {
  const start = words.findIndex(word => /(^|\/)phpunit$/.test(word));
  if (start < 0) return;
  const rest = words.slice(start + 1);
  const paths = rest.filter(word => word.endsWith('.php') && !unresolved(word) && !word.endsWith('phpunit.xml.dist')).map(word => normalize(join(cwd, word)));
  for (const path of paths.filter(item => tree.files.includes(item) && item.endsWith('Test.php'))) {
    if (!phpScope(tree, [path]).names.some(name => /::test/.test(name)) && !/#\[Test\]/.test(phpScope(tree, [path]).text)) report('php test', `${path} holds no test`);
  }
  const scope = phpScope(tree, paths.length > 0 ? paths.filter(path => tree.files.includes(path)) : phpFiles(tree));
  for (const value of wordValue(rest, '--filter')) {
    if (value === '' || unresolvedPattern(value)) continue;
    for (const branch of alternatives(value)) {
      const dataSet = / with data set "([^"]+)"/.exec(branch) ?? /^with data set "([^"]+)"/.exec(branch);
      const method = branch.replace(/ ?with data set .*$/, '');
      if (dataSet !== null && !scope.text.includes(must(dataSet[1]))) report('php data set', `${branch} in ${paths.join(' ')}`);
      if (method !== '' && method !== '^' && !selects(method, scope.names) && !selects(method, scope.cases)) report('php test', `--filter ${method}${paths.length > 0 ? ` in ${paths.join(' ')}` : ''}`);
    }
  }
};

const pythonClasses = (tree: Tree) => {
  const classes = new Map<string, { bases: string[]; methods: Set<string> }>();
  for (const path of tree.files.filter(file => file.startsWith('packages/python/tests/') && file.endsWith('.py'))) {
    const lines = tree.read(path).split('\n');
    lines.forEach((line, index) => {
      const match = /^class (\w+)(?:\(([^)]*)\))?:/.exec(line);
      if (match === null) return;
      const methods = new Set<string>();
      for (let next = index + 1; next < lines.length && !/^\S/.test(must(lines[next])); next += 1) {
        const method = /^ +(?:async )?def (\w+)/.exec(must(lines[next]));
        if (method !== null) methods.add(must(method[1]));
      }
      const known = classes.get(must(match[1]));
      const bases = (match[2] ?? '').split(',').map(base => base.trim().split('.').at(-1) ?? '').filter(Boolean);
      if (known === undefined) classes.set(must(match[1]), { bases, methods });
      else { known.bases.push(...bases); for (const method of methods) known.methods.add(method); }
    });
  }
  return classes;
};

const pythonHasMethod = (classes: ReturnType<typeof pythonClasses>, name: string, method: string, seen = new Set<string>()): boolean => {
  if (seen.has(name)) return false;
  seen.add(name);
  const item = classes.get(name);
  if (item === undefined) return false;
  return item.methods.has(method) || item.bases.some(base => pythonHasMethod(classes, base, method, seen));
};

const checkPythonName = (tree: Tree, dotted: string, report: Report) => {
  const parts = dotted.split('.');
  let length = parts.length;
  let file: string | undefined;
  for (; length > 0; length -= 1) {
    const path = parts.slice(0, length).join('/');
    file = tree.files.find(item => item === `${path}.py` || item === `${path}/__init__.py` || item === `${path}/__main__.py`);
    if (file !== undefined) break;
  }
  if (file === undefined || length < 3) {
    report('python module', dotted);
    return;
  }
  if (/\/test_[^/]+\.py$/.test(file) && !/^\s+(?:async )?def test|\bload_tests\b|^from \S+ import |^(?:async )?def test/m.test(tree.read(file))) report('python test', `${dotted} holds no test`);
  const [className, method, extra] = parts.slice(length);
  if (className !== undefined) checkPythonMember(tree, file, className, method, dotted, report);
  if (extra !== undefined) report('python test', dotted);
};

const checkPythonMember = (tree: Tree, file: string, className: string, method: string | undefined, name: string, report: Report) => {
  const source = tree.read(file);
  const classes = pythonClasses(tree);
  const held = new RegExp(`^class ${className}\\b|^from .* import .*\\b${className}\\b|^    ${className},?$|^${className} = `, 'm').test(source);
  if (/^[a-z_]\w*$/.test(className)) {
    if (!new RegExp(`^(?:async )?def ${className}\\b`, 'm').test(source)) report('python test', name);
    return;
  }
  if (!held) {
    report('python test', name);
    return;
  }
  if (method !== undefined && !pythonHasMethod(classes, className, method)) report('python test', name);
};

// checkPythonDiscover reads `discover -s directory -p pattern -k name`: the pattern selects a file and the name a test of those files.
const checkPythonDiscover = (tree: Tree, words: string[], report: Report) => {
  const directory = (wordValue(words, '-s')[0] ?? '.').replace(/^\.\//, '');
  for (const pattern of wordValue(words, '-p')) {
    const files = tree.files.filter(path => path.startsWith(`${directory}/`) && path.endsWith('.py') && minimatch(basename(path), pattern));
    if (files.length === 0) report('python test file', `${directory}/${pattern}`);
    const text = files.map(path => tree.read(path)).join('\n');
    for (const name of wordValue(words, '-k')) {
      if (!text.includes(name)) report('python test', `-k ${name} in ${directory}/${pattern}`);
    }
  }
};

const checkPython = (tree: Tree, words: string[], report: Report) => {
  const moduleAt = words.findIndex((word, index) => (word === '-m' || word === '--module') && /^(unittest$|packages\.python\.)/.test(words[index + 1] ?? ''));
  if (moduleAt >= 0) {
    const module = must(words[moduleAt + 1]);
    if (module !== 'unittest') checkPythonName(tree, module, report);
    if (words[moduleAt + 2] === 'discover' || words[moduleAt + 3] === 'discover') {
      checkPythonDiscover(tree, words, report);
      return;
    }
    const file = module === 'unittest' ? undefined : tree.files.find(path => path === `${module.replaceAll('.', '/')}.py`);
    for (const word of words.slice(moduleAt + 2)) {
      if (unresolved(word) || word.startsWith('-') || word === 'discover') continue;
      if (word.startsWith('packages.python.')) checkPythonName(tree, word, report);
      else if (file !== undefined && /^[A-Za-z_]\w*(\.\w+)?$/.test(word)) {
        const [className = '', method] = word.split('.');
        checkPythonMember(tree, file, className, method, `${module} ${word}`, report);
      }
    }
  }
};

const rustValueFlags = new Set(['--manifest-path', '--features', '-p', '--package', '--bin', '--example', '--target', '--target-dir', '--color', '--message-format', '-j', '--jobs', '--profile', '--config', '--exclude', '-F', '--bench']);

const rustIncluded = (tree: Tree, start: string, seen = new Set<string>()): Set<string> => {
  if (seen.has(start) || !tree.files.includes(start)) return seen;
  seen.add(start);
  const source = tree.read(start);
  const base = /(?:^|\/)(?:main|lib|mod)\.rs$/.test(start) || /\/tests\/[^/]+\.rs$/.test(start) ? dirname(start) : start.replace(/\.rs$/, '');
  for (const match of source.matchAll(/#\[path\s*=\s*"([^"]+)"\]/g)) rustIncluded(tree, normalize(join(dirname(start), must(match[1]))), seen);
  for (const match of source.matchAll(/^\s*(?:pub(?:\([a-z]+\))?\s+)?mod\s+(\w+)\s*;/gm)) {
    rustIncluded(tree, `${base}/${match[1]}.rs`, seen);
    rustIncluded(tree, `${base}/${match[1]}/mod.rs`, seen);
  }
  return seen;
};

const rustCrates = (tree: Tree) => tree.files.filter(path => basename(path) === 'Cargo.toml').map(path => ({
  directory: dirname(path),
  name: /^name\s*=\s*"([^"]+)"/m.exec(tree.read(path))?.[1] ?? '',
  programs: [...tree.read(path).matchAll(/\[\[test\]\]\s*\nname\s*=\s*"([^"]+)"(?:\s*\npath\s*=\s*"([^"]+)")?/g)].map(match => ({ name: must(match[1]), path: match[2] })),
}));

const rustPrograms = (tree: Tree, crates: ReturnType<typeof rustCrates>, scope: ReturnType<typeof rustCrates>, name: string): string[] => scope.flatMap(crate => {
  const declared = crate.programs.flatMap(item => item.name === name && item.path !== undefined ? [join(crate.directory, item.path)] : []);
  return [...declared, `${crate.directory}/tests/${name}.rs`, `${crate.directory}/tests/${name}/main.rs`].filter(path => tree.files.includes(path));
});

const checkRust = (tree: Tree, words: string[], cwd: string, report: Report) => {
  const start = words.findIndex((word, index) => word === 'cargo' && ['test', '+'].some(() => words.slice(index + 1, index + 3).includes('test')));
  if (start < 0) return;
  const args = words.slice(words.indexOf('test', start) + 1);
  const crates = rustCrates(tree);
  const manifest = wordValue(args, '--manifest-path')[0];
  const packages = [...wordValue(args, '-p'), ...wordValue(args, '--package')];
  const workspace = normalize(join(cwd, manifest === undefined ? '' : dirname(manifest))).replace(/\/$/, '');
  const scope = packages.length > 0 ? crates.filter(crate => packages.includes(crate.name))
    : crates.filter(crate => workspace === '.' || crate.directory === workspace || crate.directory.startsWith(`${workspace}/`));
  const programs = wordValue(args, '--test').filter(name => !unresolved(name));
  const files = new Set<string>();
  for (const name of programs) {
    const found = name.includes('*')
      ? tree.files.filter(path => scope.some(crate => minimatch(path, `${crate.directory}/tests/${name}.rs`)))
      : rustPrograms(tree, crates, scope, name);
    if (found.length === 0) report('rust test program', `--test ${name}`);
    for (const path of found) rustIncluded(tree, path, files);
  }
  // A program runs the modules of a test case crate as groups, so those modules declare its names too. The loop reads a
  // copy of the set, since rustIncluded adds the files that it finds to that set.
  for (const path of new Set(files)) {
    for (const match of tree.read(path).matchAll(/\bpolyspec_orm(?:_(\w+?))?_cases::(\w+)::trials\b/g)) {
      rustIncluded(tree, `packages/rust/${match[1] ?? 'orm'}/tests/cases/${must(match[2])}.rs`, files);
    }
  }
  const filters: string[] = [];
  let after = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = must(args[index]);
    if (word === '--') {
      after = true;
    } else if (word.startsWith('-')) {
      if (rustValueFlags.has(word) || word === '--test' || after && word === '--skip') index += 1;
    } else if (!unresolved(word)) filters.push(word);
  }
  if (filters.length === 0) return;
  const paths = programs.length > 0 ? [...files] : tree.files.filter(path => path.endsWith('.rs') && scope.some(crate => path.startsWith(`${crate.directory}/`)) && (args.includes('--lib') ? !/\/tests\/[^/]+\.rs$/.test(path) : true));
  const source = paths.map(path => tree.read(path)).join('\n');
  const names = new Set([...source.matchAll(/\b(?:fn|mod)\s+(\w+)/g)].map(match => must(match[1])));
  for (const path of paths) names.add(basename(path, '.rs'));
  const identifiers = [...names, ...recipeCases(tree, source)];
  for (const filter of filters) {
    const parts = filter.split('::').filter(Boolean);
    parts.forEach((part, index) => {
      const held = index === parts.length - 1 && !filter.endsWith('::') ? identifiers.some(name => name.includes(part)) || source.includes(part) : names.has(part) || programs.includes(part);
      if (!held) report('rust test', `${filter}${programs.length > 0 ? ` in --test ${programs.join(' --test ')}` : ''}`);
    });
  }
};

// nodeSources is a test file and the local files it imports, whose calls may declare its titles.
const nodeSources = (tree: Tree, path: string, seen = new Set<string>()): Set<string> => {
  if (seen.has(path) || !tree.files.includes(path)) return seen;
  seen.add(path);
  for (const match of tree.read(path).matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]|\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    nodeSources(tree, normalize(join(dirname(path), must(match[1] ?? match[2]))), seen);
  }
  return seen;
};

// nodeTitles lists the declared titles: a template is a regular expression of its literal parts, and a title that is a variable marks the
// source as computed, so that a filter is then searched in its text.
const nodeTitles = (text: string) => {
  const literal: string[] = [];
  const templates: RegExp[] = [];
  let computed = false;
  for (const match of text.matchAll(/\b(?:\w*[tT]est|it|describe|suite|rule)\(\s*(?:(['"])((?:\\.|(?!\1).)*)\1|`((?:\\.|[^`])*)`|([A-Za-z_$][\w$.]*))/g)) {
    if (match[2] !== undefined) literal.push(match[2]);
    else if (match[3] !== undefined) {
      if (match[3].includes('${')) {
        const parts = match[3].split(/\$\{[^}]*\}/);
        if (parts.some(part => part.trim() !== '')) templates.push(new RegExp(parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')));
      }
      else literal.push(match[3]);
    } else computed = true;
  }
  return { literal, templates, computed };
};

const checkNode = (tree: Tree, words: string[], cwd: string, report: Report) => {
  if (!words.some(word => /(^|\/)node$/.test(word))) return;
  const paths = words.filter(word => /\.m?[jt]s$/.test(word) && !unresolved(word)).map(word => normalize(join(cwd, word)));
  if (words.includes('--test')) {
    for (const path of paths.filter(item => tree.files.includes(item))) {
      const text = [...nodeSources(tree, path)].map(item => tree.read(item)).join('\n');
      if (!/\b\w*[tT]est\(|\bit\(|\bdescribe\(|\bsuite\(/.test(text)) report('typescript test', `${path} holds no test`);
    }
  }
  for (const value of wordValue(words, '--test-name-pattern')) {
    if (value === '' || unresolvedPattern(value)) continue;
    const text = paths.flatMap(path => [...nodeSources(tree, path)]).map(path => tree.read(path)).join('\n');
    const titles = nodeTitles(text);
    const cases = recipeCases(tree, text);
    for (const branch of alternatives(value)) {
      const literal = branch.replace(/^\^|\$$/g, '');
      if (!selects(branch, titles.literal) && !selects(branch, cases) && !titles.templates.some(title => title.test(literal)) && !(titles.computed && text.includes(literal))) {
        report('typescript test', `--test-name-pattern ${branch} in ${paths.join(' ')}`);
      }
    }
  }
};

// Output paths, which a recipe writes, are not test names.
const PATH_WORD = /^(\.\/|\/)?((?:packages|tests|examples|benchmarks|scripts)\/[^\s:=,'"`]*\.(?:php|phpt|mjs|mts|cjs|ts|py|rs|go|sh))$/;

const checkPaths = (tree: Tree, words: string[], cwd: string, report: Report) => {
  for (const word of words) {
    const match = PATH_WORD.exec(word);
    if (match === null) continue;
    const path = normalize(match[1] === '/' ? must(match[2]) : join(cwd, must(match[2])));
    if (unresolved(path)) continue;
    const held = /[*?{[]/.test(path) ? tree.files.some(file => minimatch(file, path)) : tree.files.includes(path);
    if (!held && !tree.ignored(path)) report('test file', path);
  }
};

export const checkCommand = (tree: Tree, command: string, targets?: Set<string>): string[] => {
  const found = new Set<string>();
  const report: Report = (kind, name) => found.add(`${kind}: ${name}`);
  let cwd = '.';
  const outer: string[] = [];
  for (const words of shellSegments(command)) {
    if (words[0] === '(') {
      outer.push(cwd);
      continue;
    }
    if (words[0] === ')') {
      cwd = outer.pop() ?? cwd;
      continue;
    }
    if (words[0] === 'cd' && words[1] !== undefined && !unresolved(words[1])) {
      cwd = normalize(join(cwd, words[1]));
      continue;
    }
    checkPaths(tree, words, cwd, report);
    checkGo(tree, words, cwd, report);
    checkPhp(tree, words, cwd, report);
    checkPython(tree, words, report);
    checkRust(tree, words, cwd, report);
    checkNode(tree, words, cwd, report);
    if (targets !== undefined && words[0] === 'make') {
      for (const word of words.slice(1)) {
        if (!word.startsWith('-') && !word.includes('=') && !targets.has(word)) report('make target', word);
      }
    }
  }
  return [...found];
};

export type Makefile = { variables: Map<string, string>; recipes: Map<string, string[]>; targets: Set<string>; patterns: string[] };

const REPLACED_WITH_ARGUMENTS = new Set(['strip', 'addprefix', 'addsuffix', 'patsubst', 'foreach', 'sort', 'filter', 'filter-out', 'wildcard', 'notdir', 'dir', 'basename', 'firstword', 'lastword', 'word', 'words']);

// expand evaluates the make references of a recipe line: a variable, $(if), $(call), $(subst) and the text of the other functions; what it cannot know,
// such as $(shell), stays a reference, which the checks read as unknown.
export const expand = (text: string, variables: Map<string, string>, overrides: Map<string, string> = new Map(), depth = 0): string => {
  if (depth > 12) return text;
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char !== '$') {
      out += char;
      continue;
    }
    const next = text[at + 1];
    if (next === '$') {
      out += '$';
      at += 1;
      continue;
    }
    if (next !== '(' && next !== '{') {
      out += `$${next ?? ''}`;
      at += 1;
      continue;
    }
    const open = next as string;
    const close = open === '(' ? ')' : '}';
    let level = 1;
    let end = at + 2;
    for (; end < text.length && level > 0; end += 1) {
      if (text[end] === open) level += 1;
      else if (text[end] === close) level -= 1;
    }
    const inner = text.slice(at + 2, end - 1);
    at = end - 1;
    const space = inner.search(/\s/);
    const name = space < 0 ? inner : inner.slice(0, space);
    const body = space < 0 ? '' : inner.slice(space + 1);
    const splitArguments = () => {
      const parts: string[] = [];
      let current = '';
      let nested = 0;
      for (const c of body) {
        if (c === '(' || c === '{') nested += 1;
        if (c === ')' || c === '}') nested -= 1;
        if (c === ',' && nested === 0) { parts.push(current); current = ''; } else current += c;
      }
      parts.push(current);
      return parts;
    };
    if (space < 0) {
      const value = overrides.get(name) ?? variables.get(name);
      if (value !== undefined) out += expand(value, variables, overrides, depth + 1);
      else if (name === 'CURDIR') out += '.';
      else if (/^\d+$/.test(name) || /^[@<^*]$/.test(name)) out += `$(${name})`;
      else out += '';
    } else if (name === 'if') {
      const [condition = '', yes, no] = splitArguments();
      out += expand(expand(condition, variables, overrides, depth + 1).trim() !== '' ? yes ?? '' : no ?? '', variables, overrides, depth + 1);
    } else if (name === 'call') {
      const [fn = '', ...args] = splitArguments();
      let value = variables.get(fn.trim()) ?? '';
      args.forEach((arg, index) => { value = value.replaceAll(`$(${index + 1})`, arg); });
      out += expand(value, variables, overrides, depth + 1);
    } else if (name === 'subst') {
      const [from = '', to = '', ...rest] = splitArguments();
      out += expand(rest.join(','), variables, overrides, depth + 1).replaceAll(from, to);
    } else if (name === 'abspath' || name === 'realpath') {
      out += expand(body, variables, overrides, depth + 1).trim().split(/\s+/).map(path => `/${path.replace(/^\/+/, '')}`).join(' ');
    } else if (name === 'shell') {
      out += '$unknown';
    } else if (REPLACED_WITH_ARGUMENTS.has(name)) {
      out += expand(body, variables, overrides, depth + 1);
    } else out += '$unknown';
  }
  return out;
};

export const readMakefile = (text: string): Makefile => {
  const variables = new Map<string, string>();
  const recipes = new Map<string, string[]>();
  const targets = new Set<string>();
  const patterns: string[] = [];
  const lines = text.replace(/\\\n[\t ]*/g, ' ').split('\n');
  let current: string[] = [];
  let defining: { name: string; lines: string[] } | undefined;
  for (const line of lines) {
    if (defining !== undefined) {
      if (/^endef\b/.test(line)) {
        variables.set(defining.name, defining.lines.join('; '));
        defining = undefined;
      } else defining.lines.push(line.replace(/^\t/, ''));
      continue;
    }
    const define = /^define\s+(\S+)/.exec(line);
    if (define !== null) {
      defining = { name: must(define[1]), lines: [] };
      continue;
    }
    if (line.startsWith('\t')) {
      current.push(line.slice(1).replace(/^[@+-]+/, ''));
      continue;
    }
    if (line.startsWith('#') || line.trim() === '') continue;
    const variable = /^(?:export\s+)?([A-Za-z_][\w.-]*)\s*(\?=|:=|::=|\+=|=)\s*(.*)$/.exec(line);
    if (variable !== null) {
      const name = must(variable[1]);
      const operator = must(variable[2]);
      if (operator === '+=') variables.set(name, `${variables.get(name) ?? ''} ${variable[3]}`);
      else if (operator !== '?=' || !variables.has(name)) variables.set(name, must(variable[3]));
      current = [];
      continue;
    }
    const rule = /^([^\s:#=][^:#=]*?)\s*:(?!=)\s*(.*)$/.exec(line);
    if (rule !== null) {
      current = [];
      for (const target of must(rule[1]).split(/\s+/)) {
        if (target.includes('%')) patterns.push(target);
        targets.add(target);
        recipes.set(target, current);
      }
    }
  }
  return { variables, recipes, targets, patterns };
};

export const makefileCommands = (makefile: Makefile): NamedCommand[] => [...makefile.recipes.entries()].flatMap(([target, lines]) =>
  lines.map(line => ({ place: `Makefile ${target}`, command: expand(line, makefile.variables) })));

// featureCommands is a verification command and, for each make target it fills with VAR=value, that target's recipe under those values.
export const featureCommands = (makefile: Makefile, place: string, command: string): NamedCommand[] => {
  const commands: NamedCommand[] = [{ place, command }];
  for (const words of shellSegments(command)) {
    if (words[0] !== 'make') continue;
    const overrides = new Map(words.filter(word => /^[A-Z_][A-Z0-9_]*=/.test(word)).map(word => [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] as [string, string]));
    if (overrides.size === 0) continue;
    for (const target of words.slice(1).filter(word => !word.startsWith('-') && !word.includes('='))) {
      for (const line of makefile.recipes.get(target) ?? []) commands.push({ place: `${place} (make ${target})`, command: expand(line, makefile.variables, overrides) });
    }
  }
  return commands;
};

const pathHeld = (tree: Tree, path: string) => /[*?{[]/.test(path) ? tree.files.some(file => minimatch(file, path)) : tree.files.includes(path) || tree.files.some(file => file.startsWith(`${path}/`));

type Features = { features: { id: string; tests?: string[]; verification?: { id: string; command: string; inputs?: string[] }[]; coverage?: { owners?: Record<string, { tests?: string[]; commands?: Record<string, { test?: string; recipe?: string; symbol?: string }[]> }> } }[]; helpers?: { id: string; command?: string; paths?: string[]; tests?: string[] }[] };
type Inputs = { targets: Record<string, { inputs?: string[] }>; paths: Record<string, unknown> };

// staleNames is every name of the declaring files that no test of the tree holds, each with the places that name it.
export const staleNames = (tree: Tree, sources: { makefile: string; features: Features; checkInputs: Inputs }): Map<string, string[]> => {
  const stale = new Map<string, string[]>();
  const add = (name: string, place: string) => {
    const places = stale.get(name) ?? [];
    if (!places.includes(place)) places.push(place);
    stale.set(name, places);
  };
  const makefile = readMakefile(sources.makefile);
  const commands = makefileCommands(makefile);
  for (const feature of sources.features.features) {
    for (const verification of feature.verification ?? []) {
      commands.push(...featureCommands(makefile, `contracts/features.json ${feature.id}/${verification.id}`, verification.command));
      for (const input of verification.inputs ?? []) {
        if (!pathHeld(tree, input) && !tree.ignored(input)) add(`input: ${input}`, `contracts/features.json ${feature.id}/${verification.id}`);
      }
    }
    for (const path of feature.tests ?? []) {
      if (!pathHeld(tree, path)) add(`test file: ${path}`, `contracts/features.json ${feature.id}/tests`);
    }
    for (const [owner, part] of Object.entries(feature.coverage?.owners ?? {})) {
      const place = `contracts/features.json ${feature.id}/coverage/${owner}`;
      for (const path of part.tests ?? []) {
        if (!pathHeld(tree, path)) add(`test file: ${path}`, place);
      }
      for (const entry of Object.values(part.commands ?? {}).flat()) {
        if (entry.test !== undefined && !pathHeld(tree, entry.test)) add(`test file: ${entry.test}`, place);
        else if (entry.test !== undefined && entry.symbol !== undefined && !phpOrFileHolds(tree, entry.test, entry.symbol)) add(`test symbol: ${entry.symbol} in ${entry.test}`, place);
        if (entry.recipe !== undefined && !pathHeld(tree, entry.recipe)) add(`recipe: ${entry.recipe}`, place);
      }
    }
  }
  for (const helper of sources.features.helpers ?? []) {
    if (helper.command !== undefined) commands.push({ place: `contracts/features.json helper ${helper.id}`, command: helper.command });
    for (const path of [...helper.paths ?? [], ...helper.tests ?? []]) {
      if (!pathHeld(tree, path)) add(`test file: ${path}`, `contracts/features.json helper ${helper.id}`);
    }
  }
  for (const { place, command } of commands) {
    for (const name of checkCommand(tree, command, makefile.targets)) add(name, place);
  }
  for (const [target, declaration] of Object.entries(sources.checkInputs.targets)) {
    for (const input of declaration.inputs ?? []) {
      if (!pathHeld(tree, input) && !tree.ignored(input)) add(`input: ${input}`, `contracts/check-inputs.json ${target}`);
    }
  }
  for (const path of Object.keys(sources.checkInputs.paths)) {
    if (!pathHeld(tree, path) && !tree.ignored(path)) add(`input: ${path}`, 'contracts/check-inputs.json paths');
  }
  return stale;
};

const phpOrFileHolds = (tree: Tree, test: string, symbol: string): boolean => (test.endsWith('.php') ? phpScope(tree, [test]).text : tree.read(test)).includes(symbol);
