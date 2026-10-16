'use strict';

// Wires the Do stuff pocket (pocket.html) from the preload's isolated world. The pocket's own page
// runs no script and nothing is exposed to it. Main answers these channels only from the pocket's
// own window (main.cjs fromPocket), and sends it only what lib/pocket.cjs shapePocket let through.
// A sandboxed preload can't require local files, so the line's wording lives here, and
// tests/unit/electron-pocket.test.ts runs this file against the pocket's markup. The sprint's
// wording is the web's (components/sidebar/sprint-ring.tsx): change one, change both.

const { ipcRenderer } = require('electron');

// "1h 20m", "45m", "2h": lib/do-stuff-walk.ts spanLabel.
function span(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** The pocket's top line and how much of a sprint is left (0..1, or null with none). */
function lineFor(state, now) {
  const s = state && state.sprint;
  if (s) {
    const total = s.endsAt - s.startedAt;
    const left = Math.max(0, s.endsAt - Math.max(now, s.startedAt));
    if (left === 0) return { text: s.until ? `time's up · ${s.until} next` : "time's up", left: 0 };
    const text = `${span(Math.ceil(left / 60_000))} left${s.until ? ` · till ${s.until}` : ''}`;
    return { text, left: total > 0 ? left / total : 0 };
  }
  const done = state && state.done > 0 ? ` · ${state.done} done` : '';
  return { text: `now${done}`, left: null };
}

function wire() {
  const $ = (id) => document.getElementById(id);
  let state = null;
  let timer = null;

  const paint = () => {
    const line = lineFor(state, Date.now());
    $('line').textContent = line.text;
    $('sprint').hidden = line.left === null;
    $('left').style.transform = `scaleX(${line.left === null ? 1 : line.left})`;
  };

  ipcRenderer.on('dsul-pocket:state', (_event, next) => {
    state = next && typeof next === 'object' ? next : null;
    $('title').textContent = state ? state.title : '';
    $('title').title = state ? state.title : '';
    $('done').setAttribute('aria-label', state ? `Done: ${state.title}` : 'Done');
    clearInterval(timer);
    timer = state && state.sprint ? setInterval(paint, 1000) : null;
    paint();
  });

  const act = (action) => () => ipcRenderer.send('dsul-pocket:action', { action, id: state ? state.id : '' });
  $('done').addEventListener('click', act('done'));
  $('skip').addEventListener('click', act('skip'));
  $('open').addEventListener('click', act('open'));
  $('close').addEventListener('click', act('close'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') act('close')();
  });

  // Listening now: main answers with what is current.
  ipcRenderer.send('dsul-pocket:ready');
}

// The preload runs before the pocket's markup exists.
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', wire, { once: true });
else wire();
