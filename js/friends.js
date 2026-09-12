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
    return ownLink;
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
    inviteLink, linkPreview, accept,
    remove, inviteToRoom, dismiss,
  };
})();
