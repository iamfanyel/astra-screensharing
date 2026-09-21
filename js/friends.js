'use strict';

/**
 * Friends, from the page's side. See handleFriends in worker.js for the store.
 *
 * Everything here needs a Discord sign-in, because that id is the only durable
 * name Astra knows a person by - a guest is a name typed into a box, and there
 * is nothing to hang a list on. So the whole feature is absent rather than
 * broken when nobody is signed in: `available()` is false and the panel stays
 * away, which is the same shape native-screen.js and native-audio.js use for
 * the things only one platform can do.
 *
 * Every call resolves to the server's JSON - including its `{ error }` when it
 * refuses - or null when there was no answer at all. Callers tell "you have no
 * friends" from "the network is down" by that null, and keep what they last
 * drew rather than wiping it.
 */
window.AstraFriends = (function () {
  /** The signed-in token, or null for a guest. */
  function token() {
    return window.AstraDiscord ? window.AstraDiscord.getToken() : null;
  }

  function available() {
    return !!token();
  }

  /**
   * One call, one answer, never a throw.
   *
   * A friends list that fails loudly would take the lobby down with it, and
   * the lobby's job is to get somebody into a room.
   */
  async function call(path, method, body) {
    const bearer = token();
    if (!bearer) return null;
    try {
      const options = { method, headers: { Authorization: 'Bearer ' + bearer } };
      if (body) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      const res = await fetch(path, options);
      if (res.status === 401) {
        // Signing somebody out is not a thing to do on a guess. Our own API
        // answers this in JSON and only when Discord itself rejected the
        // token; anything else wearing a 401 - a proxy's page, a challenge -
        // is a bad minute, not an expired account. See verifyDiscordToken.
        const said = await res.json().catch(() => null);
        if (said && said.error && window.AstraDiscord
            && typeof window.AstraDiscord.handleExpiredToken === 'function') {
          window.AstraDiscord.handleExpiredToken();
        }
        return null;
      }
      // A refusal still says why ("That is your own link."), so read it; only
      // a body that is not JSON - a proxy's error page - counts as no answer.
      const answer = await res.json().catch(() => null);
      if (!answer) return null;
      if (!res.ok && !answer.error) return null;
      return answer;
    } catch (_) {
      return null;
    }
  }

  function ask(method, body) {
    return call('/api/friends', method, body);
  }

  /**
   * Say where we are, so friends can see it.
   *
   * 'online' is here but not busy, 'in-room' is in a call, 'offline' is said
   * on the way out. Nothing carries a room code: which room, and who may walk
   * into it, is a separate decision - see the Presence class in worker.js.
   *
   * Fire and forget. A missed beat costs nothing; the server treats anybody
   * who has not spoken for a minute and a half as gone, which is also how
   * somebody who closed the tab stops showing as here.
   */
  function beat(status) {
    return call('/api/presence', 'POST', { status });
  }

  /**
   * Which friends are around, as `{ people, version }`, or null.
   *
   * `people` maps id to status. `version` changes whenever the list or the
   * waiting invitations do, so a poll can skip `state()` - which carries every
   * friend's picture and banner - while it stays the same.
   */
  async function presence() {
    const answer = await call('/api/presence', 'GET');
    if (!answer || answer.error) return null;
    return { people: answer.people || {}, version: answer.version || null };
  }

  /** The list and anything waiting, together - the panel draws both. Null on failure. */
  async function state() {
    const answer = await ask('GET');
    if (!answer || answer.error) return null;
    return {
      friends: Array.isArray(answer.friends) ? answer.friends : [],
      invites: Array.isArray(answer.invites) ? answer.invites : [],
      version: answer.version || null,
    };
  }

  /**
   * Your friend link. Absolute, because it is going into a message or onto a
   * screen for somebody to point a camera at.
   *
   * The same link every time - one short code per person - so it can be put
   * in a bio or pasted twice without either copy going stale. Kept after the
   * first ask for the life of the page.
   */
  let ownLink = null;
  async function inviteLink() {
    if (ownLink) return ownLink;
    const answer = await ask('POST', { action: 'link' });
    if (!answer || !answer.code) return null;
    ownLink = new URL('/add/' + encodeURIComponent(answer.code), location.origin).toString();
    // Whoever is about to share the link should have a preview card behind it.
    // The answer already says which card is stored, so no second ask for that.
    syncCard(answer.card || null);
    return ownLink;
  }

  /*
   * The link preview card: the art from astrabannerfriends.png with your
   * picture showing through its round hole, as chat apps show it when your
   * link is pasted. Drawn here because this is where the picture decodes;
   * the worker only stores and serves it.
   */
  const CARD_ART = '/astrabannerfriends.png';
  /** Bump when the art or the layout below changes, so every card is redrawn. */
  const CARD_DESIGN = 4;
  const CARD_WIDTH = 1200;
  const CARD_HEIGHT = 675;
  // The hole in the art, measured on the 2400x1350 file: a circle spanning
  // x 812-1589 and y 215-992. Halved for the card.
  const CARD_HOLE = { x: 600.25, y: 301.75, r: 194.5 };
  const CARD_SEEN_KEY = 'astra:friend-card';

  let cardSyncing = false;
  /** Asked for again while a sync was running: run once more when it ends. */
  let cardSyncAgain = false;

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  /** A short hash, the same shape the worker's version check accepts. */
  function fingerprint(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  /** The signed-in Discord user, or null. */
  function discordUser() {
    return window.AstraDiscord && window.AstraDiscord.getUser ? window.AstraDiscord.getUser() : null;
  }

  /** What the card shows: the picture, or null and the name its colour comes from. */
  function cardSubject(user) {
    const profile = window.AstraProfile;
    const avatar = profile ? profile.getAvatar() : null;
    const name = ((profile && profile.getName()) || (user && (user.global_name || user.username)) || 'Guest')
      .trim()
      .slice(0, 32);
    return { avatar: avatar && profile.isAvatar(avatar) ? avatar : null, name };
  }

  function readSeenCard() {
    try {
      return JSON.parse(localStorage.getItem(CARD_SEEN_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function rememberCard(account, version) {
    try {
      localStorage.setItem(CARD_SEEN_KEY, JSON.stringify({ account, version }));
    } catch (_) {
      /* private mode: it will just ask again next time */
    }
  }

  async function drawCard(subject) {
    const canvas = document.createElement('canvas');
    canvas.width = CARD_WIDTH;
    canvas.height = CARD_HEIGHT;
    const ink = canvas.getContext('2d');
    const [art, picture] = await Promise.all([
      loadImage(CARD_ART),
      subject.avatar ? loadImage(subject.avatar) : Promise.resolve(null),
    ]);

    ink.fillStyle = '#0e0e0e';
    ink.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

    // A touch wider than the hole, so the art's anti-aliased rim lands on the
    // picture rather than on the dark fill behind it.
    const { x, y } = CARD_HOLE;
    const r = CARD_HOLE.r + 3;
    ink.save();
    ink.beginPath();
    ink.arc(x, y, r, 0, Math.PI * 2);
    ink.clip();
    if (picture) {
      // Cover the circle, cropping the long side from the middle.
      const scale = (r * 2) / Math.min(picture.width, picture.height);
      const w = picture.width * scale;
      const h = picture.height * scale;
      ink.drawImage(picture, x - w / 2, y - h / 2, w, h);
    } else {
      // The same mark-on-colour the app shows for somebody without a picture.
      await window.AstraProfile.drawMark(ink, subject.name, x, y, r);
    }
    ink.restore();

    ink.drawImage(art, 0, 0, CARD_WIDTH, CARD_HEIGHT);
    return canvas.toDataURL('image/jpeg', 0.88);
  }

  /**
   * Make sure the stored card shows the current picture.
   *
   * Cheap when nothing changed: the version last confirmed for this account is
   * remembered, so a matching one costs no request at all. Otherwise the server
   * says what it holds - unless the caller already knows, as `inviteLink` does -
   * and only a different one is drawn and sent. Somebody who has never made a
   * link has no card to keep, and nothing is sent.
   *
   * `storedVersion` is what the server holds, when known: a version string, or
   * null for no card yet. Leave it undefined to have it asked for.
   */
  async function syncCard(storedVersion) {
    if (!available()) return;
    if (cardSyncing) {
      // The picture may have changed mid-sync; check again once this one ends.
      cardSyncAgain = true;
      return;
    }

    const user = discordUser();
    const account = user && user.id ? String(user.id) : '';
    const subject = cardSubject(user);
    // The name only shows as the colour, so it only counts without a picture.
    const version = CARD_DESIGN + '.' + fingerprint(subject.avatar || 'initial:' + subject.name);

    const seen = readSeenCard();
    if (seen && seen.account === account && seen.version === version) return;

    cardSyncing = true;
    try {
      let current = storedVersion;
      if (current === undefined) {
        const status = await ask('POST', { action: 'card' });
        if (!status || !status.linked) return;
        current = status.version;
      }
      if (current !== version) {
        const stored = await ask('POST', { action: 'card', version, image: await drawCard(subject) });
        if (!stored || !stored.ok) return;
      }
      rememberCard(account, version);
    } catch (_) {
      // A card that could not be drawn leaves the plain art in its place.
    } finally {
      cardSyncing = false;
      if (cardSyncAgain) {
        cardSyncAgain = false;
        syncCard();
      }
    }
  }

  /** Whose link a code is, before anything is agreed to. */
  function linkPreview(code) {
    return call('/api/friends?link=' + encodeURIComponent(code), 'GET');
  }

  /** Take a link somebody handed us. */
  function accept(code) {
    return ask('POST', { action: 'accept', code });
  }

  function remove(id) {
    return ask('POST', { action: 'remove', id });
  }

  /** Leave a room invitation for a friend to find. */
  function inviteToRoom(id, code) {
    return ask('POST', { action: 'invite', to: id, code });
  }

  function dismiss(from) {
    return ask('POST', { action: 'dismiss', from });
  }

  return {
    available, state, presence, beat,
    inviteLink, linkPreview, accept, syncCard,
    remove, inviteToRoom, dismiss,
  };
})();
