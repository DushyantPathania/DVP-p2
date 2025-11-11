// Toggle control behavior
// - Works with the `.toggle` markup (input id="btn") added to index.html
// - Hidden on the landing page via CSS; revealed after clicking #enterBtn
// - Emits a `view-toggle` event on window with { detail: { map: true/false } }
window.addEventListener('DOMContentLoaded', () => {
  const container = document.querySelector('.toggle');
  const input = document.getElementById('btn');
  const textEl = document.getElementById('toggleText');
  if (!container || !input || !textEl) return;

  // Reflect landing visibility in aria states
  container.setAttribute('aria-hidden', document.body.classList.contains('landing') ? 'true' : 'false');
  textEl.setAttribute('aria-hidden', document.body.classList.contains('landing') ? 'true' : 'false');

  // Show the toggle after the user clicks Explore (id: enterBtn)
  const enterBtn = document.getElementById('enterBtn');
  if (enterBtn) {
    enterBtn.addEventListener('click', () => {
      container.style.display = '';
      container.setAttribute('aria-hidden', 'false');
      textEl.setAttribute('aria-hidden', 'false');
    });
  }

  // Update the concise label for the toggle. isMap === true => 2D atlas active.
  function setLabelForMode(isMap){
    if (!textEl) return;
    if (isMap) textEl.textContent = '2D atlas — click to switch to 3D globe';
    else       textEl.textContent = '3D globe — click to switch to 2D atlas';
  }

  // When the user toggles, emit view-toggle and update label immediately for responsiveness
  input.addEventListener('change', () => {
    const isMap = !!input.checked;
    setLabelForMode(isMap);
    window.dispatchEvent(new CustomEvent('view-toggle', { detail: { map: isMap } }));
  });

  // Listen for programmatic syncs from map.js and update label & input state
  window.addEventListener('view-mode-sync', (ev) => {
    const isMap = !!(ev && ev.detail && ev.detail.map);
    if (input.checked !== isMap) input.checked = isMap;
    input.setAttribute('aria-checked', isMap ? 'true' : 'false');
    setLabelForMode(isMap);
  });

  // Initialize label from the current checkbox state
  setLabelForMode(!!input.checked);
});
