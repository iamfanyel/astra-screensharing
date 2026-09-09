'use strict';

/**
 * What the app does to the page it loads.
 *
 * The page is the same one a browser gets. Everything that makes the desktop
 * build different - the source picker, the system audio mix - happens in the
 * main process, behind the ordinary getDisplayMedia call, and the site needs
 * to know nothing about it. What is left is the presentation the web app
 * cannot do for itself: telling the stylesheet it is in a window with no
 * frame, and keeping the system's own buttons in step with the theme.
 *
 * Nothing is exposed to the page. It has no use for any of this.
 */

const { ipcRenderer } = require('electron');

/**
 * Keep the system's window buttons in the app's colours.
 *
 * Windows paints minimise/maximise/close itself, over the strip the page
 * draws, and it has to be told what colour to use. Astra has three themes and
 * a hue slider, so that answer changes while the app is open - and a hardcoded
 * one looks broken the moment somebody picks the light theme. Reading it back
 * off the strip means the two can never disagree, and the web app does not
 * have to know this window exists.
 */
function reportTitlebarColors() {
  const bar = document.querySelector('.titlebar');
  if (!bar) return;
  const label = bar.firstElementChild || bar;
  ipcRenderer.send('astra:titlebar-colors', {
    color: hex(getComputedStyle(bar).backgroundColor),
    symbolColor: hex(getComputedStyle(label).color),
  });
}

/** setTitleBarOverlay wants #rrggbb; getComputedStyle gives rgb(r, g, b). */
function hex(value) {
  const parts = String(value).match(/\d+/g);
  if (!parts || parts.length < 3) return null;
  return '#' + parts.slice(0, 3)
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Sit the wordmark on the mark's centre line rather than on its own.
 *
 * "astra" has no descenders, so its ink sits high inside a line box that still
 * reserves room for them, and centring that box leaves the word looking low
 * beside the logo. How far off depends entirely on the font's metrics - the
 * brand face has a notably tall ascent and the fallbacks do not, so the same
 * hardcoded nudge would be right on one machine and wrong on the next. Measure
 * the face that actually loaded and move the word by exactly that much.
 */
function alignWordmark() {
  const bar = document.querySelector('.titlebar');
  // No height means the stylesheet is not in effect yet, and every measurement
  // taken now would be of the wrong font at the wrong size.
  if (!bar || !bar.getBoundingClientRect().height) return false;
  const span = bar.querySelector('span');
  if (!span || !span.textContent.trim()) return false;

  const style = getComputedStyle(span);
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
  const m = ctx.measureText(span.textContent);
  if (!m.fontBoundingBoxAscent) return true; // Unsupported: leave it where it is.

  // Where the box centres, against where the ink actually is.
  const boxMiddle = (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
  const inkMiddle = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  span.style.transform = 'translateY(' + (inkMiddle - boxMiddle).toFixed(2) + 'px)';
  return true;
}

/**
 * Align it as soon as it exists, rather than once the document is complete.
 *
 * The strip is painted while the page is still parsing, so measuring at
 * DOMContentLoaded meant the word appeared at its natural position and then
 * stepped by a couple of pixels on every navigation. The strip is the first
 * thing in the body, so this finds it almost immediately and stops watching.
 */
function alignWordmarkAsap() {
  if (alignWordmark()) return;
  // Whichever of the two gets there first disarms the other.
  const observer = new MutationObserver(align);
  function align() {
    if (!alignWordmark()) return;
    observer.disconnect();
    document.removeEventListener('DOMContentLoaded', align);
  }
  observer.observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', align);
}

/** Everything that needs the strip to exist, and so everything that needs a body. */
function dressTitlebar() {
  reportTitlebarColors();
  // Already aligned by now in the ordinary case; this is for a face that only
  // finishes loading later, and is a no-op when the answer has not changed.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(alignWordmark);
  // The theme lands as an attribute on the root, and the hue as an inline
  // custom property on the same element.
  new MutationObserver(reportTitlebarColors).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'style', 'class'],
  });
}

function markDesktop() {
  document.documentElement.classList.add('is-desktop-app');
}

/**
 * Mark the page the instant there is a page to mark.
 *
 * A sandboxed preload runs before <html> exists - measured, not assumed: every
 * navigation reports documentElement as null at this point, which is why
 * reaching for it directly throws and takes the rest of this file with it.
 *
 * Waiting for DOMContentLoaded instead is correct but far too late: the page
 * parses, lays out and paints its browser layout first, then drops by the
 * height of the title bar when the class finally lands. Watching the document
 * catches <html> as the parser inserts it, which is before anything is drawn.
 */
function markDesktopAsap() {
  if (document.documentElement) {
    markDesktop();
    return;
  }
  // Whichever of the two gets there first disarms the other.
  const observer = new MutationObserver(mark);
  function mark() {
    if (!document.documentElement) return;
    observer.disconnect();
    document.removeEventListener('DOMContentLoaded', mark);
    markDesktop();
  }
  observer.observe(document, { childList: true });
  // A net, in case the element ever arrives without a mutation we are watching.
  document.addEventListener('DOMContentLoaded', mark);
}

markDesktopAsap();
alignWordmarkAsap();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', dressTitlebar, { once: true });
} else {
  dressTitlebar();
}
