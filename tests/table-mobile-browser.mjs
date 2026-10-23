// Uses the actual bundled export, then tests it with classes and optional
// overflow/min-width hints removed. This is a conservative fallback test,
// not an emulator of WeChat's undocumented HTML sanitization or night mode.
const prose = '| 入口 | 适合什么情况 | 怎么用 |\n| --- | --- | --- |\n| 官方汇总脚本 `op_tune.sh` | 使用 AITER 源码仓库自带的输入 CSV，快速运行某类算子的测试或调优 | 选 `test` 或 `tune`，可指定算子类别 |\n| 按算子的 tuner | 要调自己模型的一批输入，或希望控制输出 CSV、比较方式和阈值 | 用 `-i` 给输入 CSV，用 `-o` 保存配置；Fused MoE 使用 `gemm_moe_tune.py` |\n| Fused MoE 在线调优 | 想在运行时探索配置表未命中的键 | 设置 `AITER_ONLINE_TUNE=1`；仅在目标键未命中时触发 |';
const specs='| 项目 | 配置 |\n| --- | --- |\n| 处理器 | AMD 锐龙 AI Max+ PRO 495，16 核 32 线程，最高加速频率 5.2GHz |\n| 内存 | 单节点 192GB LPDDR5X 统一内存 |';
const numbers='| GPU | 精度 | Batch | 内存 | 环境 | 结果 |\n| --- | --- | --- | --- | --- | --- |\n| MI308X | BF16 | 128 | 192GB | ROCm | 123.45 |';
const output=document.querySelector('#output'), report=document.querySelector('#report');
const results={checks:0,failures:[],measurements:[]};
const check=(ok,label)=>{results.checks++;if(!ok)results.failures.push(label);};
try {
  const page=new DOMParser().parseFromString(await fetch('/editor/').then(r=>r.text()),'text/html');
  const renderer=await import(page.querySelector('script[type="module"][crossorigin]').getAttribute('src'));
  const payload=[];
  for(const theme of ['technical','journal','minimal','obsidian','deepsea','teal','nord','dracula','latte','grace','default','simple']) {
    for(const size of [12,13,16]) {
      const options={table_font_size:size,table_mode:'auto'};
      const exported=renderer.exportWechatArticle(prose,theme,'blue',options);
      if(theme==='technical'&&size===12) payload.push({name:'technical12',html:exported});
      if(theme==='obsidian'&&size===13) payload.push({name:'obsidian13',html:exported});
      for(const fallback of [false,true]) {
        output.innerHTML=exported;
        if(fallback)for(const el of output.querySelectorAll('*')) {
          el.removeAttribute('class');
          for(const key of ['min-width','max-width','overflow','overflow-x','overflow-y','table-layout','overflow-wrap'])el.style.removeProperty(key);
        }
        check(!output.querySelector('table'),`${theme}/${size}: descriptive rows become cards`);
        check(!output.querySelector('style,script,[class]'),`${theme}/${size}: exported layout is inline-only`);
        for(const token of ['op_tune.sh','gemm_moe_tune.py','AITER_ONLINE_TUNE=1','使用 AITER 源码仓库自带的输入 CSV，快速运行某类算子的测试或调优'])
          check(output.textContent.includes(token),`${theme}/${size}: full cell retained: ${token}`);
        for(const width of [272,312,345,358,390,690,976]) {
          output.style.width=width+'px';
          check(output.scrollWidth<=output.clientWidth+1,`${theme}/${size}/${width}/${fallback}: no clipped content`);
          if(theme==='technical'&&size===12&&!fallback)results.measurements.push({width,table:!!output.querySelector('table'),cellWidths:[...output.querySelectorAll('tr:first-child th')].map(el=>Math.round(el.getBoundingClientRect().width)),scrollWidth:output.scrollWidth});
        }
      }
      output.innerHTML=renderer.exportWechatArticle(specs,theme,'blue',options);output.style.width='272px';
      check(!!output.querySelector('table')&&!output.querySelector('table table'),`${theme}/${size}: two-column specs remain a table`);
      check(output.scrollWidth<=output.clientWidth+1,`${theme}/${size}: specs fit narrow article`);
      output.innerHTML=renderer.exportWechatArticle(numbers,theme,'blue',options);output.style.width='690px';
      check(!!output.querySelector('table'),`${theme}/${size}: numeric comparison remains a table`);
      const cells=[...output.querySelectorAll('tr:first-child th')];
      check(cells.every(el=>el.getBoundingClientRect().width>60),`${theme}/${size}: no squeezed numeric column`);
    }
  }
  document.querySelector('#export-data').value=JSON.stringify(payload);
  output.style.width='358px';output.innerHTML=renderer.exportWechatArticle(prose,'technical','blue',{table_font_size:12,table_mode:'auto'});
}catch(error){results.failures.push(error.stack||String(error));}
document.body.dataset.results=JSON.stringify(results);
report.textContent=`${results.failures.length?'FAIL':'PASS'} · ${results.checks} checks\n${results.failures.slice(0,8).join('\n')}`;
