// isolatedEnvironment is the environment of the child processes a test case starts (make, check scripts, shells running fake tools).
// From this process it takes only PATH, HOME, and TMPDIR; any other variables are only those the case passes as variables. So a case's result
// does not depend on the environment of whoever ran it: GROUP set by CI's `make orm-check GROUP=<group>`, GITHUB_ACTIONS,
// GITHUB_STEP_SUMMARY, ORM_CHECK_RUN_ID, ORM_CI_SETUP, ORM_GIT_RANGE, the parent make's MAKEFLAGS, and variables the Makefile exports
// do not reach the child processes. PATH finds the tools, HOME finds the user settings and caches of git, cargo, and go,
// and TMPDIR is the temporary directory the check runner gives each step (AGENTS.md). The MISE_ variables are the mise
// settings of the checkout that the Makefile exports (Makefile:140-145): a mise shim on PATH, such as var/tools/mise/shims/go,
// reads its tool versions from MISE_GLOBAL_CONFIG_FILE, so a child that runs a shim outside the checkout finds the same tool.
const INHERITED_VARIABLES = ['PATH', 'HOME', 'TMPDIR', 'MISE_DATA_DIR', 'MISE_CACHE_DIR', 'MISE_STATE_DIR', 'MISE_CONFIG_DIR',
  'MISE_GLOBAL_CONFIG_FILE', 'MISE_GLOBAL_CONFIG_ROOT'];

export function isolatedEnvironment(variables: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...variables };
}
