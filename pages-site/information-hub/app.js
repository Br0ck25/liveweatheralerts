const tabs = Array.from(document.querySelectorAll('.hub-tab'));
const panels = Array.from(document.querySelectorAll('.hub-panel'));

function activateTab(tab) {
  const target = tab.dataset.panel;
  if (!target) return;

  tabs.forEach((candidate) => {
    const isActive = candidate === tab;
    candidate.classList.toggle('is-active', isActive);
    candidate.setAttribute('aria-selected', isActive ? 'true' : 'false');
    candidate.tabIndex = isActive ? 0 : -1;
  });

  panels.forEach((panel) => {
    const isActive = panel.id === `panel-${target}`;
    panel.classList.toggle('is-active', isActive);
    panel.hidden = !isActive;
  });
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activateTab(tab));

  tab.addEventListener('keydown', (event) => {
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;

    if (nextIndex !== index) {
      event.preventDefault();
      const nextTab = tabs[nextIndex];
      activateTab(nextTab);
      nextTab.focus();
    }
  });
});
