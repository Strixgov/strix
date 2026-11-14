import {createHash} from 'node:crypto';
import {validateCandidate} from './taas-candidate.mjs';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const STATES=new Set(['DISCOVERED','TRIAGED','HOLD','QUALIFIED','BUILDING','VERIFIED','READY_FOR_APPROVAL','APPROVED','REJECTED','RETIRED']);
const EDGES={DISCOVERED:['TRIAGED','HOLD','REJECTED'],TRIAGED:['QUALIFIED','HOLD','REJECTED'],HOLD:['TRIAGED','REJECTED'],QUALIFIED:['BUILDING','HOLD','REJECTED'],BUILDING:['VERIFIED','HOLD','REJECTED'],VERIFIED:['READY_FOR_APPROVAL','HOLD','REJECTED'],READY_FOR_APPROVAL:['APPROVED','HOLD','REJECTED'],APPROVED:['RETIRED'],REJECTED:[],RETIRED:[]};
/** Disposable in-memory planning registry. Not an authority or durable event store. */
export class CandidateRegistry {
  #items=new Map();
  register(candidate) {
    const validation=validateCandidate(candidate);
    if(!validation.valid) return {ok:false,reason:'INVALID_CANDIDATE',details:validation.errors};
    const existing=this.#items.get(candidate.candidateId);
    if(existing) {
      if(digest(existing.candidate)!==digest(candidate)) return {ok:false,reason:'CANDIDATE_ID_COLLISION'};
      return {ok:true,duplicate:true,revision:existing.revision,state:existing.state};
    }
    this.#items.set(candidate.candidateId,{candidate:structuredClone(candidate),state:'DISCOVERED',revision:0,events:[]});
    return {ok:true,duplicate:false,revision:0,state:'DISCOVERED'};
  }
  transition({candidateId,expectedRevision,to,actor,evidenceRef}) {
    const item=this.#items.get(candidateId);
    if(!item) return {ok:false,reason:'NOT_FOUND'};
    if(item.revision!==expectedRevision) return {ok:false,reason:'STALE_REVISION'};
    if(!STATES.has(to)||!EDGES[item.state].includes(to)) return {ok:false,reason:'INVALID_TRANSITION'};
    if(typeof actor!=='string'||!actor.trim()||typeof evidenceRef!=='string'||!evidenceRef.trim()) return {ok:false,reason:'MISSING_PROVENANCE'};
    // An in-memory record is never sufficient to authorize a consequential action.
    if(to==='APPROVED') return {ok:false,reason:'EXTERNAL_AUTHORITY_REQUIRED'};
    if(to==='QUALIFIED' && (item.candidate.rightsReview.status!=='eligible' || item.candidate.rightsReview.evidenceRefs.length===0 || !item.candidate.routeOptions.some(r=>r.rightsReview?.status==='eligible' && r.rightsReview.evidenceRefs.length>0))) return {ok:false,reason:'RIGHTS_NOT_ESTABLISHED'};
    const previous=item.events.at(-1)?.hash??'GENESIS';
    const event={candidateId,from:item.state,to,actor,evidenceRef,revision:expectedRevision+1,previous};
    const frozen=Object.freeze({...event,hash:digest(event)});
    item.events.push(frozen);item.state=to;item.revision++;
    return {ok:true,revision:item.revision,state:item.state,event:structuredClone(frozen)};
  }
  read(id){const item=this.#items.get(id);return item?structuredClone({candidate:item.candidate,state:item.state,revision:item.revision,events:item.events}):null;}
}
