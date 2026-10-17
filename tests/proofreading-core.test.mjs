import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { analyzeMarkdown, applyCorrections, RULE_COUNT } from '../frontend/proofreading-core.mjs';

const pairs = text => analyzeMarkdown(text).issues.map(({ original, replacement }) => [original, replacement]);

test('detects common authored typo phrases and exposes only usable suggestions', () => {
  const text = '按装完成，以经可以登陆系统；既使失败也要再接再励。';
  const result = analyzeMarkdown(text);
  assert.deepEqual(result.issues.map(i => [i.original, i.replacement]), [
    ['按装', '安装'], ['以经', '已经'], ['登陆系统', '登录系统'], ['既使', '即使'], ['再接再励', '再接再厉'],
  ]);
  assert.equal(result.truncated, false);
  assert.ok(RULE_COUNT >= 100);
  for (const issue of result.issues) {
    assert.equal(text.slice(issue.from, issue.to), issue.original);
    assert.equal(issue.kind, 'typo');
    assert.ok(['high', 'review'].includes(issue.confidence));
    assert.ok(issue.message.length > 0);
    assert.equal(typeof issue.id, 'string');
  }
});

test('preserves UTF-16 offsets with emoji and CRLF during analysis and correction', () => {
  const text = '😀\r\n按装。\r\n以经';
  const result = analyzeMarkdown(text);
  assert.deepEqual(result.issues.map(i => [i.from, i.to]), [[4, 6], [9, 11]]);
  assert.deepEqual(applyCorrections(text, result.issues), {
    text: '😀\r\n安装。\r\n已经',
    changes: [{ from: 4, to: 6, insert: '安装' }, { from: 9, to: 11, insert: '已经' }],
  });
});

test('uses stable unique IDs, source order, and nonoverlapping longest matches', () => {
  const text = '登陆系统；按装。按装。';
  const first = analyzeMarkdown(text);
  assert.deepEqual(first, analyzeMarkdown(text));
  assert.equal(new Set(first.issues.map(i => i.id)).size, first.issues.length);
  assert.deepEqual(first.issues.map(i => i.original), ['登陆系统', '按装', '按装']);
  assert.ok(first.issues.every((issue, index, all) => index === 0 || all[index - 1].to <= issue.from));
});

test('does not flag Chinese spelling variants, ambiguous grammar, valid ellipses or technical terms', () => {
  assert.deepEqual(pairs('账号 帐号 账户 其它 其他 的地得 登陆月球 登陆艇 已经安装 ROCm HIP GPU Radeon gfx1151 Ryzen AI Max+ PRO 395 PyTorch DeepSeek …… ... **粗体** __强调__ --- ==='), []);
  assert.deepEqual(pairs('部份 急待解决 张惶失措 层峦迭嶂'), []);
});

test('honors only exact ignored original phrases and does not apply inherited object names', () => {
  assert.deepEqual(analyzeMarkdown('按装 以经 按装', { ignoredWords: ['按装'] }).issues.map(i => i.original), ['以经']);
  assert.deepEqual(analyzeMarkdown('按装', { ignoredWords: ['按'] }).issues.map(i => i.original), ['按装']);
  assert.deepEqual(pairs('__proto__ constructor toString prototype'), []);
});

test('protects fenced and indented code, including unclosed fences and blockquoted fences', () => {
  const text = [
    '# 按装说明', '```js', 'const 以经 = "按装";', '```',
    '~~~text', '既使', '~~~', '    按装', '\t以经',
    '> ```', '> 按装', '> ```', '以经完成。', '```', '按装',
  ].join('\r\n');
  assert.deepEqual(pairs(text), [['按装', '安装'], ['以经', '已经']]);
});

test('protects backtick runs of matching size without hiding following prose', () => {
  assert.deepEqual(pairs('`按装`，``包含 ` 以经 的代码``，按装。`未闭合的以经'), [
    ['按装', '安装'], ['以经', '已经'],
  ]);
});

test('checks link labels and image captions while protecting URLs, destinations and reference targets', () => {
  const text = [
    '[按装](https://example.test/以经 "按装")',
    '![以经](images/按装.png)',
    '[既使][按装引用]', '[按装引用]: https://example.test/以经 "按装"',
    '<https://example.test/按装> https://example.test/以经?q=既使',
    '按装。',
  ].join('\n');
  assert.deepEqual(pairs(text), [['按装', '安装'], ['以经', '已经'], ['既使', '即使'], ['按装', '安装']]);
});

test('protects HTML attributes, comments and raw code containers while checking visible HTML prose', () => {
  const text = '<p title="以经 > 按装">按装</p><!-- 以经 --><pre class="按装">以经</pre>' +
    '<CODE>按装</CODE><style>.按装{}</style><script>"以经"</script><span data-x="既使">以经</span>';
  assert.deepEqual(pairs(text), [['按装', '安装'], ['以经', '已经']]);
  assert.deepEqual(pairs('<pre>按装\n以经'), []);
});

test('protects file paths, filenames and code-like identifiers while checking adjacent Chinese prose', () => {
  const text = 'C:\\tools\\按装\\以经.txt /tmp/按装/以经.md ./按装.exe ../以经.py 按装.ts ' +
    '按装_count enable按装 foo.按装 按装() foo[按装] 按装。以经完成。';
  assert.deepEqual(pairs(text), [['按装', '安装'], ['以经', '已经']]);
  assert.deepEqual(pairs('按装ROCm后，以经可以使用GPU运行PyTorch；HIP、gfx1151和Ryzen AI无需改动。'), [
    ['按装', '安装'], ['以经', '已经'],
  ]);
});

test('marks repeated punctuation for review without treating valid emphasis or ellipsis as errors', () => {
  const issues = analyzeMarkdown('按装，，完成。！！可以？？……... **好** __好__').issues;
  assert.deepEqual(issues.map(i => [i.original, i.replacement, i.kind, i.confidence]), [
    ['按装', '安装', 'typo', 'high'], ['，，', '，', 'punctuation', 'review'],
    ['！！', '！', 'punctuation', 'review'], ['？？', '？', 'punctuation', 'review'],
  ]);
});

test('applies an unsorted selection using original offsets without mutating inputs', () => {
  const text = '按装，以经。';
  const issues = analyzeMarkdown(text).issues.reverse();
  const before = structuredClone(issues);
  assert.equal(applyCorrections(text, issues).text, '安装，已经。');
  assert.deepEqual(issues, before);
  assert.deepEqual(applyCorrections(text, []), { text, changes: [] });
  assert.deepEqual(applyCorrections('，，以经', analyzeMarkdown('，，以经').issues), {
    text: '，已经',
    changes: [{ from: 0, to: 2, insert: '，' }, { from: 2, to: 4, insert: '已经' }],
  });
});

test('rejects all changes when any source is stale, duplicated, overlapping or outside bounds', () => {
  const text = '按装，以经。';
  const [a, b] = analyzeMarkdown(text).issues;
  for (const issues of [
    [a, { ...b, original: '错误' }], [a, a], [a, { ...b, from: 1 }],
    [{ ...a, from: -1 }], [{ ...a, from: 0.5 }], [{ ...a, to: 99 }],
    [{ ...a, to: a.from }], [{ ...a, replacement: '' }], [{ ...a, replacement: '安装<script>' }],
    [{ ...a, replacement: '已经' }], [{ ...a, original: 'a'.repeat(1000) }],
  ]) {
    assert.throws(() => applyCorrections(text, issues));
  }
  assert.throws(() => applyCorrections('已经，以经。', [a, b]));
  assert.throws(() => applyCorrections('`按装`', [{
    ...a, id: 'typo:1:3:按装', from: 1, to: 3,
  }]));
});

test('rejects malformed, inherited and accessor-backed suggestions without executing accessors', () => {
  const issue = analyzeMarkdown('按装').issues[0];
  let invoked = false;
  const accessor = { ...issue };
  Object.defineProperty(accessor, 'replacement', { get() { invoked = true; return '安装'; } });
  for (const issues of [null, {}, [null], ['按装'], [Object.create(issue)], [accessor], [{ ...issue, from: NaN }]]) {
    assert.throws(() => applyCorrections('按装', issues));
  }
  assert.equal(invoked, false);
  assert.throws(() => analyzeMarkdown({ toString() { throw new Error('must not coerce'); } }));
});

test('bounds large input and issue count and finishes adversarial Markdown promptly', { timeout: 5000 }, () => {
  const started = performance.now();
  const many = analyzeMarkdown('按装，'.repeat(100000));
  assert.equal(many.truncated, true);
  assert.ok(many.issues.length > 0 && many.issues.length <= 1000);
  const huge = analyzeMarkdown('文'.repeat(1000000));
  assert.equal(huge.truncated, true);
  assert.deepEqual(huge.issues, []);
  const adversarial = analyzeMarkdown('['.repeat(80000) + '`'.repeat(80000) + '按装');
  assert.equal(typeof adversarial.truncated, 'boolean');
  assert.deepEqual(analyzeMarkdown('a['.repeat(80000) + ' 按装').issues.map(i => i.original), ['按装']);
  assert.ok(performance.now() - started < 3000);
});

test('ignored repeated phrases do not prevent applying a later displayed suggestion',()=>{
  const text='按装，'.repeat(500)+'以经';
  const result=analyzeMarkdown(text,{ignoredWords:['按装']});
  assert.deepEqual(result.issues.map(i=>i.original),['以经']);
  assert.equal(applyCorrections(text,result.issues).text,'按装，'.repeat(500)+'已经');
});
