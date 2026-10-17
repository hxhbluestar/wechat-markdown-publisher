import { scanCodeRegions } from "./technical-writing.mjs";
export function codeFoldRanges(text) {
  return scanCodeRegions(text)
    .fences.filter((f) => f.closed)
    .map((f) => {
      const from = text.indexOf("\n", f.from) + 1;
      let to = f.to;
      while (to > from && /[\r\n]/.test(text[to - 1])) to--;
      return {
        from,
        to,
        lines: text
          .slice(f.bodyFrom, f.bodyTo)
          .replace(/\r?\n$/, "")
          .split("\n").length,
      };
    })
    .filter((r) => r.from > 0 && r.to > r.from);
}
export function createCodeFolding({
  StateField,
  StateEffect,
  Decoration,
  EditorView,
  WidgetType,
}) {
  const effect = StateEffect.define();
  class FoldWidget extends WidgetType {
    constructor(range) {
      super();
      this.range = range;
    }
    eq(other) {
      return (
        other.range.from === this.range.from &&
        other.range.lines === this.range.lines
      );
    }
    toDOM(view) {
      const b = view.dom.ownerDocument.createElement("button");
      b.type = "button";
      b.className = "code-fold-widget";
      b.textContent = `展开 ${this.range.lines} 行代码`;
      b.addEventListener("click", () =>
        view.dispatch({ effects: effect.of({ unfold: this.range.from }) }),
      );
      return b;
    }
    ignoreEvent() {
      return false;
    }
  }
  const make = (state, folded, excluded) =>
    folded
      ? Decoration.set(
          codeFoldRanges(state.doc.toString())
            .filter((r) => !excluded.has(r.from))
            .map((r) =>
              Decoration.replace({
                widget: new FoldWidget(r),
                block: true,
              }).range(r.from, r.to),
            ),
          true,
        )
      : Decoration.none;
  const field = StateField.define({
    create: () => ({
      folded: false,
      excluded: new Set(),
      decorations: Decoration.none,
    }),
    update(value, tr) {
      let { folded, excluded } = value,
        changed = tr.docChanged;
      if (changed) excluded = new Set();
      for (const e of tr.effects)
        if (e.is(effect)) {
          if (typeof e.value.folded === "boolean") {
            folded = e.value.folded;
            excluded = new Set();
          }
          if (Number.isInteger(e.value.unfold)) {
            excluded = new Set(excluded);
            excluded.add(e.value.unfold);
          }
          changed = true;
        }
      return changed
        ? { folded, excluded, decorations: make(tr.state, folded, excluded) }
        : value;
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.decorations),
  });
  return {
    extension: field,
    field,
    effect,
    set(view, folded) {
      view?.dispatch({ effects: effect.of({ folded: !!folded }) });
    },
  };
}
