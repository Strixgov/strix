import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateIdentity,validateCandidate} from '../src/taas-candidate.mjs';
test('identity function refuses null and missing fields without throwing',()=>{assert.equal(candidateIdentity(null),null);assert.equal(candidateIdentity({}),null);assert.equal(candidateIdentity({sourceKind:'repository',origin:'https://github.com/x',sourceRevision:1}),null);});
test('empty HTTPS host refused even when candidate identity is internally consistent',()=>{const c={schemaVersion:'taas-candidate-v1',sourceKind:'repository',origin:'https://',sourceRevision:'a'.repeat(40),originDigest:'b'.repeat(64),capabilityIntent:'test',rightsReview:{status:'pending',evidenceRefs:[]},routeOptions:[{route:'api_adapter',estimatedBuildCost:1,annualOperatingCost:1,rightsReview:{status:'pending',evidenceRefs:[]}}]};c.candidateId=candidateIdentity(c);assert.equal(validateCandidate(c).valid,false);});
