'use strict';

/**
 * The picker's own little renderer. It knows nothing about capture: the main
 * process hands it a list of thumbnails and takes back an id.
 */
(function () {
  const list = document.getElementById('sources');
  const segments = Array.from(document.querySelectorAll('.segment'));
  const settingsWrap = document.getElementById('settings-wrap');
  const settingsToggle = document.getElementById('settings-toggle');
  const settingsPanel = document.getElementById('settings');
  const summary = document.getElementById('settings-summary');
  const resOptions = document.getElementById('res-options');
  const fpsOptions = document.getElementById('fps-options');
  const audioGroup = document.getElementById('audio-group');
  const audioDivider = document.getElementById('audio-divider');
  const audioInput = document.getElementById('share-audio');

  const SHARE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2" y="4" width="20" height="13" rx="2" />' +
    '<path d="M8 21h8M12 17v4M12 13.5V7m0 0L9.6 9.4M12 7l2.4 2.4" /></svg>';

  /** Null until the main process has listed them; see pickSource in main.js. */
  let sources = null;
  let kind = 'screen';

  /**
   * Set when the app knows this machine has monitors it could not list.
   *
   * Worth saying out loud rather than leaving somebody to hunt for a screen
   * that is not in the grid: it is Astra's problem, not theirs, and it is
   * fixed by restarting - see the note on CAPTURE_PREFS in main.js.
   */
  let missing = null;

  /**
   * What the room is set to share at, and what the user does to it here.
   *
   * Sent over with the chosen source rather than written back separately, so
   * one message carries the whole decision and there is no order to get wrong.
   */
  const settings = { quality: null, options: [], audio: false, audioSupported: false };

  function render() {
    // Until they arrive, the grid keeps the spinner it was loaded with.
    if (!sources) return;
    list.textContent = '';
    list.removeAttribute('aria-busy');

    const shown = sources.filter((source) => source.kind === kind);

    if (!shown.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = kind === 'screen'
        ? 'No screens found.'
        : 'No open windows to share.';
      list.append(empty);
      return;
    }

    if (kind === 'screen' && missing) {
      const note = document.createElement('p');
      note.className = 'notice';
      note.textContent = 'Showing ' + missing.found + ' of ' + missing.expected
        + ' monitors. Restart Astra to see the rest.';
      list.append(note);
    }

    for (const source of shown) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source';
      button.setAttribute('role', 'option');
      button.title = source.name;

      const frame = document.createElement('span');
      frame.className = 'thumb-frame';
      const thumb = document.createElement('img');
      thumb.className = 'thumb';
      thumb.src = source.thumbnail;
      thumb.alt = '';
      frame.append(thumb);

      const label = document.createElement('span');
      label.className = 'label';
      if (source.icon) {
        const icon = document.createElement('img');
        icon.src = source.icon;
        icon.alt = '';
        label.append(icon);
      }
      const name = document.createElement('span');
      name.textContent = source.name;
      label.append(name);

      const action = document.createElement('span');
      action.className = 'share-now';
      action.innerHTML = '<span>' + SHARE_ICON + 'Share Screen</span>';
      frame.append(action);

      button.append(frame, label);
      button.addEventListener('click', () => share(source.id));
      list.append(button);
    }
  }

  /** One message, carrying the source and the settings it is shared with. */
  function share(id) {
    window.picker.choose({
      id,
      quality: settings.quality,
      audio: settings.audioSupported ? settings.audio : null,
    });
  }

  function chosenOption() {
    return settings.options.find((option) => option.value === settings.quality);
  }

  function describe() {
    const chosen = chosenOption();
    const parts = [chosen ? chosen.label : 'Quality'];
    if (settings.audioSupported && !settings.audio) parts.push('no audio');
    summary.textContent = parts.join(' · ');
  }

  /**
   * The room's options are whole settings - "1080p · 30fps" - but they are
   * picked here the way the room's share menu picks them: a resolution and a
   * frame rate, each on its own. Both halves are read off the labels, so the
   * room stays the one place that says which settings exist.
   */
  function withHalves(option) {
    const [res, fps = ''] = option.label.split('·').map((part) => part.trim());
    return Object.assign({}, option, { res, fps: fps.replace(/\s*fps$/i, ' FPS') });
  }

  /** Change one half and keep the other - or, if that pair does not exist, the first that has it. */
  function pick(half, value) {
    const wanted = Object.assign({}, chosenOption(), { [half]: value });
    const match = settings.options.find((option) => option.res === wanted.res && option.fps === wanted.fps)
      || settings.options.find((option) => option[half] === value);
    if (!match) return;
    settings.quality = match.value;
    markSettings();
    describe();
  }

  /** One radio row per distinct value of a half, built once. */
  function buildHalf(group, half) {
    for (const value of new Set(settings.options.map((option) => option[half]))) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'option';
      row.dataset.half = half;
      row.dataset.value = value;
      row.setAttribute('role', 'radio');
      row.textContent = value;
      row.insertAdjacentHTML('beforeend', '<span class="radio" aria-hidden="true"></span>');
      row.addEventListener('click', () => pick(half, value));
      group.append(row);
    }
  }

  function markSettings() {
    const chosen = chosenOption() || {};
    for (const row of settingsPanel.querySelectorAll('.option')) {
      const selected = chosen[row.dataset.half] === row.dataset.value;
      row.classList.toggle('is-selected', selected);
      row.setAttribute('aria-checked', String(selected));
    }
  }

  function buildSettings() {
    buildHalf(resOptions, 'res');
    buildHalf(fpsOptions, 'fps');
    markSettings();

    // Only Windows has a system mix to offer; elsewhere the box would do
    // nothing.
    audioGroup.hidden = !settings.audioSupported;
    audioDivider.hidden = !settings.audioSupported;
    audioInput.checked = settings.audio;
    describe();
  }

  function toggleSettings(force) {
    const open = force === undefined ? settingsPanel.hidden : force;
    settingsPanel.hidden = !open;
    settingsToggle.setAttribute('aria-expanded', String(open));
  }

  settingsToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSettings();
  });

  settingsPanel.addEventListener('click', (event) => event.stopPropagation());

  audioInput.addEventListener('change', () => {
    settings.audio = audioInput.checked;
    describe();
  });

  // Anywhere else puts it away, including a click on a source - which would
  // otherwise share with the panel still hanging open over the window.
  document.addEventListener('click', () => toggleSettings(false));

  function selectKind(next) {
    kind = next;
    for (const segment of segments) {
      const active = segment.dataset.kind === kind;
      segment.classList.toggle('is-active', active);
      segment.setAttribute('aria-selected', String(active));
    }
    list.scrollTop = 0;
    render();
  }

  for (const segment of segments) {
    segment.addEventListener('click', () => selectKind(segment.dataset.kind));
  }

  // Escape, like a click outside the window (see pickSource in main.js),
  // closes it, which sends null: nothing was chosen.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // The panel first: Escape should close what it opened, not the window.
    if (!settingsPanel.hidden) {
      toggleSettings(false);
      return;
    }
    window.picker.choose(null);
  });

  // Twice per opening: the room's settings first, then the sources once they
  // are listed - see pickSource in main.js.
  window.picker.onSources((payload) => {
    // The room owns these; the picker shows them and hands back whatever they
    // were changed to. Nothing is shown at all when they could not be read.
    const given = payload.settings;
    if (given && Array.isArray(given.options) && given.options.length) {
      Object.assign(settings, given, { options: given.options.map(withHalves) });
      settingsWrap.hidden = false;
      buildSettings();
    }

    if (!payload.sources) return;
    sources = payload.sources;
    missing = payload.missingMonitors || null;

    // Open on whichever tab has something in it: a machine with one screen and
    // no capturable windows should not greet you with an empty grid.
    selectKind(sources.some((source) => source.kind === 'screen') ? 'screen' : 'window');
  });
})();
