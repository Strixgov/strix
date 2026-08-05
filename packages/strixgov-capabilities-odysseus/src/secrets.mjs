/**
 * Odysseus host surface — secret / credential access.
 *
 * Risk model:
 *   - Secret access is HIGH READ. It is a read, but the read IS the
 *     blast radius: once a credential is in model context it can ride
 *     out through any subsequent write surface (email, web.fetch,
 *     shell). Never auto-allow.
 *
 * Secret WRITE/rotation is intentionally absent from v0.1 — rotating
 * credentials is an operator ceremony, not an agent capability, and
 * classifying it here would normalize agents holding rotation
 * authority.
 *
 * Interception: `host-hook`.
 */
export const secretCapabilities = Object.freeze([
  {
    id: "odysseus.secret.access",
    name: "secret.access",
    risk: "HIGH",
    mode: "READ",
    interception: "host-hook",
    description:
      "Read a stored secret or credential into agent context. The read is the blast radius.",
  },
]);
