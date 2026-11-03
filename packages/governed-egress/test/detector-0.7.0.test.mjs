/**
 * Detector 0.7.0 — a time of day that belongs to a patient date is part of
 * that date (operator decision Q2, 2026-10-06; HIPAA Safe Harbor removes
 * every date element except the year). Positives with the negative controls
 * that keep the rule off times describing the lab rather than the patient.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanText, DETECTOR_INFO } from '../src/detection/pattern-detector.mjs';
import { strixRedactor } from '../accuracy/benchmark.mjs';

const dates = (s) => scanText(s).findings.filter((f) => f.category === 'DATE').map((f) => f.value);

// The version pin moved to detector-0.8.0.test.mjs; these behaviours stay.
test('version is 0.7.0 or later', () => {
  assert.notEqual(DETECTOR_INFO.version, '0.6.0');
});

test('a time right after a date widens the date finding', () => {
  assert.deepEqual(dates('Collected: 09/14/2026 07:42 by phlebotomy'), ['09/14/2026 07:42']);
  assert.deepEqual(dates('drawn 2026-08-30T14:05 | spec'), ['2026-08-30T14:05']);
  assert.deepEqual(dates('collected on 08/02/2026 at 11:20.'), ['08/02/2026 at 11:20']);
  assert.deepEqual(dates('Received 09/14/2026, 9:05 AM in the lab'), ['09/14/2026, 9:05 AM']);
  assert.deepEqual(dates('stamped 2026-09-21 08:15:30 here'), ['2026-09-21 08:15:30']);
});

test('a time under a collection label, with no date, is a date element', () => {
  assert.deepEqual(dates('Collection time: 0630'), ['0630']);
  assert.deepEqual(dates('specimen collected 13:40 at bedside'), ['13:40']);
});

test('a four-digit run after a date is a time only in a collection context', () => {
  assert.deepEqual(dates('drawn 10/01/26 0915 orders'), ['10/01/26 0915']);
  assert.deepEqual(dates('DOB 03/09/1966 2024 visit'), ['03/09/1966']);
  assert.deepEqual(dates('DOS 07/22/2026 1130 units'), ['07/22/2026']);
});

test('negative controls: lab hours, schedules and durations are kept', () => {
  assert.deepEqual(dates('Lab hours 07:00-18:00; courier pickup 16:30 daily; run time 45 min'), []);
  assert.deepEqual(dates('DOS 07/22/2026   CPT 87804 Flu'), ['07/22/2026']);
});

test('end to end: no time is left beside the date token, and the rescan passes', async () => {
  const redact = await strixRedactor();
  const out = await redact('Patient: Delphine Okonkwo-Reyes\nCollected: 09/14/2026 07:42\nLab hours 07:00-18:00');
  assert.ok(!out.refused, 'refused');
  assert.ok(!out.released.includes('07:42'));
  assert.ok(!out.released.includes('09/14/2026'));
  assert.ok(out.released.includes('07:00-18:00'));
});
