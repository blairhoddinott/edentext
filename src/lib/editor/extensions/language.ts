import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import '@tiptap/extension-text-style';
import { asianLang, isAsianTag, westLang } from '../../storage/documentLanguage';

// The language of a paragraph and of a run, the two levels LibreOffice and Word both
// carry (ODF fo:language/fo:country, Word w:lang). The value is the full tag ('en-US'),
// not one of our dictionary codes: a document in a language we have no dictionary for
// must still save the language it came with. Each level carries a western language
// (`lang`) and an asian one (`langAsian`), the two slots both formats keep.

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    language: {
      /** The paragraph's language; null falls back to the document's. */
      setBlockLanguage: (tag: string | null) => ReturnType;
      /** The selection's language, as a run. */
      setRunLanguage: (tag: string | null) => ReturnType;
    };
  }
}

// A real `lang` attribute, not a data-*: CSS hyphenation and the browser's own spell
// check both read it. It names the western language, the asian one only where there is
// none, which is also how a pasted asian `lang` comes in.
const blockAttr = {
  lang: {
    default: null as string | null,
    parseHTML: (element: HTMLElement) => westLang(element.getAttribute('lang')),
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.lang ? { lang: String(attributes.lang) } : {},
  },
  langAsian: {
    default: null as string | null,
    parseHTML: (element: HTMLElement) =>
      element.getAttribute('data-lang-asian') || asianLang(element.getAttribute('lang')),
    renderHTML: (attributes: Record<string, unknown>) => {
      if (!attributes.langAsian) return {};
      const tag = String(attributes.langAsian);
      return attributes.lang ? { 'data-lang-asian': tag } : { 'data-lang-asian': tag, lang: tag };
    },
  },
};

// The slot a tag goes to; null clears both.
const slot = (tag: string | null) =>
  tag === null ? { lang: null, langAsian: null } : isAsianTag(tag) ? { langAsian: tag } : { lang: tag };

const differs = (attrs: Record<string, unknown>, want: Record<string, string | null | undefined>) =>
  Object.entries(want).some(([k, v]) => (attrs[k] ?? null) !== v);

export const Language = Extension.create({
  name: 'language',

  addOptions() {
    return {
      types: ['paragraph', 'heading'] as string[],
    };
  },

  addGlobalAttributes() {
    return [
      { types: this.options.types, attributes: blockAttr },
      { types: ['textStyle'], attributes: blockAttr },
    ];
  },

  addCommands() {
    return {
      // Only a block or run whose language differs is rewritten: the document's language
      // clears every override, and a block rewritten for nothing is redrawn and undoable.
      setBlockLanguage: (tag) => ({ tr, state, dispatch }) => {
        const want = slot(tag);
        const types = this.options.types;
        const { from, to, empty, $from } = state.selection;
        const blocks: [PMNode, number][] = [];
        if (empty) {
          for (let d = $from.depth; d > 0; d--) {
            if (types.includes($from.node(d).type.name)) { blocks.push([$from.node(d), $from.before(d)]); break; }
          }
        } else {
          state.doc.nodesBetween(from, to, (n, pos) => { if (types.includes(n.type.name)) blocks.push([n, pos]); });
        }
        if (dispatch) {
          for (const [n, pos] of blocks) if (differs(n.attrs, want)) tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...want });
        }
        return blocks.length > 0;
      },

      setRunLanguage: (tag) => ({ state, chain }) => {
        const want = slot(tag);
        const { from, to, empty } = state.selection;
        let change = empty;
        if (!empty) {
          state.doc.nodesBetween(from, to, (n) => {
            if (n.isText) change ||= differs(n.marks.find((m) => m.type.name === 'textStyle')?.attrs ?? {}, want);
          });
        }
        return change ? chain().setMark('textStyle', want).removeEmptyTextStyle().run() : true;
      },
    };
  },
});
