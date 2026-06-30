// Only the capability-graph *types* (the schema/contract surface) are part of
// the open proof package. The decision logic — registry, resolver, profiles,
// packs — moved to the closed control core (@strixgov/governance-core).
export * from "./types.js";
