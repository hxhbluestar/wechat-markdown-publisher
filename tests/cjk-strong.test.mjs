import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCjkStrong} from '../frontend/cjk-strong.mjs';
test('Chinese labels ending in punctuation can touch English or numbers',()=>{
 for(const suffix of ['395/128GB','Qwen','1.5.10','以下为各自配置']) assert.equal(prepareCjkStrong(`**公开性能：**${suffix}`),`<strong>公开性能：</strong>${suffix}`);
 assert.equal(prepareCjkStrong('正文。**怎么用：**Linux'), '正文。<strong>怎么用：</strong>Linux');
});
test('escaped literals, code, HTML attributes and link destinations remain untouched',()=>{
 for(const source of ['\\*\\*公开性能：\\*\\*395','`**公开性能：**395`','```txt\n**公开性能：**395\n```','    **公开性能：**395','<img alt="**公开性能：**395">','[来源](https://example.org/**公开性能：**395)']) assert.equal(prepareCjkStrong(source),source);
});
test('normal Markdown and complex inline emphasis stay with the original parser',()=>{
 for(const source of ['**项目与作者：**[链接](url)','**公开性能：** 395','**正常加粗**Qwen','**代码 `x`：**395','**<img src=x>：**395','**[链接](x)：**395'])assert.equal(prepareCjkStrong(source),source);
});
