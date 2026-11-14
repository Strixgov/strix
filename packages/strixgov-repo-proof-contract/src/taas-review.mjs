import {createHash} from 'node:crypto';
import {compareRoutes,validateCandidate} from './taas-candidate.mjs';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function prepareReview({candidate,sourceRef,reviewer}={}){
 const checked=validateCandidate(candidate);
 if(!checked.valid)return {status:'HOLD',reasons:checked.errors};
 if(typeof sourceRef!=='string'||!sourceRef.trim()||typeof reviewer!=='string'||!reviewer.trim())return {status:'HOLD',reasons:['INVALID_REVIEW_INPUT']};
 const plan=compareRoutes(candidate);
 if(plan.status!=='PLANNING_ONLY')return {status:'HOLD',reasons:plan.reasons};
 const body={version:'taas-review-v1',kind:'UNSIGNED_PLANNING',candidateId:candidate.candidateId,sourceRef,reviewer,plan,authorized:false};
 return {status:'REVIEW_ONLY',packet:{...body,digest:digest(body)}};
}
export function verifyReview(packet){
 if(!packet||packet.version!=='taas-review-v1'||packet.kind!=='UNSIGNED_PLANNING'||packet.authorized!==false)return false;
 const {digest:expected,...body}=packet;
 return typeof expected==='string'&&expected===digest(body);
}
