// 공통 구성요소 문서(docs/interfaces-model.md와 그 한국어 쌍)를 manifest에서 만든다. 도표는 reviewer가 manifest에서 고치는
// 구성요소의 field, method, ownership 규칙에서 나온다. 손으로 쓴 lifecycle 도표는 따로 있다.
import { createHash } from 'node:crypto';
import { byteOrder } from './json.mts';
import type { Manifest } from './manifest.mts';

// DOCUMENT_ID는 구성요소 문서 쌍의 doc-id다(@polyspec/kit의 make documents-check). 한국어 문서는 영어 문서의 sha256도 가진다.
const DOCUMENT_ID = 'interfaces-model';

/** diagram은 manifest의 구성요소 문서다. korean이면 한국어 문서다. 지역화한 설명이나 관계가 없으면 error다. */
export function diagram(m: Manifest, korean: boolean): string {
  const components = m.components ?? [], edges = m.edges ?? [];
  let b = '';
  if (korean) {
    const english = diagram(m, false);
    b += `<!-- doc-id: ${DOCUMENT_ID} -->\n<!-- source-sha256: ${createHash('sha256').update(english, 'utf8').digest('hex')} -->\n`;
    b += '# 공통 구성요소\n\n<!-- contracts/interfaces.json에서 생성됨. 직접 수정하지 않는다. -->\n\n```mermaid\nclassDiagram\n';
  } else {
    b += `<!-- doc-id: ${DOCUMENT_ID} -->\n`;
    b += '# Common components\n\n<!-- Generated from contracts/interfaces.json; DO NOT EDIT. -->\n\n```mermaid\nclassDiagram\n';
  }
  const fieldNames = (fields: Record<string, string> | undefined): string[] => Object.keys(fields ?? {}).sort(byteOrder);
  for (const c of components) {
    b += `    class ${c.id ?? ''} {\n`;
    if ((c.internal ?? '') !== '') b += '        <<internal>>\n';
    for (const k of fieldNames(c.fields)) {
      const t = (c.fields?.[k] ?? '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      b += `        ${t} ${k}\n`;
    }
    for (const method of c.methods ?? []) b += `        ${method}()\n`;
    b += '    }\n';
  }
  for (const e of edges) {
    if ((e.role ?? '') === '' || (e.role_ko ?? '') === '') throw new Error(`edge ${e.from ?? ''} -> ${e.to ?? ''} has no localized role`);
    b += `    ${e.from ?? ''} ${e.kind ?? ''} ${e.to ?? ''} : ${e.role ?? ''}\n`;
  }
  b += korean ? '```\n\n| 구성요소 | 동작 및 상태 |\n|---|---|\n' : '```\n\n| Component | Behavior and state |\n|---|---|\n';
  for (const c of components) {
    let description = (korean ? c.ownership_ko : c.ownership) ?? '';
    if (description === '') throw new Error(`component ${c.id ?? ''} has no localized description`);
    const internal = c.internal ?? '', internalKo = c.internal_ko ?? '';
    if ((internal === '') !== (internalKo === '')) throw new Error(`component ${c.id ?? ''} is internal without its localized grounding`);
    if (korean && internalKo !== '') description += ` 내부: ${internalKo}`;
    else if (internal !== '') description += ` Internal: ${internal}`;
    b += `| ${c.id ?? ''} | ${description} |\n`;
  }
  b += korean
    ? '\n`<<internal>>`로 표시한 구성요소는 manifest의 `internal` 필드(`internal_ko`)가 그 근거를 적는다. 각 client가 그 method를 공통 signature 없이 비공개로 구현하므로 그 method에는 interface rule이 없다. 다른 구성요소의 모든 method는 rule을 가지며 모든 rule은 공개 구성요소의 method 하나의 rule이다. `make interface-check`가 두 방향을 모두 확인한다.\n'
    : '\nA component marked `<<internal>>` states its grounding in the manifest field `internal` (`internal_ko`): each client implements its methods privately with no common signature, so they have no interface rule. Every method of the other components has a rule, and every rule names a method of a public component; `make interface-check` checks both directions.\n';
  b += korean ? '\n| 시작 | 대상 | 관계 |\n|---|---|---|\n' : '\n| From | To | Relation |\n|---|---|---|\n';
  for (const e of edges) b += `| ${e.from ?? ''} | ${e.to ?? ''} | ${(korean ? e.role_ko : e.role) ?? ''} |\n`;
  b += korean
    ? '\n도표의 type 이름에서 `_`는 중첩 type 구분자다. 정확한 type은 다음 표에 정의한다.\n\n| 필드 | 공통 type |\n|---|---|\n'
    : '\nAn underscore in a diagram type name separates nested types. The table defines the exact types.\n\n| Field | Common type |\n|---|---|\n';
  for (const c of components) {
    for (const k of fieldNames(c.fields)) b += `| ${c.id ?? ''}.${k} | \`${c.fields?.[k] ?? ''}\` |\n`;
  }
  return b;
}
