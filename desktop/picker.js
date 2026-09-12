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
  const qualityOptions = document.getElementById('quality-options');
  const audioRow = document.getElementById('audio-row');
  const audioDivider = document.getElementById('audio-divider');
  const audioInput = document.getElementById('share-audio');

  const TICK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="20 6 9 17 4 12" /></svg>';

  const SHARE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2" y="4" width="20" height="13" rx="2" />' +
    '<path d="M8 21h8M12 17v4M12 13.5V7m0 0L9.6 9.4M12 7l2.4 2.4" /></svg>';

  let sources = [];
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
    const shown = sources.filter((source) => source.kind === kind);
    list.textContent = '';

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

  function describe() {
    const chosen = settings.options.find((option) => option.value === settings.quality);
    const parts = [chosen ? chosen.label : 'Quality'];
    if (settings.audioSupported && !settings.audio) parts.push('no audio');
    summary.textContent = parts.join(' · ');
  }

  function renderSettings() {
    qualityOptions.textContent = '';
    for (const option of settings.options) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'option' + (option.value === settings.quality ? ' is-selected' : '');
      const name = document.createElement('span');
      name.textContent = option.label;
      row.append(name);
      row.insertAdjacentHTML('beforeend', TICK);
      row.addEventListener('click', () => {
        settings.quality = option.value;
        renderSettings();
        describe();
      });
      qualityOptions.append(row);
    }

    // Only Windows has a system mix to offer; elsewhere the row would be a
    // switch that does nothing.
    audioRow.hidden = !settings.audioSupported;
    audioDivider.hidden = !settings.audioSupported;
    audioInput.checked = settings.audio;
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

  // Cancelling and closing are the same answer, so both send null.
  document.getElementById('cancel').addEventListener('click', () => window.picker.choose(null));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // The panel first: Escape should close what it opened, not the window.
    if (!settingsPanel.hidden) {
      toggleSettings(false);
      return;
    }
    window.picker.choose(null);
  });

  window.picker.onSources((payload) => {
    sources = payload.sources;
    missing = payload.missingMonitors || null;

    // The room owns these; the picker shows them and hands back whatever they
    // were changed to. Nothing is shown at all when they could not be read.
    if (payload.settings && payload.settings.options && payload.settings.options.length) {
      Object.assign(settings, payload.settings);
      settingsWrap.hidden = false;
      renderSettings();
      describe();
    }

    // Open on whichever tab has something in it: a machine with one screen and
    // no capturable windows should not greet you with an empty grid.
    selectKind(sources.some((source) => source.kind === 'screen') ? 'screen' : 'window');
  });
})();
