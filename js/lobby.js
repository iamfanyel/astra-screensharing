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
        // Signing in is what makes friends possible, and signing out is what
        // takes them away - either way the panel is now wrong, and so is
        // whether there is anything worth polling for.
        renderFriends(true).then(watchFriends);
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


  /**
   * The friends panel.
   *
   * Two things live here: the people you can hand a room to, and any room
   * somebody has already handed you. Both need a Discord sign-in, so for a
   * guest the whole section stays hidden rather than showing an empty list
   * with no way to fill it.
   */
  const friendsSection = document.getElementById('friends');
  const friendsList = document.getElementById('friends-list');
  /** The same fade the room's People list lays over a banner. */
  const NAMEPLATE_GRADIENT =
    'linear-gradient(90deg, rgba(14, 14, 18, 0.82) 0%, rgba(14, 14, 18, 0.65) 32%, rgba(14, 14, 18, 0.28) 65%, transparent 100%)';

  /** A row, for a friend or for a room somebody is asking you to join. */
  function friendRow(person, action, status) {
    const row = document.createElement('li');
    row.className = 'friend';

    // Their banner behind the row, as the member list draws it. Checked by
    // profile.js, so a string that is not a picture is never put in a url().
    const banner = person.banner && window.AstraProfile && window.AstraProfile.isBanner(person.banner)
      ? person.banner
      : null;
    if (banner) {
      row.classList.add('has-banner');
      const plate = document.createElement('div');
      plate.className = 'friend-plate';
      plate.setAttribute('aria-hidden', 'true');
      plate.style.backgroundImage = NAMEPLATE_GRADIENT + ', url("' + banner.replace(/"/g, '%22') + '")';
      row.append(plate);
    }

    const avatar = document.createElement('span');
    avatar.className = 'friend-avatar';
    if (status && status !== 'offline') {
      // A dot on the picture, the way every chat app does it - it reads at a
      // glance and costs the row no width.
      avatar.classList.add('is-' + status);
    }
    AstraProfile.paint(avatar, person.name || '', person.avatar);

    const name = document.createElement('span');
    name.className = 'friend-name';
    name.textContent = person.name;

    row.append(avatar, name, action);
    return row;
  }

  /** The list as last fetched, so a poll that finds nothing new can skip it. */
  let shownFriends = null;
  /** Who was around at the last answer, kept through a poll that gets none. */
  let shownPeople = {};

  /**
   * Draw the panel.
   *
   * Every call asks who is around, which is small. The list itself - every
   * friend's picture and banner - is fetched again only when the presence
   * answer's version says it changed, or `refresh` says we just changed it.
   */
  async function renderFriends(refresh) {
    if (!friendsSection || !window.AstraFriends) return;
    if (!window.AstraFriends.available()) {
      friendsSection.hidden = true;
      shownFriends = null;
      shownPeople = {};
      return;
    }
    friendsSection.hidden = false;
    if (refresh) shownFriends = null;

    let presence;
    let data = shownFriends;
    if (!data) {
      // Nothing to fall back on yet: ask for both at once.
      [data, presence] = await Promise.all([
        window.AstraFriends.state(),
        window.AstraFriends.presence(),
      ]);
    } else {
      presence = await window.AstraFriends.presence();
      if (presence && presence.version !== data.version) {
        data = (await window.AstraFriends.state()) || data;
      }
    }

    // No answer at all: leave whatever is on screen rather than wipe it.
    if (!data) return;
    shownFriends = data;

    if (presence) shownPeople = presence.people;
    const { friends, invites } = data;
    const people = shownPeople;
    friendsList.textContent = '';

    /** Join and dismiss, for a room somebody has handed you. */
    function inviteActions(invite) {
      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'friend-join';
      join.textContent = 'Join';
      join.addEventListener('click', () => {
        rememberName();
        location.href = 'room/?room=' + encodeURIComponent(invite.code) + '&go=1';
      });

      const no = document.createElement('button');
      no.type = 'button';
      no.className = 'friend-dismiss';
      no.title = 'Dismiss';
      no.setAttribute('aria-label', 'Dismiss the invitation from ' + invite.from.name);
      no.textContent = '×';
      no.addEventListener('click', async () => {
        await window.AstraFriends.dismiss(invite.from.id);
        renderFriends(true);
      });

      const actions = document.createElement('span');
      actions.className = 'friend-actions';
      actions.append(join, no);
      return actions;
    }

    function markInvited(row, invite) {
      row.classList.add('friend-invited');
      const asking = document.createElement('span');
      asking.className = 'friend-sub';
      asking.textContent = 'invited you to ' + invite.code;
      row.querySelector('.friend-name').append(asking);
    }

    // One row per person: an invitation from a friend goes on that friend's
    // own row rather than a second one above it.
    const friendIds = new Set(friends.map((friend) => friend.id));
    const inviteFrom = new Map();
    for (const invite of invites) {
      if (invite && invite.from) inviteFrom.set(invite.from.id, invite);
    }

    // Invitations first: they are the only rows with somewhere to go. One from
    // somebody no longer on the list still gets a row of its own.
    for (const invite of inviteFrom.values()) {
      if (friendIds.has(invite.from.id)) continue;
      const row = friendRow(invite.from, inviteActions(invite));
      markInvited(row, invite);
      friendsList.append(row);
    }

    const ordered = friends
      .filter((friend) => inviteFrom.has(friend.id))
      .concat(friends.filter((friend) => !inviteFrom.has(friend.id)));

    for (const friend of ordered) {
      const invite = inviteFrom.get(friend.id);
      const status = people[friend.id] || 'offline';
      if (invite) {
        const row = friendRow(friend, inviteActions(invite), status);
        markInvited(row, invite);
        friendsList.append(row);
        continue;
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'friend-dismiss';
      remove.title = 'Remove ' + friend.name;
      remove.setAttribute('aria-label', 'Remove ' + friend.name);
      remove.textContent = '×';
      remove.addEventListener('click', async () => {
        if (!confirm('Remove ' + friend.name + ' from your friends?')) return;
        await window.AstraFriends.remove(friend.id);
        renderFriends(true);
      });
      const row = friendRow(friend, remove, status);
      if (status !== 'offline') {
        const sub = document.createElement('span');
        sub.className = 'friend-sub';
        sub.textContent = status === 'in-room' ? 'in a call' : 'online';
        row.querySelector('.friend-name').append(sub);
      }
      friendsList.append(row);
    }

    if (!friends.length && !invites.length) {
      const empty = document.createElement('li');
      empty.className = 'friends-empty';
      empty.textContent = 'Nobody yet. Send someone your link.';
      friendsList.append(empty);
    }
  }

  /**
   * Keep the panel current while somebody is sat on the lobby.
   *
   * Without this an invitation only appears on a page load, which misses the
   * one case the feature exists for: waiting for a friend to start something.
   * A poll is enough - there is no connection to push down, and this is a read
   * rather than a write, which is the side of the quota that can afford it.
   *
   * Only while the page is actually being looked at. A tab left open for a day
   * in the background should cost nothing, and the check on returning catches
   * whatever arrived while it was away.
   */
  const FRIENDS_POLL_MS = 25000;
  let friendsPoll = null;

  function watchFriends() {
    if (friendsPoll) {
      clearInterval(friendsPoll);
      friendsPoll = null;
    }
    if (document.visibilityState !== 'visible') return;
    if (!window.AstraFriends || !window.AstraFriends.available()) return;
    // Sitting on the lobby counts as being around, and the same tick that asks
    // who is here says that we are.
    window.AstraFriends.beat('online');
    friendsPoll = setInterval(() => {
      window.AstraFriends.beat('online');
      renderFriends();
    }, FRIENDS_POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    // Coming back is the moment most likely to have something waiting.
    if (document.visibilityState === 'visible') renderFriends();
    watchFriends();
  });

  renderFriends().then(watchFriends);

})();
