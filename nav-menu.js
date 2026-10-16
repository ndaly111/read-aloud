/* Phone-width menu: collapses the primary nav behind a two-line button (styles.css,
   "Mobile menu"). Without this script the nav simply stays visible. */
(() => {
  'use strict';
  function init() {
    const header = document.querySelector('header.site-header');
    const container = header && header.querySelector('.nav-container');
    const nav = container && container.querySelector('.site-nav');
    if (!nav || container.querySelector('.menu-toggle')) return;
    if (!nav.id) nav.id = 'site-nav';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-toggle';
    button.setAttribute('aria-controls', nav.id);
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', 'Menu');
    button.innerHTML = '<span></span><span></span>';
    container.insertBefore(button, container.firstChild);
    header.classList.add('has-menu');
    const setOpen = open => {
      header.classList.toggle('menu-open', open);
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
    };
    button.addEventListener('click', () => setOpen(!header.classList.contains('menu-open')));
    nav.addEventListener('click', event => { if (event.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && header.classList.contains('menu-open')) {
        setOpen(false);
        button.focus();
      }
    });
    document.addEventListener('click', event => {
      if (!header.contains(event.target)) setOpen(false);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
