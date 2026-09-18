'use strict';

/**
 * The page an invite link opens.
 *
 * A friend request is somebody asking for something, so the page names them
 * before it asks for anything: their picture, their name, their banner behind
 * it. "Become friends with someone?" is a thing nobody should have to click.
 *
 * The link is /add/<code>, one code per person and the same for good, so
 * reloading or opening it twice costs nothing.
 *
 * Everything needs a Discord sign-in, because a friendship has to hang off an
 * id rather than a typed name. Somebody who arrives signed out is told what to
 * do and sent to connect, then comes back to the same link.
 */
(function () {
  const el = {
    wash: document.getElementById('invite-wash'),
    card: document.getElementById('invite-card'),
    loader: document.getElementById('invite-loader'),
    avatar: document.getElementById('invite-avatar'),
    eyebrow: document.getElementById('invite-eyebrow'),
    name: document.getElementById('invite-name'),
    sub: document.getElementById('invite-sub'),
    actions: document.getElementById('invite-actions'),
    accept: document.getElementById('invite-accept'),
    note: document.getElementById('invite-note'),
  };

  // /add/K7QM3XPA - the code is the last path segment.
  const code = (location.pathname.match(/^\/add\/([A-Za-z0-9]{8})\/?$/) || [])[1] || '';

  function reveal() {
    if (el.loader) el.loader.hidden = true;
    if (el.card) el.card.hidden = false;
  }

  function showLoading() {
    if (el.card) el.card.hidden = true;
    if (el.loader) el.loader.hidden = false;
  }

  function say(text, kind) {
    el.sub.textContent = text || '';
    el.sub.classList.toggle('is-bad', kind === 'bad');
  }

  function note(text) {
    el.note.textContent = text || '';
    el.note.hidden = !text;
  }

  /** A dead end: say why, and leave the way back as the only thing to press. */
  function dead(title, why) {
    el.name.textContent = title;
    el.eyebrow.textContent = 'Friend request';
    say(why, 'bad');
    el.actions.hidden = false;
    el.accept.hidden = true;
  }

  /**
   * The colour a picture is mostly made of.
   *
   * Not the average: averaging a photograph gives mud, because opposite hues
   * cancel. This buckets pixels by hue and picks the heaviest bucket, weighting
   * each pixel by the square of its saturation - so one vivid patch beats a
   * large dull area, which is what the eye picks out of a picture too.
   *
   * Near-black and near-white pixels are skipped: they carry no hue worth
   * having, and a photograph is mostly made of them.
   *
   * The bucket's own key is returned as the hue rather than the mean of the
   * hues in it. Hue wraps, and averaging 355 with 3 gives 179 - cyan, from two
   * reds. Six degrees of error costs a blurred glow nothing; that would.
   */
  function dominantHue(image) {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ink = canvas.getContext('2d', { willReadFrequently: true });
    if (!ink) return null;

    let pixels;
    try {
      ink.drawImage(image, 0, 0, size, size);
      pixels = ink.getImageData(0, 0, size, size).data;
    } catch (_) {
      // A picture from another origin taints the canvas. Astra's are data URLs
      // so this should not happen, but an unreadable image is not worth an
      // exception on a page somebody is being asked to trust.
      return null;
    }

    const buckets = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 128) continue;
      const hsl = toHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
      if (hsl.l < 0.12 || hsl.l > 0.93) continue;

      const key = (Math.round(hsl.h / 12) * 12) % 360;
      const found = buckets.get(key) || { weight: 0, s: 0, l: 0, n: 0 };
      found.weight += hsl.s * hsl.s;
      found.s += hsl.s;
      found.l += hsl.l;
      found.n += 1;
      buckets.set(key, found);
    }

    let hue = null;
    let best = null;
    for (const [key, bucket] of buckets) {
      if (!best || bucket.weight > best.weight) {
        best = bucket;
        hue = key;
      }
    }
    if (!best || !best.n) return null;

    const saturation = best.s / best.n;
    // A picture with no colour in it cannot lend any. Better the theme's tint
    // than a grey glow, which reads as a rendering fault rather than a choice.
    if (saturation < 0.14) return null;

    return { h: hue, s: saturation, l: best.l / best.n };
  }

  function toHsl(r, g, b) {
    const red = r / 255;
    const green = g / 255;
    const blue = b / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };

    const span = max - min;
    const s = l > 0.5 ? span / (2 - max - min) : span / (max + min);
    let h;
    if (max === red) h = ((green - blue) / span + (green < blue ? 6 : 0)) / 6;
    else if (max === green) h = ((blue - red) / span + 2) / 6;
    else h = ((red - green) / span + 4) / 6;
    return { h: h * 360, s, l };
  }

  /**
   * Light the glow with the picture's colour.
   *
   * The hue is taken as found; saturation and lightness are pulled into a band
   * that actually glows. A muddy brown avatar would otherwise give a glow you
   * cannot see, and a neon one would give a glow you cannot look at - and in
   * both cases the hue is the part that says whose page this is.
   */
  function lightGlow(image) {
    const found = dominantHue(image);
    const glow = document.querySelector('.invite-glow');
    if (!found || !glow) return;
    const saturation = Math.round(Math.min(0.88, Math.max(0.5, found.s)) * 100);
    const lightness = Math.round(Math.min(0.7, Math.max(0.52, found.l)) * 100);
    const h = Math.round(found.h);
    glow.style.setProperty('--glow-color', `hsl(${h} ${saturation}% ${lightness}% / 0.32)`);
    glow.style.setProperty('--glow-color-fade', `hsl(${h} ${saturation}% ${Math.max(0, lightness - 7)}% / 0.14)`);
  }

  /**
   * Their picture, and their banner behind it.
   *
   * The avatar is drawn the way every other avatar in Astra is - profile.js
   * owns that, including what counts as a valid picture, so a banner somebody
   * put a script tag in is never a string this page trusts.
   */
  function paint(person) {
    el.name.textContent = person.name;
    document.title = person.name + ' — astra';

    if (person.avatar && window.AstraProfile.isAvatar(person.avatar)) {
      const img = document.createElement('img');
      img.alt = '';
      // Waited for: a picture that has not decoded yet has no pixels to read,
      // and the glow keeps the theme's tint until it does.
      img.addEventListener('load', () => lightGlow(img), { once: true });
      img.src = person.avatar;
      el.avatar.textContent = '';
      el.avatar.append(img);
    } else {
      window.AstraProfile.paint(el.avatar, person.name || '', null);
    }

    if (person.banner && window.AstraProfile.isBanner(person.banner)) {
      el.wash.style.backgroundImage = 'url("' + person.banner.replace(/"/g, '%22') + '")';
      el.wash.classList.add('has-banner');
    }
  }

  /** Out of this page, behind the loader so it does not flash on the way. */
  function leave() {
    showLoading();
    setTimeout(() => location.replace('/'), 150);
  }

  const decline = document.getElementById('invite-decline');
  if (decline) {
    decline.addEventListener('click', (event) => {
      event.preventDefault();
      leave();
    });
  }

  /** Work out what to show. The page stays behind the loader until this returns. */
  async function start() {
    if (!code) {
      dead('Nothing to open', 'That link is missing its code. Ask for a new one.');
      return;
    }

    // Signed out: there is nothing to attach a friendship to yet, and sending
    // them through Discord now brings them back to this same link.
    if (!window.AstraFriends || !window.AstraFriends.available()) {
      el.name.textContent = 'Someone wants to be friends';
      say('Connect Discord to see who, and to accept.');
      el.actions.hidden = false;
      el.accept.textContent = 'Connect with Discord';
      el.accept.addEventListener('click', () => {
        // Back to this link, code and all, once Discord is done.
        window.AstraDiscord.login(location.pathname + location.search);
      });
      return;
    }

    const answer = await window.AstraFriends.linkPreview(code);
    if (!answer) {
      dead('Connection failed', 'Could not load the friend request. Check your connection and reload.');
      return;
    }
    if (answer.error || !answer.from) {
      dead('Link not found', answer.error || 'That link did not work.');
      return;
    }

    paint(answer.from);

    if (answer.mine) {
      el.eyebrow.textContent = 'Your own link';
      say('Send this to somebody else - it will not work on you.');
      el.actions.hidden = false;
      el.accept.hidden = true;
      return;
    }

    if (answer.already) {
      el.eyebrow.textContent = 'Already friends';
      say('You are already friends with ' + answer.from.name + '.');
      el.actions.hidden = false;
      el.accept.hidden = true;
      return;
    }

    say('wants to be friends on Astra.');
    el.actions.hidden = false;

    el.accept.addEventListener('click', async () => {
      el.accept.disabled = true;
      el.accept.textContent = 'Accepting…';
      const done = await window.AstraFriends.accept(code);
      if (!done || done.error) {
        el.accept.disabled = false;
        el.accept.textContent = 'Accept';
        note((done && done.error) || 'That did not work. Try again in a moment.');
        return;
      }
      leave();
    });
  }

  // The sign-in comes back through the site root, which consumes the token and
  // then sends the browser on to whatever `state` named - this page, code and
  // all. So by the time this runs there is nothing to unpack, only to draw.
  start().finally(reveal);
})();
