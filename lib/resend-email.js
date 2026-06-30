// ── Resend email helper — CFC BUSINESS ONLY ──────────────────────────────────
// Scope (per the user's explicit instruction):
//   • Use ONLY for Custom Flooring Centres business (run-orders, yourfloors, customfc-backend, cfc-tender-radar).
//   • NEVER use for: mario (CFC accounting forensic), Lifted, Ride Orion, or personal/CFO work.
//   • NEVER send personal / non-CFC data to mac@customfc.ca.
//   • Vendor/customer outbound STILL needs explicit per-email human approval
//     (see feedback: never email vendors/customers unprompted). This helper does not change that.
//
// Sender: with the shared `onboarding@resend.dev` sender, Resend only delivers to the
// account owner's own email — fine for internal alerts, NOT for vendor/customer mail.
// Verify customfc.ca in Resend to send from name@customfc.ca to anyone.
//
// Requires RESEND_API_KEY in run-orders/.env.
const https = require('https');

function sendEmail({ to, subject, html, text, from = 'onboarding@resend.dev', replyTo } = {}) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set (add it to run-orders/.env — CFC only)');
  if (!to || !subject || (!html && !text)) throw new Error('sendEmail requires { to, subject, html|text }');
  const payload = JSON.stringify({
    from, to: Array.isArray(to) ? to : [to], subject,
    ...(html ? { html } : {}), ...(text ? { text } : {}), ...(replyTo ? { reply_to: replyTo } : {}),
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        let body; try { body = JSON.parse(d); } catch { body = d; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`Resend ${res.statusCode}: ${typeof body === 'string' ? body : JSON.stringify(body)}`));
      });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

module.exports = { sendEmail };
