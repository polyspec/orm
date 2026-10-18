// isolatedEnvironment is the environment of the child processes a test case starts (make, check scripts, shells running fake tools).
// From this process it takes only PATH, HOME, and TMPDIR; any other variables are only those the case passes as variables. So a case's result
// does not depend on the environment of whoever ran it: GROUP set by CI's `make check GROUP=<group>`, GITHUB_ACTIONS,
// GITHUB_STEP_SUMMARY, ORM_CHECK_RUN_ID, ORM_CI_SETUP, ORM_GIT_RANGE, the parent make's MAKEFLAGS, and variables the Makefile exports
// do not reach the child processes. PATH finds the tools, HOME finds the user settings and caches of git, cargo, and go,
// and TMPDIR is the temporary directory the check runner gives each step (AGENTS.md).
const INHERITED_VARIABLES = ['PATH', 'HOME', 'TMPDIR'];

export function isolatedEnvironment(variables: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...variables };
}
