'use strict';

/** Landing page: pick a name, then create or join. */
(function () {
  const nameInput = document.getElementById('name');
  const avatarEl = document.getElementById('avatar');
  const avatarChange = document.getElementById('avatar-change');
  const avatarFile = document.getElementById('avatar-file');
  const avatarClear = document.getElementById('avatar-clear');
  const codeInput = document.getElementById('code');
  const createForm = document.getElementById('create-form');
  const joinForm = document.getElementById('join-form');
  const errorEl = document.getElementById('error');

  function fail(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  const urlParams = new URLSearchParams(location.search);
  if (urlParams.has('deleted') || urlParams.has('expired')) {
    fail('That room has expired or no longer exists.');
    history.replaceState(null, '', location.pathname);
  }

  nameInput.value = AstraProfile.getName();

  const picker = AstraProfile.mountPicker({
    nameInput,
    avatarEl,
    changeBtn: avatarChange,
    fileInput: avatarFile,
    clearBtn: avatarClear,
    onError: fail,
  });

  if (window.AstraDiscord) {
    window.AstraDiscord.bindUI({
      connectBtn: document.getElementById('discord-connect'),
      badge: document.getElementById('discord-connected'),
      usernameEl: document.getElementById('discord-username'),
      disconnectBtn: document.getElementById('discord-disconnect'),
      // Connecting adopts the Discord display name and picture.
      onChange: () => {
        nameInput.value = AstraProfile.getName();
        picker.repaint();
      },
      onError: fail,
    });
  }

  function rememberName() {
    AstraProfile.setName(nameInput.value);
  }

  nameInput.addEventListener('change', rememberName);
  nameInput.addEventListener('blur', rememberName);

  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    rememberName();
    location.href = 'room/?create=1';
  });

  // `go=1` says the profile is already set, so the room can skip its own gate.
  // A bare invite link has no such flag and still asks who you are.

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = codeInput.value.trim().toUpperCase();
    if (!window.ASTRA.roomCodePattern.test(code)) return fail('Room codes are 6 letters and numbers.');
    rememberName();
    location.href = 'room/?room=' + encodeURIComponent(code) + '&go=1';
  });

  // Codes are always upper case, so save people the shift key.
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    errorEl.hidden = true;
  });

  /**
   * The room code inside an invite link, or null for anything that is not one.
   *
   * Rooms are shared by sending the link, so the link is what ends up on the
   * clipboard - and the code field is the obvious place to put it. Both kinds
   * carry the code in the query string, spelled differently: the site's own
   * links use `?room=`, and the `astra://` links the apps register use
   * `?code=`.
   *
   * Anything without a query string is left alone, which is every code that
   * was simply typed.
   */
  function codeInLink(text) {
    let raw = String(text || '').trim();
    const hash = raw.indexOf('#');
    if (hash !== -1) raw = raw.slice(0, hash);
    const query = raw.indexOf('?');
    if (query === -1) return null;

    let params;
    try {
      params = new URLSearchParams(raw.slice(query + 1));
    } catch (_) {
      return null;
    }
    const code = (params.get('room') || params.get('code') || '').trim().toUpperCase();
    return window.ASTRA.roomCodePattern.test(code) ? code : null;
  }

  /**
   * Paste rather than input, because by the time `input` runs the link is
   * already gone: the field is six characters wide and the browser truncates a
   * pasted value to fit, so the handler above would be sanitising "https:".
   * The clipboard still has the whole thing.
   *
   * Assigning the value in script is not subject to maxlength either, so a
   * longer code from an older build survives this where typing it would not.
   */
  codeInput.addEventListener('paste', (event) => {
    const clipboard = event.clipboardData || window.clipboardData;
    if (!clipboard) return;
    const code = codeInLink(clipboard.getData('text'));
    // Not a link: let the ordinary paste happen, and be tidied as always.
    if (!code) return;
    event.preventDefault();
    codeInput.value = code;
    errorEl.hidden = true;
  });

})();
