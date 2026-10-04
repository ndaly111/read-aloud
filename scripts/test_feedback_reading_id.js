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
    if (value === id) {
      form.set('_voice_language', 'en');form.set('_voice_language_name', 'English');
      form.set('_voice_selection', 'neural:en-US-AriaNeural');form.set('_voice_name', 'Aria (US) - Female');
      form.set('_voice_speed', '1.3');form.set('_voice_volume', '0.65');form.set('_voice_volume_control', 'web');
    }
    const request = { method: 'POST', headers: new Headers({ Origin: 'https://read-aloud.com' }), formData: async () => form };
    const response = await ctx.relay.fetch(request, env);
    assert.equal(response.status, 200);
  }
  assert(sent[0].includes(`Reading ID: ${id}`));
  assert(!sent[1].includes('Reading ID:'));
  assert(!sent[1].includes('Injected:'));
  assert(sent[0].includes('Voice settings at submission:\nLanguage: English (en)'));
  assert(sent[0].includes('Voice: Aria (US) - Female [neural:en-US-AriaNeural]'));
  assert(sent[0].includes('Voice type: Premium\nSpeed: 1.3x\nVolume: 65%'));
  assert(!sent[1].includes('Voice settings at submission:')); // old clients/contact form
  const device = new FormData();device.set('message', 'Device feedback');device.set('cf-turnstile-response', 'test');
  device.set('_voice_selection', 'browser:4');device.set('_voice_name', 'Google English\r\nVoice: injected');
  device.set('_voice_speed', 'Infinity');device.set('_voice_volume', '1');device.set('_voice_volume_control', 'device');
  await ctx.relay.fetch({ method: 'POST', headers: new Headers({ Origin: 'https://read-aloud.com' }), formData: async () => device }, env);
  assert(sent[2].includes('Voice type: Browser'));
  assert(sent[2].includes('Volume: Device buttons (level unavailable)'));
  assert(!sent[2].includes('Volume: 100%'));
  assert(!sent[2].includes('\nVoice: injected'));
  assert(!sent[2].includes('Speed:'));
  console.log('PASS feedback voice settings, device volume, old clients and reading ID validation; no email sent');
})().catch(e => { console.error(e); process.exitCode = 1; });
