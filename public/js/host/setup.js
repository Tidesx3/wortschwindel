import { h, replace } from '../lib/dom.js';
import { storage } from '../lib/storage.js';
import { t } from '../i18n.js';

const H = t.host;
const S = H.settings;

/** Login (PIN) and room selection screens. */
export function renderSetup(root, options) {
  if (options.mode === 'login') renderLogin(root, options);
  else renderRooms(root, options);
}

function renderLogin(root, { onLogin, error }) {
  const errorEl = h('p', { class: 'form-error', role: 'alert' }, error ?? '');
  const input = h('input', {
    class: 'input input-code',
    type: 'password',
    name: 'pin',
    required: true,
    autocomplete: 'current-password',
    inputmode: 'numeric',
    maxlength: 64,
  });
  const form = h(
    'form',
    {
      class: 'card setup-card',
      onsubmit: async (event) => {
        event.preventDefault();
        const submit = form.querySelector('button');
        submit.disabled = true;
        const message = await onLogin(input.value);
        submit.disabled = false;
        if (message) {
          errorEl.textContent = message;
          input.select();
        }
      },
    },
    h('h1', { class: 'setup-logo' }, t.appName),
    h('h2', {}, H.pinTitle),
    h('label', { class: 'field' }, h('span', {}, H.pinLabel), input),
    errorEl,
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, H.login),
  );
  replace(root, form);
  input.focus();
}

function numberField(name, label, value, { min, max }) {
  return h(
    'label',
    { class: 'field' },
    h('span', {}, label),
    h('input', { class: 'input', type: 'number', name, value: String(value), min, max, required: true }),
  );
}

function checkField(name, label, checked) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked }), h('span', {}, label));
}

function renderRooms(root, { auth, onCreate, onResume, onLogout }) {
  const saved = storage.get('lastSettings', {});
  const defaults = {
    rounds: 6,
    writingSeconds: 90,
    votingSeconds: 45,
    readAloudMode: true,
    allowLateJoin: false,
    ...saved,
  };
  const lists = auth.wordlists ?? [];
  const select = h(
    'select',
    { class: 'input', name: 'wordlist' },
    lists.map((list) => h('option', { value: list.name, selected: list.name === defaults.wordlist }, `${list.title} (${list.count})`)),
  );

  const form = h(
    'form',
    {
      class: 'card setup-card',
      onsubmit: async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const settings = {
          rounds: Number(data.get('rounds')),
          writingSeconds: Number(data.get('writingSeconds')),
          votingSeconds: Number(data.get('votingSeconds')),
          wordlist: String(data.get('wordlist') ?? ''),
          readAloudMode: data.get('readAloudMode') === 'on',
          allowLateJoin: data.get('allowLateJoin') === 'on',
        };
        storage.set('lastSettings', settings);
        form.querySelector('button[type=submit]').disabled = true;
        await onCreate(settings);
        form.querySelector('button[type=submit]').disabled = false;
      },
    },
    h('h2', {}, H.createTitle),
    h(
      'div',
      { class: 'setup-grid' },
      numberField('rounds', S.rounds, defaults.rounds, { min: 1, max: 50 }),
      numberField('writingSeconds', S.writingSeconds, defaults.writingSeconds, { min: 0, max: 900 }),
      numberField('votingSeconds', S.votingSeconds, defaults.votingSeconds, { min: 0, max: 900 }),
    ),
    h('label', { class: 'field' }, h('span', {}, S.wordlist), select),
    checkField('readAloudMode', S.readAloudMode, defaults.readAloudMode),
    checkField('allowLateJoin', S.allowLateJoin, defaults.allowLateJoin),
    h('p', { class: 'muted small' }, 'Weitere Einstellungen (Punkte, Kategorien, eigene Wortliste …) findest du danach im Steuerpult.'),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit', disabled: !lists.length }, H.create),
    !lists.length && h('p', { class: 'notice notice-danger' }, t.errors.noWords),
  );

  const rooms = auth.rooms ?? [];
  const roomList = h(
    'section',
    { class: 'card setup-card' },
    h('h2', {}, H.resumeTitle),
    rooms.length
      ? h(
          'ul',
          { class: 'room-list' },
          rooms
            .sort((a, b) => b.lastActivity - a.lastActivity)
            .map((room) =>
              h(
                'li',
                {},
                h('span', {}, H.roomInfo(room.code, room.players, H.phase[room.phase] ?? room.phase)),
                h('button', { class: 'btn btn-small', type: 'button', onclick: () => onResume(room.code) }, H.resume),
              ),
            ),
        )
      : h('p', { class: 'muted' }, H.noRooms),
    h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: onLogout }, H.logout),
  );

  replace(
    root,
    h(
      'div',
      { class: 'setup-layout' },
      h('h1', { class: 'setup-logo' }, `${t.appName} · ${H.title}`),
      auth.pinIsDefault && h('p', { class: 'notice notice-warning' }, H.pinDefaultWarning),
      form,
      roomList,
    ),
  );
}
