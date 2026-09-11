'use strict';

/**
 * Chromium parts that ship with Electron and that Astra never loads.
 *
 * Electron's Windows build carries the whole browser, including back ends for
 * things a browser might do and this app does not. Two of them are large and
 * easy to be sure about:
 *
 *   The DirectX shader compiler (dxcompiler, dxil) exists to compile shaders
 *   for WebGPU. Astra has no WebGPU in it - the picture is a video element and
 *   the interface is ordinary CSS - and Chromium only loads these when a page
 *   actually asks for a GPU adapter, so nothing ever reaches for them.
 *
 *   SwiftShader (vk_swiftshader and its Vulkan loader) is the software
 *   renderer Chromium falls back to when a machine's GPU is unusable. It is
 *   not the only fallback: below it is plain software compositing, which is
 *   what a window with no GPU at all ends up using. Verified by running the
 *   packaged app with --disable-gpu and these files deleted - the room renders
 *   and even reports WebGL.
 *
 * Everything else that is big has to stay. Astra.exe is Chromium itself,
 * icudtl.dat and the .pak files are its data, and LICENSES.chromium.html is
 * the licence text Chromium's terms require us to hand on.
 *
 * Deleting at pack time rather than filtering: these are Electron's own files,
 * not the app's, so `files` in package.json never sees them.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const UNUSED = [
  'dxcompiler.dll',
  'dxil.dll',
  'vk_swiftshader.dll',
  'vulkan-1.dll',
  'vk_swiftshader_icd.json',
];

exports.default = async function afterPack(context) {
  // The others are packed on their own platforms, where these names differ.
  if (context.electronPlatformName !== 'win32') return;

  let freed = 0;
  const gone = [];
  for (const name of UNUSED) {
    const file = path.join(context.appOutDir, name);
    try {
      const { size } = await fs.stat(file);
      await fs.rm(file);
      freed += size;
      gone.push(name);
    } catch (_) {
      // A future Electron that no longer ships it. Nothing to do.
    }
  }

  // Said out loud so a build that silently stops saving anything is visible.
  console.log(
    `  • trimmed unused Chromium back ends  freed=${(freed / 1048576).toFixed(1)}MB`
    + `  files=${gone.length}/${UNUSED.length}`,
  );
};
