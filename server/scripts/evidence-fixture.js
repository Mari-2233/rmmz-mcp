#!/usr/bin/env node
// Export a synthetic, explicitly marked contract fixture. This command never
// connects to Pocket Mirror and cannot produce live_execution evidence.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  BASE_REVISION,
  buildPositiveEnvelope,
  canonicalStringify,
  sha256Raw,
} from '../src/evidence.js';

function usage(message) {
  if (message) console.error(`evidence-fixture: ${message}`);
  console.error('Usage: node scripts/evidence-fixture.js [--revision COMMIT] [--checker-file PATH] [--output PATH]');
  process.exitCode = 1;
}

let revision = BASE_REVISION;
let checkerArtifactSha256;
let output;
for (let i = 2; i < process.argv.length; i += 1) {
  const flag = process.argv[i];
  if (!['--revision', '--checker-file', '--output'].includes(flag)) {
    usage(`unknown argument ${flag}`);
  } else if (i + 1 >= process.argv.length) {
    usage(`${flag} requires a value`);
  } else {
    const value = process.argv[++i];
    if (flag === '--revision') revision = value;
    if (flag === '--checker-file') checkerArtifactSha256 = sha256Raw(readFileUtf8(value));
    if (flag === '--output') output = value;
  }
}
function readFileUtf8(path) {
  return readFileSync(path, 'utf8');
}
if (process.exitCode) {
  // usage already reported the error
} else {
  try {
    const envelope = buildPositiveEnvelope({ revision, checkerArtifactSha256 });
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    if (output) writeFileSync(output, serialized, { encoding: 'utf8', flag: 'wx' });
    else process.stdout.write(serialized);
  } catch (error) {
    console.error(`evidence-fixture: ${error.message}`);
    process.exitCode = 1;
  }
}
