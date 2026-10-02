'use strict';

// Wires the find bar (find-bar.html) from the preload's isolated world. The bar's own page runs
// no script and nothing is exposed to it, so there is no bridge for anything in the bar to reach.
// Main answers these channels only from the bar's own view (main.cjs fromFindBar). A sandboxed
// preload can't require local files such as lib/find-bar.cjs, only Electron and a few Node
// built-ins, so the key handling lives here, and tests/unit/electron-find-bar.test.ts runs this
// file against the bar's markup.

const { ipcRenderer } = require('electron');

function wire() {
  const bar = document.querySelector('[role="search"]');
  const query = document.getElementById('query');
  const count = document.getElementById('count');

  query.addEventListener('input', () => ipcRenderer.send('dsul-find:query', query.value));
  document.addEventListener('keydown', (event) => {
    // An input method that is still composing owns Enter and Escape.
    if (event.isComposing || event.keyCode === 229) return;
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      event.preventDefault();
      ipcRenderer.send('dsul-find:close');
    } else if (event.key === 'Enter' && event.target === query && !mod && !event.altKey) {
      event.preventDefault();
      ipcRenderer.send('dsul-find:step', !event.shiftKey);
    }
    // Everything else is left for the menu: Ctrl/⌘ F and G, F3, and Ctrl/⌘ +, − and 0, which
    // zoom the page (main.cjs zoomPage), never this bar.
  });
  document.getElementById('previous').addEventListener('click', () => ipcRenderer.send('dsul-find:step', false));
  document.getElementById('next').addEventListener('click', () => ipcRenderer.send('dsul-find:step', true));
  document.getElementById('close').addEventListener('click', () => ipcRenderer.send('dsul-find:close'));

  // Main sends nothing before the bar's page has loaded (did-finish-load), so these are
  // registered in time. Shown, or asked for again while open: the last search, selected, so
  // typing replaces it.
  ipcRenderer.on('dsul-find:show', (_event, text) => {
    query.value = typeof text === 'string' ? text : '';
    query.focus();
    query.select();
  });
  ipcRenderer.on('dsul-find:count', (_event, label) => {
    count.textContent = label && typeof label.text === 'string' ? label.text : '';
    bar.dataset.none = String(!!(label && label.none));
  });
}

// The preload runs before the bar's markup exists.
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', wire, { once: true });
else wire();
