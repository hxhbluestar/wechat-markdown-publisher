/* AI/GPU extensions for the locally bundled Highlight.js 11.11.1.
 * Lexical highlighting only: no code execution, network or automatic detection.
 * Keep the upstream Python/C++ grammars intact for legacy renderers.
 */
(function (h) {
  'use strict';
  if (!h || h.getLanguage('ai-python')) return;

  function clone(value, seen = new Map()) {
    if (!value || typeof value !== 'object' || value instanceof RegExp) return value;
    if (seen.has(value)) return seen.get(value);
    const result = Array.isArray(value) ? [] : {};
    seen.set(value, result);
    for (const key of Object.keys(value)) result[key] = clone(value[key], seen);
    return result;
  }

  function python(name, aliases) {
    const grammar = clone(h.getLanguage('python'));
    const types = { scope: 'type', match: /\b(?:(?:torch|np|numpy|jnp|jax|tf|T|tl)\.)+(?:Tensor|Size|dtype|device|constexpr|tensor|float(?:16|32|64)?|bfloat16|int(?:8|16|32|64)?|uint(?:8|16|32|64)?|bool)\b/ };
    const api = { scope: 'built_in', match: /\b(?:torch|torchvision|torchaudio|np|numpy|jnp|jax|tf|tensorflow|nn|F|T|tl|triton|tilelang)(?:\.[A-Za-z_]\w*)+/ };
    // Function calls complement upstream definition/keyword/string modes.
    const reserved = new Set(Object.entries(grammar.keywords).filter(([key]) => !key.startsWith('$')).flatMap(([, words]) => Array.isArray(words) ? words : words.split(/\s+/)).map(word => word.split('|')[0]));
    const calls = { scope: 'title.function', match: /\b[A-Za-z_]\w*(?=\s*\()/, relevance: 0,
      'on:begin': (match, response) => { if (reserved.has(match[0])) response.ignoreMatch(); } };
    const additions = [types, api, calls];
    // Params and f-string expressions have their own mode scopes. Add tokens
    // there too, without entering comments or the literal part of strings.
    const visited = new Set();
    function extend(mode, inheritedScope) {
      if (!mode || typeof mode !== 'object' || visited.has(mode)) return;
      visited.add(mode);
      for (const child of mode.contains || []) extend(child);
      const scope = mode.scope || mode.className || inheritedScope;
      for (const child of mode.variants || []) extend(child, scope);
      extend(mode.starts);
      if (['params', 'subst'].includes(scope)) mode.contains = [...additions, ...(mode.contains || [])];
    }
    extend(grammar);
    grammar.name = name;
    grammar.aliases = aliases;
    grammar.contains = [...additions, ...grammar.contains];
    return grammar;
  }

  h.registerLanguage('ai-python', () => python('AI Python', ['python3', 'py3', 'pytorch', 'torch']));
  h.registerLanguage('tilelang', () => python('TileLang', ['tile-lang', 'tile_lang']));
  h.registerLanguage('triton', () => python('Triton', []));

  function gpuCpp(name, aliases) {
    const grammar = clone(h.getLanguage('cpp'));
    grammar.name = name;
    grammar.aliases = aliases;
    grammar.contains = [
      { scope: 'keyword', match: /\b__(?:global|device|host|shared|constant|managed|restrict|forceinline|noinline|launch_bounds)__\b/ },
      { scope: 'type', match: /\b(?:dim3|(?:u?int|float|double)[234]|__(?:half2?|nv_bfloat16|nv_bfloat162)|(?:hip|cuda)(?:Error_t|Stream_t|Event_t|DeviceProp_t))\b/ },
      { scope: 'built_in', match: /\b(?:(?:hip|cuda)[A-Z]\w*|__(?:syncthreads|syncwarp|threadfence(?:_block|_system)?|shfl\w*|ballot\w*|activemask|ldg)|atomic[A-Z]\w*|(?:threadIdx|blockIdx|blockDim|gridDim|warpSize))\b/ },
      ...grammar.contains,
    ];
    return grammar;
  }
  h.registerLanguage('hip', () => gpuCpp('HIP', ['hip-cpp']));
  h.registerLanguage('cuda', () => gpuCpp('CUDA', ['cu', 'cuh']));
  if (h.getLanguage('llvm')) h.registerAliases(['ll'], { languageName: 'llvm' });
  if (h.getLanguage('powershell')) h.registerAliases(['psm1', 'psd1'], { languageName: 'powershell' });
})(typeof hljs === 'undefined' ? null : hljs);
