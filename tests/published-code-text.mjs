/** Read publishing HTML's explicit line breaks without normalizing code data. */
export function publishedCodeText(node) {
  return node.nodeType===3 ? node.nodeValue : node.tagName==='BR' ? '\n' : [...node.childNodes].map(publishedCodeText).join('');
}
