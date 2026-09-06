'use strict';

/**
 * Your profile: a name and an optional picture, kept in this browser alone.
 *
 * There is no account and no server to hold a picture, so it travels to the
 * room over the same data channel as everything else. That means it has to be
 * small: pictures are cropped square, scaled to 96px and stored as a data URL
 * under a hard size cap.
 */
(function () {
  const NAME_KEY = 'astra:name';
  const AVATAR_KEY = 'astra:avatar';
  const SIZE = 96;
  const PREVIEW = 240; // the editor canvas, in CSS pixels
  const MAX_LENGTH = 30000; // data URL characters, so roughly 22KB of image

  function getName() {
    try {
      return localStorage.getItem(NAME_KEY) || '';
    } catch (_) {
      return '';
    }
  }

  function setName(name) {
    const clean = String(name || '').trim().slice(0, 32);
    try {
      if (clean) localStorage.setItem(NAME_KEY, clean);
      else localStorage.removeItem(NAME_KEY);
    } catch (_) {
      /* private mode - it just will not persist */
    }
    if (window.AstraDiscord && window.AstraDiscord.syncName) {
      window.AstraDiscord.syncName(clean);
    }
    return clean;
  }

  function getAvatar() {
    try {
      const stored = localStorage.getItem(AVATAR_KEY);
      return isAvatar(stored) ? stored : null;
    } catch (_) {
      return null;
    }
  }

  function setAvatar(dataUrl) {
    try {
      if (dataUrl) localStorage.setItem(AVATAR_KEY, dataUrl);
      else localStorage.removeItem(AVATAR_KEY);
    } catch (_) {
      /* out of quota or private mode */
    }
    return dataUrl || null;
  }

  /**
   * Pictures arrive from other people's browsers, so treat them as untrusted:
   * only base64 image data URLs, and only small ones.
   */
  function isAvatar(value) {
    return (
      typeof value === 'string' &&
      value.length <= MAX_LENGTH &&
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)
    );
  }

  const BANNER_KEY = 'astra:banner';
  const BANNER_WIDTH = 480;
  const BANNER_HEIGHT = 160;
  const BANNER_PREVIEW_W = 300;
  const BANNER_PREVIEW_H = 100;
  const BANNER_MAX_LENGTH = 45000;

  function getBanner() {
    try {
      const stored = localStorage.getItem(BANNER_KEY);
      return isBanner(stored) ? stored : null;
    } catch (_) {
      return null;
    }
  }

  function setBanner(dataUrl) {
    try {
      if (dataUrl) localStorage.setItem(BANNER_KEY, dataUrl);
      else localStorage.removeItem(BANNER_KEY);
    } catch (_) {}
    if (window.AstraDiscord && window.AstraDiscord.syncBanner) {
      window.AstraDiscord.syncBanner(dataUrl || null);
    }
    return dataUrl || null;
  }

  function isBanner(value) {
    return (
      typeof value === 'string' &&
      value.length <= BANNER_MAX_LENGTH &&
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)
    );
  }

  /**
   * The smallest scale at which the picture still covers the frame at this
   * rotation.
   *
   * A picture that only just covered square-on pulls its corners inside the
   * frame as soon as it is turned, and then no offset can hide the gap. Growing
   * the cover scale with the turn keeps zoom 1 meaning "just covers", whichever
   * way round the picture is - the same rule crop tools use.
   */
  function coverScale(pictureW, pictureH, frameW, frameH, rotation) {
    const radians = (rotation * Math.PI) / 180;
    const cos = Math.abs(Math.cos(radians));
    const sin = Math.abs(Math.sin(radians));
    return Math.max(
      (cos * frameW + sin * frameH) / pictureW,
      (sin * frameW + cos * frameH) / pictureH
    );
  }

  /**
   * Hold the picture over the whole frame, so dragging can never expose the
   * backdrop behind it.
   *
   * Written in the picture's own turned frame, every corner of the frame has
   * to land inside the picture. Solving that pair of inequalities gives one
   * bound per axis. When no offset can cover - a diagonal turn on a picture
   * that only just fitted square-on - the bound collapses to zero and the
   * picture pins to the middle, which is the best position on offer.
   *
   * Sizes are in preview pixels, the same units as `view.x` / `view.y`.
   */
  function clampOffset(view, pictureW, pictureH, frameW, frameH) {
    const radians = (view.rotation * Math.PI) / 180;
    const cos = Math.abs(Math.cos(radians));
    const sin = Math.abs(Math.sin(radians));
    const fw = frameW / 2;
    const fh = frameH / 2;
    const pw = pictureW / 2;
    const ph = pictureH / 2;
    // At a quarter turn one of the two terms drops out; guard the divisions.
    const FLAT = 1e-6;

    const maxX = (absY) => {
      let limit = Infinity;
      if (cos > FLAT) limit = Math.min(limit, (pw - sin * (fh + absY)) / cos - fw);
      if (sin > FLAT) limit = Math.min(limit, (ph - cos * (fh + absY)) / sin - fw);
      return Math.max(0, limit);
    };
    const maxY = (absX) => {
      let limit = Infinity;
      if (sin > FLAT) limit = Math.min(limit, (pw - cos * (fw + absX)) / sin - fh);
      if (cos > FLAT) limit = Math.min(limit, (ph - sin * (fw + absX)) / cos - fh);
      return Math.max(0, limit);
    };

    const pin = (value, max) => Math.max(-max, Math.min(max, value));
    view.x = pin(view.x, maxX(Math.abs(view.y)));
    view.y = pin(view.y, maxY(Math.abs(view.x)));
  }

  /**
   * Open the adjust dialog for a chosen file. Resolves with a data URL, or
   * null if the person backed out.
   */
  async function edit(file) {
    if (!file || !/^image\//.test(file.type)) throw new Error('That file is not an image.');
    const bitmap = await createImageBitmap(file);

    const view = { zoom: 1, rotation: 0, x: 0, y: 0 };
    // Zoom 1 means "just covers", recomputed as the picture turns.
    const baseScale = () =>
      coverScale(bitmap.width, bitmap.height, PREVIEW, PREVIEW, view.rotation);

    const ui = buildEditor();
    const ctx = ui.canvas.getContext('2d');

    function draw(target, size) {
      const k = size / PREVIEW;
      target.clearRect(0, 0, size, size);
      target.fillStyle = '#161616';
      target.fillRect(0, 0, size, size);
      target.save();
      target.translate(size / 2 + view.x * k, size / 2 + view.y * k);
      target.rotate((view.rotation * Math.PI) / 180);
      const scale = baseScale() * view.zoom * k;
      const w = bitmap.width * scale;
      const h = bitmap.height * scale;
      target.drawImage(bitmap, -w / 2, -h / 2, w, h);
      target.restore();
    }

    /** Re-pin the picture, then repaint. Every control goes through here. */
    const render = () => {
      const scale = baseScale() * view.zoom;
      clampOffset(view, bitmap.width * scale, bitmap.height * scale, PREVIEW, PREVIEW);
      draw(ctx, PREVIEW);
    };
    render();

    return new Promise((resolve) => {
      const close = (value) => {
        document.removeEventListener('keydown', onKey);
        ui.root.remove();
        if (bitmap.close) bitmap.close();
        resolve(value);
      };

      const onKey = (event) => {
        if (event.key === 'Escape') close(null);
      };
      document.addEventListener('keydown', onKey);

      ui.zoom.addEventListener('input', () => {
        view.zoom = Number(ui.zoom.value);
        render();
      });

      ui.rotation.addEventListener('input', () => {
        view.rotation = Number(ui.rotation.value);
        render();
      });

      ui.reset.addEventListener('click', () => {
        view.zoom = 1;
        view.rotation = 0;
        view.x = 0;
        view.y = 0;
        ui.zoom.value = '1';
        ui.rotation.value = '0';
        render();
      });

      // Drag the picture around inside the circle.
      ui.canvas.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const startX = event.clientX - view.x;
        const startY = event.clientY - view.y;
        const move = (e) => {
          view.x = e.clientX - startX;
          view.y = e.clientY - startY;
          render();
        };
        const up = () => {
          ui.canvas.removeEventListener('pointermove', move);
          ui.canvas.removeEventListener('pointerup', up);
          ui.canvas.removeEventListener('pointercancel', up);
        };
        try {
          ui.canvas.setPointerCapture(event.pointerId);
        } catch (_) {
          /* capture is only an optimisation */
        }
        ui.canvas.addEventListener('pointermove', move);
        ui.canvas.addEventListener('pointerup', up);
        ui.canvas.addEventListener('pointercancel', up);
      });

      ui.cancel.addEventListener('click', () => close(null));
      ui.root.addEventListener('click', (event) => {
        if (event.target === ui.root) close(null);
      });

      ui.save.addEventListener('click', () => {
        const out = document.createElement('canvas');
        out.width = SIZE;
        out.height = SIZE;
        draw(out.getContext('2d'), SIZE);
        const url = encode(out);
        if (url) return close(url);
        ui.error.textContent = 'That picture will not compress small enough. Try another one.';
        ui.error.hidden = false;
      });
    });
  }

  /**
   * Encode a square canvas as the largest JPEG that still fits the payload cap,
   * or null if even the lowest quality is too big. The cap matters because the
   * result travels to the room over a data channel.
   */
  function encode(canvas) {
    for (const quality of [0.82, 0.7, 0.55, 0.4]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= MAX_LENGTH) return url;
    }
    return null;
  }

  function buildEditor() {
    const root = document.createElement('div');
    root.className = 'editor';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Adjust your picture');
    root.innerHTML =
      '<div class="editor-card">' +
      '<h2>Adjust your picture</h2>' +
      '<div class="editor-stage">' +
      '<canvas width="' + PREVIEW + '" height="' + PREVIEW + '"></canvas>' +
      '<div class="editor-mask"></div>' +
      '</div>' +
      '<label class="menu-row"><span>Size</span>' +
      '<input class="editor-zoom" type="range" min="1" max="4" step="0.01" value="1" /></label>' +
      '<label class="menu-row"><span>Rotation</span>' +
      '<input class="editor-rotation" type="range" min="-180" max="180" step="1" value="0" /></label>' +
      '<div class="editor-actions">' +
      '<button type="button" class="btn btn-small editor-reset">Reset</button>' +
      '<span class="editor-spacer"></span>' +
      '<button type="button" class="btn btn-small editor-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-small btn-primary editor-save">Save</button>' +
      '</div>' +
      '<p class="error editor-error" role="alert" hidden></p>' +
      '</div>';

    document.body.appendChild(root);
    return {
      root,
      canvas: root.querySelector('canvas'),
      zoom: root.querySelector('.editor-zoom'),
      rotation: root.querySelector('.editor-rotation'),
      reset: root.querySelector('.editor-reset'),
      cancel: root.querySelector('.editor-cancel'),
      save: root.querySelector('.editor-save'),
      error: root.querySelector('.editor-error'),
    };
  }

  /**
   * Wire up a name field and its avatar picker. Both the landing page and the
   * room's join gate show this same widget; they differ only in what they do
   * once the picture changes, which is what `onChange` is for.
   *
   * Returns { repaint, open } so callers can refresh it or trigger the file
   * dialog from elsewhere.
   */
  function mountPicker(options) {
    const nameInput = options.nameInput;
    const avatarEl = options.avatarEl;
    const fileInput = options.fileInput;
    const onChange = options.onChange || function () {};
    const onError = options.onError || function () {};

    function repaint() {
      const avatar = getAvatar();
      paint(avatarEl, (nameInput && nameInput.value) || 'Guest', avatar);
      if (options.clearBtn) options.clearBtn.hidden = !avatar;
    }

    function apply(dataUrl) {
      setAvatar(dataUrl);
      // A picture chosen by hand outranks the one Discord imported.
      if (window.AstraDiscord && window.AstraDiscord.saveAccountAvatar) {
        window.AstraDiscord.saveAccountAvatar(dataUrl);
      }
      repaint();
      onChange(dataUrl);
    }

    // While there is no picture the avatar shows an initial, so track the name.
    if (nameInput) nameInput.addEventListener('input', repaint);
    if (options.changeBtn) options.changeBtn.addEventListener('click', () => fileInput.click());
    if (options.clearBtn) options.clearBtn.addEventListener('click', () => apply(null));

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = ''; // so picking the same file twice still fires
      if (!file) return;
      try {
        const picture = await edit(file);
        if (picture) apply(picture);
      } catch (err) {
        console.error(err);
        onError(err.message || 'Could not read that picture.');
      }
    });

    repaint();
    return { repaint, open: () => fileInput.click() };
  }

  /**
   * A stable shade per name, so people without a picture stay recognisable.
   * Only the lightness comes from the name - the hue is the app tint, so these
   * follow the theme like every other grey.
   */
  function tint(name) {
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    const light = 38 + (hash % 26);
    return (
      'linear-gradient(135deg, hsl(var(--tint-h) var(--tint-s) ' + light + '%),' +
      ' hsl(var(--tint-h) var(--tint-s) ' + (light - 14) + '%))'
    );
  }

  /**
   * Render a picture, or fall back to the initial.
   *
   * The people list repaints on every roster event, so bail out when nothing
   * changed - re-validating a 30KB data URL and rebuilding an <img> for an
   * identical picture is pure waste.
   */
  function paint(element, name, avatar) {
    const paintedName = String(name || '');
    const paintedAvatar = avatar || '';
    if (element.__astraName === paintedName && element.__astraAvatar === paintedAvatar) return;
    element.__astraName = paintedName;
    element.__astraAvatar = paintedAvatar;

    element.textContent = '';
    if (isAvatar(avatar)) {
      const img = document.createElement('img');
      img.src = avatar;
      img.alt = '';
      element.style.background = 'none';
      element.appendChild(img);
      return;
    }
    element.style.background = tint(String(name || ''));
    element.textContent = (String(name || '').trim()[0] || '?').toUpperCase();
  }

  function tintBanner(seed) {
    let hash = 0;
    for (const char of String(seed || '')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    const h1 = hash % 360;
    const h2 = (h1 + 45) % 360;
    return 'linear-gradient(135deg, hsl(' + h1 + ' 35% 24%), hsl(' + h2 + ' 45% 14%))';
  }

  function paintBanner(element, banner, fallbackSeed) {
    if (!element) return;
    const painted = banner || '';
    const seed = fallbackSeed || '';
    if (element.__astraBanner === painted && element.__astraBannerSeed === seed) return;
    element.__astraBanner = painted;
    element.__astraBannerSeed = seed;

    if (isBanner(banner)) {
      element.style.backgroundImage = 'url(' + banner + ')';
      element.style.backgroundSize = 'cover';
      element.style.backgroundPosition = 'center';
      element.classList.add('has-image');
    } else {
      element.style.backgroundImage = '';
      element.style.background = tintBanner(fallbackSeed);
      element.classList.remove('has-image');
    }
  }

  function encodeBanner(canvas) {
    for (const quality of [0.82, 0.72, 0.58, 0.45, 0.35]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= BANNER_MAX_LENGTH) return url;
    }
    return null;
  }

  function buildBannerEditor() {
    const root = document.createElement('div');
    root.className = 'editor banner-editor-modal';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Adjust your banner');
    root.innerHTML =
      '<div class="editor-card banner-editor-card">' +
      '<h2>Adjust your banner</h2>' +
      '<div class="editor-stage banner-stage">' +
      '<canvas width="' + BANNER_PREVIEW_W + '" height="' + BANNER_PREVIEW_H + '"></canvas>' +
      '<div class="banner-editor-mask"></div>' +
      '</div>' +
      '<label class="menu-row"><span>Size</span>' +
      '<input class="editor-zoom" type="range" min="1" max="4" step="0.01" value="1" /></label>' +
      '<label class="menu-row"><span>Rotation</span>' +
      '<input class="editor-rotation" type="range" min="-180" max="180" step="1" value="0" /></label>' +
      '<div class="editor-actions">' +
      '<button type="button" class="btn btn-small editor-reset">Reset</button>' +
      '<span class="editor-spacer"></span>' +
      '<button type="button" class="btn btn-small editor-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-small btn-primary editor-save">Save</button>' +
      '</div>' +
      '<p class="error editor-error" role="alert" hidden></p>' +
      '</div>';

    document.body.appendChild(root);
    return {
      root,
      canvas: root.querySelector('canvas'),
      zoom: root.querySelector('.editor-zoom'),
      rotation: root.querySelector('.editor-rotation'),
      reset: root.querySelector('.editor-reset'),
      cancel: root.querySelector('.editor-cancel'),
      save: root.querySelector('.editor-save'),
      error: root.querySelector('.editor-error'),
    };
  }

  async function editBanner(file) {
    if (!file || !/^image\//.test(file.type)) throw new Error('That file is not an image.');
    const bitmap = await createImageBitmap(file);

    const view = { zoom: 1, rotation: 0, x: 0, y: 0 };
    const baseScale = () =>
      coverScale(bitmap.width, bitmap.height, BANNER_PREVIEW_W, BANNER_PREVIEW_H, view.rotation);

    const ui = buildBannerEditor();
    const ctx = ui.canvas.getContext('2d');

    function draw(target, w, h) {
      const kw = w / BANNER_PREVIEW_W;
      const kh = h / BANNER_PREVIEW_H;
      target.clearRect(0, 0, w, h);
      target.fillStyle = '#161616';
      target.fillRect(0, 0, w, h);
      target.save();
      target.translate(w / 2 + view.x * kw, h / 2 + view.y * kh);
      target.rotate((view.rotation * Math.PI) / 180);
      const scale = baseScale() * view.zoom * kw;
      const bw = bitmap.width * scale;
      const bh = bitmap.height * scale;
      target.drawImage(bitmap, -bw / 2, -bh / 2, bw, bh);
      target.restore();
    }

    const render = () => {
      const scale = baseScale() * view.zoom;
      clampOffset(view, bitmap.width * scale, bitmap.height * scale,
                  BANNER_PREVIEW_W, BANNER_PREVIEW_H);
      draw(ctx, BANNER_PREVIEW_W, BANNER_PREVIEW_H);
    };
    render();

    return new Promise((resolve) => {
      const close = (value) => {
        document.removeEventListener('keydown', onKey);
        ui.root.remove();
        if (bitmap.close) bitmap.close();
        resolve(value);
      };

      const onKey = (event) => {
        if (event.key === 'Escape') close(null);
      };
      document.addEventListener('keydown', onKey);

      ui.zoom.addEventListener('input', () => {
        view.zoom = Number(ui.zoom.value);
        render();
      });

      ui.rotation.addEventListener('input', () => {
        view.rotation = Number(ui.rotation.value);
        render();
      });

      ui.reset.addEventListener('click', () => {
        view.zoom = 1;
        view.rotation = 0;
        view.x = 0;
        view.y = 0;
        ui.zoom.value = '1';
        ui.rotation.value = '0';
        render();
      });

      ui.canvas.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const startX = event.clientX - view.x;
        const startY = event.clientY - view.y;
        const move = (e) => {
          view.x = e.clientX - startX;
          view.y = e.clientY - startY;
          render();
        };
        const up = () => {
          ui.canvas.removeEventListener('pointermove', move);
          ui.canvas.removeEventListener('pointerup', up);
          ui.canvas.removeEventListener('pointercancel', up);
        };
        try {
          ui.canvas.setPointerCapture(event.pointerId);
        } catch (_) {}
        ui.canvas.addEventListener('pointermove', move);
        ui.canvas.addEventListener('pointerup', up);
        ui.canvas.addEventListener('pointercancel', up);
      });

      ui.cancel.addEventListener('click', () => close(null));
      ui.root.addEventListener('click', (event) => {
        if (event.target === ui.root) close(null);
      });

      ui.save.addEventListener('click', () => {
        const out = document.createElement('canvas');
        out.width = BANNER_WIDTH;
        out.height = BANNER_HEIGHT;
        draw(out.getContext('2d'), BANNER_WIDTH, BANNER_HEIGHT);
        const url = encodeBanner(out);
        if (url) return close(url);
        ui.error.textContent = 'That banner will not compress small enough. Try another one.';
        ui.error.hidden = false;
      });
    });
  }

  window.AstraProfile = {
    getName,
    setName,
    getAvatar,
    setAvatar,
    isAvatar,
    getBanner,
    setBanner,
    isBanner,
    edit,
    editBanner,
    encode,
    encodeBanner,
    paint,
    paintBanner,
    mountPicker,
    SIZE,
    MAX_LENGTH,
    BANNER_WIDTH,
    BANNER_HEIGHT,
    BANNER_MAX_LENGTH,
  };
})();
