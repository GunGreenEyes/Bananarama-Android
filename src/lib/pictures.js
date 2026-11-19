'use strict';
// Where images go on Android: the shared Pictures folder, so they show up in the
// Gallery. In Termux that is ~/storage/pictures after `termux-setup-storage`,
// which points at /storage/emulated/0/Pictures. Elsewhere (tests, a PC) it is
// ~/Pictures.
const fs = require('fs');
const os = require('os');
const path = require('path');

function candidates(home = os.homedir()) {
  return [
    path.join(home, 'storage', 'pictures'),   // Termux symlink
    '/storage/emulated/0/Pictures',           // primary shared storage
    '/sdcard/Pictures',
    path.join(home, 'Pictures')
  ];
}

function resolvePictures(home = os.homedir(), exists = fs.existsSync) {
  const list = candidates(home);
  return list.find(c => exists(c)) || list[list.length - 1];
}

/** True when shared storage is reachable (termux-setup-storage has been run). */
function hasSharedStorage(home = os.homedir(), exists = fs.existsSync) {
  return candidates(home).slice(0, 3).some(c => exists(c));
}

module.exports = { resolvePictures, hasSharedStorage, candidates };

if (require.main === module) console.log(resolvePictures());
