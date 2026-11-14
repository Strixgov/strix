import { createHash } from 'node:crypto';

export const TAAS_VERSION = 'taas-candidate-v1';
const KINDS = new Set(['repository','research','api','standard','model','skill','license','asset','operations']);
const ROUTES = new Set(['reuse_existing','open_source_compose','api_adapter','fork','clean_room','research_implement','license','purchase','managed_service']);
const SHA256 = /^[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const RIGHTS = new Set(['pending','eligible','ineligible']);
const evidenceValid = review => review && typeof review==='object' && !Array.isArray(review) && RIGHTS.has(review.status) && Array.isArray(review.evidenceRefs) && review.evidenceRefs.every(ref=>typeof ref==='string' && ref.trim().length>0) && new Set(review.evidenceRefs).size===review.evidenceRefs.length;
const originValid = origin => { try { const url=new URL(origin); return url.protocol==='https:' && !!url.hostname && !url.username && !url.password && !url.hash && url.port==='' && !url.hostname.endsWith('.') && !/\\s/.test(origin); } catch { return false; } };
const REFUSAL = Object.freeze({ SHAPE:'INVALID_SHAPE', VERSION:'UNSUPPORTED_VERSION', SOURCE:'INVALID_SOURCE', RIGHTS:'RIGHTS_NOT_ESTABLISHED', ROUTE:'INVALID_ROUTE', CLAIM:'AUTHORITY_OR_PROOF_FORBIDDEN' });

export function candidateIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const {sourceKind, origin, sourceRevision}=input;
  if (typeof sourceKind!=='string' || typeof origin!=='string' || typeof sourceRevision!=='string') return null;
  return createHash('sha256').update(JSON.stringify([sourceKind,origin,sourceRevision])).digest('hex');
}

/** Planning-only candidate: no kernel authority, proof, or execution semantics. */
export function validateCandidate(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {valid:false, errors:[REFUSAL.SHAPE]};
  if (candidate.schemaVersion !== TAAS_VERSION) errors.push(REFUSAL.VERSION);
  if (!KINDS.has(candidate.sourceKind) || typeof candidate.origin !== 'string' || !originValid(candidate.origin) || !SHA256.test(candidate.originDigest ?? '') || typeof candidate.sourceRevision !== 'string' || !candidate.sourceRevision.trim() || (candidate.sourceKind === 'repository' && !SHA40.test(candidate.sourceRevision))) errors.push(REFUSAL.SOURCE);
  if (candidate.candidateId !== candidateIdentity(candidate)) errors.push(REFUSAL.SOURCE);
  if (typeof candidate.capabilityIntent !== 'string' || !candidate.capabilityIntent.trim()) errors.push(REFUSAL.SHAPE);
  if (!evidenceValid(candidate.rightsReview)) errors.push(REFUSAL.SHAPE);
  if (!Array.isArray(candidate.routeOptions) || candidate.routeOptions.length === 0 || candidate.routeOptions.length > 100 || new Set(candidate.routeOptions.map(r=>r?.route)).size!==candidate.routeOptions.length || candidate.routeOptions.some(r=>!r || !ROUTES.has(r.route) || typeof r.estimatedBuildCost !== 'number' || !Number.isFinite(r.estimatedBuildCost) || r.estimatedBuildCost < 0 || typeof r.annualOperatingCost !== 'number' || !Number.isFinite(r.annualOperatingCost) || r.annualOperatingCost < 0 || !evidenceValid(r.rightsReview))) errors.push(REFUSAL.ROUTE);
  for (const key of ['executionToken','approvalToken','evidenceRecord','claimRung','authorizedActions','deploymentTarget']) if (Object.hasOwn(candidate,key)) errors.push(REFUSAL.CLAIM);
  return {valid:errors.length===0, errors:[...new Set(errors)]};
}

export function assessCandidate(candidate) {
  const validation=validateCandidate(candidate);
  if (!validation.valid) return {status:'HOLD', reasons:validation.errors};
  if (candidate.rightsReview.status !== 'eligible' || candidate.rightsReview.evidenceRefs.length===0) return {status:'HOLD',reasons:[REFUSAL.RIGHTS]};
  return {status:'QUALIFIED_FOR_PLANNING',reasons:[]};
}

export function compareRoutes(candidate, horizonYears=3) {
  const assessment=assessCandidate(candidate);
  if (assessment.status!=='QUALIFIED_FOR_PLANNING') return {status:'HOLD',reasons:assessment.reasons,routes:[]};
  if (!Number.isFinite(horizonYears) || horizonYears<=0 || horizonYears>10) return {status:'HOLD',reasons:[REFUSAL.SHAPE],routes:[]};
  const eligible=candidate.routeOptions.filter(r=>r.rightsReview?.status==='eligible' && r.rightsReview.evidenceRefs.length>0);
  if (eligible.length===0) return {status:'HOLD',reasons:[REFUSAL.RIGHTS],routes:[]};
  return {status:'PLANNING_ONLY',excludedRoutes:candidate.routeOptions.filter(r=>!eligible.includes(r)).map(r=>r.route),routes:eligible.map(r=>({route:r.route,estimatedTotalCost:r.estimatedBuildCost+r.annualOperatingCost*horizonYears})).sort((a,b)=>a.estimatedTotalCost-b.estimatedTotalCost || a.route.localeCompare(b.route))};
}
