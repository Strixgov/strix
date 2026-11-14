import {createHash} from 'node:crypto';
import {candidateIdentity, validateCandidate} from './taas-candidate.mjs';
const sha256 = input => createHash('sha256').update(input).digest('hex');
/** Read-only, untrusted GSD-1 discovery projection. Never asserts governed coverage. */
export function fromGsdDiscovery(input) {
  if(!input || typeof input!=='object' || Array.isArray(input)) return {status:'HOLD',reason:'UNPINNED_OR_UNVERIFIED_SOURCE'};
  const {origin,commitSha,signal,sourceDigest,rightsReview,routeOptions}=input;
  if(typeof origin!=='string'||!/^git\+https:\/\/[^\s#]+\.git$/.test(origin)||!/^[a-f0-9]{40}$/.test(commitSha??'')||typeof signal!=='string'||!signal.trim()||!/^[a-f0-9]{64}$/.test(sourceDigest??'')) return {status:'HOLD',reason:'UNPINNED_OR_UNVERIFIED_SOURCE'};
  let url;
  try { url=new URL(origin.slice(4,-4)); } catch { return {status:'HOLD',reason:'UNPINNED_OR_UNVERIFIED_SOURCE'}; }
  if(url.protocol!=='https:' || !url.hostname || url.username || url.password || url.hash || url.search || url.port || !url.pathname || url.pathname==='/') return {status:'HOLD',reason:'UNPINNED_OR_UNVERIFIED_SOURCE'};
  const candidate={schemaVersion:'taas-candidate-v1',sourceKind:'repository',origin:origin.slice(4,-4),sourceRevision:commitSha,originDigest:sourceDigest,capabilityIntent:signal,rightsReview:rightsReview??{status:'pending',evidenceRefs:[]},routeOptions:routeOptions??[{route:'research_implement',estimatedBuildCost:0,annualOperatingCost:0,rightsReview:{status:'pending',evidenceRefs:[]}}]};
  candidate.candidateId=candidateIdentity(candidate);
  const check=validateCandidate(candidate);
  return check.valid?{status:'DISCOVERED',candidate,provenance:{source:'gsd1',sourceDigest,sourceDigestVerified:false,adapterDigest:sha256('gsd1-taas-v1')}}:{status:'HOLD',reason:'INVALID_CANDIDATE',details:check.errors};
}
