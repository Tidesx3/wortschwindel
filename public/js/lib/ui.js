import { h, $ } from './dom.js';
import { t } from '../i18n.js';
import { storage } from './storage.js';

let toastContainer = null;

export function toast(message, { type = 'info', duration = 3500 } = {}) {
  if (!toastContainer) {
    toastContainer = h('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.append(toastContainer);
  }
  const el = h('div', { class: `toast toast-${type}` }, message);
  toastContainer.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

/** Modal dialog built on <dialog>. Resolves with the clicked button value, or null. */
export function dialog({ title, message, buttons, input = null, body = null }) {
  if (typeof HTMLDialogElement !== 'function') {
    // Safari < 15.4: fall back to native dialogs.
    const text = [title, message].filter(Boolean).join('\n\n');
    if (input) {
      const value = window.prompt(text, input.value ?? '');
      return Promise.resolve(value === null ? null : { value: 'ok', text: value });
    }
    const confirmButton = buttons.find((b) => b.value !== 'cancel');
    return Promise.resolve(window.confirm(text) ? confirmButton?.value ?? 'ok' : null);
  }
  return new Promise((resolve) => {
    const field = input
      ? h(input.multiline ? 'textarea' : 'input', {
          class: 'input',
          value: input.value ?? '',
          maxlength: input.maxLength ?? 400,
          rows: input.multiline ? 4 : undefined,
        })
      : null;
    if (field && input.multiline) field.value = input.value ?? '';
    const el = h(
      'dialog',
      { class: 'modal' },
      h(
        'form',
        { method: 'dialog' },
        title && h('h2', {}, title),
        message && h('p', {}, message),
        body,
        field,
        h(
          'div',
          { class: 'modal-actions' },
          buttons.map((button) =>
            h('button', { class: `btn ${button.class ?? ''}`, value: button.value, type: 'submit' }, button.label),
          ),
        ),
      ),
    );
    el.addEventListener('close', () => {
      const value = el.returnValue;
      el.remove();
      if (!value || value === 'cancel') resolve(null);
      else resolve(field ? { value, text: field.value } : value);
    });
    el.addEventListener('cancel', () => {
      el.returnValue = 'cancel';
    });
    document.body.append(el);
    el.showModal();
    (field ?? el.querySelector('button:last-child'))?.focus();
  });
}

export async function confirmDialog(message, { confirmLabel = t.common.confirm, danger = true, title = null } = {}) {
  const result = await dialog({
    title,
    message,
    buttons: [
      { label: t.common.cancel, value: 'cancel', class: 'btn-ghost' },
      { label: confirmLabel, value: 'ok', class: danger ? 'btn-danger' : 'btn-primary' },
    ],
  });
  return result === 'ok';
}

export async function promptDialog(message, value = '', { maxLength = 100, multiline = false } = {}) {
  const result = await dialog({
    message,
    input: { value, maxLength, multiline },
    buttons: [
      { label: t.common.cancel, value: 'cancel', class: 'btn-ghost' },
      { label: t.common.save, value: 'ok', class: 'btn-primary' },
    ],
  });
  return result ? result.text : null;
}

// ---------------------------------------------------------------- theme & fullscreen

export function initTheme(defaultTheme = 'light') {
  applyTheme(storage.get('theme', defaultTheme));
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  storage.set('theme', theme);
}

export function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

export function toggleFullscreen() {
  const doc = document;
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc);
  } else {
    const el = doc.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
  }
}

export function focusFirst(selector, root = document) {
  $(selector, root)?.focus();
}
