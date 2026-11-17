#!/usr/bin/env node
// PreToolUse hook: コミットメッセージとPRのタイトル・本文を、実行前にチェックする。
//   Bash の git commit（-m / --message / -F / ヒアドキュメント）
//   Bash の gh pr create / gh pr edit（--title / --body / --body-file）
//   GitHub MCP の create_pull_request / update_pull_request
// 要修正があれば実行を中止させて（deny）、直させる。取り出せない書き方のときは何もしない。
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanText, loadConfig, hasErrors, formatResult } from './scan.mjs';
import { readInput, disabled, blockCount, recordBlock, resetBlock, emit, clip, MAX_BLOCKS } from './hook-lib.mjs';

const input = await readInput();
if (disabled()) process.exit(0);
const ti = input.tool_input || {};
const cwd = input.cwd || process.cwd();

// シェルのコマンド文字列を、引用符を解釈しながら単語に分ける（簡易版）
export function tokenize(cmd) {
  const tokens = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      cur += cmd.slice(i + 1, end === -1 ? cmd.length : end);
      i = end === -1 ? cmd.length : end;
      has = true;
    } else if (c === '"') {
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && '"\\$`'.includes(cmd[i + 1])) i++;
        cur += cmd[i++];
      }
      has = true;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/\s/.test(c) || ';&|'.includes(c)) {
      if (has) tokens.push(cur);
      if (';&|'.includes(c)) tokens.push(c);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

function heredocs(cmd) {
  const out = [];
  const re = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2(?=\s|$|\))/g;
  for (const m of cmd.matchAll(re)) out.push(m[3]);
  return out;
}

function readFileArg(p) {
  if (!p || p === '-') return null;
  const abs = resolve(cwd, p);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

// 1つのコマンド（; や && で区切られた単位）から、オプションの値を集める
function optionValues(tokens, names) {
  const vals = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    for (const n of names) {
      if (t === n && i + 1 < tokens.length) vals.push(tokens[i + 1]);
      else if (n.startsWith('--') && t.startsWith(n + '=')) vals.push(t.slice(n.length + 1));
    }
  }
  return vals;
}

function splitCommands(tokens) {
  const cmds = [[]];
  for (const t of tokens) {
    if (t === ';' || t === '&' || t === '|') cmds.push([]);
    else cmds[cmds.length - 1].push(t);
  }
  return cmds.filter((c) => c.length);
}

// 調べる対象を { label, kind, text } の配列で返す
function targets() {
  const out = [];
  const name = input.tool_name || '';
  if (/(create_pull_request|update_pull_request)$/.test(name)) {
    if (ti.title) out.push({ label: 'PRタイトル', kind: 'commit', text: ti.title });
    if (ti.body) out.push({ label: 'PR本文', kind: 'pr', text: ti.body });
    return out;
  }
  if (name !== 'Bash' || typeof ti.command !== 'string') return out;
  const cmd = ti.command;
  const docs = heredocs(cmd);
  // ヒアドキュメントの中身でトークン化が崩れないよう、先に取り除く
  const stripped = cmd.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\s|$|\))/g, '');
  for (const tokens of splitCommands(tokenize(stripped))) {
    const gi = tokens.indexOf('git');
    if (gi >= 0 && tokens.slice(gi + 1).includes('commit')) {
      const msgs = optionValues(tokens, ['-m', '--message']);
      let text = msgs.filter((m) => !/^\$\(cat\s*$/.test(m) && !m.startsWith('$(')).join('\n\n');
      const fileArg = optionValues(tokens, ['-F', '--file'])[0];
      if (fileArg === '-' || msgs.some((m) => m.startsWith('$('))) text = [text, ...docs].filter(Boolean).join('\n\n');
      else if (fileArg) text = readFileArg(fileArg) || text;
      if (text.trim()) out.push({ label: 'コミットメッセージ', kind: 'commit', text });
      continue;
    }
    const hi = tokens.indexOf('gh');
    if (hi >= 0 && tokens[hi + 1] === 'pr' && ['create', 'edit'].includes(tokens[hi + 2])) {
      const title = optionValues(tokens, ['-t', '--title'])[0];
      let body = optionValues(tokens, ['-b', '--body'])[0];
      const bodyFile = optionValues(tokens, ['-F', '--body-file'])[0];
      if (body && body.startsWith('$(')) body = docs.join('\n\n');
      if (!body && bodyFile) body = bodyFile === '-' ? docs.join('\n\n') : readFileArg(bodyFile);
      if (title) out.push({ label: 'PRタイトル', kind: 'commit', text: title });
      if (body) out.push({ label: 'PR本文', kind: 'pr', text: body });
    }
  }
  return out;
}

const config = loadConfig(cwd);
const list = targets();
if (!list.length) process.exit(0);
// 差し戻し回数は「コミット」と「PR」で別々に数え、問題なく通ったら0に戻す
const key = 'publish:' + (list.some((t) => t.label.startsWith('PR')) ? 'pr' : 'commit');
const found = [];
for (const t of list) {
  const r = scanText(t.text, { kind: t.kind, disable: config.disable });
  if (hasErrors(r)) found.push({ ...t, r });
}
if (!found.length) { resetBlock(input.session_id, key); process.exit(0); }
if (blockCount(input.session_id, key) >= MAX_BLOCKS) { resetBlock(input.session_id, key); process.exit(0); }
recordBlock(input.session_id, key);

emit({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: clip(
      '[ja-sunao] 実行前のチェックで、AIが書いた文章に多いパターンが検出されました。' +
        '[要修正] の箇所を直してから、もう一度実行してください。内容と文体は変えないでください。\n\n' +
        found.map((f) => formatResult(f.r, `${f.label}: `)).join('\n\n'),
    ),
  },
});
