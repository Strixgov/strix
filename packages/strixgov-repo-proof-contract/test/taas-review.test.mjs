import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateIdentity} from '../src/taas-candidate.mjs';
import {prepareReview,verifyReview} from '../src/taas-review.mjs';
const c={schemaVersion:'taas-candidate-v1',sourceKind:'repository',origin:'https://github.com/example/repo',sourceRevision:'a'.repeat(40),originDigest:'b'.repeat(64),capabilityIntent:'synthetic',rightsReview:{status:'eligible',evidenceRefs:['synthetic:license']},routeOptions:[{route:'api_adapter',estimatedBuildCost:1,annualOperatingCost:2,rightsReview:{status:'eligible',evidenceRefs:['synthetic:license']}}]};
c.candidateId=candidateIdentity(c);
test('review packet verifies but cannot authorize',()=>{const r=prepareReview({candidate:c,sourceRef:'synthetic:source',reviewer:'synthetic:reviewer'});assert.equal(r.status,'REVIEW_ONLY');assert.equal(verifyReview(r.packet),true);assert.equal(r.packet.authorized,false);const changed=structuredClone(r.packet);changed.plan.routes[0].estimatedTotalCost=0;assert.equal(verifyReview(changed),false);});
test('missing reviewer or pending rights is held',()=>{assert.equal(prepareReview({candidate:c,sourceRef:'x',reviewer:''}).status,'HOLD');const changed=structuredClone(c);changed.rightsReview.status='pending';assert.equal(prepareReview({candidate:changed,sourceRef:'x',reviewer:'y'}).status,'HOLD');});
