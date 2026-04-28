(() => {
  // Floating "Feedback" button + modal. Loaded on every page.
  // Submits to the same Formspree endpoint as /contact.html.
  // Skips the contact page (already has a form there).
  if (location.pathname.replace(/\/$/, '') === '/contact.html'.replace(/\/$/, '')) return;

  const FORMSPREE = 'https://formspree.io/f/xpqjrpvp';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ra-fb-btn';
  btn.textContent = 'Feedback';
  btn.setAttribute('aria-haspopup', 'dialog');

  const dialog = document.createElement('dialog');
  dialog.className = 'ra-fb-dialog';
  dialog.setAttribute('aria-labelledby', 'ra-fb-title');
  dialog.innerHTML = `
    <form class="ra-fb-form" novalidate>
      <button type="button" class="ra-fb-close" aria-label="Close" data-close>&times;</button>
      <p class="ra-fb-eyebrow">Read‑Aloud &middot; Send feedback</p>
      <h2 class="ra-fb-title" id="ra-fb-title">What's <em>working, what's not?</em></h2>
      <p class="ra-fb-lede">Bugs, missing voices, requests, or just hello &mdash; all welcome.</p>
      <label class="ra-fb-field">
        <span>Message</span>
        <textarea name="message" required rows="5" placeholder="What's on your mind?"></textarea>
      </label>
      <label class="ra-fb-field">
        <span>Email <em>(optional, if you want a reply)</em></span>
        <input type="email" name="_replyto" autocomplete="email" placeholder="you@example.com">
      </label>
      <input type="hidden" name="_subject" value="Feedback from read-aloud.com">
      <input type="hidden" name="_page" value="">
      <div class="ra-fb-actions">
        <button type="button" class="btn btn--secondary" data-close>Cancel</button>
        <button type="submit" class="btn ra-fb-submit">Send feedback</button>
      </div>
      <p class="ra-fb-status" role="status" aria-live="polite"></p>
    </form>
  `;

  document.addEventListener('DOMContentLoaded', () => {
    document.body.appendChild(btn);
    document.body.appendChild(dialog);

    const form = dialog.querySelector('form');
    const status = dialog.querySelector('.ra-fb-status');
    const submit = dialog.querySelector('.ra-fb-submit');
    const pageInput = dialog.querySelector('input[name="_page"]');

    const open = () => {
      pageInput.value = location.pathname + location.search;
      status.textContent = '';
      status.className = 'ra-fb-status';
      submit.disabled = false;
      submit.textContent = 'Send feedback';
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
      setTimeout(() => dialog.querySelector('textarea').focus(), 50);
    };
    const close = () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      btn.focus();
    };

    btn.addEventListener('click', open);
    dialog.addEventListener('click', (e) => {
      if (e.target.matches('[data-close]')) close();
      // backdrop click (the dialog itself, not its child form)
      if (e.target === dialog) close();
    });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = form.querySelector('textarea').value.trim();
      if (!msg) {
        status.textContent = 'Add a message first.';
        status.className = 'ra-fb-status ra-fb-error';
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Sending…';
      status.textContent = '';
      status.className = 'ra-fb-status';
      try {
        const data = new FormData(form);
        const resp = await fetch(FORMSPREE, {
          method: 'POST',
          body: data,
          headers: { 'Accept': 'application/json' }
        });
        if (!resp.ok) throw new Error('Formspree returned ' + resp.status);
        status.textContent = 'Thanks — got it.';
        status.className = 'ra-fb-status ra-fb-ok';
        form.querySelector('textarea').value = '';
        form.querySelector('input[name="_replyto"]').value = '';
        submit.textContent = 'Sent';
        setTimeout(close, 1500);
      } catch (err) {
        console.warn('feedback submit failed', err);
        status.textContent = 'Couldn’t send right now. Email admin@read-aloud.com.';
        status.className = 'ra-fb-status ra-fb-error';
        submit.disabled = false;
        submit.textContent = 'Try again';
      }
    });
  });
})();
