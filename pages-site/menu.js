(function () {
  const body = document.body;
  const toggle = document.querySelector('[data-menu-toggle]');
  const overlay = document.querySelector('[data-settings-overlay]');
  const drawer = document.querySelector('[data-settings-drawer]');

  if (!body || !toggle || !overlay || !drawer) return;

  const closeBtn = drawer.querySelector('[data-menu-close]');
  const tabButtons = Array.from(drawer.querySelectorAll('[data-drawer-tab]'));
  const panels = Array.from(drawer.querySelectorAll('[data-drawer-panel]'));
  const drawerLinks = Array.from(drawer.querySelectorAll('.drawer-link'));

  function openDrawer() {
    body.classList.add('menu-open');
    overlay.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    toggle.setAttribute('aria-expanded', 'true');
  }

  function closeDrawer() {
    body.classList.remove('menu-open');
    overlay.hidden = true;
    drawer.setAttribute('aria-hidden', 'true');
    toggle.setAttribute('aria-expanded', 'false');
  }

  function setTab(name) {
    const tabName = String(name || '').toLowerCase() === 'menu' ? 'menu' : 'settings';

    tabButtons.forEach((btn) => {
      const active = (btn.getAttribute('data-drawer-tab') || '') === tabName;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active) {
        btn.removeAttribute('tabindex');
      } else {
        btn.setAttribute('tabindex', '-1');
      }
    });

    panels.forEach((panel) => {
      const active = (panel.getAttribute('data-drawer-panel') || '') === tabName;
      panel.classList.toggle('is-active', active);
      panel.hidden = !active;
    });
  }

  toggle.addEventListener('click', () => {
    if (body.classList.contains('menu-open')) {
      closeDrawer();
    } else {
      openDrawer();
    }
  });

  overlay.addEventListener('click', closeDrawer);
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);

  drawerLinks.forEach((link) => {
    link.addEventListener('click', closeDrawer);
  });

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextTab = btn.getAttribute('data-drawer-tab') || 'settings';
      setTab(nextTab);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && body.classList.contains('menu-open')) {
      closeDrawer();
    }
  });

  setTab('settings');
  closeDrawer();
})();
