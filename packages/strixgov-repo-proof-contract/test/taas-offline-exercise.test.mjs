import test from 'node:test';
import assert from 'node:assert/strict';
import {runOfflineExercise} from '../src/taas-offline-exercise.mjs';
test('synthetic discovery to qualification is reproducible and cannot authorize execution',()=>{
 const a=runOfflineExercise(),b=runOfflineExercise();
 assert.equal(a.scope,'SYNTHETIC_PLANNING_ONLY');
 assert.equal(a.candidateId,b.candidateId);
 assert.equal(a.plan.status,'PLANNING_ONLY');
 assert.equal(a.plan.routes.length,3);
 assert.equal(a.registry.state,'QUALIFIED');
 assert.equal(a.registry.events.length,2);
 assert.equal(a.registry.events[1].previous,a.registry.events[0].hash);
 assert.equal(a.executionOccurred,false);
 assert.equal(a.approvalGranted,false);
});
