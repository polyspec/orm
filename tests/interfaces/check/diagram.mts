// The component document (docs/spec/interfaces-model.md and its Korean pair) is made from the manifest. The diagram is what a reviewer edits in the manifest
// It comes from the component's fields, methods, and ownership rules. The hand-written lifecycle diagram is separate.
import { createHash } from 'node:crypto';
import { byteOrder } from './json.mts';
import type { Manifest } from './manifest.mts';

// DOCUMENT_ID is the doc-id of the component document pair (make docs-check of @polyspec/kit). The Korean document also carries the sha256 of the English document.
const DOCUMENT_ID = 'interfaces-model';

/** diagram is a component document of the manifest. If korean, it is the Korean document. Without localized explanations or relations it is an error. */
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
  const surfaces = m.native_surfaces ?? [];
  b += korean ? '\n## Host-native APIs\n\n| API | Host | Semantic requirement | Native declaration |\n|---|---|---|---|\n'
    : '\n## Host-native APIs\n\n| API | Host | Semantic requirement | Native declaration |\n|---|---|---|---|\n';
  for (const surface of surfaces) {
    b += `| ${surface.id ?? ''} | ${surface.owner ?? ''} | ${surface.semantic ?? ''} | \`${surface.symbol ?? ''}\` |\n`;
  }
  b += korean
    ? '\nHost-native API는 해당 host의 공개 primitive 형식으로만 선언하며 공통 signature를 요구하지 않는다. 공통 동작은 `behavior_adapters`의 모든 runtime 항목과 정확한 parity case로 검증한다. `unresolved` 항목은 구현 완료 증거가 아니다.\n'
    : '\nA host-native API uses its host language’s public primitive and has no common signature. The shared behavior is checked through every runtime entry and its exact parity cases in `behavior_adapters`. An `unresolved` entry is not implementation evidence.\n';
  const behaviors = m.behavior_adapters ?? [];
  b += korean
    ? '\n## 공통 동작 adapter\n\n- **INT-139** 생성 구성요소 문서는 manifest의 모든 component, method, field, ownership edge를 영·한으로 기록한다.\n\n| 요구사항 | 완료 checklist 항목 | Runtime | 상태 | Host primitive | 실행 case |\n|---|---|---|---|---|---|\n'
    : '\n## Shared behavior adapters\n\n- **INT-139** The generated component document records every component, method, field, and ownership edge in the manifest in both languages.\n\n| Requirement | Completion item | Runtime | Status | Host primitive | Executable case |\n|---|---|---|---|---|---|\n';
  for (const behavior of behaviors) {
    for (const [runtime, adapter] of Object.entries(behavior.adapters ?? {}).sort(([a], [b]) => byteOrder(a, b))) {
      const cases = (adapter.cases ?? []).map(c => `${c.test ?? ''}::${c.id ?? ''}${c.phase ? ` (${c.phase})` : ''}`).join('<br>');
      const state = adapter.status === 'unresolved' ? `${adapter.status} (${adapter.item ?? ''}; ${adapter.required_case ?? ''})` : adapter.status ?? '';
      b += `| ${behavior.id ?? ''} | ${behavior.completion_item ?? ''} | ${runtime} | ${state} | ${adapter.primitive ?? ''} | ${cases} |\n`;
    }
  }
  b += korean
    ? '\n모든 runtime에 정확한 실행 case가 있어야 공통 동작이 완료된다. `unresolved` 상태는 지정된 checklist 작업이 해결될 때까지 완료를 막는다.\n'
    : '\nA shared behavior is complete only when every runtime has an exact executable case. An `unresolved` entry blocks completion until its checklist item is resolved.\n';
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
