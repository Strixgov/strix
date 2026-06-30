// Public entry for @strixgov/healthcare-demo.
//
// Most users will run `npx @strixgov/healthcare-demo` and never import
// the package programmatically. Those who DO can use the exports here
// to integrate the synthetic-data generator + workflow into their own
// healthcare-AI testing or training material.

export {
  buildSyntheticSubmission,
  classifyAndRedact,
} from "./synthetic-records.mjs";

export {
  phaseClassify,
  phaseEvaluate,
  phaseSign,
  phaseVerify,
  runWorkflow,
} from "./clinical-workflow.mjs";
