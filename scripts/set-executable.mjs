#!/usr/bin/env node
import { chmodSync } from 'node:fs';

// npm sets executable bits for bin entries on install, but a direct repository build
// should also be runnable through a symlink or a relative path.
if (process.platform !== 'win32') {
  chmodSync(new URL('../dist/index.js', import.meta.url), 0o755);
}
