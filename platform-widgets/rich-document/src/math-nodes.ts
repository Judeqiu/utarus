/**
 * TipTap atom nodes for inline / display math.
 * Source of truth: data-latex (Markdown $$ / \[ \] / \( \)).
 * Screen: KaTeX. Double-click in edit mode prompts to edit LaTeX.
 */

import { Node, mergeAttributes, type NodeViewRendererProps } from '@tiptap/core';
import katex from 'katex';

function renderKatex(dom: HTMLElement, latex: string, displayMode: boolean): void {
  dom.replaceChildren();
  const src = latex.trim();
  if (!src) {
    dom.textContent = displayMode ? '[empty equation]' : '∅';
    return;
  }
  try {
    katex.render(src, dom, {
      throwOnError: false,
      displayMode,
      output: 'html',
      strict: 'ignore',
    });
  } catch {
    dom.textContent = src;
  }
  dom.setAttribute('data-latex', latex);
  dom.setAttribute('title', src);
}

function createMathNodeView(displayMode: boolean) {
  return ({ node, editor, getPos }: NodeViewRendererProps) => {
    const dom = document.createElement(displayMode ? 'div' : 'span');
    dom.className = displayMode ? 'math-node math-display' : 'math-node math-inline';
    dom.setAttribute('data-type', displayMode ? 'math-display' : 'math-inline');
    dom.setAttribute('contenteditable', 'false');
    let latex = String(node.attrs.latex ?? '');
    renderKatex(dom, latex, displayMode);

    const onDblClick = (e: MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (!editor.isEditable) return;
      const next = window.prompt(
        displayMode ? 'Edit display equation (LaTeX)' : 'Edit inline equation (LaTeX)',
        latex,
      );
      if (next == null) return;
      const pos = getPos();
      if (typeof pos !== 'number') return;
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setNodeMarkup(pos, undefined, { latex: next });
          return true;
        })
        .run();
    };
    dom.addEventListener('dblclick', onDblClick);

    return {
      dom,
      update(updated) {
        if (updated.type.name !== node.type.name) return false;
        const nextLatex = String(updated.attrs.latex ?? '');
        if (nextLatex !== latex) {
          latex = nextLatex;
          renderKatex(dom, latex, displayMode);
        }
        return true;
      },
      destroy() {
        dom.removeEventListener('dblclick', onDblClick);
      },
      ignoreMutation: () => true,
      selectNode() {
        dom.classList.add('math-node-selected');
      },
      deselectNode() {
        dom.classList.remove('math-node-selected');
      },
    };
  };
}

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-latex') ?? '',
        renderHTML: (attrs) => ({ 'data-latex': attrs.latex ?? '' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="math-inline"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'math-inline',
        class: 'math-node math-inline',
      }),
    ];
  },

  addNodeView() {
    return createMathNodeView(false);
  },
});

export const MathDisplay = Node.create({
  name: 'mathDisplay',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  defining: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-latex') ?? '',
        renderHTML: (attrs) => ({ 'data-latex': attrs.latex ?? '' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="math-display"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'math-display',
        class: 'math-node math-display',
      }),
    ];
  },

  addNodeView() {
    return createMathNodeView(true);
  },
});
