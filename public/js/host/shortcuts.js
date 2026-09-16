import { h } from '../lib/dom.js';
import { dialog } from '../lib/ui.js';
import { t } from '../i18n.js';

const K = t.host.shortcuts;

export function showShortcutHelp() {
  if (document.querySelector('dialog[open]')) return;
  dialog({
    title: K.title,
    body: h(
      'ul',
      { class: 'shortcut-list' },
      [K.next, K.prevHighlight, K.pause, K.addTime, K.setTimer, K.fullscreen, K.panel, K.mute, K.help].map((line) => h('li', {}, line)),
    ),
    buttons: [{ label: t.common.close, value: 'ok', class: 'btn-primary' }],
  });
}

export function initShortcuts(actions) {
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))) return;
    if (document.querySelector('dialog[open]')) return;
    if (document.getElementById('console')?.hidden) return;
    // Buttons keep their native space/enter behaviour.
    if (target instanceof HTMLButtonElement && (event.key === ' ' || event.key === 'Enter')) return;

    const map = {
      ' ': actions.next,
      ArrowRight: actions.forward,
      PageDown: actions.forward,
      ArrowLeft: actions.back,
      PageUp: actions.back,
      p: actions.pause,
      P: actions.pause,
      '+': actions.addTime,
      t: actions.setTimer,
      T: actions.setTimer,
      f: actions.fullscreen,
      F: actions.fullscreen,
      s: actions.panel,
      S: actions.panel,
      m: actions.mute,
      M: actions.mute,
      '?': showShortcutHelp,
    };
    const action = map[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });
}
