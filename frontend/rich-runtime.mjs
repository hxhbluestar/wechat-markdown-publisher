/** Only pinned, self-hosted code. Call before native Markdown math rendering. */
export const MERMAID_MODULE_URL = "/editor/assets/mermaid.core-CgMKsg4i.js";
export const MATHJAX_SCRIPT_URL = "/vendor/mathjax-3.2.2/tex-svg.js";
const runtimes = new WeakMap();
const mathOwners = new WeakMap();

function ownsCompletedMath(document, window, owner) {
  return (
    owner?.completed &&
    owner.document === document &&
    window.MathJax === owner.instance &&
    document.getElementById("local-rich-mathjax-3-2-2") === owner.script &&
    owner.script.getAttribute("src") === MATHJAX_SCRIPT_URL
  );
}

function bounded(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Local rich runtime load timeout")),
      milliseconds,
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        reject(new Error("Local rich runtime failed to load"));
      },
    );
  });
}

function loadMathJax(document, window, timeoutMs) {
  const previous = mathOwners.get(window);
  if (ownsCompletedMath(document, window, previous))
    return Promise.resolve(previous.instance);
  // Do not adopt an unknown CDN-loaded global or replace an in-flight loader.
  if (
    previous ||
    "MathJax" in window ||
    document.getElementById("MathJax-script") ||
    document.getElementById("local-rich-mathjax-3-2-2")
  )
    return Promise.reject(
      new Error(
        "Initialize the local math runtime before native Markdown rendering",
      ),
    );
  const config = {
    loader: { load: [], paths: { mathjax: "/vendor/mathjax-3.2.2" } },
    // tex-svg bundles these extensions by default. Remove them at component
    // initialization, before the TeX parser is built; no \require or autoload.
    tex: {
      packages: {
        "[-]": ["autoload", "require", "html", "configmacros", "noundefined"],
      },
      maxBuffer: 20000,
      maxMacros: 1000,
    },
    svg: { fontCache: "none" },
    startup: { typeset: false },
    options: { enableMenu: false, renderActions: { addMenu: [] } },
  };
  window.MathJax = config;
  const script = document.createElement("script");
  script.id = "local-rich-mathjax-3-2-2";
  script.src = MATHJAX_SCRIPT_URL;
  const owner = { document, script, completed: false, instance: null };
  mathOwners.set(window, owner);
  let active = true;
  const loading = new Promise((resolve, reject) => {
    script.onload = () => {
      const instance = window.MathJax;
      Promise.resolve(instance?.startup?.promise).then(() => {
        if (!active) return;
        if (
          typeof instance?.tex2svg !== "function" ||
          window.MathJax !== instance
        )
          reject(new Error("Local math runtime is unavailable"));
        else {
          owner.instance = instance;
          owner.completed = true;
          resolve(instance);
        }
      }, reject);
    };
    script.onerror = () =>
      reject(new Error("Local math runtime failed to load"));
    document.head.appendChild(script);
  });
  return bounded(loading, timeoutMs).catch((error) => {
    active = false;
    script.remove();
    if (window.MathJax === config) {
      delete window.MathJax;
      mathOwners.delete(window);
    }
    throw error;
  });
}

/** Dynamic imports are injectable for deterministic tests, never article URLs. */
export async function loadRichRuntime({
  document = globalThis.document,
  window = document?.defaultView,
  timeoutMs = 10000,
  importMermaid = () => import("/editor/assets/mermaid.core-CgMKsg4i.js"),
} = {}) {
  if (
    !document?.createElement ||
    !window ||
    typeof importMermaid !== "function" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000
  )
    throw new TypeError("Invalid local rich runtime options");
  if (runtimes.has(window)) {
    const owner = mathOwners.get(window);
    if (owner?.completed && !ownsCompletedMath(document, window, owner))
      throw new Error("Local rich runtime ownership changed");
    return runtimes.get(window);
  }
  const promise = bounded(
    Promise.all([
      Promise.resolve()
        .then(importMermaid)
        .then((module) => {
          const mermaid = module?.aX?.default ?? module?.default;
          if (!mermaid) throw new Error("Local Mermaid runtime is unavailable");
          return mermaid;
        }),
      loadMathJax(document, window, timeoutMs),
    ]).then(([mermaid, mathjax]) => ({ mermaid, mathjax })),
    timeoutMs,
  );
  runtimes.set(window, promise);
  try {
    return await promise;
  } catch (error) {
    runtimes.delete(window);
    throw error;
  }
}
