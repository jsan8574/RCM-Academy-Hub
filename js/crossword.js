// Crossword grid builder: turns a list of words into a grid layout (no letters stored).
// Always gives the same grid for the same words, so the builder preview matches what learners get.
// Layout: { rows, cols, words: [{ i, r, c, d: "a" | "d", len, n }] } where i is the word's place in the list
// and n is the number shown in the grid.

export const normWord = (w) => String(w ?? "").toUpperCase().replace(/[^A-Z]/g, "");

export function buildCrossword(words) {
  const list = words.map((w, i) => ({ i, w: normWord(w) })).filter((x) => x.w.length >= 2);
  const grid = new Map();             // "r,c" → letter
  const placed = [];
  const at = (r, c) => grid.get(`${r},${c}`);
  const box = () => {
    let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
    for (const k of grid.keys()) { const [r, c] = k.split(",").map(Number); r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
    return { r0, r1, c0, c1 };
  };

  // Can `w` start at (r, c) going across ("a") or down ("d")? Returns the number of crossings, or -1.
  const fits = (w, r, c, d) => {
    const dr = d === "d" ? 1 : 0, dc = d === "a" ? 1 : 0;
    if (at(r - dr, c - dc) || at(r + dr * w.length, c + dc * w.length)) return -1;
    let cross = 0;
    for (let k = 0; k < w.length; k++) {
      const rr = r + dr * k, cc = c + dc * k;
      const cur = at(rr, cc);
      if (cur) {
        if (cur !== w[k]) return -1;
        cross += 1;
      } else if (d === "a" ? at(rr - 1, cc) || at(rr + 1, cc) : at(rr, cc - 1) || at(rr, cc + 1)) {
        return -1;                    // would touch a neighbouring word side by side
      }
    }
    return cross === w.length ? -1 : cross;
  };
  const put = (x, r, c, d) => {
    for (let k = 0; k < x.w.length; k++) grid.set(d === "a" ? `${r},${c + k}` : `${r + k},${c}`, x.w[k]);
    placed.push({ i: x.i, r, c, d, len: x.w.length });
  };

  const order = list.slice().sort((a, b) => b.w.length - a.w.length || a.i - b.i);
  let waiting = [];
  for (const x of order) {
    if (!placed.length) { put(x, 0, 0, "a"); continue; }
    if (!tryCross(x)) waiting.push(x);
  }
  // Words that didn't cross anything the first time get a second chance, then sit apart
  waiting = waiting.filter((x) => !tryCross(x));
  for (const x of waiting) {
    const b = box();
    put(x, b.r1 + 2, b.c0, "a");
  }

  function tryCross(x) {
    let best = null;
    const b = box();
    for (const [key, letter] of grid) {
      const [r, c] = key.split(",").map(Number);
      for (let k = 0; k < x.w.length; k++) {
        if (x.w[k] !== letter) continue;
        for (const d of ["a", "d"]) {
          const sr = d === "d" ? r - k : r, sc = d === "a" ? c - k : c;
          const cross = fits(x.w, sr, sc, d);
          if (cross < 1) continue;
          const er = d === "d" ? sr + x.w.length - 1 : sr, ec = d === "a" ? sc + x.w.length - 1 : sc;
          const area = (Math.max(b.r1, er) - Math.min(b.r0, sr) + 1) * (Math.max(b.c1, ec) - Math.min(b.c0, sc) + 1);
          const score = cross * 1000 - area;
          if (!best || score > best.score) best = { score, sr, sc, d };
        }
      }
    }
    if (!best) return false;
    put(x, best.sr, best.sc, best.d);
    return true;
  }

  if (!placed.length) return { rows: 0, cols: 0, words: [] };
  const b = box();
  const words2 = placed.map((p) => ({ ...p, r: p.r - b.r0, c: p.c - b.c0 }));
  // Number the start squares in reading order
  const starts = [...new Set(words2.map((p) => `${p.r},${p.c}`))]
    .map((k) => k.split(",").map(Number)).sort((a, z) => a[0] - z[0] || a[1] - z[1]);
  const num = Object.fromEntries(starts.map(([r, c], n) => [`${r},${c}`, n + 1]));
  for (const p of words2) p.n = num[`${p.r},${p.c}`];
  words2.sort((a, z) => a.i - z.i);
  return { rows: b.r1 - b.r0 + 1, cols: b.c1 - b.c0 + 1, words: words2 };
}

// Every square of the grid: { r, c, n (start number or null), letter (only when words are given) }
export function gridCells(layout, words = null) {
  const cells = new Map();
  for (const p of layout?.words ?? []) {
    for (let k = 0; k < p.len; k++) {
      const r = p.d === "d" ? p.r + k : p.r, c = p.d === "a" ? p.c + k : p.c;
      const key = `${r},${c}`;
      const cell = cells.get(key) ?? { r, c, n: null, letter: "" };
      if (k === 0) cell.n = p.n;
      if (words) cell.letter = normWord(words[p.i])[k] ?? "";
      cells.set(key, cell);
    }
  }
  return cells;
}
