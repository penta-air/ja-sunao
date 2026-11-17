#!/usr/bin/env node
// SessionStart hook: 日本語で書くときのルールを、セッションの最初に文脈へ入れる。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disabled, emit, readInput } from './hook-lib.mjs';

await readInput();
if (!disabled()) {
  const here = dirname(fileURLToPath(import.meta.url));
  const rules = readFileSync(join(here, '..', 'references', 'core-rules.md'), 'utf8');
  emit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        '[ja-sunao] 日本語の文章を書くときは、次のルールに従ってください。' +
        '日本語のファイル、コミットメッセージ、PR本文は自動でチェックされ、要修正があれば差し戻されます。\n\n' +
        rules,
    },
  });
}
