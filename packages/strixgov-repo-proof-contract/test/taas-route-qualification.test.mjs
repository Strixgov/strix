import test from 'node:test';
import assert from 'node:assert/strict';
import {CandidateRegistry} from '../src/taas-registry.mjs';
import {candidateIdentity} from '../src/taas-candidate.mjs';
const fixture=()=>{const c={schemaVersion:'taas-candidate-v1',sourceKind:'repository',origin:'https://github.com/example/route',sourceRevision:'a'.repeat(40),originDigest:'b'.repeat(64),capabilityIntent:'safe integration',rightsReview:{status:'eligible',evidenceRefs:['review:1']},routeOptions:[{route:'api_adapter',estimatedBuildCost:1,annualOperatingCost:1,rightsReview:{status:'pending',evidenceRefs:[]}}]};c.candidateId=candidateIdentity(c);return c;};
test('candidate-wide rights do not qualify an unlicensed implementation route',()=>{const c=fixture(),r=new CandidateRegistry();assert.equal(r.register(c).ok,true);assert.equal(r.transition({candidateId:c.candidateId,expectedRevision:0,to:'TRIAGED',actor:'reviewer',evidenceRef:'review:1'}).ok,true);assert.equal(r.transition({candidateId:c.candidateId,expectedRevision:1,to:'QUALIFIED',actor:'reviewer',evidenceRef:'review:2'}).reason,'RIGHTS_NOT_ESTABLISHED');});
