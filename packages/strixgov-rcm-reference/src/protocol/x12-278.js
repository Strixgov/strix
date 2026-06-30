/**
 * (a) X12 278 Health Care Services Review — Request (prior authorization).
 *
 * This is a genuine, structurally-valid X12 278 generator: ISA/GS/ST envelope,
 * BHT, hierarchical (HL) UMO -> Requester -> Subscriber -> Service loops, the
 * UM service-review segment, and SE/GE/IEA trailers with correct segment counts
 * and control numbers. It is intentionally a focused subset of the 005010X217
 * implementation guide — enough to be real on the wire and on camera, not a
 * full IG-complete encoder.
 *
 * Delimiters per X12 convention: element `*`, sub-element `:`, segment `~`.
 */
import { createHash } from 'node:crypto';
const ELEM = '*';
const SUB = ':';
const SEG = '~';
function pad(n, width) {
    return n.toString().padStart(width, '0');
}
function ymd(d) {
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`;
}
function hms(d) {
    return `${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}`;
}
function dobToCcyymmdd(iso) {
    return iso.replaceAll('-', '');
}
/**
 * The fields that define *what is being requested* — independent of envelope
 * control numbers and timestamps. This is what governance binds to: two
 * submissions with the same business content produce the same hash, which is
 * how a duplicate is recognizable regardless of fresh control numbers.
 */
export function authBusinessKey(req) {
    return {
        memberId: req.patient.memberId,
        payerId: req.patient.payerId,
        providerNpi: req.provider.npi,
        cptCode: req.cptCode,
        diagnosisCode: req.diagnosisCode,
        placeOfService: req.placeOfService,
        serviceType: 'AR', // service review
    };
}
export function authContentHash(req) {
    const key = authBusinessKey(req);
    const canonical = JSON.stringify(Object.keys(key)
        .sort()
        .reduce((acc, k) => ((acc[k] = key[k]), acc), {}));
    return createHash('sha256').update(canonical).digest('hex');
}
export function build278Request(req, opts = {}) {
    const now = opts.now ?? new Date();
    const ctrl = opts.controlNumber ?? pad(Math.floor(Math.random() * 1_000_000_000), 9);
    const isaCtrl = pad(Number(ctrl) % 1_000_000_000, 9);
    const segments = [];
    const S = (...parts) => segments.push(parts.join(ELEM));
    // Interchange + functional group envelope.
    S('ISA', '00', '          ', '00', '          ', 'ZZ', 'STRIXDEMO      ', 'ZZ', req.patient.payerId.padEnd(15, ' '), ymd(now).slice(2), hms(now), 'U', '00501', isaCtrl, '0', 'T', SUB);
    S('GS', 'HI', 'STRIXDEMO', req.patient.payerId, ymd(now), hms(now), ctrl, 'X', '005010X217');
    // Transaction set (278 request = "13").
    S('ST', '278', ctrl.slice(-4).padStart(4, '0'), '005010X217');
    S('BHT', '0078', '13', `STX${ctrl}`, ymd(now), hms(now));
    // HL1: Utilization Management Organization (payer).
    S('HL', '1', '', '20', '1');
    S('NM1', 'X3', '2', req.patient.payerName, '', '', '', '', 'PI', req.patient.payerId);
    // HL2: Requester (provider).
    S('HL', '2', '1', '21', '1');
    S('NM1', '1P', '2', req.provider.name, '', '', '', '', 'XX', req.provider.npi);
    S('PRV', 'AT', 'PXC', req.provider.taxonomy);
    // HL3: Subscriber (patient).
    S('HL', '3', '2', '22', '0');
    S('NM1', 'IL', '1', req.patient.lastName, req.patient.firstName, '', '', '', 'MI', req.patient.memberId);
    S('DMG', 'D8', dobToCcyymmdd(req.patient.dob));
    // Service review.
    S('UM', 'AR', 'I', '3', `${req.placeOfService}${SUB}B`);
    S('DTP', '435', 'D8', ymd(now));
    S('HI', `ABK${SUB}${req.diagnosisCode}`);
    S('SV1', `HC${SUB}${req.cptCode}`, '0', 'UN', '1');
    // Trailers. SE count includes ST..SE inclusive.
    const stIndex = segments.findIndex((s) => s.startsWith('ST' + ELEM));
    const seCount = segments.length - stIndex + 1;
    S('SE', seCount.toString(), ctrl.slice(-4).padStart(4, '0'));
    S('GE', '1', ctrl);
    S('IEA', '1', isaCtrl);
    return {
        edi: segments.join(SEG) + SEG,
        controlNumber: ctrl,
        contentHash: authContentHash(req),
    };
}
