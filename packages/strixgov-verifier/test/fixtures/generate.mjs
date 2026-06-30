// Regenerates se-v1-conformance-vectors.json from the JS reference verifier.
// The fixture is the cross-language conformance contract: any independent
// implementation (Python, etc.) must reproduce these exact canonical bytes
// and verify these exact signatures. Run: node generate.mjs
//
// The expected canonical strings here are produced by the SAME builder the
// se-v1-golden-vectors.test.mjs locks, so this fixture cannot drift from the
// locked goldens without that test failing first.
import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildCanonicalPayload } from "../../src/index.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

const BASE = {
  evidenceHash: "ev".repeat(32),
  proofChainHash: "pc".repeat(32),
  capabilityId: "admin.updateMemberRole",
  action: "allow",
  actorId: "user_golden_actor",
  actorRole: "owner",
  createdAt: "2026-05-26T00:00:00.000Z",
  signingKeyId: "strix-prod-2026-05",
  environment: "production",
  tenantId: "academy prod",
  regulatoryContext: { complianceMode: "eu-ai-act", euAiActArticle12: true, euAiActArticle14: true, euAiActArticle28: false },
};

const SEED_HEX = "5452495820435420676f6c64656e2076656374206b6579207365656420763031";
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(SEED_HEX, "hex")]);
const sk = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const pub = crypto.createPublicKey(sk);
const jwk = pub.export({ format: "jwk" }); // { kty:"OKP", crv:"Ed25519", x:"..." }

const consoleRec = { ...BASE, schemaVersion: "1", evidenceId: "5686" };
const academyRec = { ...BASE, sourceApp: "academy-platform", schemaVersion: 1, evidenceId: 5686 };

const consoleCanonical = buildCanonicalPayload(consoleRec);
const academyCanonical = buildCanonicalPayload(academyRec);
const sign = (s) => crypto.sign(null, Buffer.from(s, "utf8"), sk).toString("base64url");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const fixture = {
  $schema: "strix-se-v1-conformance/1",
  description:
    "Cross-language conformance vectors for Signed Evidence v1. Any independent verifier MUST reproduce expectedCanonical byte-for-byte from inputRecord, and verify signature against publicJwk. The dual-form discriminator (Academy numeric vs Console string) is load-bearing. Generated from the JS reference verifier; locked by se-v1-golden-vectors.test.mjs.",
  publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
  signingKeySeedHex: SEED_HEX,
  vectors: [
    {
      name: "console-form",
      note: "Console signers: schemaVersion/evidenceId as JSON strings; complianceMode-first regulatoryContext.",
      inputRecord: consoleRec,
      expectedCanonical: consoleCanonical,
      expectedSha256: sha(consoleCanonical),
      signatureB64url: sign(consoleCanonical),
    },
    {
      name: "academy-form",
      note: "Academy (sourceApp=academy-platform): schemaVersion/evidenceId as JSON numbers; euAiActArticle12-first regulatoryContext. Verifies against a DIFFERENT signature than console-form by design.",
      inputRecord: academyRec,
      expectedCanonical: academyCanonical,
      expectedSha256: sha(academyCanonical),
      signatureB64url: sign(academyCanonical),
    },
    {
      name: "signed-payload-passthrough",
      note: "v1.10.0 reconstruction-free path: when signedPayload is present it IS the canonical bytes, returned verbatim.",
      inputRecord: { ...consoleRec, signedPayload: '{"verbatim":"bytes"}' },
      expectedCanonical: '{"verbatim":"bytes"}',
      expectedSha256: sha('{"verbatim":"bytes"}'),
      signatureB64url: sign('{"verbatim":"bytes"}'),
    },
  ],
};

const out = join(__dir, "se-v1-conformance-vectors.json");
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log("wrote", out);
console.log("console sha256:", fixture.vectors[0].expectedSha256);
console.log("academy canonical:", academyCanonical);
