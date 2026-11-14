import test from 'node:test';
import assert from 'node:assert/strict';
import {fromGsdDiscovery} from '../src/taas-gsd-adapter.mjs';
import {compareRoutes} from '../src/taas-candidate.mjs';
const input=()=>({origin:'git+https://github.com/example/repo.git',commitSha:'a'.repeat(40),signal:'tool execution path',sourceDigest:'b'.repeat(64)});
test('pinned GSD discovery produces planning-only candidate on HOLD for rights',()=>{const r=fromGsdDiscovery(input());assert.equal(r.status,'DISCOVERED');assert.equal(r.candidate.sourceKind,'repository');assert.equal(compareRoutes(r.candidate).status,'HOLD');assert.equal(r.candidate.claimRung,undefined);});
test('moving revision and missing source digest refused',()=>{const i=input();i.commitSha='main';assert.equal(fromGsdDiscovery(i).status,'HOLD');i.commitSha='a'.repeat(40);i.sourceDigest='';assert.equal(fromGsdDiscovery(i).status,'HOLD');});
test('deterministic identity for repeated discovery',()=>{const a=fromGsdDiscovery(input()),b=fromGsdDiscovery(input());assert.equal(a.candidate.candidateId,b.candidate.candidateId);});
test('different pinned revision changes identity',()=>{const a=input(),b=input();b.commitSha='c'.repeat(40);assert.notEqual(fromGsdDiscovery(a).candidate.candidateId,fromGsdDiscovery(b).candidate.candidateId);});
