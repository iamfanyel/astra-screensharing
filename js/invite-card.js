'use strict';

/**
 * Your friend link, as a card with a code on it.
 *
 * The same panel is raised from the profile editor on both pages - the lobby
 * and a room - so it lives here rather than twice over. A page hands in the
 * few elements it drew and a way to ask what picture and banner the editor is
 * currently showing, since a card opened mid-edit should show the picture
 * being chosen rather than the one last saved.
 *
 * Everything it needs beyond that comes from AstraFriends (the link itself)
 * and the qrcode-generator script the page loads.
 */
window.AstraInviteCard = (function () {
  /** The picture in the middle, as a share of the code's width. */
  const FACE_SHARE = 0.42;
  const UNAVAILABLE = 'Code unavailable - copy the link instead.';

  /**
   * @param {object} parts
   *   panel, banner, code, copy - the elements the page drew.
   *   art     - the plain banner to fall back on, relative to that page.
   *   subject - () => ({ avatar, banner }), what the editor is showing now.
   */
  function mount(parts) {
    const subject = parts.subject || (() => ({}));
    let link = null;
    let drawnFor = null;
    let pending = false;

    /** A card is a friends feature, so it needs the sign-in friends need. */
    function canShow() {
      return !!(parts.panel && window.AstraFriends && window.AstraFriends.available());
    }

    function unavailable(box) {
      box.classList.add('is-empty');
      box.textContent = UNAVAILABLE;
    }

    /**
     * Draw the code.
     *
     * High error correction ('H') is what allows the picture in the middle:
     * the code still reads with that much of it covered.
     */
    function drawCode(url) {
      const box = parts.code;
      if (!box) return;
      box.textContent = '';
      box.classList.remove('is-empty');

      if (typeof qrcode !== 'function') return unavailable(box);

      let grid;
      try {
        grid = qrcode(0, 'H');
        grid.addData(url);
        grid.make();
      } catch (_) {
        return unavailable(box);
      }

      const modules = grid.getModuleCount();
      const scale = Math.max(3, Math.floor((220 * (window.devicePixelRatio || 1)) / modules));
      const canvas = document.createElement('canvas');
      canvas.width = modules * scale;
      canvas.height = modules * scale;
      const ink = canvas.getContext('2d');
      ink.fillStyle = '#ffffff';
      ink.fillRect(0, 0, canvas.width, canvas.height);
      ink.fillStyle = '#000000';
      for (let row = 0; row < modules; row++) {
        for (let col = 0; col < modules; col++) {
          if (grid.isDark(row, col)) ink.fillRect(col * scale, row * scale, scale, scale);
        }
      }

      const size = Math.floor(canvas.width * FACE_SHARE);
      const cx = Math.floor(canvas.width / 2);
      const cy = Math.floor(canvas.height / 2);
      const half = Math.floor(size / 2);

      // A white ring around it, so the picture reads as covering the code
      // rather than as part of it.
      function drawFace(picture) {
        const pad = Math.max(3, Math.floor(scale * 0.65));
        ink.save();
        ink.beginPath();
        ink.arc(cx, cy, half + pad, 0, Math.PI * 2);
        ink.fillStyle = '#ffffff';
        ink.fill();
        ink.beginPath();
        ink.arc(cx, cy, half, 0, Math.PI * 2);
        ink.clip();
        if (picture) {
          ink.drawImage(picture, cx - half, cy - half, size, size);
          ink.restore();
          return;
        }
        const name = (window.AstraProfile.getName() || 'Guest').trim();
        window.AstraProfile.drawMark(ink, name, cx, cy, half).then(() => ink.restore());
      }

      const avatar = subject().avatar || window.AstraProfile.getAvatar();
      if (avatar && window.AstraProfile.isAvatar(avatar)) {
        const picture = new Image();
        picture.crossOrigin = 'anonymous';
        picture.onload = () => drawFace(picture);
        picture.onerror = () => drawFace(null);
        picture.src = avatar;
      } else {
        drawFace(null);
      }

      box.append(canvas);
    }

    /** Their own banner behind the card, or the plain art. */
    function paintBanner() {
      if (!parts.banner) return;
      const chosen = subject().banner;
      let banner = chosen || window.AstraProfile.getBanner();
      // A Discord banner is a URL rather than one of ours, and only stands in
      // while the editor is showing the saved picture.
      if (window.AstraDiscord && typeof window.AstraDiscord.getUser === 'function') {
        const user = window.AstraDiscord.getUser();
        if (user && user.bannerCdnUrl && (!chosen || chosen === window.AstraProfile.getBanner())) {
          banner = user.bannerCdnUrl.replace('size=600', 'size=1024');
        }
      }
      const usable = banner && (window.AstraProfile.isBanner(banner) || banner.startsWith('http'));
      parts.banner.style.backgroundImage = 'url("'
        + (usable ? banner.replace(/"/g, '%22') : parts.art)
        + '")';
    }

    /**
     * Raise the card, asking for the link the first time and keeping it after
     * that: it is one code per person and it does not go stale.
     */
    async function open() {
      const panel = parts.panel;
      if (!panel) return;
      if (!canShow()) {
        panel.hidden = true;
        return;
      }

      panel.hidden = false;
      paintBanner();

      // Already drawn: only the picture in the middle can have changed.
      if (link && parts.code && parts.code.querySelector('canvas')) {
        const avatar = subject().avatar || window.AstraProfile.getAvatar();
        if (drawnFor !== avatar) {
          drawnFor = avatar;
          drawCode(link);
        }
        return;
      }

      if (parts.code && !parts.code.querySelector('canvas')) {
        parts.code.classList.remove('is-empty');
        parts.code.innerHTML = '<div class="profile-invite-spinner" aria-label="Loading"></div>';
      }

      if (pending) return;
      pending = true;
      const answer = await window.AstraFriends.inviteLink();
      pending = false;

      // Closed again while we were waiting: nothing to draw into.
      if (panel.hidden) return;

      if (!answer) {
        link = null;
        if (parts.code) {
          parts.code.classList.add('is-empty');
          parts.code.textContent = 'Could not create link. Try again.';
        }
        return;
      }

      link = answer;
      drawnFor = subject().avatar || window.AstraProfile.getAvatar();
      drawCode(link);
    }

    function close() {
      if (parts.panel) parts.panel.hidden = true;
    }

    // Copying it, with the button saying so for a moment afterwards.
    if (parts.copy) {
      const copyIcon = parts.copy.innerHTML;
      const doneIcon =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" '
        + 'stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>';
      let saying = null;

      parts.copy.addEventListener('click', async () => {
        if (!link) return;
        try {
          await navigator.clipboard.writeText(link);
        } catch (_) {
          return;
        }
        parts.copy.classList.add('is-copied');
        parts.copy.setAttribute('title', 'Copied!');
        parts.copy.innerHTML = doneIcon;
        clearTimeout(saying);
        saying = setTimeout(() => {
          parts.copy.classList.remove('is-copied');
          parts.copy.setAttribute('title', 'Copy link');
          parts.copy.innerHTML = copyIcon;
        }, 1500);
      });
    }

    return { canShow, open, close };
  }

  return { mount };
})();
