'use strict';

// One tooltip element, moved around and re-pointed as the mouse (or keyboard
// focus) lands on anything carrying data-tip. Speech-bubble shaped, always
// the same near-white on navy whatever the desktop theme is, and it flips
// above or below its anchor so it never runs off the edge of the window.

(() => {
  const DELAY = 400;
  const GAP = 8;

  const tip = document.getElementById('tooltip');
  const text = document.getElementById('tooltip-text');
  const arrow = document.getElementById('tooltip-arrow');
  if (!tip) return;

  let timer = null;
  let anchor = null;

  function hide() {
    clearTimeout(timer);
    timer = null;
    anchor = null;
    tip.classList.remove('shown');
    tip.hidden = true;
  }

  function place(target, label) {
    text.textContent = label;
    tip.hidden = false;
    tip.dataset.side = 'below';
    // Measure first, position second: the bubble's height depends on how the
    // label wraps, which isn't known until it's in the document.
    const box = target.getBoundingClientRect();
    const size = tip.getBoundingClientRect();

    const below = box.bottom + GAP;
    const fitsBelow = below + size.height <= window.innerHeight - 4;
    const top = fitsBelow ? below : box.top - GAP - size.height;
    tip.dataset.side = fitsBelow ? 'below' : 'above';

    const wanted = box.left + box.width / 2 - size.width / 2;
    const left = Math.max(6, Math.min(wanted, window.innerWidth - size.width - 6));

    tip.style.top = `${Math.max(4, top)}px`;
    tip.style.left = `${left}px`;

    // The arrow points at the middle of the anchor even when the bubble had
    // to be nudged sideways to stay on screen.
    const arrowX = box.left + box.width / 2 - left;
    arrow.style.left = `${Math.max(8, Math.min(arrowX - 6, size.width - 20))}px`;

    tip.classList.add('shown');
  }

  // Shown briefly by code rather than hover: the update dot answers a
  // manual check with a bubble even if the pointer has already moved on.
  window.flashTooltip = (target, label, ms = 2200) => {
    clearTimeout(timer);
    anchor = target;
    place(target, label || target.dataset.tip || '');
    timer = setTimeout(hide, ms);
  };

  function schedule(target) {
    const label = target.dataset.tip;
    if (!label) return;
    anchor = target;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (anchor === target && document.contains(target)) place(target, label);
    }, DELAY);
  }

  function tipTarget(node) {
    return node && node.closest ? node.closest('[data-tip]') : null;
  }

  document.addEventListener('mouseover', (event) => {
    const target = tipTarget(event.target);
    if (!target) return;
    if (target === anchor) return;
    hide();
    schedule(target);
  });

  document.addEventListener('mouseout', (event) => {
    const target = tipTarget(event.target);
    if (target && target === anchor) hide();
  });

  document.addEventListener('focusin', (event) => {
    const target = tipTarget(event.target);
    if (target) { hide(); schedule(target); }
  });

  document.addEventListener('focusout', hide);
  document.addEventListener('mousedown', hide);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hide(); });
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  window.addEventListener('scroll', hide, true);
})();
