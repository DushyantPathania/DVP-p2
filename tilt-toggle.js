// Toggle helper (visuals adapted from CodePen)
// Source: https://codepen.io/josetxu/pen/mdQePNo (author: josetxu)
// - Keeps initial 'pristine' class until first interaction to prevent initial animations
// - Renders a small persistent caption (verbose) next to the toggle and updates it on change
// - Exposes syncTiltToggleLabel() for programmatic updates
window.addEventListener('DOMContentLoaded', () => {
  const el = document.querySelector('.tilt-toggle');
  if (!el) return;

  const input = el.querySelector('.tilt-toggle__input');
  const labelEl = el.querySelector('label[for="btn"]');
  const pristine = 'tilt-toggle--pristine';

  // short names and verbose descriptions (data attributes on container)
  const nameGlobe = el.dataset.nameGlobe || 'Globe';
  const nameMap = el.dataset.nameMap || 'Map';
  const verbose = {
    globe: el.dataset.verboseGlobe || '3D Globe — tilt, rotate and spin to explore the world.',
    map: el.dataset.verboseMap || '2D Map — flat, draggable map with zoom for details.'
  };

  // ensure pristine until first interaction
  el.classList.add(pristine);
  if (input) el.classList.toggle('is-checked', !!input.checked);

  // create persistent caption element (if not present) and place it under the toggle
  let caption = el.querySelector('.tilt-toggle-caption');
  if (!caption) {
    caption = document.createElement('div');
    caption.className = 'tilt-toggle-caption';
    caption.setAttribute('aria-hidden', 'true');
    el.appendChild(caption);
  }

  function updateCaption(){
    const mode = input && input.checked ? 'map' : 'globe';
    caption.textContent = mode === 'map' ? verbose.map : verbose.globe;
  }
  updateCaption();

  // no transient tooltip: we only keep the persistent caption next to the control

  // sync visual active state and caption
  function syncLabel(){
    if (!input) return;
    // keep a class for CSS hooks and update caption
    el.classList.toggle('is-checked', !!input.checked);
    input.setAttribute('aria-checked', input.checked ? 'true' : 'false');
    updateCaption();
  }
  syncLabel();

  // interactions

  if (labelEl) {
    // remove pristine on pointerdown so the animation classes are enabled before the change event
    labelEl.addEventListener('pointerdown', () => { el.classList.remove(pristine); });
  }

  if (input) {
    input.addEventListener('change', (e) => {
      el.classList.remove(pristine);
      syncLabel();
    });
  }

  // helper for programmatic updates
  window.syncTiltToggleLabel = function(){
    // remove pristine so programmatic changes animate
    el.classList.remove(pristine);
    syncLabel();
  };
});
