// Word-level diff (LCS) rendered as HTML with <ins>/<del>.
import { esc } from './util.js';

export function diffWords(a = '', b = '') {
  const A = String(a).split(/(\s+)/), B = String(b).split(/(\s+)/);
  const n = A.length, m = B.length;
  if (n * m > 4e6) {                 // very long texts: fall back to block replace
    return a === b ? esc(a) : `<del>${esc(a)}</del><ins>${esc(b)}</ins>`;
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  const push = (tag, s) => {
    const last = out[out.length - 1];
    if (last && last.tag === tag) last.s += s; else out.push({ tag, s });
  };
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('', A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', A[i++]);
    else push('ins', B[j++]);
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('ins', B[j++]);
  return out.map(({ tag, s }) => (tag ? `<${tag}>${esc(s)}</${tag}>` : esc(s))).join('');
}
