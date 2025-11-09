// Minimal TiltToggle helper. Keeps initial 'pristine' class until first change to prevent initial animations.
window.addEventListener("DOMContentLoaded",() => {
  class TiltToggle {
    constructor(el) {
      this.el = document.querySelector(el);
      this.pristine = "tilt-toggle--pristine";
      this.init();
    }
    init() {
      if (!this.el) return;
      this.el.classList.add(this.pristine);

      // if input exists inside, sync initial checked state and update class on change
      const input = this.el.querySelector('.tilt-toggle__input');
      if (input) {
        // set initial checked class on label
        this.el.classList.toggle('is-checked', !!input.checked);

        input.addEventListener('change', (e) => {
          this.el.classList.remove(this.pristine);
          this.el.classList.toggle('is-checked', !!e.target.checked);
        });
      } else {
        this.el.addEventListener("change", () => {
          this.el.classList.remove(this.pristine);
        });
      }
    }
  }

  // instantiate if toggle present
  if (document.querySelector('.tilt-toggle')) {
    new TiltToggle('.tilt-toggle');
  }
});
