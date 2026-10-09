import test from 'node:test';
import assert from 'node:assert/strict';
import {PromptForgeEngine,DeterministicPromptForgeProvider,validateGovernedCandidate} from '../dist/index.js';
const input={name:'Git Workflow Advisor',agentClass:'advisor',rightsStatus:'UNVERIFIED',sourcePrompt:'Propose a safe history rewrite. Never execute commands.',revisionRequest:'Preserve capability-specific prerequisites and evidence requirements.'};
const base=new DeterministicPromptForgeProvider();
const capability={id:'plan-history-rewrite',description:'Propose an authorized history rewrite.',inputs:['Supplied commit graph'],outputs:['Conditional unexecuted rewrite plan'],acceptanceCriteria:['No completion claims without evidence'],consequential:true,preconditions:['Scoped human authorization','Branch ownership and protection policy established','Collaborator impact reviewed','Expected remote revision established','Recovery plan agreed'],evidenceRequirements:['Authorization identifying branch and operation','Authoritative ownership and protected-branch rules','Collaborator dependency review','Expected remote object ID with observation time','Preserved commit IDs and recovery procedure']};
function provider(value){return {async generate(stage,source,context){const r=await base.generate(stage,source,context);if(stage==='CAPABILITY_EXTRACTION')r.data=value;return r;}};}
test('capability contracts survive extraction, stage evidence and APS mapping without granting authority',async()=>{
 const result=await new PromptForgeEngine(provider({capabilities:[capability]})).transform(input);
 const extracted=result.stages.find(x=>x.stage==='CAPABILITY_EXTRACTION').output.capabilities[0];
 const saved=result.apsDocument.capabilities[0];
 assert.deepEqual(extracted.preconditions,capability.preconditions);
 assert.deepEqual(saved.preconditions,capability.preconditions);
 assert.deepEqual(saved.evidence_requirements,capability.evidenceRequirements);
 assert.deepEqual(result.apsDocument.governance.authority.execution,[]);
 assert.deepEqual(result.apsDocument.governance.authority.delegation,[]);
 assert.deepEqual(result.apsDocument.operational.tools,[]);
 assert.equal(result.apsDocument.extensions.promptforge.engine_version,'promptforge-2.2');
 assert.equal(result.apsDocument.governance.contextual_authority.authority_model,'contextual_least_privilege');
 assert.deepEqual(result.apsDocument.governance.contextual_authority.roles,[]);
 assert.equal(result.reviewPackage.validation.checks.find(x=>x.id==='PF2-010').passed,true);
 assert.equal(result.reviewPackage.validation.checks.find(x=>x.id==='PF2-011').passed,true);
 assert.ok(result.apsDocument.sufficiency.answerability_policy.required_information.includes('Scoped human authorization'));
 assert.equal(result.apsDocument.sufficiency.answerability_policy.clarification.question_selection,'Ask for the highest-consequence unresolved requirement first.');
 assert.equal(result.apsDocument.sufficiency.pre_execution_consolidation.required,true);
 assert.equal(result.apsDocument.sufficiency.pre_execution_consolidation.fail_closed,true);
 assert.equal(result.reviewPackage.validation.checks.find(x=>x.id==='PF2-012').passed,true);
 assert.ok(result.apsDocument.extensions.promptforge.revision_request_sha256);
 assert.equal(result.reviewPackage.validation.status,'PASS');
});
for(const field of ['preconditions','evidenceRequirements'])for(const value of [undefined,[],[''],['valid',42],'not-an-array'])test('rejects invalid '+field+' '+JSON.stringify(value),async()=>{
 await assert.rejects(new PromptForgeEngine(provider({capabilities:[{...capability,[field]:value}]})).transform(input),/requires non-empty/);
});
test('rejects generic-only evidence and empty extraction instead of silently producing a passing APS',async()=>{
 await assert.rejects(new PromptForgeEngine(provider({capabilities:[{...capability,evidenceRequirements:['source_intent_review']}]})).transform(input),/failed governance validation/);
 await assert.rejects(new PromptForgeEngine(provider({capabilities:[]})).transform(input),/no capabilities/);
});
test('candidate validation detects lost structured evidence',async()=>{
 const r=await new PromptForgeEngine(provider({capabilities:[capability]})).transform(input);
 r.apsDocument.capabilities[0].preconditions=[];
 const v=validateGovernedCandidate(r.apsDocument,input,r.sourceSha256);
 assert.equal(v.status,'FAIL');assert.equal(v.checks.find(x=>x.id==='PF2-009').passed,false);
});

test('candidate sufficiency validation fails cleanly when capabilities are malformed',async()=>{
 const r=await new PromptForgeEngine(provider({capabilities:[capability]})).transform(input);
 for (const malformed of [undefined,null,'not-an-array',{}]) {
   const candidate=structuredClone(r.apsDocument);
   candidate.capabilities=malformed;
   const v=validateGovernedCandidate(candidate,input,r.sourceSha256);
   assert.equal(v.status,'FAIL');
   assert.equal(v.checks.find(x=>x.id==='PF2-012').passed,false);
 }
});
