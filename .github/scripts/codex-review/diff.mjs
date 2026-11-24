// Unified diff helpers.

/**
 * Returns a Map of new-side file path -> Set of line numbers that GitHub
 * accepts for RIGHT-side review comments (added and context lines).
 * Quoted paths and deleted files are omitted.
 */
export function commentableLines(diff) {
  const files = new Map();
  let current = null;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  for (const line of String(diff ?? '').split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const marker = line[0];
      if (marker === '+') {
        current?.add(newLine);
        newLine += 1;
        newLeft -= 1;
        continue;
      }
      if (marker === '-') {
        oldLeft -= 1;
        continue;
      }
      if (marker === ' ' || line === '') {
        current?.add(newLine);
        newLine += 1;
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
      if (marker === '\\') continue;
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      if (target.startsWith('b/')) {
        const path = target.slice(2);
        if (!files.has(path)) files.set(path, new Set());
        current = files.get(path);
      } else {
        current = null;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLine = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    }
  }
  return files;
}
