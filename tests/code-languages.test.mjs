import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {CODE_SAMPLES as sample} from './code-samples.mjs';
import {prepareTypography} from '../frontend/typography.mjs';

const context=vm.createContext({});
for(const file of ['app/web/highlight.min.js','app/web/vendor/highlight-powershell-11.11.1.min.js','app/web/vendor/highlight-extras-11.11.1.js','frontend/code-languages.js']) {
  if(fs.existsSync(file))vm.runInContext(fs.readFileSync(file,'utf8'),context);
}
const highlighter=context.hljs;
const {document}=parseHTML('<html><body></body></html>');


test('AI and infrastructure fence names and common aliases all have usable offline grammars',()=>{
  for(const name of ['ai-python','python3','py3','pytorch','torch','tilelang','tile-lang','tile_lang','triton','hip','hip-cpp','cuda','cu','cuh','cpp','c++','cxx','hpp','powershell','pwsh','ps1','psm1','psd1','bash','sh','shell','console','shellsession','dockerfile','docker','cmake','llvm','ll','jsonc','toml','yaml','yml','rust']) assert.ok(highlighter.getLanguage(name),name);
});

test('each representative language highlights tokens and preserves every original code character',()=>{
  for(const [language,code] of Object.entries(sample)) {
    const grammar=language==='python'?'ai-python':language;
    const html=highlighter.highlight(code,{language:grammar,ignoreIllegals:true}).value;
    const host=document.createElement('div');host.innerHTML=html;
    assert.equal(host.textContent,code,language);
    assert.ok(host.querySelector('span[class*="hljs-"]'),language);
  }
});

test('Python based GPU DSLs distinguish decorators, tensor annotations and operations',()=>{
  for(const language of ['tilelang','triton']) {
    const host=document.createElement('div');host.innerHTML=highlighter.highlight(sample[language],{language}).value;
    assert.ok(host.querySelector('.hljs-meta'),language+' decorator');
    assert.ok(host.querySelector('.hljs-type'),language+' tensor or compile-time annotation');
    assert.ok([...host.querySelectorAll('.hljs-built_in')].some(n=>/T\.(Kernel|copy)|tl\.(load|store|arange)/.test(n.textContent)),language+' GPU API');
  }
});

test('names inside comments and strings remain literal instead of receiving GPU token colors',()=>{
  const code='# T.Kernel tl.load torch.matmul\ns = "T.Kernel <tag>& tl.load"\n';
  for(const language of ['ai-python','tilelang','triton']) {
    const host=document.createElement('div');host.innerHTML=highlighter.highlight(code,{language}).value;
    assert.equal(host.textContent,code);
    assert.equal(host.querySelectorAll('.hljs-comment .hljs-built_in,.hljs-string .hljs-built_in').length,0);
  }
});

test('all publishing layouts keep canonical language names and use AI Python for ordinary python fences',()=>{
  for(const theme of ['technical','journal','minimal','obsidian']) {
    for(const [fence,label,code] of [['python','Python',sample.python],['cxx','C++',sample.cpp],['TILELANG','TileLang',sample.tilelang],['pwsh','PowerShell',sample.powershell],['hip','HIP · C++',sample.hip],['cu','CUDA · C++',sample.cuda],['shellsession','Shell Session','$ python train.py\nready\n']]) {
      const original=document.createElement('code');original.className='language-'+fence;original.textContent=code;
      const result=prepareTypography('<pre>'+original.outerHTML+'</pre>',{theme},document,highlighter);
      const host=document.createElement('div');host.innerHTML=result.html;
      assert.equal(host.querySelector('.wx-code-caption').textContent,label,theme+'/'+fence);
      assert.equal(host.querySelector('pre code').textContent,code,theme+'/'+fence);
      assert.ok(host.querySelector('pre code span[class*="hljs-"]'),theme+'/'+fence);
      if(fence==='python')assert.ok([...host.querySelectorAll('.hljs-built_in')].some(n=>n.textContent==='torch.softmax'),theme+' uses the enhanced grammar for ordinary Python fences');
    }
  }
});

test('GPU extensions neither replace original Python grammar nor fail on repeated loading',()=>{
  const python=highlighter.getLanguage('python');
  if(fs.existsSync('frontend/code-languages.js'))vm.runInContext(fs.readFileSync('frontend/code-languages.js','utf8'),context);
  assert.equal(highlighter.getLanguage('python'),python);
  assert.equal(highlighter.highlight('def run():\n    return 1\n',{language:'python'}).language,'python');
});

test('f-string expressions get API colors while literal text, triple strings and comments stay literal',()=>{
  const code='text = """T.Kernel <>& torch.matmul"""\nvalue = f"torch.softmax: {torch.softmax(x, dim=-1)}"\n# torch.softmax(x)\n';
  for(const language of ['ai-python','tilelang','triton']) {
    const host=document.createElement('div');host.innerHTML=highlighter.highlight(code,{language}).value;
    assert.equal(host.textContent,code);
    assert.equal(host.querySelectorAll('.hljs-comment .hljs-built_in').length,0);
    assert.equal([...host.querySelectorAll('.hljs-built_in')].filter(n=>n.textContent==='torch.softmax').length,1,language+' only colors executable expression');
  }
});

test('HIP and CUDA extensions preserve base C++ scopes inside strings and comments',()=>{
  const code='// __global__ threadIdx.x\nconst char* s = "hipMalloc __syncthreads() <>&";\ndim3 block(128);\n__global__ void run() { __syncthreads(); }\n';
  for(const language of ['hip','cuda']) {
    const host=document.createElement('div');host.innerHTML=highlighter.highlight(code,{language}).value;
    assert.equal(host.textContent,code);
    assert.equal(host.querySelectorAll('.hljs-comment .hljs-built_in,.hljs-string .hljs-built_in,.hljs-string .hljs-keyword').length,0);
    assert.ok([...host.querySelectorAll('.hljs-keyword')].some(n=>n.textContent==='__global__'));
    assert.ok([...host.querySelectorAll('.hljs-built_in')].some(n=>n.textContent==='__syncthreads'));
    assert.ok([...host.querySelectorAll('.hljs-type')].some(n=>n.textContent==='dim3'));
  }
});

test('function call decoration never overrides Python keywords or built-in names',()=>{
  for(const language of ['ai-python','tilelang','triton']) {
    const host=document.createElement('div');host.innerHTML=highlighter.highlight('async def run(x):\n    result = await(infer(x))\n    del(x)\n    return sum(result)\n',{language}).value;
    for(const word of ['await','del'])assert.ok([...host.querySelectorAll('.hljs-keyword')].some(n=>n.textContent===word),language+'/'+word);
    assert.ok([...host.querySelectorAll('.hljs-built_in')].some(n=>n.textContent==='sum'),language+'/sum');
  }
});
