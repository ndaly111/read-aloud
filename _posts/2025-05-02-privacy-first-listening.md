---
layout: post
title: "Privacy‑First Listening: What Stays On Your Device, What Might Leak, and How to Paste Sensitive Text Safely"
date: 2025-05-02
author: "Andrew Wilson"
slug: privacy-first-listening
permalink: /blog/privacy-first-listening/
categories: [blog]
tags: [Privacy, Trust]
---
You’re about to do something surprisingly intimate: paste text into a box and let a voice read it back to you.

Sometimes that text is harmless (“a blog post I’m skimming”). Other times it’s… not: a performance review you’re editing, a legal clause you’re trying to understand, an email draft with someone’s address, or a document full of names and numbers.

So here’s the real question:

**Is “text‑to‑speech” private by default?**
Not automatically.

Privacy isn’t a vibe — it’s a set of decisions. And the right way to think about it is:
1. **Does this tool upload my text to a server?**
2. **Even if it doesn’t, what else could expose what I pasted?**

This guide answers both — with a practical checklist you can use every time.

---

**How Read‑Aloud handles your text**

Read‑Aloud is built around a simple idea: **your text should be spoken locally on your device**.

Here’s what that means in concrete terms:
- Read‑Aloud uses your **browser/operating system’s speech engine** via the **Web Speech API**, and in some cases an **offline fallback voice (meSpeak)**.
- **The text you paste or type is not sent to Read‑Aloud’s servers.** Speech is generated in your browser so it can be spoken on your device.
- There are **no required accounts**, and the site states it **doesn’t store your pasted text in a database**.

That’s the core “privacy‑first” promise: **no upload, no account, no content storage**.

But “privacy‑first” does **not** mean “nothing can possibly go wrong.” It means the biggest risk — “my text is being shipped to someone else’s servers” — is intentionally avoided.

Now let’s talk about the risks that *remain*.

---

**Local vs cloud TTS: the tradeoff in plain English**

Most text‑to‑speech tools fall into one of two buckets:

**Local TTS (device voices)**
- Speech is produced by the voices already available in your browser/OS.
- Generally better for sensitive text because you’re not handing content to a third‑party TTS server *by default*.

**Cloud TTS (server voices)**
- Your text is uploaded to a provider to generate audio.
- Often offers very realistic voices, but privacy depends on that provider’s storage, logging, and policy.

Read‑Aloud deliberately sits in the first bucket: **in‑browser playback using device voices**.

---

**What stays on your device (and what doesn’t)**

**Stays on your device**
- **Your pasted text** (it stays in your browser while speech is generated).
- **Speech generation** through the browser/OS speech engine.

**Still exists outside your device (but not your pasted text)**

Even if the text itself isn’t uploaded, normal “website stuff” can still happen:
- The site notes that, like most websites, the **hosting provider may process standard server logs** (requested page, time, basic device/network info) for security and reliability.
- If you **email support or use a contact form**, they receive what you send (including your email address and message).
- If/when ads or analytics are enabled, the privacy policy says it will describe what’s collected and by whom; third‑party ads may use cookies/local storage when enabled.

This is the key distinction:

**Read‑Aloud isn’t uploading your pasted content — but your browsing session still has normal web footprint.**

---

**What might leak anyway (the practical threat model)**

This is the part people skip — and it’s where most real‑world privacy mistakes happen.

**1) You’re screen‑sharing**

If someone can see your screen, they can see your text box. If you’re playing audio out loud, they can also hear it.

Read‑Aloud’s own privacy guide calls this out directly: don’t paste sensitive content while screen‑sharing.

**Fix:** Don’t share that window, or stop sharing before you paste.

**2) You’re on a shared/public computer**

Libraries, work hot‑desks, borrowed laptops — all increase risk. The privacy guide explicitly warns against pasting private content on shared devices.

**Fix:** Use your own device, or use a temporary/guest browser profile and clear everything when you’re done (more on that below).

**3) Browser extensions can read page content**

Many extensions can access what’s on the page — including text in input boxes. Read‑Aloud’s privacy guide flags this as a major risk.

**Fix:** For sensitive text, use a clean profile with extensions disabled (or a Guest window).

**4) Passwords and 2FA codes**

This isn’t just “privacy” — it’s account security. The Read‑Aloud privacy checklist explicitly says: **don’t paste passwords or 2FA codes**.

**Fix:** Never paste credentials. If you need to “listen” to a security email, paste only the non‑sensitive parts.

**5) You paste way more than you need**

Even when everything is local, “less exposure” is better exposure.

Read‑Aloud’s privacy checklist recommends pasting only the section you need.

**Fix:** Paste the paragraph you’re actually reviewing — not the entire document.

---

**The “Before You Paste” checklist**

Use this like a pre‑flight check. (Yes, it’s boring. That’s why it works.)

**Before you paste sensitive text:**
- ☐ I am **not screen‑sharing** (or the shared window does not include the Read‑Aloud text box).
- ☐ I am **not on a shared/public computer**.
- ☐ I **trust the extensions** installed in this browser (or I’m using a clean/Guest profile).
- ☐ The text does **not** include passwords, 2FA codes, or unnecessary private identifiers.
- ☐ If it’s sensitive, I will **paste only what I need**.

If you can’t check these boxes, don’t paste the full text.

---

**A safe workflow for pasting sensitive text**

Here’s a repeatable routine that takes under a minute.

**Step 1: Use a “clean” session**

Pick one:
- A Private/Incognito window
- A Guest profile (best if you want **no extensions**)
- A separate browser profile dedicated to “listening” tasks

Why: it reduces extension exposure and keeps your normal browsing environment cleaner.

**Step 2: Redact fast (copy/paste template)**

If the text contains personal details, do a quick “spoken version” edit before listening:

**Redaction template (replace sensitive details):**
- Names → **[NAME]**
- Addresses → **[ADDRESS]**
- Account numbers → **[ACCOUNT ####]**
- Phone/email → **[CONTACT INFO]**
- Anything you wouldn’t read out loud in a café → **remove it**

This still lets you proofread flow and meaning without carrying the raw identifiers.

**Step 3: Paste only the chunk you actually need**

If you’re proofreading, you rarely need the whole thing at once. Paste one section, listen, fix, repeat.

**Step 4: Listen privately**
- Use headphones if possible.
- Be mindful of smart speakers, shared office spaces, or open microphones on calls.

**Step 5: Clean up after you finish**

Do this every time for sensitive text:
- Click **Stop** (so nothing keeps playing).
- Select all → delete the text box contents.
- Close the tab/window.

Bonus: clear clipboard by copying something harmless (like a single period) after you paste.

---

**Why there are no audio downloads**

People often ask for MP3 export. Read‑Aloud intentionally doesn’t do that.

The privacy guide explains why: **many system voices don’t provide a way for a website to capture the speech output as a file**, and the Web Speech API is designed to speak through your device speakers — it doesn’t hand a site an audio recording.

That constraint is also part of the privacy posture: **playback in the browser, not generating files that might be saved, synced, or shared accidentally**.

---

**If you need even higher assurance**

If you’re working with genuinely high‑sensitivity material (regulated data, confidential HR documents, etc.), consider keeping the whole workflow offline:
- Use built‑in accessibility readers with offline voices where possible. For example, Microsoft notes that once downloaded, **Natural Narrator voices work on‑device and don’t require an internet connection**.
- On iPhone/iPad, Apple notes that **enhanced‑quality voices are downloaded and installed** (often large) via Wi‑Fi.

That said: no matter what tool you use, **your environment** (screen sharing, extensions, shared devices) is usually the weak point — not the “voice.”

---

**The takeaway**

Read‑Aloud is designed so your pasted text is spoken locally in your browser using your device’s voices, without uploading that text to Read‑Aloud’s servers.

But safe use still comes down to a few habits:
- Don’t paste secrets (passwords/2FA).
- Don’t paste while screen‑sharing.
- Don’t trust random extensions with sensitive text.
- Paste only what you need.
- Clear the text when you’re done.

If you want, I can also write a short “one‑screen” version of this (a compact privacy card you can put right above the text box), so users see the checklist at the exact moment it matters.
