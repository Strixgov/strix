// Verification / parsing only. Minting (createPayload / signToken /
// serializeToken) moved to the closed control core (@strixgov/governance-core).
export {
  deserializeToken,
  verifySignature,
  validateToken,
  canonicalizePayload,
  sha256,
  TokenFormatError,
} from "./sdt.js";
export type { TokenValidationResult } from "./sdt.js";
