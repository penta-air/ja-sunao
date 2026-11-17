#!/usr/bin/env node
// 日本語の文章から、AIが書いた文章に多い言い回しと構成を検出する。
// 依存パッケージなし。Node.js 18 以上で動く。
//
// 使い方:
//   node scan.mjs <file>...              ファイルを調べる（拡張子で文書かコードかを判断）
//   node scan.mjs --kind commit < msg    標準入力の文章を指定の種類として調べる
//   オプション: --json（結果をJSONで出す） --kind doc|comment|commit|pr
//
// 判定は2段階。
//   error: 誤検出が少なく、直すべきもの。hookはこれがあると差し戻す
//   warn : 文脈しだいのもの。助言として伝えるだけ
// 終了コード: error があれば 1、なければ 0。

import { readFileSync, existsSync } from 'node:fs';
import { extname, basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = '.ja-sunao.json';

// ---------------------------------------------------------------------------
// 対象の種類

const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.txt']);

// コメント記法の定義。line: 行コメント、block: ブロックコメント、str: 文字列の区切り
const C_LIKE = { line: ['//'], block: [['/*', '*/']], str: ['"', "'", '`'] };
const HASH = { line: ['#'], block: [], str: ['"', "'"] };
const COMMENT_SYNTAX = {
  '.js': C_LIKE, '.mjs': C_LIKE, '.cjs': C_LIKE, '.jsx': C_LIKE,
  '.ts': C_LIKE, '.mts': C_LIKE, '.cts': C_LIKE, '.tsx': C_LIKE,
  '.java': C_LIKE, '.kt': C_LIKE, '.kts': C_LIKE, '.scala': C_LIKE,
  '.c': C_LIKE, '.h': C_LIKE, '.cc': C_LIKE, '.cpp': C_LIKE, '.hpp': C_LIKE,
  '.cs': C_LIKE, '.go': C_LIKE, '.rs': C_LIKE, '.swift': C_LIKE,
  '.dart': C_LIKE, '.php': { line: ['//', '#'], block: [['/*', '*/']], str: ['"', "'"] },
  '.css': { line: [], block: [['/*', '*/']], str: ['"', "'"] },
  '.scss': C_LIKE, '.less': C_LIKE,
  '.py': { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]], str: ['"', "'"] },
  '.rb': HASH, '.sh': HASH, '.bash': HASH, '.zsh': HASH, '.fish': HASH,
  '.pl': HASH, '.r': HASH, '.R': HASH, '.ps1': { line: ['#'], block: [['<#', '#>']], str: ['"', "'"] },
  '.yaml': HASH, '.yml': HASH, '.toml': HASH, '.tf': { line: ['#', '//'], block: [['/*', '*/']], str: ['"'] },
  '.sql': { line: ['--'], block: [['/*', '*/']], str: ["'"] },
  '.lua': { line: ['--'], block: [['--[[', ']]']], str: ['"', "'"] },
  '.hs': { line: ['--'], block: [['{-', '-}']], str: ['"'] },
  '.html': { line: [], block: [['<!--', '-->']], str: [] },
  '.xml': { line: [], block: [['<!--', '-->']], str: [] },
  '.vue': { line: ['//'], block: [['<!--', '-->'], ['/*', '*/']], str: ['"', "'", '`'] },
  '.svelte': { line: ['//'], block: [['<!--', '-->'], ['/*', '*/']], str: ['"', "'", '`'] },
};
const NAMED_FILES = { Dockerfile: HASH, Makefile: HASH, '.gitignore': HASH, '.env': HASH };

export function kindOfPath(path) {
  const ext = extname(path);
  if (DOC_EXT.has(ext.toLowerCase())) return 'doc';
  if (COMMENT_SYNTAX[ext] || COMMENT_SYNTAX[ext.toLowerCase()] || NAMED_FILES[basename(path)]) return 'comment';
  return null;
}

// ---------------------------------------------------------------------------
// 本文の取り出し

// Markdown から、調べる対象にしない部分（コード、引用、URL、HTMLコメント、フロントマター）を空行に置き換える。
// 行番号がずれないように、行は消さずに中身だけ消す。
export function extractDoc(text, ext = '.md') {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inFence = null;
  let inFront = false;
  let inHtmlComment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (i === 0 && /^---\s*$/.test(line) && ext !== '.txt') { inFront = true; out.push(''); continue; }
    if (inFront) { if (/^(---|\.\.\.)\s*$/.test(line)) inFront = false; out.push(''); continue; }
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence && ext !== '.txt') {
      if (!inFence) inFence = fence[1][0];
      else if (fence[1][0] === inFence) inFence = null;
      out.push('');
      continue;
    }
    if (inFence) { out.push(''); continue; }
    if (inHtmlComment) { if (line.includes('-->')) inHtmlComment = false; out.push(''); continue; }
    if (line.includes('<!--') && !line.includes('-->')) { inHtmlComment = true; out.push(''); continue; }
    if (/^\s*>/.test(line)) { out.push(''); continue; }
    if (ext === '.mdx' && /^\s*(import|export)\s/.test(line)) { out.push(''); continue; }
    line = line
      .replace(/<!--.*?-->/g, '')
      .replace(/`[^`\n]*`/g, '')
      .replace(/\]\([^)]*\)/g, ']')
      .replace(/https?:\/\/\S+/g, '');
    if (ext === '.mdx') line = line.replace(/<\/?[A-Z][^>]*>/g, '');
    out.push(line);
  }
  return out.join('\n');
}

// ソースコードから、日本語を含むコメントだけを取り出す。
// 文字列リテラルの中の「//」などをコメントと取り違えないよう、文字列も読み飛ばす。
export function extractComments(text, syntax) {
  const comments = [];
  const s = text.replace(/\r\n?/g, '\n');
  let i = 0;
  let line = 1;
  const at = (tok) => tok && s.startsWith(tok, i);
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\n') { line++; i++; continue; }
    const blk = syntax.block.find(([open]) => at(open));
    if (blk) {
      const [open, close] = blk;
      const start = i + open.length;
      let end = s.indexOf(close, start);
      if (end === -1) end = s.length;
      const body = s.slice(start, end);
      comments.push({ line, text: body.replace(/^[ \t]*\*+ ?/gm, '') });
      line += (body.match(/\n/g) || []).length;
      i = end + close.length;
      continue;
    }
    const lc = syntax.line.find((tok) => at(tok));
    if (lc) {
      let end = s.indexOf('\n', i);
      if (end === -1) end = s.length;
      // 連続する行コメントは1つのコメントとしてまとめる
      const body = s.slice(i + lc.length, end);
      const prev = comments[comments.length - 1];
      if (prev && prev.lineComment && prev.endLine === line - 1) {
        prev.text += '\n' + body;
        prev.endLine = line;
      } else {
        comments.push({ line, endLine: line, text: body, lineComment: true });
      }
      i = end;
      continue;
    }
    if (syntax.str.includes(ch)) {
      i++;
      while (i < s.length && s[i] !== ch) {
        if (s[i] === '\\') i++;
        else if (s[i] === '\n') { if (ch !== '`') break; line++; }
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return comments.filter((c) => JA_CHAR.test(c.text));
}

// ---------------------------------------------------------------------------
// 判定ルール

const JA_CHAR = /[぀-ヿ一-鿿]/;
const JA_CHAR_G = /[぀-ヿ一-鿿]/g;

export function japaneseRatio(text) {
  const visible = text.replace(/\s/g, '');
  if (!visible.length) return 0;
  return (visible.match(JA_CHAR_G) || []).length / visible.length;
}

// 言い回しのルール。kinds はそのルールを当てる種類。
// level は error（差し戻す）か warn（助言）。min は、何回以上出たら指摘するか。
const PHRASE_RULES = [
  {
    id: 'closing-cliche', level: 'error', kinds: ['doc', 'pr', 'commit', 'comment'],
    re: /いかがでしたか|参考になれば幸いです|お役に立てれば幸いです|お役に立てたら幸いです|参考になれば嬉しいです/g,
    message: '定型の締めの言葉です。締めの一文ごと削るか、読み手が次にすることを書いてください。',
  },
  {
    id: 'sycophancy', level: 'error', kinds: ['doc', 'pr', 'commit', 'comment'],
    re: /(素晴らしい|いい|良い|鋭い|的確な)(ご)?質問(ですね|です！|をありがとう)/g,
    message: '相手を持ち上げる定型句です。削って本題から書いてください。',
  },
  {
    id: 'double-dash', level: 'error', kinds: ['doc', 'pr', 'commit', 'comment'],
    re: /——|――|—/g,
    message: 'ダッシュで文をつないでいます。読点で続けるか、文を分けてください。',
  },
  {
    id: 'preface', level: 'warn', kinds: ['doc', 'pr'],
    re: /(本記事|本稿|この記事|本ドキュメント|このドキュメント|本書)では[^。\n]{0,40}(解説|紹介|説明|見ていき|まとめ)(します|ていきます|ました)/g,
    message: '中身のない前置きです。結論から書き始められないか確認してください。',
  },
  {
    id: 'koto-ga-dekiru', level: 'warn', kinds: ['doc', 'pr', 'commit', 'comment'], min: 2,
    re: /することができ(ます|る|ません|ない)/g,
    message: '「することができる」は「できる」で足ります。',
  },
  {
    id: 'hedge-cliche', level: 'warn', kinds: ['doc', 'pr', 'commit', 'comment'],
    re: /と言えるでしょう|と言えます(?!か)|と言っても過言ではありません|ではないでしょうか/g,
    message: '確信の度合いをぼかす定型句です。言い切れるなら言い切り、推定なら推定と書いてください。',
  },
  {
    id: 'stock-words', level: 'warn', kinds: ['doc', 'pr', 'commit', 'comment'], min: 3,
    re: /重要です|重要な役割|不可欠です|さまざまな|様々な|多岐にわたる|において|シームレス|包括的|堅牢な|革新的|画期的|飛躍的|大幅に向上|効率的に|を活用し|強力な|柔軟に対応/g,
    message: '意味の薄い定型語が続いています。何がどう重要か、具体的な言葉に置き換えられないか確認してください。',
  },
  {
    id: 'not-but', level: 'warn', kinds: ['doc', 'pr'], min: 3,
    re: /ではなく[、,]/g,
    message: '「〜ではなく、〜」が多く出ています。読み手が誤解しそうな箇所以外は、そのまま言い切ってください。',
  },
  {
    // 話し言葉の動詞。口語の比喩（効く、刺さる、肝）と、意味の広い和語の基本動詞（見る、拾う、抑える、沿わせる、回す、叩く、走る）。
    id: 'spoken-verb', level: 'warn', kinds: ['doc', 'pr', 'commit', 'comment'],
    re: /効(く|き(?!目)|いて|いた|いてる|かな[いく]|かず|かせ|けば)|刺さ(る|り|った|らない)|[がの]肝(だ|です|である|になる|。|$)|に沿わせ(る|ます|て)|(を|も|だけを?)見(る|ます)(?![ぁ-ゖ])|(を|で|だけで)抑え(る|ます)(?![ぁ-ゖ])|を拾(う|います)(?![ぁ-ゖ])|を回(す|します)(?![ぁ-ゖ])|を叩(く|きます)(?![ぁ-ゖ])|が走(る|ります|り[、,])/gm,
    message: '話し言葉の動詞（「効く」「刺さる」のような比喩や、「見る」「拾う」「抑える」のような意味の広い動詞）で、何が起きるかがぼやけています。「効果がある」「チェックする」「検出する」「抑制する」のように、書き言葉で動作を特定できる語にしてください。',
  },
  {
    id: 'conclusion-first-cliche', level: 'warn', kinds: ['doc', 'pr', 'comment'],
    re: /結論から(言うと|申し上げると|お伝えすると)|一言で言えば|要するに[、,]/g,
    message: '結論を予告する定型句です。予告せず、結論そのものを書いてください。',
  },
  {
    id: 'exclamation', level: 'warn', kinds: ['doc', 'pr', 'commit', 'comment'], min: 3,
    re: /[！!](?=\s|$|[^=])/gm,
    message: '「！」が多く出ています。文の中身で伝えられないか確認してください。',
  },
  {
    id: 'emoji', level: 'warn', kinds: ['doc', 'pr', 'commit', 'comment'],
    re: /[\u{1F300}-\u{1FAFF}\u{2705}\u{2728}\u{274C}\u{2B50}\u{26A0}]/gu,
    message: '絵文字で飾っています。相手やリポジトリの慣習でなければ外してください。',
  },
  {
    id: 'fullwidth-alnum', level: 'warn', kinds: ['doc', 'pr', 'commit', 'comment'],
    re: /[Ａ-Ｚａ-ｚ０-９]/g,
    message: '全角の英数字が混ざっています。半角にそろえてください。',
  },
];

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function phraseFindings(rawText, kind, baseLine = 1) {
  // 「」で囲まれた部分は引用や用語の例として扱い、言い回しのチェックから外す。
  // パターンそのものを話題にしている文書（この種のルール集など）で誤検出しないため。
  // 罫線や署名の区切り線のように、記号だけでできた行もダッシュの判定から外す（行数は保つ）。
  const text = rawText
    .replace(/「[^」\n]{0,80}」/g, '「」')
    .replace(/^[ \t　—―\-=_*~ー]+$/gm, '');
  const findings = [...orphanMazuFindings(text, kind, baseLine)];
  for (const rule of PHRASE_RULES) {
    if (!rule.kinds.includes(kind)) continue;
    const hits = [...text.matchAll(rule.re)];
    if (hits.length < (rule.min || 1)) continue;
    findings.push({
      rule: rule.id,
      level: rule.level,
      message: rule.message,
      count: hits.length,
      samples: hits.slice(0, 3).map((m) => ({
        line: baseLine + lineOf(text, m.index) - 1,
        text: snippet(text, m.index, m[0].length),
      })),
    });
  }
  return findings;
}

// 文頭の「まず、」のうち、後に順序を示す語が続かないもの。
// 順序を示していない「まず、」は書き出しの口癖で、AIの文章に多い。「まずは」は対象外。
const MAZU_RE = /(^|[。！？!?]\s*|^\s*(?:[-*+]|\d+[.)])\s+)まず[、,]/gm;
const SEQUENCE_RE = /次に|続いて|続けて|その後|それから|最後に|第二に|[2２二]つ目|ふたつ目|2点目|二点目/;
function orphanMazuFindings(text, kind, baseLine = 1) {
  const hits = [];
  for (const m of text.matchAll(MAZU_RE)) {
    const start = m.index + m[0].length;
    // 同じ節（次の見出しまで）の中で、順序を示す語が出てくるかを調べる
    const rest = text.slice(start);
    const nextHeading = rest.search(/^#{1,6}\s/m);
    const scope = rest.slice(0, nextHeading === -1 ? 800 : Math.min(nextHeading, 800));
    if (!SEQUENCE_RE.test(scope)) {
      hits.push({ line: baseLine + lineOf(text, start) - 1, text: snippet(text, start - 3, 3) });
    }
  }
  if (!hits.length) return [];
  return [{
    rule: 'orphan-mazu', level: kind === 'comment' ? 'warn' : 'error', count: hits.length,
    message: '文頭の「まず、」の後に「次に」「最後に」などが続かず、順序を示していません。「まず、」を外してそのまま書き始めてください。',
    samples: hits.slice(0, 3),
  }];
}

function snippet(text, index, len) {
  const start = Math.max(0, index - 12);
  const end = Math.min(text.length, index + len + 12);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

// 構成のルール（文書とPR本文だけに当てる）
function structureFindings(text) {
  const findings = [];
  const lines = text.split('\n');
  const jaChars = (text.match(JA_CHAR_G) || []).length;

  // 「**ラベル**: 説明」型の箇条書き
  const labelBullets = [];
  lines.forEach((l, i) => {
    if (/^\s*([-*+]|\d+[.)])\s+\*\*[^*\n]+\*\*\s*[:：]/.test(l)) labelBullets.push(i + 1);
  });
  if (labelBullets.length >= 3) {
    findings.push({
      rule: 'bold-label-bullets', level: 'error', count: labelBullets.length,
      message: '「**ラベル**: 説明」型の箇条書きが続いています。太字のラベルを外すか、文でつないで書いてください。',
      samples: labelBullets.slice(0, 3).map((n) => ({ line: n, text: lines[n - 1].trim().slice(0, 40) })),
    });
  }

  // 太字の密度（日本語1000字あたり）
  const bolds = [...text.matchAll(/\*\*[^*\n]+\*\*|__[^_\n]+__/g)];
  const perK = jaChars ? (bolds.length * 1000) / jaChars : 0;
  if (bolds.length >= 6 && perK > 8) {
    findings.push({
      rule: 'bold-density', level: 'error', count: bolds.length,
      message: `太字が多すぎます（日本語1000字あたり${perK.toFixed(1)}か所）。本当に目立たせたい1〜2か所に絞ってください。`,
      samples: bolds.slice(0, 3).map((m) => ({ line: lineOf(text, m.index), text: m[0] })),
    });
  } else if (bolds.length >= 4 && perK > 4) {
    findings.push({
      rule: 'bold-density', level: 'warn', count: bolds.length,
      message: `太字がやや多めです（日本語1000字あたり${perK.toFixed(1)}か所）。`,
      samples: [],
    });
  }

  // 本文をなぞるだけの「まとめ」見出し（文書の最後の見出し）
  const headings = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^#{1,6}\s/.test(l));
  const last = headings[headings.length - 1];
  if (last && headings.length >= 3 && /^#{1,6}\s*(まとめ|おわりに|終わりに|結論|最後に)\s*$/.test(last.l)) {
    findings.push({
      rule: 'summary-section', level: 'warn', count: 1,
      message: '最後に「まとめ」の節があります。本文の繰り返しになっていないか確認し、なっていれば削ってください。',
      samples: [{ line: last.i + 1, text: last.l.trim() }],
    });
  }

  // 見出しの多さ
  if (headings.length >= 4 && jaChars > 0 && (headings.length * 1000) / jaChars > 12) {
    findings.push({
      rule: 'heading-density', level: 'warn', count: headings.length,
      message: '本文の量に比べて見出しが多すぎます。読み手が探す場所にだけ見出しを付けてください。',
      samples: [],
    });
  }

  // 箇条書きの割合
  const contentLines = lines.filter((l) => JA_CHAR.test(l));
  const bulletLines = contentLines.filter((l) => /^\s*([-*+]|\d+[.)])\s/.test(l));
  if (contentLines.length >= 10 && bulletLines.length / contentLines.length > 0.75) {
    findings.push({
      rule: 'bullet-heavy', level: 'warn', count: bulletLines.length,
      message: '本文のほとんどが箇条書きです。因果や経緯のある部分は文でつないで書いてください。',
      samples: [],
    });
  }

  // 長すぎる文と段落（説明が長い文書の目安）
  const longParas = [];
  let para = [];
  let paraStart = 0;
  const flush = () => {
    const t = para.join('');
    if ((t.match(JA_CHAR_G) || []).length > 300) longParas.push({ line: paraStart, text: t.slice(0, 30) + '…' });
    para = [];
  };
  lines.forEach((l, i) => {
    if (!l.trim() || /^\s*(#{1,6}|[-*+]|\d+[.)]|\|)\s?/.test(l)) { flush(); return; }
    if (!para.length) paraStart = i + 1;
    para.push(l.trim());
  });
  flush();
  if (longParas.length) {
    findings.push({
      rule: 'long-paragraph', level: 'warn', count: longParas.length,
      message: '300字を超える段落があります。読み手が判断や作業に要る分だけに絞れないか、分けられないか確認してください。',
      samples: longParas.slice(0, 3),
    });
  }

  // 文の長さの単調さと、同じ文末の連続
  const sentences = text
    .split(/(?<=[。！？!?])|\n/)
    .map((x) => x.replace(/^\s*([-*+]|\d+[.)]|#{1,6})\s+/, '').trim())
    .filter((x) => JA_CHAR.test(x) && x.length >= 5 && /[。！？!?]$/.test(x));
  const longSentences = sentences.filter((x) => x.length >= 90);
  if (longSentences.length) {
    findings.push({
      rule: 'long-sentence', level: 'warn', count: longSentences.length,
      message: '90字を超える文があります。主張ごとに文を分けるか、要らない説明を削れないか確認してください。',
      samples: longSentences.slice(0, 3).map((x) => ({ line: null, text: x.slice(0, 40) + '…' })),
    });
  }
  if (sentences.length >= 8) {
    const lens = sentences.map((x) => x.length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    if (mean > 0 && sd / mean < 0.25) {
      findings.push({
        rule: 'monotone-length', level: 'warn', count: sentences.length,
        message: `文の長さがそろいすぎています（平均${mean.toFixed(0)}字、ばらつき${((sd / mean) * 100).toFixed(0)}%）。短い文と長い文を内容に合わせて混ぜてください。`,
        samples: [],
      });
    }
    let run = 1;
    let worst = null;
    for (let k = 1; k < sentences.length; k++) {
      const a = sentences[k - 1].slice(-4);
      const b = sentences[k].slice(-4);
      run = a === b ? run + 1 : 1;
      if (run >= 4 && !worst) worst = { ending: b, text: sentences[k] };
    }
    if (worst) {
      findings.push({
        rule: 'same-ending', level: 'warn', count: 4,
        message: `同じ文末「${worst.ending}」が4回以上続いています。`,
        samples: [{ line: null, text: worst.text.slice(0, 40) }],
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 設定ファイル（.ja-sunao.json）
//   { "exclude": ["docs/legacy/**", "CHANGELOG.md"], "disable": ["emoji"] }

const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/CHANGELOG.md', '**/vendor/**', '**/dist/**', '**/.git/**'];

export function loadConfig(startDir) {
  let dir = resolve(startDir || process.cwd());
  for (;;) {
    const p = join(dir, CONFIG_FILE);
    if (existsSync(p)) {
      try {
        const c = JSON.parse(readFileSync(p, 'utf8'));
        return { root: dir, exclude: [...DEFAULT_EXCLUDE, ...(c.exclude || [])], disable: c.disable || [] };
      } catch {
        break;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: resolve(startDir || process.cwd()), exclude: DEFAULT_EXCLUDE, disable: [] };
}

function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

export function isExcluded(path, config) {
  const abs = resolve(path);
  const rel = abs.startsWith(config.root + '/') ? abs.slice(config.root.length + 1) : abs;
  return config.exclude.some((g) => {
    const re = globToRe(g);
    return re.test(rel) || re.test(abs) || re.test('/' + rel);
  });
}

// ---------------------------------------------------------------------------
// 公開API

// text を kind（doc / comment / commit / pr）として調べる。
// path を渡すと、拡張子に応じて本文やコメントを取り出してから調べる。
export function scanText(text, { kind, path, disable = [] } = {}) {
  const ext = path ? extname(path) : '.md';
  const k = kind || (path ? kindOfPath(path) : 'doc');
  if (!k) return { kind: null, skipped: 'unsupported', findings: [] };
  let findings = [];

  if (k === 'comment') {
    const syntax = COMMENT_SYNTAX[ext] || COMMENT_SYNTAX[ext.toLowerCase()] || NAMED_FILES[basename(path || '')] || C_LIKE;
    for (const c of extractComments(text, syntax)) {
      findings.push(...phraseFindings(c.text, 'comment', c.line));
    }
    // コメントは短く文脈も限られるので、すべて助言にとどめる
    findings = mergeByRule(findings).map((f) => ({ ...f, level: 'warn' }));
  } else {
    const body = k === 'commit' ? stripCommitNoise(text) : extractDoc(text, ext);
    // コミットメッセージやタイトルは短いので、文字数の下限を下げる
    const minChars = k === 'commit' ? 4 : 20;
    if (japaneseRatio(body) < 0.2 || (body.match(JA_CHAR_G) || []).length < minChars) {
      return { kind: k, skipped: 'not-japanese', findings: [] };
    }
    findings.push(...phraseFindings(body, k));
    if (k === 'doc' || k === 'pr') findings.push(...structureFindings(body));
    findings.push(...lineBreakFindings(body));
  }

  findings = findings.filter((f) => !disable.includes(f.rule));
  return { kind: k, findings };
}

// 日本語の文章の改行（コードのコメント以外のすべて。箇条書きの項目の中も含む）。
// 1行に2文以上続いて80字を超える行、4文以上続く行と、空行のない6行以上のまとまりを助言する。
// 意味のつながった2〜3文は1行に続けてよい。すべての句点で改行させないため、80字を目安にしている。
function lineBreakFindings(text) {
  const findings = [];
  const lines = text.split('\n');
  const crowded = [];
  lines.forEach((l, i) => {
    const body = l.replace(/^\s*([-*+]|\d+[.)]|>)\s+/, '').trim();
    if (!JA_CHAR.test(body) || /^#{1,6}\s|^\|/.test(l)) return;
    const inner = (body.match(/[。！？](?=.)/g) || []).length;
    if ((inner >= 1 && body.length > 80) || inner >= 3) crowded.push({ line: i + 1, text: body.slice(0, 40) + '…' });
  });
  if (crowded.length) {
    findings.push({
      rule: 'line-break', level: 'warn', count: crowded.length,
      message: '1行に文が続いて80字を超えています（または4文以上続いています）。句点で改行してください。箇条書きの項目なら、続きの行を項目の本文の位置にそろえて字下げします。',
      samples: crowded.slice(0, 3),
    });
  }
  const blocks = [];
  let start = -1;
  let len = 0;
  lines.concat(['']).forEach((l, i) => {
    const prose = l.trim() && JA_CHAR.test(l) && !/^\s*([-*+]|\d+[.)]|#{1,6}|\||>)\s?/.test(l) && !/^\s{2,}/.test(l);
    if (prose) { if (start < 0) start = i; len++; }
    else { if (len > 5) blocks.push({ line: start + 1, text: lines[start].trim().slice(0, 30) + '…' }); start = -1; len = 0; }
  });
  if (blocks.length) {
    findings.push({
      rule: 'long-block', level: 'warn', count: blocks.length,
      message: '空行のないまとまりが6行以上続いています。話題が変わるところで空行を1行入れ、1つのまとまりを5行までにしてください。',
      samples: blocks.slice(0, 3),
    });
  }
  return findings;
}

function stripCommitNoise(text) {
  return text
    .split('\n')
    .filter((l) => !/^#/.test(l) && !/^[A-Za-z-]+: .+/.test(l)) // コメント行と Co-Authored-By などのトレーラー
    .join('\n')
    .replace(/https?:\/\/\S+/g, '');
}

function mergeByRule(findings) {
  const map = new Map();
  for (const f of findings) {
    const m = map.get(f.rule);
    if (!m) map.set(f.rule, { ...f, samples: [...f.samples] });
    else { m.count += f.count; m.samples.push(...f.samples); m.samples = m.samples.slice(0, 3); }
  }
  return [...map.values()];
}

export function hasErrors(result) {
  return result.findings.some((f) => f.level === 'error');
}

export function formatResult(result, label = '') {
  const why = { 'not-japanese': '日本語の文章ではない', excluded: '設定で除外', unsupported: '未対応の形式' };
  if (result.skipped) return `${label}対象外（${why[result.skipped] || result.skipped}）`;
  if (!result.findings.length) return `${label}指摘なし`;
  const order = { error: 0, warn: 1 };
  const lines = [`${label}${result.findings.length}件の指摘`];
  for (const f of [...result.findings].sort((a, b) => order[a.level] - order[b.level])) {
    lines.push(`- [${f.level === 'error' ? '要修正' : '助言'}] ${f.rule}（${f.count}件）: ${f.message}`);
    for (const s of f.samples) lines.push(`    ${s.line ? `${s.line}行目: ` : ''}${s.text}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  const json = argv.includes('--json');
  const kIdx = argv.indexOf('--kind');
  const kind = kIdx >= 0 ? argv[kIdx + 1] : undefined;
  const files = argv.filter((a, i) => !a.startsWith('--') && !(kIdx >= 0 && i === kIdx + 1));
  const results = [];
  if (!files.length) {
    const text = await readStdin();
    const config = loadConfig();
    results.push({ file: '(stdin)', ...scanText(text, { kind: kind || 'doc', disable: config.disable }) });
  }
  for (const f of files) {
    const config = loadConfig(dirname(resolve(f)));
    if (isExcluded(f, config)) { results.push({ file: f, kind: null, skipped: 'excluded', findings: [] }); continue; }
    const text = readFileSync(f, 'utf8');
    results.push({ file: f, ...scanText(text, { kind, path: f, disable: config.disable }) });
  }
  if (json) console.log(JSON.stringify(results, null, 2));
  else console.log(results.map((r) => formatResult(r, `${r.file}: `)).join('\n\n'));
  process.exit(results.some(hasErrors) ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
