// isolatedEnvironment은 test case가 시작하는 하위 process(make, check script, 가짜 도구를 실행하는 shell)의 환경이다.
// 이 process에서는 PATH, HOME, TMPDIR만 가져오고, 그 밖의 변수는 case가 variables로 준 것뿐이다. 그래서 case의 결과는
// 그것을 실행한 쪽의 환경에 달리지 않는다: CI의 `make check GROUP=<group>`이 환경에 둔 GROUP, GITHUB_ACTIONS,
// GITHUB_STEP_SUMMARY, ORM_CHECK_RUN_ID, ORM_CI_SETUP, ORM_GIT_RANGE, 상위 make의 MAKEFLAGS와 Makefile이 export하는
// 변수는 하위 process에 닿지 않는다. PATH는 도구를 찾고, HOME은 git, cargo, go의 사용자 설정과 cache를 찾으며,
// TMPDIR은 check runner가 단계마다 주는 임시 directory다(AGENTS.md).
export const INHERITED_VARIABLES = ['PATH', 'HOME', 'TMPDIR'];

export function isolatedEnvironment(variables = {}) {
  const env = {};
  for (const name of INHERITED_VARIABLES) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...variables };
}
