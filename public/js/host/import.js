import { add, h } from '../lib/dom.js';
import { toast } from '../lib/ui.js';
import { t } from '../i18n.js';

const I = t.host.import;
const MAX_BYTES = 500 * 1024;

// Kept across re-renders so a typed CSV is not lost.
const draft = { format: 'csv', content: '', title: '', preview: null, fileName: '' };

export function renderImport(container, view, { act }) {
  const info = view.host.wordlist;
  const previewBox = h('div', { class: 'import-preview' });

  function showPreview(preview) {
    draft.preview = preview;
    previewBox.replaceChildren();
    if (!preview) return;
    add(previewBox, 
      h('p', { class: preview.valid ? 'notice notice-success' : 'notice notice-danger' }, I.result(preview.valid, preview.invalid)),
      preview.sample.length > 0 && h('p', { class: 'small' }, I.sample(preview.sample.join(', '))),
      preview.errors.length > 0 &&
        h(
          'ul',
          { class: 'import-errors small' },
          preview.errors.map((error) => h('li', {}, error)),
          preview.moreErrors > 0 && h('li', {}, `… +${preview.moreErrors}`),
        ),
      preview.applied && h('p', { class: 'notice notice-success' }, I.applied),
    );
  }

  async function send(apply) {
    if (!draft.content.trim()) return;
    const result = await act('host:importWordlist', {
      format: draft.format,
      content: draft.content,
      title: draft.title || draft.fileName || undefined,
      apply,
    });
    if (result) showPreview(result.preview);
  }

  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json,.csv,text/csv,text/plain',
    class: 'input',
    onchange: async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > MAX_BYTES) {
        toast(I.fileTooLarge, { type: 'error' });
        return;
      }
      draft.content = await file.text();
      draft.format = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
      draft.fileName = file.name.replace(/\.[^.]+$/, '');
      if (draft.format === 'csv') textarea.value = draft.content;
      send(false);
    },
  });

  const textarea = h('textarea', {
    class: 'input import-textarea',
    rows: 8,
    placeholder: I.csvPlaceholder,
    spellcheck: 'false',
    oninput: (event) => {
      draft.content = event.target.value;
      draft.format = 'csv';
      draft.fileName = '';
    },
  });
  textarea.value = draft.format === 'csv' ? draft.content : '';

  add(container, 
    h('h3', {}, I.title),
    info.custom && h('p', { class: 'notice' }, t.host.settings.customList(info.title, info.total)),
    h('label', { class: 'field' }, h('span', {}, I.listTitle), h('input', {
      class: 'input',
      maxlength: 60,
      value: draft.title,
      oninput: (event) => {
        draft.title = event.target.value;
      },
    })),
    h('label', { class: 'field' }, h('span', {}, I.json), fileInput),
    h('label', { class: 'field' }, h('span', {}, I.csv), h('small', { class: 'muted' }, I.csvHelp), textarea),
    h(
      'div',
      { class: 'panel-row' },
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => send(false) }, I.preview),
      h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => send(true) }, I.apply),
    ),
    previewBox,
  );
  showPreview(draft.preview);
}
