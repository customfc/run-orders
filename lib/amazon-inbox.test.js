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
