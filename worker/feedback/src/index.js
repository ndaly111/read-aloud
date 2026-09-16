// read-aloud.com feedback relay: Turnstile-verified form -> email via
// Cloudflare Email Routing. Replaces Formspree (50/mo cap hit 2026-09).
import { EmailMessage } from "cloudflare:email";

const MAX_MSG = 5000;

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  const ok = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function verifyTurnstile(token, ip, secret) {
  if (!token || !secret) return false;
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST", body,
  });
  const data = await r.json().catch(() => ({}));
  return data.success === true;
}

// "Ho Chi Minh City, Vietnam" from Cloudflare's request.cf geo fields.
// Falls back to the raw ISO code if the runtime can't name it.
function describeLocation(cf) {
  const code = cf?.country;
  if (!code) return "unknown";
  let country = code;
  try {
    country = new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code;
  } catch (_) {}
  const city = cf?.city;
  const region = cf?.region && cf.region !== city ? cf.region : "";
  const parts = [city, region, country].filter(Boolean);
  return parts.join(", ");
}

// Minimal RFC 5322 message. Header values are stripped of CR/LF to prevent
// header injection; body is 8bit UTF-8 plain text.
function buildMime({ from, to, replyTo, subject, text }) {
  const clean = s => String(s || "").replace(/[\r\n]+/g, " ").trim();
  const utf8Subject = "=?UTF-8?B?" + btoa(unescape(encodeURIComponent(clean(subject)))) + "?=";
  const lines = [
    `From: Read-Aloud Feedback <${clean(from)}>`,
    `To: ${clean(to)}`,
    replyTo ? `Reply-To: ${clean(replyTo)}` : null,
    `Subject: ${utf8Subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@read-aloud.com>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
  ].filter(l => l !== null);
  return lines.join("\r\n");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const h = cors(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (request.method !== "POST") return json({ ok: false, error: "POST only" }, 405, h);

    const ip = request.headers.get("CF-Connecting-IP") || "";

    // Rate limit per IP.
    if (env.RL) {
      const { success } = await env.RL.limit({ key: ip || "anon" });
      if (!success) return json({ ok: false, error: "Too many submissions. Try again in a minute." }, 429, h);
    }

    let form;
    try { form = await request.formData(); }
    catch { return json({ ok: false, error: "Bad form data" }, 400, h); }

    // Honeypot: bots fill hidden fields. Pretend success so they move on.
    if ((form.get("_gotcha") || "").trim()) return json({ ok: true }, 200, h);

    const message = (form.get("message") || "").toString().trim();
    if (!message) return json({ ok: false, error: "Add a message first." }, 400, h);
    if (message.length > MAX_MSG) return json({ ok: false, error: "Message too long." }, 400, h);

    const token = form.get("cf-turnstile-response");
    if (!(await verifyTurnstile(token, ip, env.TURNSTILE_SECRET))) {
      return json({ ok: false, error: "Verification failed. Please try again." }, 403, h);
    }

    const replyTo = (form.get("_replyto") || "").toString().trim();
    const validReply = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo) ? replyTo : "";
    const name = (form.get("name") || "").toString().trim();
    const page = (form.get("_page") || "").toString().trim();
    const subject = (form.get("_subject") || "Feedback from read-aloud.com").toString();

    const text = [
      message,
      "",
      "---",
      name ? `Name: ${name}` : null,
      `Email: ${replyTo || "(not given)"}`,
      page ? `Page: ${page}` : null,
      `Referer: ${request.headers.get("Referer") || "(none)"}`,
      `Location: ${describeLocation(request.cf)}`,
      `UA: ${request.headers.get("User-Agent") || "?"}`,
      `Time: ${new Date().toISOString()}`,
    ].filter(l => l !== null).join("\n");

    const raw = buildMime({
      from: env.FROM_ADDRESS, to: env.TO_ADDRESS, replyTo: validReply, subject, text,
    });

    try {
      await env.MAIL.send(new EmailMessage(env.FROM_ADDRESS, env.TO_ADDRESS, raw));
    } catch (e) {
      console.error("send failed", e && e.message);
      return json({ ok: false, error: "Couldn't deliver. Email admin@read-aloud.com." }, 502, h);
    }
    return json({ ok: true }, 200, h);
  },
};
