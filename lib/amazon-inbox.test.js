// Offline tests for the Amazon inbox handler: parsing, policy, state. Fake IO only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const inbox = require('./amazon-inbox');

const relay = (subject, body, id = 'g1', at = '2026-10-07T10:00:00Z') => ({ id, subject, from: { emailAddress: { address: 'abc123@marketplace.amazon.ca' } }, receivedDateTime: at, conversationId: `c-${id}`, body: { content: body } });
const SLAV = 'You have received a message. Order ID: 701-7482945-9395469: # ASIN Product Name 0 B0BN6Y63P6 Schluter Ditra-Heat-PS Message: Hello, has this order been cancelled? No refund had been issued. Kind regards, Slav View Message Resolve Case Report suspicious activity';

test('only Amazon mail is ours: buyer relay and A-to-z notices, never Prosol', () => {
  assert.equal(inbox.classifySource(relay('Inquiry from Amazon customer Vyacheslav (Order: 701-7482945-9395469)', SLAV)), 'buyer');
  assert.equal(inbox.classifySource({ subject: 'Your Amazon A-to-z Guarantee Claim for Order 701-6409544-1789850', from: { emailAddress: { address: 'no-reply@amazon.ca' } } }), 'atoz');
  assert.equal(inbox.classifySource({ subject: 'Order - Calgary South', from: { emailAddress: { address: 'klazzarotto@prosol.ca' } } }), null);
});

test('parses order id, first name and only the buyer\'s words', () => {
  const p = inbox.parseMessage(relay('Inquiry from Amazon customer Vyacheslav (Order: 701-7482945-9395469)', SLAV), SLAV);
  assert.equal(p.orderId, '701-7482945-9395469');
  assert.equal(p.name, 'Vyacheslav');
  assert.equal(p.said, 'Hello, has this order been cancelled? No refund had been issued. Kind regards, Slav');
});

test('French buyers get French', () => {
  assert.equal(inbox.language("Le colis n'a pas été livré. Merci de nous revenir urgemment"), 'fr');
  assert.equal(inbox.language('Item not received either ship or refund please'), 'en');
});

test('auto-send only for a tracking answer backed by a carrier scan', () => {
  const f = { items: [{ cancelRequested: false }], shipments: [{ scanned: true }] };
  assert.equal(inbox.autoSendable({ category: 'tracking', needsMac: false }, f), true);
  assert.equal(inbox.autoSendable({ category: 'tracking', needsMac: false }, { ...f, shipments: [{ scanned: false }] }), false);
  assert.equal(inbox.autoSendable({ category: 'return', needsMac: false }, f), false);
  assert.equal(inbox.autoSendable({ category: 'tracking', needsMac: false }, { ...f, items: [{ cancelRequested: true }] }), false);
});

function fakeIo({ msgs, replied = false, draft = { category: 'other', reply: 'Hi Slav,\n\nIt was cancelled.\n\nThanks,\nMac\nCustomFlooring', needsMac: false, action: '' } }) {
  const calls = { sent: [], mac: [], read: [] };
  return {
    calls,
    io: {
      listMessages: async () => msgs,
      bodyText: (m) => m.body.content,
      repliedInConversation: async () => replied,
      facts: async (id) => ({ orderId: id, status: 'Canceled', items: [], shipments: [] }),
      draft: async () => draft,
      send: async (e) => calls.sent.push(e),
      markRead: async (id) => calls.read.push(id),
      notifyMac: async (o) => calls.mac.push(o),
    },
  };
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amz-inbox-')), 's.json');
const NOW = new Date('2026-10-07T12:00:00Z');

test('a new message is carded once, then reminded once near the 24 h line, and sends on Mac\'s tap', async () => {
  const stateFile = tmp();
  const m = relay('Inquiry from Amazon customer Vyacheslav (Order: 701-7482945-9395469)', SLAV);
  const a = fakeIo({ msgs: [m] });
  const out = await inbox.run({ io: a.io, live: true, now: NOW, stateFile });
  assert.equal(out.fresh.length, 1);
  assert.equal(a.calls.mac.length, 1);
  assert.equal(a.calls.sent.length, 0, 'nothing goes to the buyer without Mac');
  const b = fakeIo({ msgs: [m] });
  await inbox.run({ io: b.io, live: true, now: new Date('2026-10-07T13:00:00Z'), stateFile });
  assert.equal(b.calls.mac.length, 0, 'no repeat card');
  const c = fakeIo({ msgs: [m] });
  const late = await inbox.run({ io: c.io, live: true, now: new Date('2026-10-08T05:00:00Z'), stateFile });
  assert.equal(late.stale.length, 1);
  const key = out.fresh[0].key;
  const d = fakeIo({ msgs: [] });
  await inbox.sendCarded(key, { io: d.io, text: 'Edited reply', stateFile });
  assert.equal(d.calls.sent[0].reply, 'Edited reply');
  assert.equal(inbox.loadState(stateFile).messages[key].status, 'sent');
});

test('already answered from hello@: no card; a thank-you is carded', async () => {
  const m = relay('Re: Order delivery inquiry from Amazon customer Vyacheslav (Order: 701-7201751-6353045)', 'Message: Thank you for the update. View Message');
  const answered = fakeIo({ msgs: [m], replied: true });
  const o1 = await inbox.run({ io: answered.io, live: true, now: NOW, stateFile: tmp() });
  assert.equal(o1.fresh.length + answered.calls.mac.length, 0);
  // A thank-you still needs an answer inside Amazon's 24 h window: carded with a short acknowledgement.
  const thanks = fakeIo({ msgs: [m], draft: { category: 'thanks', reply: 'Hi Slav,\n\nGlad they all arrived. Enjoy the install!\n\nThanks,\nMac\nCustomFlooring', needsMac: false, action: '' } });
  const o2 = await inbox.run({ io: thanks.io, live: true, now: NOW, stateFile: tmp() });
  assert.equal(o2.fresh.length, 1);
  assert.equal(thanks.calls.sent.length, 0, 'not sent without Mac unless AMAZON_INBOX_AUTOSEND_THANKS=1');
});

test('dry run writes nothing and emails nobody', async () => {
  const stateFile = tmp();
  const a = fakeIo({ msgs: [relay('Inquiry from Amazon customer X (Order: 701-7482945-9395469)', SLAV)] });
  await inbox.run({ io: a.io, live: false, now: NOW, stateFile });
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(a.calls.mac.length + a.calls.sent.length, 0);
});

test('send links are message-bound', () => {
  const t = inbox.sendToken('abc', 's');
  assert.ok(inbox.verifySend('abc', t, 's'));
  assert.ok(!inbox.verifySend('abd', t, 's'));
});

test('tracking numbers the buyer quotes are picked up', () => {
  const p = inbox.parseMessage({ subject: 'Inquiry (Order: 701-2953867-2160265)' }, 'Message: no status on 520746515391 520746515425 and 1Z999AA10123456784 View Message');
  assert.deepEqual(p.trackings, ['520746515391', '520746515425', '1Z999AA10123456784']);
});

test('"Hi there," is never sent: the name when we have it, else a bare "Hi,"', () => {
  assert.equal(inbox.fixGreeting('Hi there,\nThank you.', null), 'Hi,\nThank you.');
  assert.equal(inbox.fixGreeting('Hey there!\nThanks.', 'Dong'), 'Hi Dong,\nThanks.');
  assert.equal(inbox.fixGreeting('Hi Dong,\nThanks.', 'Dong'), 'Hi Dong,\nThanks.');
  assert.equal(inbox.fixGreeting('Thanks for the note, there is more to come.', null), 'Thanks for the note, there is more to come.');
});

// 702-4021580-3477824, 2026-10-09: card "Needs your OK: issue a full refund", draft "We have issued a full refund",
// Send tapped, no refund existed. Send must not tell a buyer about a refund Amazon doesn't show.
function cardWith(stateFile, entry) {
  const key = 'k1';
  fs.writeFileSync(stateFile, JSON.stringify({ messages: { [key]: { key, graphId: 'g1', status: 'carded', orderId: '702-4021580-3477824', ...entry } } }));
  return key;
}
const sendIo = (cents) => { const sent = []; return { sent, io: { send: async (e) => sent.push(e), markRead: async () => {}, refundCents: async () => cents } }; };
const REFUND_DRAFT = 'Hi,\n\nWe have issued a full refund of $50.53 for your order.\n\nThanks,\nMac\nCustomFlooring';

test('a refund card does not send until the refund shows; "refund is done" overrides', async () => {
  const stateFile = tmp();
  const key = cardWith(stateFile, { needsMac: true, action: 'Issue a full refund of $50.53.', reply: REFUND_DRAFT, refundCentsAtCard: 0 });
  const none = sendIo(0);
  await assert.rejects(inbox.sendCarded(key, { io: none.io, stateFile }), (e) => e.code === 'REFUND_NOT_DONE');
  assert.equal(none.sent.length, 0);
  assert.equal(inbox.loadState(stateFile).messages[key].status, 'carded');
  const done = sendIo(5053);
  await inbox.sendCarded(key, { io: done.io, stateFile });
  assert.equal(done.sent.length, 1);
  const f2 = tmp();
  const key2 = cardWith(f2, { needsMac: true, action: 'Issue a full refund of $50.53.', reply: REFUND_DRAFT, refundCentsAtCard: 0 });
  const ticked = sendIo(0);
  await inbox.sendCarded(key2, { io: ticked.io, refundDone: true, stateFile: f2 });
  assert.equal(ticked.sent.length, 1, 'Mac ticked "the refund is done" (Seller Central lag)');
});

test('a second refund must be new: the refund already on the order at card time does not count', async () => {
  const stateFile = tmp();
  const key = cardWith(stateFile, { needsMac: true, action: 'Refund the $27 return postage.', reply: 'Hi,\n\nWe refunded $27 for your return postage.', facts: 'Order x: Shipped.\nAlready refunded on this order: 1 refund(s), $244.57 in total.' });
  const same = sendIo(24457);
  await assert.rejects(inbox.sendCarded(key, { io: same.io, stateFile }), (e) => e.code === 'REFUND_NOT_DONE');
  const more = sendIo(27157);
  await inbox.sendCarded(key, { io: more.io, stateFile });
  assert.equal(more.sent.length, 1);
});

test('a reply that mentions an existing refund sends; one that invents a refund does not', async () => {
  const elkar = tmp();
  const k = cardWith(elkar, { needsMac: false, action: '', reply: 'Hi,\n\nWe refunded the full $49.65 on October 7.', refundCentsAtCard: 4965 });
  const io1 = sendIo(4965);
  await inbox.sendCarded(k, { io: io1.io, stateFile: elkar });
  assert.equal(io1.sent.length, 1);
  const invented = tmp();
  const k2 = cardWith(invented, { needsMac: false, action: '', reply: 'Hi,\n\nYour refund has been issued.' });
  await assert.rejects(inbox.sendCarded(k2, { io: sendIo(0).io, stateFile: invented }), (e) => e.code === 'REFUND_NOT_DONE');
});

test('Mac edits the refund line out: it sends without a refund', async () => {
  const stateFile = tmp();
  const key = cardWith(stateFile, { needsMac: true, action: 'Issue a full refund of $50.53.', reply: REFUND_DRAFT, refundCentsAtCard: 0 });
  const io = sendIo(0);
  await inbox.sendCarded(key, { io: io.io, text: 'Hi,\n\nYour parcel is being traced with the carrier and I will update you tomorrow.', stateFile });
  assert.equal(io.sent.length, 1);
});

test('refund wording: claims vs plain mentions', () => {
  assert.ok(inbox.claimsRefund('We have issued a full refund of $50.53'));
  assert.ok(inbox.claimsRefund('We refunded the full $49.65'));
  assert.ok(inbox.claimsRefund('Nous avons remboursé votre commande'));
  assert.ok(!inbox.claimsRefund('If the receipt shows more, send it and we will look at a refund.'));
  assert.ok(!inbox.claimsRefund('Your order shipped today.'));
  assert.ok(inbox.refundNeeded({ needsMac: true, action: 'Issue a full refund of $50.53' }));
  assert.ok(!inbox.refundNeeded({ needsMac: true, action: 'Send a replacement' }));
  assert.ok(!inbox.refundNeeded({ needsMac: false, action: '' }));
});
