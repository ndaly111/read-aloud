// Exercise the real relay with local Turnstile/mail adapters. Sends no email.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'worker', 'feedback', 'src', 'index.js'), 'utf8')
  .replace('import { EmailMessage } from "cloudflare:email";', '')
  .replace('export default {', 'globalThis.relay = {');
const ctx = { Response, FormData, Intl, Date, btoa, unescape, encodeURIComponent,
  crypto: require('crypto').webcrypto, console,
  EmailMessage: class { constructor(from, to, raw) { this.raw = raw; } },
  fetch: async () => ({ json: async () => ({ success: true }) }),
};
vm.createContext(ctx);vm.runInContext(source, ctx);
(async () => {
  const sent = [];
  const env = { ALLOWED_ORIGINS: 'https://read-aloud.com', TURNSTILE_SECRET: 'test-secret',
    FROM_ADDRESS: 'sender@example.com', TO_ADDRESS: 'receiver@example.com', MAIL: { send: async mail => sent.push(mail.raw) } };
  const id = 'b48e0c45-31c6-4c07-9363-973e7418cfaa';
  for (const value of [id, 'malicious\r\nInjected: header']) {
    const form = new FormData();form.set('message', 'Test feedback');form.set('cf-turnstile-response', 'test');
    form.set('_reading_id', value);
    const request = { method: 'POST', headers: new Headers({ Origin: 'https://read-aloud.com' }), formData: async () => form };
    const response = await ctx.relay.fetch(request, env);
    assert.equal(response.status, 200);
  }
  assert(sent[0].includes(`Reading ID: ${id}`));
  assert(!sent[1].includes('Reading ID:'));
  assert(!sent[1].includes('Injected:'));
  console.log('PASS feedback correlation and invalid reading ID rejection; no email sent');
})().catch(e => { console.error(e); process.exitCode = 1; });
