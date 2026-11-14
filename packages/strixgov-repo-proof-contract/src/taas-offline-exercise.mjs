import {fromGsdDiscovery} from './taas-gsd-adapter.mjs';
import {compareRoutes} from './taas-candidate.mjs';
import {CandidateRegistry} from './taas-registry.mjs';

/** Purely synthetic end-to-end planning exercise. No worker, network, approval or side effect. */
export function runOfflineExercise() {
  const routes=[
    {route:'reuse_existing',estimatedBuildCost:100,annualOperatingCost:20,rightsReview:{status:'eligible',evidenceRefs:['synthetic:review']}},
    {route:'api_adapter',estimatedBuildCost:50,annualOperatingCost:60,rightsReview:{status:'eligible',evidenceRefs:['synthetic:review']}},
    {route:'open_source_compose',estimatedBuildCost:150,annualOperatingCost:10,rightsReview:{status:'eligible',evidenceRefs:['synthetic:review']}}
  ];
  const discovery=fromGsdDiscovery({origin:'git+https://github.com/example/synthetic.git',commitSha:'a'.repeat(40),signal:'synthetic tool consequence',sourceDigest:'b'.repeat(64),rightsReview:{status:'eligible',evidenceRefs:['synthetic:review']},routeOptions:routes});
  if(discovery.status!=='DISCOVERED') throw new Error('Discovery refused');
  const registry=new CandidateRegistry();
  const registration=registry.register(discovery.candidate);
  if(!registration.ok) throw new Error('Registration refused');
  const plan=compareRoutes(discovery.candidate);
  if(plan.status!=='PLANNING_ONLY') throw new Error('Route comparison refused');
  const steps=['TRIAGED','QUALIFIED'];
  for(const [i,to] of steps.entries()) {
    const t=registry.transition({candidateId:discovery.candidate.candidateId,expectedRevision:i,to,actor:'synthetic-reviewer',evidenceRef:'synthetic:fixture:'+i});
    if(!t.ok) throw new Error('Transition refused: '+t.reason);
  }
  return {scope:'SYNTHETIC_PLANNING_ONLY',candidateId:discovery.candidate.candidateId,registration,plan,registry:registry.read(discovery.candidate.candidateId),executionOccurred:false,approvalGranted:false};
}
