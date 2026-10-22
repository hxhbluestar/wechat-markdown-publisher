/** Read publishing HTML's explicit line breaks without normalizing code data. */
export function publishedCodeText(node) {
  return node.nodeType===3 ? node.nodeValue : node.hasAttribute?.('data-wx-code-line-number') ? '' : node.tagName==='BR' ? '\n' : [...node.childNodes].map(publishedCodeText).join('');
}
