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

  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    rememberName();
    location.href = 'room.html?create=1';
  });

  // `go=1` says the profile is already set, so the room can skip its own gate.
  // A bare invite link has no such flag and still asks who you are.

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = codeInput.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(code)) return fail('Room codes are 6 letters and numbers.');
    rememberName();
    location.href = 'room.html?room=' + encodeURIComponent(code) + '&go=1';
  });

  // Codes are always upper case, so save people the shift key.
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    errorEl.hidden = true;
  });

})();
