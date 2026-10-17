import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_TEMPLATES, EXPERIMENT_FIELDS, createContentTemplate, createTitleCandidates, analyzeTechnicalWriting } from '../frontend/technical-writing.mjs';

test('technical terminology finds prose variants but protects code, links and identifiers', () => {
  const content = '使用rocm、pytorch、tilelang、triton、hip、VLLM和sglang，以及amd。\n```python\nrocm = "pytorch 按装"\n```\n`sglang`\n[链接](https://example.org/rocm)\nmy_pytorch_model';
  const terms = analyzeTechnicalWriting(content).filter(issue => issue.code === 'technical-term');
  assert.equal(terms.length, 8);
  assert.deepEqual(terms.map(issue => issue.suggested), ['ROCm', 'PyTorch', 'TileLang', 'Triton', 'HIP', 'vLLM', 'SGLang', 'AMD']);
  assert.ok(terms.every(issue => content.slice(issue.from, issue.to).toLowerCase() === issue.suggested.toLowerCase()));
});

test('metric and mutable version advice is contextual and never changes numeric content', () => {
  const issues = analyzeTechnicalWriting('TTFT 10ms，TPOT 2ms，ITL 2ms；显存 24 GB / 22.3 GiB；使用 latest/nightly。输出吞吐 100 token/s。');
  for (const code of ['metric-latency-definition', 'metric-memory-units', 'version-unpinned', 'metric-throughput-definition']) assert.ok(issues.some(issue => issue.code === code), code);
  assert.ok(issues.every(issue => !Object.hasOwn(issue, 'replacement')));
  assert.equal(analyzeTechnicalWriting('ROCm PyTorch TileLang Triton HIP vLLM SGLang AMD').length, 0);
});

test('benchmark template preserves provenance and exposes reproducible conditions with no invented results', () => {
  const original = { title: '合成性能测试', author: '合成作者', digest: '合成摘要', source_url: 'https://example.org/benchmark', source_author: 'Source author', source_date: '2026-01-01', imported_at: '2026-10-18T00:00:00Z', source_snapshot: 'local-copy.html' };
  const result = createContentTemplate('benchmark', original);
  assert.equal(result.metadata.title, original.title);
  assert.equal(result.metadata.source_snapshot, 'local-copy.html');
  assert.equal(result.metadata.source_author, 'Source author');
  assert.ok(result.content.includes('TTFT'));
  assert.ok(result.content.includes('实测数据'));
  const required = result.experimentFields.filter(field => field.required).map(field => field.key);
  for (const key of ['hardware', 'vram', 'os_kernel', 'rocm_version', 'framework_version', 'model_version', 'precision', 'parallelism', 'input_output_length', 'concurrency', 'test_date', 'raw_data_source']) assert.ok(required.includes(key), key);
  result.metadata.title = 'edited';
  assert.equal(original.title, '合成性能测试');
  assert.ok(EXPERIMENT_FIELDS.length >= 12);
});

test('three local templates and three editable title structures carry original metadata', () => {
  assert.equal(CONTENT_TEMPLATES.length, 3);
  for (const type of ['tutorial', 'benchmark', 'rocm-repost']) {
    const result = createContentTemplate(type, { title: 'ROCm 合成文章', author: '作者', source_url: 'https://example.org/source' });
    assert.ok(result.content.startsWith('# ROCm 合成文章'));
    assert.equal(result.metadata.author, '作者');
    assert.equal(result.metadata.source_url, 'https://example.org/source');
    const titles = createTitleCandidates(type, { topic: 'ROCm', hardware: '合成 GPU' });
    assert.equal(titles.length, 3);
    assert.equal(new Set(titles.map(candidate => candidate.title)).size, 3);
    assert.ok(titles.every(candidate => candidate.editable && candidate.title.includes('ROCm')));
    titles[0].title = '作者自己修改';
    assert.equal(createTitleCandidates(type, { topic: 'ROCm' })[0].title.includes('作者自己修改'), false);
  }
  assert.throws(() => createContentTemplate('unknown'), /template/i);
});

test('missing benchmark conditions require review only for benchmark articles', () => {
  const missing = analyzeTechnicalWriting('正文', { article_type: 'benchmark' }).filter(issue => issue.code === 'experiment-condition-missing');
  assert.ok(missing.length >= 12);
  assert.ok(missing.every(issue => issue.field.startsWith('experiment_conditions.') && issue.severity === 'confirm'));
  assert.equal(analyzeTechnicalWriting('普通文章').length, 0);
  const conditions = Object.fromEntries(EXPERIMENT_FIELDS.map(field => [field.key, '作者已填写']));
  assert.equal(analyzeTechnicalWriting('正文', { article_type: 'benchmark', experiment_conditions: conditions }).length, 0);
});

test('placeholder benchmark condition values do not count as reproducible conditions', () => {
  const conditions = Object.fromEntries(EXPERIMENT_FIELDS.map(field => [field.key, '待补充']));
  const issues = analyzeTechnicalWriting('正文', { article_type: 'benchmark', experiment_conditions: conditions });
  assert.equal(issues.filter(issue => issue.code === 'experiment-condition-missing').length, 12);
});
