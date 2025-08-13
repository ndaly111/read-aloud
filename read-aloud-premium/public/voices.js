(async function () {
  const API_BASE = window.API_BASE || "";
const api = (path) => API_BASE + "/api" + path;

  cconst listEl = document.getElementById('voice-list');

    onst audioEl = document.getElementById('audio');
  const customText = document.getElementById('customText');

  // Fetch available voices
  const res = await fetch(api('/voices'));
  const data = await res.json();

  // Populate list
  data.voices.forEach((v) => {
    const row = document.createElement('div');
    row.className = 'voice-row';
    row.innerHTML = `
      <div class="label">
        ${v.label} ${v.premium ? '<span class="chip">Premium</span>' : ''}
      </div>
      <div class="actions">
        <button data-key="${v.key}" class="play">Play</button>
      </div>
    `;
    listEl.appendChild(row);
  });

  // Attach play handler
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button.play');
    if (!btn) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Generating…';
    try {
      const key = btn.getAttribute('data-key');
      const params = new URLSearchParams({ voice: key });
      const txt = (customText.value || '').trim();
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
})();
