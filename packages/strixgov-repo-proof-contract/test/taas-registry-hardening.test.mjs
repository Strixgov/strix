import test from 'node:test';
import assert from 'node:assert/strict';
import {CandidateRegistry} from '../src/taas-registry.mjs';
import {candidateIdentity} from '../src/taas-candidate.mjs';
const fixture=()=>{const c={schemaVersion:'taas-candidate-v1',sourceKind:'repository',origin:'https://github.com/example/fixture',sourceRevision:'a'.repeat(40),originDigest:'b'.repeat(64),capabilityIntent:'sample',rightsReview:{status:'eligible',evidenceRefs:['review:1']},routeOptions:[{route:'api_adapter',estimatedBuildCost:10,annualOperatingCost:1,rightsReview:{status:'eligible',evidenceRefs:['review:1']}}]};c.candidateId=candidateIdentity(c);return c;};
test('same ID cannot silently replace a changed payload',()=>{const r=new CandidateRegistry(),c=fixture();assert.equal(r.register(c).ok,true);const changed=structuredClone(c);changed.capabilityIntent='different';assert.equal(r.register(changed).reason,'CANDIDATE_ID_COLLISION');});
test('pending rights cannot qualify',()=>{const r=new CandidateRegistry(),c=fixture();c.rightsReview={status:'pending',evidenceRefs:[]};r.register(c);assert.equal(r.transition({candidateId:c.candidateId,expectedRevision:0,to:'TRIAGED',actor:'reviewer',evidenceRef:'e1'}).ok,true);assert.equal(r.transition({candidateId:c.candidateId,expectedRevision:1,to:'QUALIFIED',actor:'reviewer',evidenceRef:'e2'}).reason,'RIGHTS_NOT_ESTABLISHED');});
