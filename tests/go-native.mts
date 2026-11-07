// Native Go compilation and execution are separate repository-owned phases.
import { basename, isAbsolute, join } from 'node:path';

const buildValues = new Set(['-tags', '-mod', '-modfile', '-overlay', '-gcflags', '-asmflags', '-ldflags', '-p', '-pkgdir', '-toolexec', '-buildmode', '-compiler', '-coverpkg', '-covermode']);
const buildBooleans = new Set(['-race', '-msan', '-asan', '-cover', '-a', '-x', '-trimpath', '-buildvcs']);
const discoveryFlags = new Set(['-tags', '-mod', '-modfile', '-overlay', '-race', '-msan', '-asan', '-compiler']);
const testValues = new Set(['-run', '-skip', '-count', '-timeout', '-shuffle', '-parallel', '-cpu', '-bench', '-benchtime', '-list']);
const testBooleans = new Set(['-failfast', '-short', '-benchmem']);

export type GoInvocation = { packages: string[]; build: string[]; discovery: string[]; native: string[]; raw: boolean };
export type GoPackage = { path: string; directory: string; hasTests: boolean };

/** Keep native flags in their owning phase; unsupported orchestration is an explicit error. */
export function goInvocation(args: string[]): GoInvocation {
  const plan: GoInvocation = { packages: [], build: [], discovery: [], native: ['-test.v=test2json'], raw: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('-')) { plan.packages.push(arg); continue; }
    const flag = arg.split('=')[0] ?? '';
    if (flag === '-json') { plan.raw = arg !== '-json=false'; continue; }
    if (flag === '-v') continue;
    const build = buildValues.has(flag) || buildBooleans.has(flag);
    const native = testValues.has(flag) || testBooleans.has(flag);
    if (!build && !native) throw new Error(`go-test: unsupported flag ${flag}; declare its build or native execution semantics in tests/go-native.mts`);
    const words = [arg];
    if ((buildValues.has(flag) || testValues.has(flag)) && !arg.includes('=')) {
      const value = args[++index];
      if (value === undefined || value === '') throw new Error(`go-test: ${flag} needs a value; provide ${flag}=<value>`);
      words.push(value);
    }
    if (build) {
      plan.build.push(...words);
      if (discoveryFlags.has(flag)) plan.discovery.push(...words);
    } else plan.native.push(...words.map((word, offset) => offset === 0 ? word.replace(/^-/, '-test.') : word));
  }
  if (!plan.packages.length) plan.packages.push('.');
  return plan;
}

// Go owns package discovery. Four tab-separated fields avoid a second parser for Go's JSON object stream.
export const GO_PACKAGE_FORMAT = '{{.ImportPath}}\t{{.Dir}}\t{{len .TestGoFiles}}\t{{len .XTestGoFiles}}';
export const goDiscoveryArguments = (plan: GoInvocation): string[] => ['list', '-e', '-f', GO_PACKAGE_FORMAT, ...plan.discovery, ...plan.packages];

export function goPackages(output: string): GoPackage[] {
  const packages: GoPackage[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n').filter(Boolean)) {
    const [path, directory, internal, external, extra] = line.split('\t');
    if (!path || directory === undefined || internal === undefined || external === undefined || extra !== undefined ||
        !/^\d+$/.test(internal) || !/^\d+$/.test(external) || (directory !== '' && !isAbsolute(directory)))
      throw new Error(`go-test: invalid package discovery record ${JSON.stringify(line)}; inspect go list with the declared package patterns`);
    if (seen.has(path)) throw new Error(`go-test: duplicate package ${path}; inspect go list with the declared package patterns`);
    seen.add(path);
    packages.push({ path, directory, hasTests: Number(internal) + Number(external) > 0 });
  }
  if (!packages.length) throw new Error('go-test: package discovery selected no package; provide a package pattern that matches the checkout');
  return packages;
}

export const goCompileArguments = (plan: GoInvocation, packages: GoPackage[], output: string): string[] =>
  ['test', '-c', ...plan.build, '-o', output, ...packages.map(pkg => pkg.path)];

export const goExecuteArguments = (plan: GoInvocation, pkg: GoPackage, binary: string): string[] =>
  ['tool', 'test2json', '-t', '-p', pkg.path, binary, ...plan.native];

export type GoBatch = { directory: string; entries: { pkg: GoPackage; binary: string }[] };

/** Go builds compatible packages together; equal native output names require separate output directories. */
export function goBatches(packages: GoPackage[], directory: string): GoBatch[] {
  const batches: GoBatch[] = [];
  for (const pkg of packages) {
    const name = `${basename(pkg.path)}.test`;
    let batch = batches.find(batch => batch.entries.every(entry => basename(entry.binary) !== name));
    if (!batch) {
      batch = { directory: join(directory, String(batches.length)), entries: [] };
      batches.push(batch);
    }
    batch.entries.push({ pkg, binary: join(batch.directory, name) });
  }
  return batches;
}
