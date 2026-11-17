#!/usr/bin/env node
// PostToolUse hook（Write / Edit / MultiEdit）: 書いた日本語をチェックする。
//   文書（.md / .mdx / .txt）: 要修正があれば差し戻す
//   コード: 日本語のコメントだけをチェックして、助言を返す
// Edit / MultiEdit では書き足した部分だけをチェックする。人が書いた既存の文章で差し戻さないため。
import { resolve, dirname } from 'node:path';
import { scanText, kindOfPath, loadConfig, isExcluded, hasErrors, formatResult } from './scan.mjs';
import { readInput, disabled, blockCount, recordBlock, resetBlock, emit, clip, MAX_BLOCKS } from './hook-lib.mjs';

const input = await readInput();
const ti = input.tool_input || {};
const filePath = ti.file_path || ti.path;

function writtenText() {
  if (input.tool_name === 'Write') return ti.content;
  if (input.tool_name === 'Edit') return ti.new_string;
  if (input.tool_name === 'MultiEdit') return (ti.edits || []).map((e) => e.new_string).join('\n\n');
  return null;
}

const text = writtenText();
if (disabled() || !filePath || typeof text !== 'string' || !text.trim()) process.exit(0);
if (!kindOfPath(filePath)) process.exit(0);

const abs = resolve(input.cwd || process.cwd(), filePath);
const config = loadConfig(dirname(abs));
if (isExcluded(abs, config)) process.exit(0);

const result = scanText(text, { path: abs, disable: config.disable });
const key = `file:${abs}`;
// 要修正がなくなったら差し戻し回数を0に戻す
if (!hasErrors(result)) resetBlock(input.session_id, key);
if (!result.findings.length) process.exit(0);
const report = clip(formatResult(result));

if (hasErrors(result) && blockCount(input.session_id, key) < MAX_BLOCKS) {
  recordBlock(input.session_id, key);
  emit({
    decision: 'block',
    reason:
      `[ja-sunao] ${filePath} の日本語に、AIが書いた文章に多いパターンが検出されました。` +
      '[要修正] の箇所を直してから先に進んでください。[助言] は文脈を見て判断してください。' +
      '直すときは内容（事実、数値、確信の度合い）と文体を変えないでください。\n\n' +
      report,
  });
} else {
  // 差し戻しの上限に達したときは助言として扱い、回数を0に戻す（次の変更ではまたチェックする）
  if (hasErrors(result)) resetBlock(input.session_id, key);
  emit({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `[ja-sunao] ${filePath} の日本語についての助言です。直すかどうかは文脈を見て判断してください。\n\n` + report,
    },
  });
}
