'use strict';

/** Landing page: pick a name, then create or join. */
(function () {
  const nameInput = document.getElementById('name');
  const codeInput = document.getElementById('code');
  const createForm = document.getElementById('create-form');
  const joinForm = document.getElementById('join-form');
  const errorEl = document.getElementById('error');

  // -- Profile modal elements --
  const el = {
    profileModal: document.getElementById('profile-modal'),
    profileModalBackdrop: document.getElementById('profile-modal-backdrop'),
    profileModalClose: document.getElementById('profile-modal-close'),
    profileModalBanner: document.getElementById('profile-modal-banner'),
    bannerChangeBtn: document.getElementById('banner-change-btn'),
    bannerClearBtn: document.getElementById('banner-clear-btn'),
    bannerFile: document.getElementById('banner-file'),
    profileModalAvatar: document.getElementById('profile-modal-avatar'),
    profileModalUserBadges: document.getElementById('profile-modal-user-badges'),
    profileAvatarChange: document.getElementById('profile-avatar-change'),
    profileAvatarClear: document.getElementById('profile-avatar-clear'),
    profileAvatarFile: document.getElementById('profile-avatar-file'),
    profileModalSave: document.getElementById('profile-modal-save'),
    profileCard: document.getElementById('profile-card'),
    profileViewCard: document.getElementById('profile-view-card'),
    profileInvite: document.getElementById('profile-invite'),
    profileInviteBanner: document.getElementById('profile-invite-banner'),
    profileInviteBack: document.getElementById('profile-invite-back'),
    profileInviteClose: document.getElementById('profile-invite-close'),
    profileInviteCode: document.getElementById('profile-invite-code'),
    profileInviteCopy: document.getElementById('profile-invite-copy'),
  };

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

  if (window.AstraDiscord) {
    window.AstraDiscord.bindUI({
      connectBtn: document.getElementById('discord-connect'),
      badge: document.getElementById('discord-connected'),
      usernameEl: document.getElementById('discord-username'),
      disconnectBtn: document.getElementById('discord-disconnect'),
      // Connecting adopts the Discord name, picture and banner, and the
      // editor should show what it just took rather than what it held.
      onChange: () => {
        nameInput.value = AstraProfile.getName();
        modalAvatar = AstraProfile.getAvatar();
        modalBanner = AstraProfile.getBanner();
        renderModalPreview();
        paintProfile();
        renderModalBadgesAndDiscord();
        if (el.profileViewCard) {
          el.profileViewCard.hidden = !inviteCard.canShow();
        }
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

  /**
   * Who the page says you are: the picture in the bar, which is also the way
   * into the editor.
   */
  const barAvatar = document.getElementById('bar-avatar');

  function paintProfile() {
    const name = nameInput.value.trim() || AstraProfile.getName() || 'Guest';
    AstraProfile.paint(barAvatar, name, AstraProfile.getAvatar());
  }
  paintProfile();

  // ── Profile modal ──────────────────────────────────────────────────────

  let modalBanner = null;
  let modalAvatar = null;

  /** The badge id to show for yourself. */
  function selfBadge() {
    return (window.AstraDiscord && typeof window.AstraDiscord.badgeFor === 'function')
      ? window.AstraDiscord.badgeFor()
      : '';
  }

  /** Fill a badge holder, hiding it when there is nothing to show. */
  function paintBadge(holder, badgeId) {
    if (!holder) return;
    holder.textContent = '';
    const badge = badgeId && window.AstraDiscord ? window.AstraDiscord.createBadge(badgeId) : null;
    if (badge) holder.appendChild(badge);
    holder.hidden = !badge;
  }

  function renderModalBadgesAndDiscord() {
    paintBadge(el.profileModalUserBadges, selfBadge());
  }

  function renderModalPreview() {
    const name = (nameInput.value || AstraProfile.getName() || 'Guest').trim();
    AstraProfile.paintBanner(el.profileModalBanner, modalBanner, name);
    AstraProfile.paint(el.profileModalAvatar, name, modalAvatar);
    if (el.bannerClearBtn) el.bannerClearBtn.hidden = !modalBanner;
    if (el.profileAvatarClear) el.profileAvatarClear.hidden = !modalAvatar;
  }

  function showProfileCard() {
    if (el.profileCard) el.profileCard.hidden = false;
    if (el.profileInvite) el.profileInvite.hidden = true;
    if (el.profileModalClose) el.profileModalClose.focus();
  }

  function showInviteCard() {
    if (el.profileCard) el.profileCard.hidden = true;
    inviteCard.open();
    if (el.profileInviteClose) el.profileInviteClose.focus();
  }

  function openModal() {
    modalBanner = AstraProfile.getBanner();
    modalAvatar = AstraProfile.getAvatar();
    nameInput.value = AstraProfile.getName();
    renderModalBadgesAndDiscord();
    renderModalPreview();
    showProfileCard();
    if (el.profileViewCard) {
      el.profileViewCard.hidden = !inviteCard.canShow();
    }
    el.profileModal.hidden = false;
    document.addEventListener('keydown', handleModalKey);
    if (el.profileModalClose) el.profileModalClose.focus();
  }

  function closeModal() {
    el.profileModal.hidden = true;
    showProfileCard();
    inviteCard.close();
    document.removeEventListener('keydown', handleModalKey);
  }

  function handleModalKey(e) {
    if (e.key === 'Escape') closeModal();
  }

  function saveChanges() {
    const newName = AstraProfile.setName(nameInput.value);
    AstraProfile.setAvatar(modalAvatar);
    AstraProfile.setBanner(modalBanner);

    if (window.AstraDiscord) {
      if (window.AstraDiscord.saveAccountAvatar) {
        window.AstraDiscord.saveAccountAvatar(modalAvatar);
      }
      if (window.AstraDiscord.syncBanner) {
        window.AstraDiscord.syncBanner(modalBanner);
      }
      if (window.AstraDiscord.syncName) {
        window.AstraDiscord.syncName(newName);
      }
    }

    renderModalPreview();
    paintProfile();
    closeModal();
  }

  // Wire modal buttons
  el.profileModalClose.addEventListener('click', closeModal);
  if (el.profileViewCard) el.profileViewCard.addEventListener('click', showInviteCard);
  if (el.profileInviteBack) el.profileInviteBack.addEventListener('click', showProfileCard);
  if (el.profileInviteClose) el.profileInviteClose.addEventListener('click', closeModal);
  el.profileModalBackdrop.addEventListener('click', closeModal);
  el.profileModalSave.addEventListener('click', saveChanges);

  nameInput.addEventListener('input', () => {
    renderModalPreview();
    paintProfile();
  });

  // Banner handlers
  el.bannerChangeBtn.addEventListener('click', () => el.bannerFile.click());
  el.bannerFile.addEventListener('change', async () => {
    const file = el.bannerFile.files && el.bannerFile.files[0];
    el.bannerFile.value = '';
    if (!file) return;
    try {
      const cropped = await AstraProfile.editBanner(file);
      if (cropped) {
        modalBanner = cropped;
        renderModalPreview();
      }
    } catch (err) {
      fail(err.message || 'Couldn\u2019t load that banner');
    }
  });

  el.bannerClearBtn.addEventListener('click', () => {
    modalBanner = null;
    renderModalPreview();
  });

  // Avatar handlers
  el.profileAvatarChange.addEventListener('click', () => el.profileAvatarFile.click());
  el.profileAvatarFile.addEventListener('change', async () => {
    const file = el.profileAvatarFile.files && el.profileAvatarFile.files[0];
    el.profileAvatarFile.value = '';
    if (!file) return;
    try {
      const cropped = await AstraProfile.edit(file);
      if (cropped) {
        modalAvatar = cropped;
        renderModalPreview();
      }
    } catch (err) {
      fail(err.message || 'Couldn\u2019t load that picture');
    }
  });

  el.profileAvatarClear.addEventListener('click', () => {
    modalAvatar = null;
    renderModalPreview();
  });

  // Open the modal from the bar
  document.getElementById('bar-profile').addEventListener('click', openModal);

  // ── Your card ──────────────────────────────────────────────────────────

  /**
   * The friend link, as a card with a code on it - the same one a room
   * raises, drawn by js/invite-card.js. The picture and banner it shows are
   * the editor's, so a card opened mid-edit shows what is being chosen
   * rather than what was last saved.
   */
  const inviteCard = window.AstraInviteCard.mount({
    panel: el.profileInvite,
    banner: el.profileInviteBanner,
    code: el.profileInviteCode,
    copy: el.profileInviteCopy,
    art: 'astrabanner.png',
    subject: () => ({ avatar: modalAvatar, banner: modalBanner }),
  });

  paintProfile();

  /**
   * The friends panel folds away to its own edge, and stays where it was put:
   * somebody who never uses it should not have to close it twice.
   */
  const FRIENDS_KEY = 'astra:friends-open';
  const friendsRail = document.getElementById('friends-rail');
  const friendsToggle = document.getElementById('friends-toggle');

  function friendsAreOpen() {
    return document.documentElement.dataset.friends !== 'closed';
  }

  function setFriendsOpen(open) {
    // On the root, where the head script already put it: one holder, and the
    // only one that exists before the page is drawn.
    document.documentElement.dataset.friends = open ? 'open' : 'closed';
    friendsToggle.setAttribute('aria-expanded', String(open));
    const label = open ? 'Hide friends' : 'Show friends';
    friendsToggle.title = label;
    friendsToggle.setAttribute('aria-label', label);
    try {
      localStorage.setItem(FRIENDS_KEY, open ? 'open' : 'closed');
    } catch (_) {
      // Not remembered, but honoured for this visit.
    }
  }

  friendsToggle.addEventListener('click', () => {
    setFriendsOpen(!friendsAreOpen());
  });

  // Folded, the faces are the way back in: their own buttons are not drawn,
  // so a click on one can only mean "open this". Bound to the bar rather than
  // to the list, which is not declared until further down this file.
  friendsRail.addEventListener('click', (event) => {
    if (friendsAreOpen()) return;
    if (event.target.closest('.friend')) setFriendsOpen(true);
  });

  /**
   * The phone's two views, switched from the bar along the bottom. The
   * attribute is on the body whatever the width, and the stylesheet only
   * acts on it where that bar is the thing on screen.
   */
  const tabs = [...document.querySelectorAll('.mobile-tab')];

  function showTab(name) {
    document.body.dataset.tab = name;
    for (const tab of tabs) {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('is-on', on);
      if (on) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  }

  showTab('home');

  let friendsWereOpen = true;
  try {
    friendsWereOpen = localStorage.getItem(FRIENDS_KEY) !== 'closed';
  } catch (_) {
    // Whatever the default is, then.
  }
  setFriendsOpen(friendsWereOpen);

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
  const friendsCount = document.getElementById('friends-count');
  /** The same fade the room's People list lays over a banner. */
  const NAMEPLATE_GRADIENT =
    'linear-gradient(90deg, rgba(14, 14, 18, 0.82) 0%, rgba(14, 14, 18, 0.65) 32%, rgba(14, 14, 18, 0.28) 65%, transparent 100%)';

  /** A row, for a friend or for a room somebody is asking you to join. */
  function friendRow(person, action, status) {
    const row = document.createElement('li');
    row.className = 'friend';
    // Folded, the bar is a column of faces and this is the only name there
    // is to read.
    row.title = person.name || '';

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

  const FRIENDS_CACHE_KEY = 'astra:friends-cache';
  /** The list as last fetched, so a poll that finds nothing new can skip it. */
  let shownFriends = null;
  try {
    const cached = localStorage.getItem(FRIENDS_CACHE_KEY);
    if (cached) shownFriends = JSON.parse(cached);
  } catch (_) {}
  /** Who was around at the last answer, kept through a poll that gets none. */
  let shownPeople = {};

  function drawFriendsList(data, people) {
    if (!friendsList || !data) return;
    const { friends, invites } = data;
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
    const friendIds = new Set((friends || []).map((friend) => friend.id));
    const inviteFrom = new Map();
    for (const invite of (invites || [])) {
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

    const ordered = (friends || [])
      .filter((friend) => inviteFrom.has(friend.id))
      .concat((friends || []).filter((friend) => !inviteFrom.has(friend.id)));

    for (const friend of ordered) {
      const invite = inviteFrom.get(friend.id);
      const status = (people && people[friend.id]) || 'offline';
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

    // How many of them are around. Nothing to say with an empty list, and an
    // empty count is what hides it - see .friends-count.
    const around = (friends || []).filter((friend) => ((people && people[friend.id]) || 'offline') !== 'offline');
    if (friendsCount) {
      friendsCount.textContent = (friends && friends.length)
        ? around.length + ' of ' + friends.length + ' online'
        : '';
    }

    if ((!friends || !friends.length) && (!invites || !invites.length)) {
      const empty = document.createElement('li');
      empty.className = 'friends-empty';
      empty.textContent = 'Nobody yet. Send someone your link.';
      friendsList.append(empty);
    }
  }

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
      if (friendsCount) friendsCount.textContent = '';
      shownFriends = null;
      shownPeople = {};
      try { localStorage.removeItem(FRIENDS_CACHE_KEY); } catch (_) {}
      return;
    }
    friendsSection.hidden = false;

    // Instantly paint from cache if available so there is zero delay on load
    if (shownFriends && !friendsList.hasChildNodes()) {
      drawFriendsList(shownFriends, shownPeople);
    }

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
    try {
      localStorage.setItem(FRIENDS_CACHE_KEY, JSON.stringify(data));
    } catch (_) {}

    if (presence) shownPeople = presence.people;
    drawFriendsList(data, shownPeople);
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
