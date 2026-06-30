/**
 * TypeScript surface for @strixgov/mcp-token-validator.
 *
 * The runtime is JavaScript (ESM); these types are for editor support
 * and downstream TypeScript consumers. Field order in
 * ExecutionAuthorizationV1 mirrors the locked canonical order from
 * docs/architecture/mcp-mode-3-enforcement-v1.md §4.
 */

/** JSON Web Key (RFC 7517) subset — only Ed25519 OKP is supported. */
export interface JsonWebKey {
  kid: string;
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface ExecutionAuthorizationV1Payload {
  schemaVersion: 1;
  authorizationId: string;
  decisionId: string;
  capabilityId: string;
  actorId: string;
  actorClass: "agent" | "human" | "system" | string;
  payloadHash: string;
  tenantId: string;
  environment: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

/**
 * The full token shape — the canonical payload plus the signing-key id
 * and Ed25519 signature over the canonical payload.
 */
export interface ExecutionAuthorizationV1 extends ExecutionAuthorizationV1Payload {
  signingKeyId: string;
  signature: string;
}

export interface ValidateOptions {
  jwks: { keys: JsonWebKey[] };
  expectedTenantId?: string;
  expectedEnvironment?: string;
  expectedActorClass?: string;
  burnNonce: (nonce: string) => Promise<boolean>;
  /** Override the current time. Test-only. */
  now?: () => number;
}

export type ValidationReason =
  | "TOKEN_MALFORMED"
  | "CANONICALIZATION_DRIFT"
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "KEY_NOT_FOUND"
  | "KEY_NOT_ATTESTED"
  | "KEY_REVOKED"
  | "SIGNATURE_INVALID"
  | "EXPIRED"
  | "TENANT_MISMATCH"
  | "ENVIRONMENT_MISMATCH"
  | "ACTOR_CLASS_MISMATCH"
  | "NONCE_REUSED";

export type ValidationResult =
  | {
      ok: true;
      authorizationId: string;
      actorId: string;
      capabilityId: string;
      payloadHash: string;
      expiresAt: string;
    }
  | { ok: false; reason: ValidationReason; error?: string };

export declare function validateAuthorization(
  token: ExecutionAuthorizationV1,
  opts: ValidateOptions,
): Promise<ValidationResult>;

export declare function validateAuthorizationFromHeader(
  headerValue: string,
  opts: ValidateOptions,
): Promise<ValidationResult>;

export declare function canonicalizeJSON(value: unknown): string;

export declare function sha256OfJSON(value: unknown): string;

export declare const VALIDATION_REASONS: Readonly<Record<ValidationReason, ValidationReason>>;
