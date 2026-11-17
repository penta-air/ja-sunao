// hook 用の共通処理。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 同じ対象で何回差し戻したら、それ以降は助言に切り替えるか
export const MAX_BLOCKS = 2;

export async function readInput() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

export function disabled() {
  return process.env.JA_SUNAO_DISABLE === '1';
}

// 差し戻し回数をセッションごとに記録して、同じ対象での無限ループを防ぐ
function statePath(sessionId) {
  const dir = join(tmpdir(), 'ja-sunao');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${String(sessionId || 'default').replace(/[^\w-]/g, '_')}.json`);
}

export function blockCount(sessionId, key) {
  try {
    return JSON.parse(readFileSync(statePath(sessionId), 'utf8'))[key] || 0;
  } catch {
    return 0;
  }
}

export function recordBlock(sessionId, key) {
  const p = statePath(sessionId);
  let state = {};
  try { state = JSON.parse(readFileSync(p, 'utf8')); } catch {}
  state[key] = (state[key] || 0) + 1;
  writeFileSync(p, JSON.stringify(state));
}

// 問題なく通ったら、その対象の差し戻し回数を0に戻す
export function resetBlock(sessionId, key) {
  const p = statePath(sessionId);
  try {
    const state = JSON.parse(readFileSync(p, 'utf8'));
    if (state[key]) { delete state[key]; writeFileSync(p, JSON.stringify(state)); }
  } catch {}
}

export function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

// 出力が長くなりすぎないように切り詰める
export function clip(text, max = 2500) {
  return text.length > max ? text.slice(0, max) + '\n…（以下省略）' : text;
}
