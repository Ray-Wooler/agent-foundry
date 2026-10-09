import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePocEvidence } from '../dist/poc-evidence.js';
const valid = () => ({
 apsVersion:'1.5-alpha', hypothesis:'Cache improves latency', businessOutcome:'Faster response',
 baseline:'p95=200 ms', method:'Run 30 paired trials', environment:'Staging, build abc',
 measurements:[{metric:'p95 latency in ms',observed:120,threshold:150,direction:'at_most',evidenceRef:'artifact:run-1'}],
 provenance:['git:abc'],limitations:['Small sample'],rightsStatus:'VERIFIED',executionAuthorized:true,executionObserved:true,independentReview:true
});
test('complete externally reviewed PoC evidence passes metadata gate only',()=>{
 assert.deepEqual(evaluatePocEvidence(valid()),{decision:'GO',findings:[]});
});
test('missing experimental evidence cannot GO',()=>{
 const x=valid();x.measurements=[];assert.equal(evaluatePocEvidence(x).decision,'ITERATE');
});
test('failed feasibility threshold is NO_GO',()=>{
 const x=valid();x.measurements[0].observed=180;assert.equal(evaluatePocEvidence(x).decision,'NO_GO');
});
test('unverified rights, absent approval, unobserved execution and missing review prevent GO',()=>{
 for(const patch of [{rightsStatus:'UNVERIFIED'},{executionAuthorized:false},{executionObserved:false},{independentReview:false}]){
  assert.notEqual(evaluatePocEvidence({...valid(),...patch}).decision,'GO');
 }
});
test('prohibited source rights yield NO_GO',()=>{
 assert.equal(evaluatePocEvidence({...valid(),rightsStatus:'PROHIBITED'}).decision,'NO_GO');
});
