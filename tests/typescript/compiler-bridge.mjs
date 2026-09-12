import { planFromProto, requestToProto } from '../../clients/typescript/dist/index.js';
import { create } from '@bufbuild/protobuf';
import { PlanSchema, QueryKind } from '../../clients/typescript/dist/gen/proto/orm/compiler/v1/compiler_pb.js';

const request = requestToProto({
  ir_version:1,schema_hash:'schema',kind:'update',entity:'battle',scope_p:0,n_params:3,
  where:{items:[{pred:{column:'seq',op:'eq',p:1}}]},
  joins:[{rel:'service',kind:'left',query:{entity:'service'}}],
  set:[{column:'name',p:2}],
});
if (request.parameterCount !== 3 || request.root?.scopeParameter !== 0 || request.root.joins[0]?.query?.entity !== 'service' || request.set[0]?.parameter !== 2) throw new Error('TypeScript request bridge failed');

const plan = planFromProto(create(PlanSchema,{schemaHash:'schema',kind:QueryKind.ALL,steps:[{id:0,role:'root',sql:'SELECT ?',binds:[{source:'param',parameter:1,hostStyles:['hex'],columnType:'string'}],assemble:{entity:'battle',alias:'a',columns:[{index:0,name:'seq',column:'seq',type:'i64'}]}}]}));
if (plan.kind !== 'all' || plan.steps[0]?.bind_slots[0]?.param !== 1 || plan.steps[0]?.bind_slots[0]?.host_styles[0] !== 'hex' || plan.steps[0]?.assemble?.columns[0]?.type !== 'i64') throw new Error('TypeScript plan bridge failed');

let rejected = false;
try { requestToProto({ir_version:1,schema_hash:'',kind:'all',entity:'battle',n_params:-1}); } catch { rejected = true; }
if (!rejected) throw new Error('TypeScript bridge accepted an invalid integer');
console.log('typescript compiler bridge: request, plan, and invalid input passed');
