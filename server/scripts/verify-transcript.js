#!/usr/bin/env node
// Verify a session transcript written with PMGT_TRANSCRIPT (see src/transcript.js).
//   node scripts/verify-transcript.js <session.jsonl>
// Prints entry, tool and error counts plus the chain head. Exit 0 only if the chain holds.
import { verifyTranscript } from '../src/transcript.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/verify-transcript.js <session.jsonl>');
  process.exit(2);
}
try {
  const v = verifyTranscript(file);
  console.log(JSON.stringify(v, null, 2));
  process.exit(v.ok ? 0 : 1);
} catch (e) {
  console.error(`cannot verify ${file}: ${e.message}`);
  process.exit(2);
}
