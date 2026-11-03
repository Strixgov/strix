/**
 * The one declaration of this package's capability id.
 *
 * It was declared twice — once in the Anthropic adapter and once in the
 * kernel binding — which is the hand-maintained-pin drift class: two
 * constants that must agree, with nothing making them agree. A capability
 * id that disagrees between the transport and the authority binding is not
 * a cosmetic defect; it is a token minted for one capability being spent at
 * a boundary that believes it is another.
 *
 * Declared here rather than in either consumer because the dependency
 * direction matters: a kernel-authority module must not import a transport
 * adapter to learn what it is authorizing.
 */
export const EGRESS_CAPABILITY_ID = 'ai.external.document.send';
