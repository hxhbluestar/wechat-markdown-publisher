import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeArticle } from '../frontend/article-preflight.mjs';

const metadata = { title: '合成技术文章', source_url: 'https://example.org/synthetic' };
const run = (content, extra = {}) => analyzeArticle({ content, metadata, assets: [], ...extra });
const codes = report => report.issues.map(issue => issue.code);

test('15 image references locate the one missing asset precisely', () => {
  const content = Array.from({ length: 15 }, (_, i) => `![图 ${i + 1}](images/figure-${i + 1}.png)`).join('\n');
  const assets = Array.from({ length: 15 }, (_, i) => ({ path: `images/figure-${i + 1}.png`, size: 128, content_type: 'image/png' })).filter(asset => asset.path !== 'images/figure-8.png');
  const report = run(content, { assets });
  const missing = report.issues.filter(issue => issue.code === 'image-missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, 'blocker');
  assert.equal(content.slice(missing[0].from, missing[0].to), 'images/figure-8.png');
  assert.equal(report.counts.blocker, 1);
  assert.equal(report.canSync, false);
});

test('normalizes draft image URLs and detects empty, remote and failed assets', () => {
  const content = '![a](/api/editor/drafts/d1/assets/images/a.png)\n![r](https://example.org/a.png)\n![e]()\n![b](b.png)';
  const report = run(content, { draftId: 'd1', assets: [{ path: 'images/a.png', size: 25 }, { path: 'images/b.png', size: 0 }] });
  assert.equal(codes(report).includes('image-missing'), false);
  assert.equal(codes(report).filter(code => code === 'image-remote').length, 1);
  assert.equal(codes(report).filter(code => code === 'image-empty').length, 1);
  assert.equal(codes(report).filter(code => code === 'image-broken').length, 1);
  assert.equal(report.counts.blocker, 3);
});

test('reference images and HTML images retain precise source offsets, code examples are ignored', () => {
  const content = '![图][asset]\n[asset]: <images/a%20b.png> "标题"\n<img src="images/c.png" alt="例子">\n`![示例](images/not-real.png)`\n```md\n![代码](images/also-not-real.png)\n```';
  const report = run(content, { assets: [{ path: 'images/a b.png', size: 30 }] });
  assert.equal(codes(report).filter(code => code === 'image-missing').length, 1);
  const issue = report.issues.find(item => item.code === 'image-missing');
  assert.equal(content.slice(issue.from, issue.to), 'images/c.png');
});

test('unresolved reference and unsupported local image are blockers without leaking paths', () => {
  const content = '![图][missing]\n![vector](images/private-host.svg)';
  const report = run(content);
  assert.ok(codes(report).includes('image-reference-missing'));
  assert.ok(codes(report).includes('image-unsupported'));
  assert.equal(JSON.stringify(report).includes('private-host'), false);
});

test('proofreads metadata and prose while preserving code strings and explicit output logs', () => {
  const content = '请按装软件。\n```python\nmessage = "按装，，rocm"\n```\n```text\n按装，，\n```\n`按装`';
  const report = run(content, { metadata: { ...metadata, title: '按装指南', digest: '以经完成' } });
  assert.equal(report.issues.filter(issue => issue.code === 'proofreading' && issue.field === 'content').length, 1);
  assert.ok(report.issues.some(issue => issue.code === 'proofreading' && issue.field === 'title'));
  assert.ok(report.issues.some(issue => issue.code === 'proofreading' && issue.field === 'digest'));
  assert.equal(codes(report).includes('code-language-unsupported'), false);
  assert.equal(codes(report).includes('technical-term'), false);
});

test('reports language, code width, wide table and heading structure as advice', () => {
  const content = ['```', 'x'.repeat(141), '```', '```made-up-lang', 'hello', '```', '```log', 'result: ok', '```', '| a | b | c | d | e |', '| --- | --- | --- | --- | --- |', '| 1 | 2 | 3 | 4 | 5 |', '## 重复', '##### 很深', '## 重复'].join('\n');
  const report = run(content);
  for (const code of ['code-language-missing', 'code-language-unsupported', 'code-line-long', 'table-wide', 'heading-deep', 'heading-duplicate']) assert.ok(codes(report).includes(code), code);
  assert.equal(report.issues.filter(issue => issue.code === 'code-language-unsupported').length, 1);
  assert.equal(report.counts.blocker, 0);
});

test('source omission and placeholders require author review and preserve deliberate code TODOs', () => {
  const report = run('TODO: 补充\nTBD\n待补充\n```python\n# TODO: internal\n```', { metadata: { title: '文章' } });
  assert.equal(report.issues.filter(issue => issue.code === 'placeholder').length, 3);
  assert.equal(report.issues.find(issue => issue.code === 'source-empty').severity, 'info');
  assert.equal(report.canSync, true);
  assert.ok(report.issues.every(issue => issue.severity === 'info'));
});

test('privacy findings mask tokens, private addresses and usernames even inside code', () => {
  const token = 'syntheticOnlySecret987654321';
  const content = `
\`\`\`bash
export API_TOKEN="${token}"
ssh synthetic_user@172.25.12.3
cd /home/synthetic_user/project
\`\`\`
`;
  const report = run(content);
  for (const code of ['privacy-secret', 'privacy-private-ip', 'privacy-username']) assert.ok(codes(report).includes(code), code);
  const output = JSON.stringify(report);
  for (const sensitive of [token, '172.25.12.3', 'synthetic_user']) assert.equal(output.includes(sensitive), false, sensitive);
  assert.ok(report.issues.filter(issue => issue.code.startsWith('privacy-')).every(issue => issue.severity === 'info' && issue.masked === '[已脱敏]'));
});

test('public documentation addresses and placeholder credentials do not create false secret findings', () => {
  const report = run('IP: 192.0.2.1, 8.8.8.8, 999.999.999.999\nTOKEN=<YOUR_TOKEN>\napi_key="example"');
  assert.equal(codes(report).some(code => code.startsWith('privacy-')), false);
});

test('rendered HTML reveals definite unresolved diagrams and local clipping risks', () => {
  const html = '<pre class="mermaid">graph TD; A-->B</pre><span class="math math-inline">x^2</span><p style="font-size:18px;line-height:12px;height:20px;overflow:hidden">text</p>';
  const report = run('正文', { html });
  assert.ok(codes(report).includes('render-mermaid-unresolved'));
  assert.ok(codes(report).includes('render-math-unresolved'));
  assert.ok(codes(report).includes('render-line-height'));
  assert.ok(codes(report).includes('render-clipping'));
  assert.equal(report.issues.find(issue => issue.code === 'render-mermaid-unresolved').severity, 'blocker');
  assert.ok(report.issues.filter(issue => issue.field === 'html').every(issue => html.slice(issue.from, issue.to).startsWith('<')));
});

test('normal inline reference superscripts and subscripts may use zero line height without overlap findings', () => {
  const report = run('正文', {html:'<p style="font-size:17px;line-height:30px">参考<sup style="font-size:10px;line-height:0;vertical-align:super">[1]</sup> H<sub style="font-size:10px;line-height:0;vertical-align:sub">2</sub>O</p>'});
  assert.equal(codes(report).includes('render-line-height'),false);
  const unsafe = run('正文', {html:'<sup style="display:block;font-size:17px;line-height:0">block</sup><p style="font-size:17px;line-height:8px">正文<sup style="font-size:10px;line-height:0">[1]</sup></p>'});
  assert.equal(unsafe.issues.filter(issue=>issue.code==='render-line-height').length,2);
});

test('rendered Mermaid SVG and KaTeX are accepted; no HTML means rendering is unverified', () => {
  const report = run('```mermaid\ngraph TD; A-->B\n```\n$x^2$', { html: '<svg class="mermaid"><text>A</text></svg><span class="katex">x</span>' });
  assert.equal(codes(report).some(code => code.startsWith('render-')), false);
  assert.equal(codes(run('```mermaid\ngraph TD; A-->B\n```')).some(code => code.startsWith('render-')), false);
});

test('IDs and reports are deterministic, technical checks can be disabled without disabling blockers', () => {
  const input = { content: '使用rocm和pytorch。![图](missing.png)', metadata, assets: [] };
  assert.deepEqual(analyzeArticle(input), analyzeArticle(input));
  const disabled = analyzeArticle({ ...input, includeTechnical: false });
  assert.equal(codes(disabled).includes('technical-term'), false);
  assert.equal(codes(disabled).includes('image-missing'), true);
  assert.equal(disabled.counts.total, disabled.issues.length);
  assert.equal(new Set(disabled.issues.map(issue => issue.id)).size, disabled.issues.length);
});

test('a bounded advice report never turns excess optional findings into a sync blocker', () => {
  const report = run(Array.from({ length: 2100 }, () => 'TODO').join('\n'));
  assert.equal(report.truncated, true);
  assert.equal(report.canSync, true);
  assert.ok(report.issues.some(issue => issue.code === 'advice-truncated' && issue.severity === 'info'));
  assert.ok(report.issues.length < 2100);
});

test('too many spelling suggestions remain optional, while late render errors still block', () => {
  const report = run('按装。'.repeat(501));
  assert.equal(report.truncated, true);
  assert.equal(report.canSync, true);
  assert.equal(report.counts.blocker, 0);
  const unsafe = run('TODO\n'.repeat(2100), {html:'<pre class="mermaid">graph TD; A--&gt;B</pre>'});
  assert.equal(unsafe.canSync,false);
  assert.ok(unsafe.issues.some(issue=>issue.code==='render-mermaid-unresolved' && issue.severity==='blocker'));
});

test('incomplete structural analysis remains a blocker beyond the source size limit', () => {
  const report = run('正'.repeat(200001));
  assert.equal(report.canSync,false);
  assert.ok(report.issues.some(issue=>issue.code==='analysis-truncated' && issue.severity==='blocker'));
});

test('actual bundled language aliases work while unavailable grammars are advisory', () => {
  const content = ['cxx', 'pwsh', 'shellsession', 'tsx', 'mjs', 'graphql', 'csharp', 'nginx'].map(language => `\`\`\`${language}\nx\n\`\`\``).join('\n');
  const findings = run(content).issues.filter(issue => issue.code === 'code-language-unsupported');
  assert.equal(findings.length, 1);
  assert.equal(content.slice(findings[0].from, findings[0].to).trim(), '```nginx');
});

test('HTML attribute inspection ignores data-src and quoted lookalike attributes', () => {
  const content = `<img alt='src="images/fake.png"' src = 'images/real.png'><img data-src="images/lazy.png">`;
  const report = run(content, { assets: [{ path: 'images/real.png', size: 22 }] });
  assert.equal(codes(report).includes('image-missing'), false);
  assert.equal(codes(report).filter(code => code === 'image-empty').length, 1);
});

test('UTF-16 and CRLF offsets survive escaped image paths and privacy review', () => {
  const content = '😀\r\n![图](images/a\\(1\\).png)\r\n![图](missing.png)\r\nBearer syntheticBearerToken0123456789';
  const report = run(content, { assets: [{ path: 'images/a(1).png', size: 20 }] });
  const missing = report.issues.filter(issue => issue.code === 'image-missing');
  assert.equal(missing.length, 1);
  assert.equal(content.slice(missing[0].from, missing[0].to), 'missing.png');
  assert.ok(codes(report).includes('privacy-secret'));
  assert.equal(JSON.stringify(report).includes('syntheticBearerToken'), false);
});

test('a line with inline image source examples and code fences never mutates its input', () => {
  const content = '> ```python\n> x = "按装rocm"\n> ```\n使用ROCm。';
  const input = { content, metadata: { ...metadata }, assets: [] };
  const before = structuredClone(input);
  assert.equal(run(content).issues.length, 0);
  analyzeArticle(input);
  assert.deepEqual(input, before);
});
test('preflight honors intentional spelling ignores and checks expanded HTML beyond source text limit',()=>{
 const report=analyzeArticle({content:'请按装环境。',metadata:{title:'按装指南',source_url:'https://example.org'},assets:[],ignoredWords:['按装'],html:'<p>Safe highlighted output</p>'.repeat(10000)});
 assert.equal(report.issues.some(i=>i.code==='proofreading'),false);
 assert.equal(report.issues.some(i=>i.code==='analysis-truncated'),false);
});
