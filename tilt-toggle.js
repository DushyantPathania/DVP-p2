// Toggle control behavior
// - Works with the `.toggle` markup (input id="btn") added to index.html
// - Hidden on the landing page via CSS; revealed after clicking #enterBtn
// - Emits a `view-toggle` event on window with { detail: { map: true/false } }
window.addEventListener('DOMContentLoaded', () => {
  const container = document.querySelector('.toggle');
  const input = document.getElementById('btn');
  if (!container || !input) return;

  // Mark initial aria-hidden state to reflect landing visibility
  container.setAttribute('aria-hidden', document.body.classList.contains('landing') ? 'true' : 'false');

  // Show the toggle after the user clicks Explore (id: enterBtn)
  const enterBtn = document.getElementById('enterBtn');
  if (enterBtn) {
    enterBtn.addEventListener('click', () => {
      // If the page removes .landing elsewhere, this will instead be handled by CSS.
      // We force show the control here to be explicit.
      container.style.display = '';
      container.setAttribute('aria-hidden', 'false');
    });
  }

  // Emit view-toggle events when the checkbox changes
  input.addEventListener('change', () => {
    const isMap = !!input.checked;
    window.dispatchEvent(new CustomEvent('view-toggle', { detail: { map: isMap } }));
    // update the adjacent label text
    const lbl = document.getElementById('toggleText');
    if (lbl) lbl.textContent = isMap ? '2D Map' : '3D Globe';
  });

  // also update the label when other parts of the app programmatically change mode
  window.addEventListener('view-mode-sync', (ev) => {
    const isMap = !!(ev?.detail?.map);
    const lbl = document.getElementById('toggleText');
    if (lbl) lbl.textContent = isMap ? '2D Map' : '3D Globe';
    // also sync checkbox if needed
    if (input.checked !== isMap) input.checked = isMap;
  });
});
