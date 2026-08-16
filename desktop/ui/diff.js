// Unified line diff for tool-call oldText/newText. Dependency-free LCS
// with a greedy fallback for huge files, plus context collapsing so the
// actual change is not clipped away.

"use strict";

const DIFF_DP_CAP = 1_600_000;
const DIFF_CONTEXT = 3;

export function splitLines(text) {
  const s = text == null ? "" : String(text);
  return s.length ? s.split("\n") : [""];
}

export function greedyLineDiff(a, b) {
  const ops = [];
  let i = 0;
  let j = 0;
  const indexOfFrom = (arr, val, from) => {
    for (let k = from; k < arr.length; k++) if (arr[k] === val) return k;
    return -1;
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: "ctx", text: a[i] });
      i++;
      j++;
      continue;
    }
    const inB = indexOfFrom(b, a[i], j + 1);
    const inA = indexOfFrom(a, b[j], i + 1);
    if (inB !== -1 && (inA === -1 || inB - j <= inA - i)) {
      while (j < inB) {
        ops.push({ type: "add", text: b[j] });
        j++;
      }
    } else if (inA !== -1) {
      while (i < inA) {
        ops.push({ type: "del", text: a[i] });
        i++;
      }
    } else {
      ops.push({ type: "del", text: a[i] });
      ops.push({ type: "add", text: b[j] });
      i++;
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ type: "del", text: a[i] });
    i++;
  }
  while (j < b.length) {
    ops.push({ type: "add", text: b[j] });
    j++;
  }
  return ops;
}

export function lcsLineDiff(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > DIFF_DP_CAP) return greedyLineDiff(a, b);
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    const row = dp[i];
    const prev = dp[i - 1];
    for (let j = 1; j <= m; j++) {
      row[j] = ai === b[j - 1] ? prev[j - 1] + 1 : prev[j] >= row[j - 1] ? prev[j] : row[j - 1];
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: "ctx", text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "add", text: b[j - 1] });
      j--;
    } else {
      ops.push({ type: "del", text: a[i - 1] });
      i--;
    }
  }
  ops.reverse();
  return ops;
}

export function collapseContext(ops, keep = DIFF_CONTEXT) {
  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type !== "ctx") {
      out.push(ops[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j].type === "ctx") j++;
    const run = j - i;
    const leading = i === 0;
    const trailing = j === ops.length;
    if (run <= keep * 2 + 1) {
      while (i < j) out.push(ops[i++]);
      continue;
    }
    const head = leading ? 0 : keep;
    const tail = trailing ? 0 : keep;
    for (let k = 0; k < head; k++) out.push(ops[i + k]);
    const skipped = run - head - tail;
    if (skipped > 0) {
      out.push({
        type: "skip",
        text: `··· ${skipped} unchanged line${skipped === 1 ? "" : "s"} ···`,
      });
    }
    for (let k = run - tail; k < run; k++) out.push(ops[i + k]);
    i = j;
  }
  return out;
}

export function unifiedLineDiff(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const raw = lcsLineDiff(a, b);
  let added = 0;
  let deleted = 0;
  for (const op of raw) {
    if (op.type === "add") added++;
    else if (op.type === "del") deleted++;
  }
  return { lines: collapseContext(raw), added, deleted };
}
