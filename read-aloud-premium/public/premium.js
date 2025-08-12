(async function () {
  // Helper to build API URLs relative to the backend. All API calls
  // assume the server is hosted at the root of the same domain.
  const api = (path) => '/api' + path;

  // Element references
  const listEl = document.getElementById('voice-list');
  const audioEl = document.getElementById('audio');
  const customPreviewText = document.getElementById('customText');
  const buyBtn = document.getElementById('buy');
  const paidStatus = document.getElementById('paidStatus');
  const genVoiceEl = document.getElementById('genVoice');
  const genTextEl = document.getElementById('genText');
  const genRateEl = document.getElementById('genRate');
  const genBtn = document.getElementById('generate');
  const downloadEl = document.getElementById('download');

  // Load the list of voices from the API
  const voiceRes = await fetch(api('/voices'));
  const voiceData = await voiceRes.json();
  voiceData.voices.forEach((v) => {
    // Preview list row
    const row = document.createElement('div');
    row.className = 'voice-row';
    row.innerHTML = `
      <div class="label">${v.label} ${v.premium ? '<span class="chip">Premium</span>' : ''}</div>
      <div class="actions"><button class="play" data-key="${v.key}">Play</button></div>
    `;
    listEl.appendChild(row);
    // Generator select option
    const opt = document.createElement('option');
    opt.value = v.key;
    opt.textContent = v.label;
    genVoiceEl.appendChild(opt);
  });

  // Handle preview playback similar to the free demos
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button.play');
    if (!btn) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Generating…';
    try {
      const key = btn.getAttribute('data-key');
      const params = new URLSearchParams({ voice: key });
      const txt = (customPreviewText.value || '').trim();
      if (txt) params.set('text', txt);
      const resp = await fetch(api('/preview?' + params.toString()));
      const j = await resp.json();
      audioEl.src = j.url;
      await audioEl.play();
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  });

  // Purchase logic: initiate a Stripe Checkout and redirect
  buyBtn.onclick = async () => {
    buyBtn.disabled = true;
    const orig = buyBtn.textContent;
    buyBtn.textContent = 'Redirecting…';
    try {
      const r = await fetch(api('/premium/checkout'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const j = await r.json();
      // Redirect to the Stripe checkout URL
      window.location.href = j.url;
    } catch (err) {
      alert('Failed to start checkout: ' + (err.message || err));
      buyBtn.textContent = orig;
      buyBtn.disabled = false;
    }
  };

  // After returning from Stripe, check the URL params for a session ID.
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('session_id');

  async function verifyPayment() {
    if (!sessionId) return;
    // Verify with the backend that payment was successful
    try {
      const resp = await fetch(api('/premium/mark_paid'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const j = await resp.json();
      if (j.ok) {
        paidStatus.textContent = 'Payment verified — you may now generate your MP3.';
      } else {
        paidStatus.textContent = 'Payment pending. If you just paid, please wait a moment.';
      }
    } catch (err) {
      paidStatus.textContent = 'Error verifying payment.';
    }
  }
  await verifyPayment();

  // Handle generation and download
  genBtn.onclick = async () => {
    downloadEl.innerHTML = '';
    if (!sessionId) {
      alert('Please purchase first by clicking the Buy button.');
      return;
    }
    const body = {
      session_id: sessionId,
      voice: genVoiceEl.value,
      text: genTextEl.value,
      rate: parseFloat(genRateEl.value || '1.0'),
    };
    genBtn.disabled = true;
    const orig = genBtn.textContent;
    genBtn.textContent = 'Generating…';
    try {
      const resp = await fetch(api('/premium/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || 'Generation failed');
      }
      const j = await resp.json();
      downloadEl.innerHTML = `<p><a href="${j.download}" download>Download MP3</a></p>`;
      // Optionally scroll to the bottom
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      genBtn.textContent = orig;
      genBtn.disabled = false;
    }
  };
})();
