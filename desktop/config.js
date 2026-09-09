'use strict';

/**
 * Where the desktop app points.
 *
 * The window loads the deployed site rather than a copy bundled inside the
 * app. Astra is worthless offline anyway - it needs the signalling broker and
 * the other person - and loading the real origin means the Discord redirect
 * and the /api routes keep working exactly as they do in a browser, with no
 * second set of registered URLs to maintain. Shipping a fix is still a deploy,
 * not a release.
 *
 * ASTRA_URL overrides it, which is how you point a dev build at the local
 * server: `ASTRA_URL=http://localhost:3000 npm start`.
 */
const APP_URL = process.env.ASTRA_URL || 'https://astrascreen.live';

module.exports = { APP_URL };
