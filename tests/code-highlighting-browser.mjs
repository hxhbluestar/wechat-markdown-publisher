import {CODE_SAMPLES} from './code-samples.mjs';
const results=[],report=document.querySelector('#code-report');
const check=(condition,label)=>{if(!condition)throw new Error(label);results.push('PASS '+label);};
const fence=(lang,code)=>'```'+lang+'\n'+code+'\n```';
function luminance(rgb){return rgb.match(/[\d.]+/g).slice(0,3).map(v=>{v=Number(v)/255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);}
function contrast(a,b){const x=luminance(a),y=luminance(b);return(Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);}
try {
  const entry=await fetch('/editor/',{cache:'no-store'}).then(r=>r.text());
  const script=new DOMParser().parseFromString(entry,'text/html').querySelector('script[type="module"][crossorigin]');
  const renderer=await import(script.getAttribute('src'));
  for(const theme of ['technical','journal','minimal','obsidian','deepsea','teal']) {
    for(const [lang,code] of Object.entries(CODE_SAMPLES)) {
      const markdown=fence(lang,code),options={code_wrap:'scroll'};
      const preview=renderer.previewWechatArticle(markdown,theme,'blue',options);
      const host=document.createElement('article');host.innerHTML=renderer.exportWechatArticle(markdown,theme,'blue',options);
      host.style.width='327px';document.body.append(host);
      const pre=host.querySelector('pre'),output=pre.querySelector('code'),tokens=[...output.querySelectorAll('span[style*="color"]')];
      check(output.textContent===code,theme+'/'+lang+' original characters survive real export');
      check(!host.querySelector('[class],script,style,button,iframe'),theme+'/'+lang+' colors do not depend on classes or scripts');
      check(tokens.length>0,theme+'/'+lang+' tokens survive inline export');
      check(new DOMParser().parseFromString(preview.html,'text/html').querySelector('pre code').textContent===code,theme+'/'+lang+' preview and export agree');
      check(getComputedStyle(output).fontSize==='14px'&&getComputedStyle(pre).tabSize==='4',theme+'/'+lang+' readable code size and tabs');
      const bg=getComputedStyle(pre).backgroundColor;
      check(tokens.every(n=>contrast(getComputedStyle(n).color,bg)>=4.5),theme+'/'+lang+' every syntax token has at least 4.5:1 contrast');
      check(host.scrollWidth<=host.clientWidth+1,theme+'/'+lang+' stays within phone article');
      host.remove();
    }
    const long=CODE_SAMPLES.python+'result = "'+('AI_ROCM_'.repeat(40))+'"\n';
    for(const width of [278,327,690,744,820,1180])for(const mode of ['wrap','scroll']) {
      const host=document.createElement('article');host.style.width=width+'px';host.innerHTML=renderer.exportWechatArticle(fence('python',long),theme,'blue',{code_wrap:mode});document.body.append(host);
      const pre=host.querySelector('pre'),code=host.querySelector('pre code');
      check(code.textContent===long && host.scrollWidth<=width+1,theme+'/'+width+'/'+mode+' contains complete long code');
      if(mode==='wrap')check(pre.scrollWidth<=pre.clientWidth+1,theme+'/'+width+' wrapped lines fit');
      else {pre.scrollLeft=pre.scrollWidth;check(pre.scrollLeft>0,theme+'/'+width+' long line can scroll to its end');}
      host.remove();
    }
  }
  for(const [title,theme,lang] of [['AMD 技术蓝 · TileLang','technical','tilelang'],['AMD 技术蓝 · PyTorch','technical','python'],['曜石青 · Triton','obsidian','triton'],['纸感期刊 · HIP','journal','hip'],['极简墨色 · PowerShell','minimal','powershell'],['AMD 技术蓝 · Bash','technical','bash']]) {
    const card=document.createElement('section');card.className='sample';const heading=document.createElement('h2');heading.textContent=title;card.append(heading);
    const article=document.createElement('article');article.innerHTML=renderer.exportWechatArticle(fence(lang,CODE_SAMPLES[lang]),theme,'blue',{code_wrap:'wrap'});card.append(article);document.querySelector('#code-gallery').append(card);
  }
  report.textContent=results.join('\n')+'\n'+results.length+' checks passed';report.dataset.result='pass';
}catch(error){report.textContent=results.join('\n')+'\nFAIL '+error.stack;report.dataset.result='fail';}
