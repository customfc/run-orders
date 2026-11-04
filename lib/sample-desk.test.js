'use strict';
const test = require('node:test');
const assert = require('node:assert');
const d = require('./sample-desk');

test('supplierFor: AquaFix -> Unifloor label mode, Biyork ships itself, Bona unknown', () => {
  assert.strictEqual(d.supplierFor('Unifloor', 'AquaFix SPC Grand Cru Romanée').key, 'unifloor');
  assert.strictEqual(d.supplierFor('', 'AquaFix SPC Harmony Evolved Lily').mode, 'label');
  const b = d.supplierFor('Biyork', 'Hydrogen 5 Pro III Gold Coast');
  assert.strictEqual(b.key, 'biyork');
  assert.strictEqual(b.mode, 'vendor-ships');
  assert.strictEqual(d.supplierFor('Bona', 'Bona Traffic HD'), null);
});

test('displayName drops em dashes', () => {
  assert.strictEqual(d.displayName('AquaFix SPC Grand Cru — Romanée'), 'AquaFix SPC Grand Cru Romanée');
});

test('billableLb: dim weight wins on a light long box, actual on a dense one', () => {
  // order 1400 as first packed: 221x25x5 cm, 39.1 lb -> dim 12.2 lb, actual wins
  assert.strictEqual(d.billableLb({ weight_lb: 39.1, length_cm: 221, width_cm: 25, height_cm: 5 }), 40);
  // a fluffy box: 60x40x40 cm, 3 lb -> dim 42.3 lb
  assert.strictEqual(d.billableLb({ weight_lb: 3, length_cm: 60, width_cm: 40, height_cm: 40 }), 43);
  assert.strictEqual(d.billableLb({ weight_lb: 0.4 }), 1);
});

test('judgeParcels: the real Unifloor boxes', () => {
  // 1389 as packed 10-01: 5.05 lb 33x63x3 -> fine
  assert.strictEqual(d.judgeParcels([{ weight_lb: 5.05, length_cm: 63, width_cm: 33, height_cm: 3 }]).action, 'buy');
  // 1353 as first packed: 8.8 lb 150x24x5 -> ask to cut, then escalate if still long
  assert.strictEqual(d.judgeParcels([{ weight_lb: 8.8, length_cm: 150, width_cm: 24, height_cm: 5 }]).action, 'ask-cut');
  assert.strictEqual(d.judgeParcels([{ weight_lb: 8.8, length_cm: 150, width_cm: 24, height_cm: 5 }], { cutAsked: true }).action, 'escalate');
  // weight without size -> ask once
  assert.strictEqual(d.judgeParcels([{ weight_lb: 2 }]).action, 'ask-size');
  assert.strictEqual(d.judgeParcels([{ weight_lb: 2 }], { sizeAsked: true }).action, 'escalate');
  // too heavy, or nonsense density
  assert.strictEqual(d.judgeParcels([{ weight_lb: 60, length_cm: 60, width_cm: 40, height_cm: 30 }]).action, 'escalate');
  assert.strictEqual(d.judgeParcels([{ weight_lb: 45, length_cm: 10, width_cm: 10, height_cm: 5 }]).action, 'escalate');
});

test('decide: what each kind of reply does', () => {
  const label = { mode: 'label' }; const own = { mode: 'vendor-ships' };
  const base = { parcels: [], tracking: [], discontinued: [], ack_only: false, confident: true, summary: '' };
  assert.strictEqual(d.decide(null, label).action, 'escalate');
  assert.strictEqual(d.decide({ ...base, confident: false }, label).action, 'escalate');
  assert.strictEqual(d.decide({ ...base, discontinued: ['Romanée'] }, label).action, 'escalate');
  assert.strictEqual(d.decide({ ...base, question: 'What paperwork do you need?' }, label).action, 'escalate');
  assert.strictEqual(d.decide({ ...base, parcels: [{ weight_lb: 2 }] }, label).action, 'parcels');
  assert.strictEqual(d.decide({ ...base, parcels: [{ weight_lb: 2 }] }, own).action, 'escalate');
  assert.strictEqual(d.decide({ ...base, tracking: [{ carrier: 'FedEx', number: '877975206043' }] }, own).action, 'tracking');
  assert.strictEqual(d.decide({ ...base, ack_only: true }, label).action, 'wait');
});

test('business days skip weekends and Remembrance Day', () => {
  assert.strictEqual(d.nextBusinessDay('2026-11-06'), '2026-11-09'); // Fri -> Mon
  assert.strictEqual(d.nextBusinessDay('2026-11-10'), '2026-11-12'); // Tue -> Thu (11th is a BC stat)
  // asked Wed 11-04 10:00 PT; by Fri 11-06 two business days have passed
  assert.strictEqual(d.businessDaysSince('2026-11-04T18:00:00Z', new Date('2026-11-06T18:00:00Z')), 2);
  assert.strictEqual(d.businessDaysSince('2026-11-06T18:00:00Z', new Date('2026-11-09T18:00:00Z')), 1);
});

test('ask text: label mode never carries the customer address; vendor-ships mode does', () => {
  const leg = { mode: 'label', dock: 'Graybar Rd', lines: [{ qty: 1, name: 'AquaFix SPC Grand Cru Romanée' }] };
  const to = { name: 'Siri Bright', street1: '1 Test Rd', city: 'Sooke', state: 'BC', postalCode: 'V9Z 0A1', phone: '2505550000' };
  const t = d.askText('1446', leg, to);
  assert.ok(t.includes('1 x AquaFix SPC Grand Cru Romanée'));
  assert.ok(!t.includes('Sooke') && !t.includes('Siri'));
  assert.ok(!/[—–]/.test(t));
  const b = d.askText('1446', { ...leg, mode: 'vendor-ships' }, to);
  assert.ok(b.includes('Siri Bright') && b.includes('Sooke BC V9Z 0A1'));
  assert.strictEqual(d.subjectFor('1446', leg), '[SAMPLE-1446] Sample request: AquaFix SPC Grand Cru Romanée');
});

test('trimQuoted keeps only the new part of a reply', () => {
  const t = 'Packed, 2 lb 30x20x5 cm.\n\nOn Wed, Nov 4, 2026 at 10:00 AM YourFloors wrote:\n> Hi team';
  assert.strictEqual(d.trimQuoted(t), 'Packed, 2 lb 30x20x5 cm.');
  const o = 'Done\n\nFrom: YourFloors Support\nSent: Wednesday\nTo: x';
  assert.strictEqual(d.trimQuoted(o), 'Done');
});

test('readReply: Opus output passes through (stubbed client)', async () => {
  const anthropic = { beta: { messages: { create: async (req) => {
    assert.strictEqual(req.model, 'claude-opus-5-5');
    assert.ok(req.messages[0].content.includes('NEWEST MESSAGE'));
    return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_reading', input: { parcels: [{ weight_lb: 1.8, length_cm: 34, width_cm: 25, height_cm: 5 }], tracking: [], discontinued: [], ack_only: false, summary: 'Packed', confident: true } }] };
  } } } };
  const leg = { supplierName: 'Unifloor', mode: 'label', lines: [{ qty: 1, name: 'X' }] };
  const newest = { id: 'm2', at: 'now', from: 'olivia@unifloor.ca', fromName: 'Olivia', subject: 'RE: [SAMPLE-1] x', text: '0.8 kg, 25x34x5 cm' };
  const r = await d.readReply({ order: '1', leg, thread: [{ id: 'm1', at: 'then', from: 'hello@yourfloors.ca', text: 'ask' }, newest], newest }, { anthropic });
  assert.strictEqual(r.parcels[0].weight_lb, 1.8);
});
