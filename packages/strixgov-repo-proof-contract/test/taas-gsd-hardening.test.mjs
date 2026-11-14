import test from 'node:test';
import assert from 'node:assert/strict';
import {fromGsdDiscovery} from '../src/taas-gsd-adapter.mjs';
const fixture=()=>({origin:'git+https://github.com/example/repo.git',commitSha:'a'.repeat(40),signal:'synthetic',sourceDigest:'b'.repeat(64)});
test('untrusted malformed discovery fails closed',()=>{for(const x of [null,undefined,[],{},'text'])assert.equal(fromGsdDiscovery(x).status,'HOLD');});
test('credentialed and ambiguous GSD origins refused',()=>{for(const origin of ['git+https://user:pass@github.com/example/repo.git','git+https://github.com/example/repo.git?x=1','git+https://github.com/example/repo.git#fragment'])assert.equal(fromGsdDiscovery({...fixture(),origin}).status,'HOLD');});
test('adapter never asserts independent verification of supplied digest',()=>{const r=fromGsdDiscovery(fixture());assert.equal(r.status,'DISCOVERED');assert.equal(r.provenance.sourceDigestVerified,false);});
