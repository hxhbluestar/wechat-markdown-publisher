import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
let preserveWechatCodeLayout;
try { ({preserveWechatCodeLayout}=await import('../frontend/publishing-presentation.mjs')); }
catch(error) { if(error.code!=='ERR_MODULE_NOT_FOUND') throw error; }
const {document}=parseHTML('<html><body></body></html>');
test('publishing code uses explicit breaks and indentation geometry without changing code characters',()=>{
  assert.equal(typeof preserveWechatCodeLayout,'function');
  const html='<pre style="white-space:pre-wrap"><code><span style="color:#008080">if</span> True:\n\tprint("x")\n\n  # END</code></pre>';
  const root=document.createElement('div');
  root.innerHTML=preserveWechatCodeLayout(html,document);
  const code=root.querySelector('code');
  assert.equal(code.querySelectorAll('br').length,3);
  assert.ok(code.textContent.includes('\tprint'));
  assert.equal(code.querySelector('[data-wx-code-indent]').style.getPropertyValue('width'),'4ch');
  assert.equal(code.textContent.includes('\u00a0'),false);
  assert.equal(code.querySelector('span').style.getPropertyValue('color'),'#008080');
  const read=node=>node.nodeType===3?node.nodeValue:node.nodeName==='BR'?'\n':[...node.childNodes].map(read).join('');
  assert.equal(read(code),'if True:\n\tprint("x")\n\n  # END');
  assert.equal(preserveWechatCodeLayout(root.innerHTML,document),root.innerHTML);
});
