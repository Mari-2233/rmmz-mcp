#!/usr/bin/env node
// Dev CLI: evaluate JS in the running game via CDP.
//   node scripts/eval.js '<expression>'
//   node scripts/eval.js -f file.js
//   node scripts/eval.js --bridge ping '[]'      (call window.__ai.ping())
//   node scripts/eval.js --shot out.jpg          (screenshot)
//   node scripts/eval.js --reload                (hot-reload mcp-mod/game/ai-bridge.js)
// Env: PMGT_CDP_PORT (default 9333)
import { readFile, writeFile } from 'node:fs/promises';
import { CdpClient } from '../src/cdp.js';
import { bridgeBundle } from '../src/bridge.js';

const cdp = new CdpClient({ port: Number(process.env.PMGT_CDP_PORT || 9333) });
const [, , a, b, c] = process.argv;

try {
  let out;
  if (a === '-f') out = await cdp.evaluate(await readFile(b, 'utf8'), { timeoutMs: 600000 });
  else if (a === '--bridge') out = await cdp.callBridge(b, c ? JSON.parse(c) : [], { timeoutMs: 600000 });
  else if (a === '--shot') {
    const img = await cdp.screenshot({ scale: 0.5 });
    await writeFile(b || 'shot.jpg', Buffer.from(img.data, 'base64'));
    out = { saved: b || 'shot.jpg' };
  } else if (a === '--reload') {
    await cdp.evaluate(`(0, eval)(${JSON.stringify((await bridgeBundle()).code)}); true`);
    out = await cdp.callBridge('ping');
  } else if (a) out = await cdp.evaluate(a, { timeoutMs: 600000 });
  else { console.error('usage: eval.js <expr> | -f file | --bridge method [jsonArgs] | --shot [file] | --reload'); process.exit(2); }
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(`${e.code || 'ERROR'}: ${e.message}`);
  process.exitCode = 1;
} finally {
  cdp.close();
}
