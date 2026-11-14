import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {SqliteTaasStore} from '../src/taas-sqlite-store.mjs';
test('existing incompatible table refuses startup without alteration',()=>{const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE taas_planning_candidates (candidate_id TEXT PRIMARY KEY, wrong_column TEXT)');assert.throws(()=>new SqliteTaasStore(db),/INCOMPATIBLE_SCHEMA/);assert.equal(db.prepare('PRAGMA table_info(taas_planning_candidates)').all().length,2);}finally{db.close();}});
test('corrupt stored record is refused rather than treated as valid state',async()=>{const db=new DatabaseSync(':memory:');try{const store=new SqliteTaasStore(db);db.prepare('INSERT INTO taas_planning_candidates VALUES (?,?,?,?)').run('id',0,'DISCOVERED',JSON.stringify({candidate:{candidateId:'wrong'},revision:0,state:'DISCOVERED'}));await assert.rejects(()=>store.get('id'),/CORRUPT_RECORD/);}finally{db.close();}});
