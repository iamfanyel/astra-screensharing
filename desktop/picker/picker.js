'use strict';

/**
 * The picker's own little renderer. It knows nothing about capture: the main
 * process hands it a list of thumbnails and takes back an id.
 */
(function () {
  const list = document.getElementById('sources');
  const segments = Array.from(document.querySelectorAll('.segment'));
  const quality = document.getElementById('quality');
  const qualityDetail = document.getElementById('quality-detail');

  let sources = [];
  let kind = 'screen';

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

      button.append(frame, label);
      button.addEventListener('click', () => window.picker.choose(source.id));
      list.append(button);
    }
  }

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
    if (event.key === 'Escape') window.picker.choose(null);
  });

  window.picker.onSources((payload) => {
    sources = payload.sources;

    // The room decides the quality; this only reports it, and says nothing at
    // all when the main process could not read it.
    if (payload.quality) {
      qualityDetail.textContent = payload.quality;
      quality.hidden = false;
    }

    // Open on whichever tab has something in it: a machine with one screen and
    // no capturable windows should not greet you with an empty grid.
    selectKind(sources.some((source) => source.kind === 'screen') ? 'screen' : 'window');
  });
})();
