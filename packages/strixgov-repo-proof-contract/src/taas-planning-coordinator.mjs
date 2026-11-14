import {validateCandidate} from './taas-candidate.mjs';
import {compareRoutes} from './taas-candidate.mjs';
import {isDeepStrictEqual} from 'node:util';

/**
 * Storage-agnostic TAAS planning coordinator.
 * Store is caller-supplied and must provide atomic compareAndSwap; this module
 * never opens a database, sends a network request, or invokes an action.
 * In particular, no production store is constructed here.
 */
export class TaasPlanningCoordinator {
  constructor({store}) {
    if (!store || typeof store.get!=='function' || typeof store.insertIfAbsent!=='function' || typeof store.compareAndSwap!=='function') throw new TypeError('ATOMIC_STORE_REQUIRED');
    this.store=store;
  }
  async discover(candidate) {
    const check=validateCandidate(candidate);
    if(!check.valid) return {ok:false,reason:'INVALID_CANDIDATE',details:check.errors};
    const record={candidate:structuredClone(candidate),revision:0,state:'DISCOVERED'};
    const result=await this.store.insertIfAbsent(candidate.candidateId,record);
    if(!result || typeof result.inserted!=='boolean') return {ok:false,reason:'STORE_CONTRACT_VIOLATION'};
    const current=await this.store.get(candidate.candidateId);
    if(!current || current.candidate.candidateId!==candidate.candidateId) return {ok:false,reason:'STORE_CONTRACT_VIOLATION'};
    if(!isDeepStrictEqual(current.candidate,candidate)) return {ok:false,reason:'CANDIDATE_ID_COLLISION'};
    return {ok:true,duplicate:!result.inserted,state:current.state,revision:current.revision};
  }
  async triage(candidateId,expectedRevision,{actor,evidenceRef}={}) {
    if(typeof actor!=='string'||!actor.trim()||typeof evidenceRef!=='string'||!evidenceRef.trim()) return {ok:false,reason:'MISSING_PROVENANCE'};
    const current=await this.store.get(candidateId);
    if(!current) return {ok:false,reason:'NOT_FOUND'};
    if(current.revision!==expectedRevision) return {ok:false,reason:'STALE_REVISION'};
    if(current.state!=='DISCOVERED') return {ok:false,reason:'INVALID_TRANSITION'};
    const next={...current,state:'TRIAGED',revision:expectedRevision+1,triageEvidence:{actor,evidenceRef}};
    const swapped=await this.store.compareAndSwap(candidateId,expectedRevision,next,'DISCOVERED');
    return swapped===true?{ok:true,state:'TRIAGED',revision:next.revision}:{ok:false,reason:'CONCURRENT_CHANGE'};
  }
  async reviseRights(candidateId,expectedRevision,{actor,evidenceRef,rightsReview,routeOptions}={}) {
    if(typeof actor!=='string'||!actor.trim()||typeof evidenceRef!=='string'||!evidenceRef.trim()) return {ok:false,reason:'MISSING_PROVENANCE'};
    const current=await this.store.get(candidateId);
    if(!current) return {ok:false,reason:'NOT_FOUND'};
    if(current.revision!==expectedRevision) return {ok:false,reason:'STALE_REVISION'};
    if(current.state!=='TRIAGED') return {ok:false,reason:'INVALID_TRANSITION'};
    const candidate={...current.candidate,rightsReview,routeOptions:routeOptions??current.candidate.routeOptions};
    const check=validateCandidate(candidate);
    if(!check.valid) return {ok:false,reason:'INVALID_CANDIDATE',details:check.errors};
    const next={...current,candidate:structuredClone(candidate),revision:expectedRevision+1,rightsRevisionEvidence:{actor,evidenceRef}};
    const swapped=await this.store.compareAndSwap(candidateId,expectedRevision,next,'TRIAGED');
    return swapped===true?{ok:true,state:'TRIAGED',revision:next.revision}:{ok:false,reason:'CONCURRENT_CHANGE'};
  }
  async qualify(candidateId,expectedRevision,{actor,evidenceRef}={}) {
    if(typeof actor!=='string'||!actor.trim()||typeof evidenceRef!=='string'||!evidenceRef.trim()) return {ok:false,reason:'MISSING_PROVENANCE'};
    const current=await this.store.get(candidateId);
    if(!current) return {ok:false,reason:'NOT_FOUND'};
    if(current.revision!==expectedRevision) return {ok:false,reason:'STALE_REVISION'};
    if(current.state!=='TRIAGED') return {ok:false,reason:'INVALID_TRANSITION'};
    const plan=compareRoutes(current.candidate);
    if(plan.status!=='PLANNING_ONLY') return {ok:false,reason:'RIGHTS_NOT_ESTABLISHED'};
    const next={...current,state:'QUALIFIED',revision:expectedRevision+1,planningEvidence:{actor,evidenceRef,routeCount:plan.routes.length}};
    const swapped=await this.store.compareAndSwap(candidateId,expectedRevision,next,'TRIAGED');
    return swapped===true?{ok:true,state:'QUALIFIED',revision:next.revision,plan}:{ok:false,reason:'CONCURRENT_CHANGE'};
  }
}
/** Disposable fixture only. Not multi-process or durable. */
export class InMemoryTaasStore {
  #data=new Map();
  async get(key){const v=this.#data.get(key);return v?structuredClone(v):null;}
  async insertIfAbsent(key,value){if(this.#data.has(key))return {inserted:false};this.#data.set(key,structuredClone(value));return {inserted:true};}
  async compareAndSwap(key,revision,value,expectedState){const current=this.#data.get(key);if(!current||current.revision!==revision||(expectedState!==undefined&&current.state!==expectedState))return false;this.#data.set(key,structuredClone(value));return true;}
}
