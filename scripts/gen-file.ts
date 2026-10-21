/**
 * Generate a large random file to try the uploader with.
 *   npm run gen:file -- <path> <size in MiB>      e.g.  npm run gen:file -- /tmp/big.bin 5120
 */
import { generateFile } from './lib/generate';

const [path, sizeMiB] = process.argv.slice(2);
if (!path || !sizeMiB || !(Number(sizeMiB) > 0)) {
  console.error('usage: npm run gen:file -- <path> <size in MiB>');
  process.exit(1);
}
const size = Math.floor(Number(sizeMiB) * 1024 * 1024);
let lastPct = -1;
generateFile(path, size, (w) => {
  const pct = Math.floor((w / size) * 100);
  if (pct !== lastPct && pct % 10 === 0) {
    lastPct = pct;
    process.stdout.write(`\r${pct}%`);
  }
})
  .then((f) => console.log(`\nwrote ${f.path} (${f.size} bytes)\nsha256 ${f.sha256}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
