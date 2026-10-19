// Real preview CSS and class-free inline export must obey the same width policy.
// A forced table margin or nowrap/min-width regression fails actual overflow checks.
const results = { checks: 0, failures: [], measurements: [] };
const output = document.querySelector('#output');
const report = document.querySelector('#report');
const check = (condition, label) => { results.checks++; if (!condition) results.failures.push(label); };
const sample = '| 项目 | 配置 |\n| --- | --- |\n| 处理器 | AMD 锐龙 AI Max+ PRO 495，16 核 32 线程，最高加速频率 5.2GHz |\n| 集成 GPU | AMD Radeon 8065S，40 个计算单元 |\n| NPU | AMD XDNA 2，最高 55 TOPS |\n| 内存 | 单节点 192GB LPDDR5X 统一内存 |';
const dense = '| GPU | 精度 | Batch | 内存 | 环境 | 最后一列 |\n| --- | --- | --- | --- | --- | --- |\n| AMD Instinct | BF16 | 128 | 192GB | ROCm Linux | LAST-COLUMN |\n| B | FP32 | 1 | 64GB | Windows | FINAL-ROW |';
const fixed = '<table style="width:1600px"><tr><th>A</th><th>B</th></tr><tr><td>LEFT</td><td>RIGHT-END</td></tr></table>';
const sizedCells = '<table><tr><th style="width:800px">A</th><th style="width:800px">B</th></tr><tr><td>LEFT</td><td>CELL-WIDTH-END</td></tr></table>';
const sizedColumns = '<table><colgroup><col width="800"><col width="800"></colgroup><tr><th>A</th><th>B</th></tr><tr><td>LEFT</td><td>COL-WIDTH-END</td></tr></table>';
const codeTable = '<table><tr><th>Code</th></tr><tr><td><pre><code class="language-python">if True:\n\tprint("x")\n\n# END</code></pre></td></tr></table>';
try {
  const entry = new DOMParser().parseFromString(await fetch('/editor/').then(r => r.text()), 'text/html');
  const { previewWechatArticle, exportWechatArticle } = await import(entry.querySelector('script[type="module"][crossorigin]').getAttribute('src'));
  for (const theme of ['grace','default','simple','technical','journal','minimal','obsidian','deepsea','teal']) {
    for (const size of [12,16]) for (const route of ['preview','export']) {
      // Leave legacy default settings implicit to cover the old early-return path too.
      const options = size === 16 && ['grace','default','simple'].includes(theme) ? {} : { table_font_size:size };
      const markdown = [sample,dense,fixed,sizedCells,sizedColumns,codeTable].join('\n\n');
      const preview = previewWechatArticle(markdown,theme,'warm',options);
      const style = document.createElement('style');
      if (route === 'preview') { style.textContent = preview.css; document.head.append(style); }
      output.innerHTML = route === 'preview' ? preview.html : exportWechatArticle(markdown,theme,'warm',options);
      if (route === 'export') check(!output.querySelector('[class],style,script'), `${theme}/${size} inline export needs no classes or scripts`);
      for (const width of [642,272,312,345,382,772,976,642]) {
        output.style.width = width + 'px';
        output.style.padding = '0';
        const tables = [...output.querySelectorAll('table')];
        check(tables.length === 6, `${theme}/${size}/${route}/${width} preserves all tables`);
        const areas = tables.map(t => { for(let p=t.parentElement;p && p!==output;p=p.parentElement) if(getComputedStyle(p).overflowX === 'auto') return p; return t; });
        const overflow = areas.map(a => a.scrollWidth > a.clientWidth + 1);
        const label = `${theme}/${size}/${route}/${width}`;
        check(!overflow[0], `${label} two-column specs fit without a scrollbar`);
        check(overflow[1] === (width <= 382), `${label} dense table scrolls only below its readable width`);
        check(overflow[2], `${label} authored 1600px grid remains scrollable`);
        for (const index of [3,4]) check(overflow[index] && tables[index].getBoundingClientRect().width >= 1598, `${label} table ${index} preserves authored column widths`);
        check(output.scrollWidth <= output.clientWidth + 1, `${label} contains overflow inside the table`);
        check(tables[0].rows.length === 5 && tables[0].textContent.includes('5.2GHz'), `${label} keeps full specs and last row`);
        check(['pre','pre-wrap'].includes(getComputedStyle(tables[5].querySelector('pre code')).whiteSpace), `${label} code inside table preserves line breaks and indentation`);
        for (const index of [1,2,3,4]) {
          const area = areas[index];
          area.scrollLeft = area.scrollWidth;
          const last = tables[index].querySelector('tr:last-child td:last-child');
          check(last.getBoundingClientRect().right <= area.getBoundingClientRect().right + 1, `${label} table ${index} final column reachable`);
        }
        results.measurements.push({theme,size,route,width,overflow});
      }
      style.remove();
    }
  }
  const manual = exportWechatArticle(sample,'technical','warm',{table_mode:'scroll',table_font_size:12});
  output.innerHTML = manual;
  output.style.width = '272px';
  const manualArea = [...output.querySelectorAll('section')].find(e => e.querySelector('table') && getComputedStyle(e).overflowX === 'auto');
  check(manualArea?.scrollWidth > manualArea?.clientWidth, 'explicit horizontal-scroll mode preserves unwrapped cells');
  output.innerHTML = exportWechatArticle(sample,'grace','warm',{table_font_size:12});
  output.style.width = '642px';
} catch (error) { results.failures.push(error.stack || String(error)); }
document.body.dataset.results = JSON.stringify(results);
report.textContent = `${results.failures.length ? 'FAIL' : 'PASS'} · ${results.checks} checks\n${results.failures.slice(0,30).join('\n')}`;
