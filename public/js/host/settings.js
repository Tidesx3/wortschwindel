import { add, h } from '../lib/dom.js';
import { toast } from '../lib/ui.js';
import { t } from '../i18n.js';

const S = t.host.settings;

// Mirrors IN_GAME_KEYS on the server.
const IN_GAME = new Set([
  'rounds',
  'writingSeconds',
  'votingSeconds',
  'autoAdvanceOnTimer',
  'autoModeration',
  'autoRevealWhenAllVoted',
  'readAloudMode',
  'showWordClass',
  'allowLateJoin',
  'maxPlayers',
]);

export function renderSettings(container, view, { act }) {
  const settings = view.host.settings;
  const info = view.host.wordlist;
  const editable = view.phase === 'LOBBY' || view.phase === 'GAME_OVER';
  const locked = (key) => !editable && !IN_GAME.has(key);

  async function save(partial) {
    const result = await act('host:updateSettings', { settings: partial });
    if (result) toast(S.saved, { type: 'success', duration: 1200 });
  }

  const number = (key, label, { min, max }) =>
    h(
      'label',
      { class: 'field field-inline' },
      h('span', {}, label),
      h('input', {
        class: 'input input-number',
        type: 'number',
        min,
        max,
        value: String(settings[key]),
        disabled: locked(key),
        onchange: (event) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value)) save({ [key]: value });
        },
      }),
    );

  const check = (key, label) =>
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: Boolean(settings[key]),
        disabled: locked(key),
        onchange: (event) => save({ [key]: event.target.checked }),
      }),
      h('span', {}, label),
    );

  const pointsField = (key, label) =>
    h(
      'label',
      { class: 'field field-inline' },
      h('span', {}, label),
      h('input', {
        class: 'input input-number',
        type: 'number',
        min: 0,
        max: 20,
        value: String(settings.points[key]),
        disabled: locked('points'),
        onchange: (event) => save({ points: { [key]: Number(event.target.value) } }),
      }),
    );

  const lists = view.host.wordlists ?? [];
  const currentList = lists.find((l) => l.name === settings.wordlist);
  const categories = info.custom ? info.categories : currentList?.categories ?? [];
  const difficulties = info.custom ? [] : currentList?.difficulties ?? [];

  const toggleInList = (key, value, checked) => {
    const next = new Set(settings[key]);
    if (checked) next.add(value);
    else next.delete(value);
    save({ [key]: [...next] });
  };

  const remainingRounds = settings.rounds - (editable ? 0 : view.roundNumber);
  const warning = info.unused < remainingRounds;

  const screenUrl = `${location.origin}/screen/${encodeURIComponent(view.code)}?token=${encodeURIComponent(view.host.screenToken)}`;

  add(container,
    h(
      'label',
      { class: 'field' },
      h('span', {}, S.screenLink),
      h('input', { class: 'input screen-link', readonly: true, value: screenUrl, onfocus: (event) => event.target.select() }),
      h('small', { class: 'muted' }, S.screenLinkHint),
    ),
    !editable && h('p', { class: 'notice small' }, S.inGameNote),
    h('h3', {}, t.host.tabs.settings),
    number('rounds', S.rounds, { min: 1, max: 50 }),
    number('writingSeconds', S.writingSeconds, { min: 0, max: 900 }),
    number('votingSeconds', S.votingSeconds, { min: 0, max: 900 }),
    number('maxDefinitionLength', S.maxDefinitionLength, { min: 30, max: 300 }),
    number('maxPlayers', S.maxPlayers, { min: 2, max: 100 }),
    check('readAloudMode', S.readAloudMode),
    check('autoAdvanceOnTimer', S.autoAdvanceOnTimer),
    check('autoModeration', S.autoModeration),
    check('autoRevealWhenAllVoted', S.autoRevealWhenAllVoted),
    check('showWordClass', S.showWordClass),
    check('standardizeAnswers', S.standardizeAnswers),
    check('allowLateJoin', S.allowLateJoin),

    h('h3', {}, S.wordlist),
    info.custom
      ? h('p', { class: 'notice' }, S.customList(info.title, info.total))
      : h(
          'select',
          {
            class: 'input',
            disabled: locked('wordlist'),
            onchange: (event) => save({ wordlist: event.target.value, categories: [], difficulties: [] }),
          },
          lists.map((list) => h('option', { value: list.name, selected: list.name === settings.wordlist }, `${list.title} (${list.count})`)),
        ),
    info.custom &&
      h(
        'button',
        { class: 'btn btn-small btn-ghost', type: 'button', disabled: !editable, onclick: () => act('host:clearCustomWordlist') },
        S.removeCustom,
      ),
    categories.length > 0 &&
      h(
        'fieldset',
        { class: 'fieldset', disabled: locked('categories') },
        h('legend', {}, S.categories),
        categories.map((category) =>
          h(
            'label',
            { class: 'check check-inline' },
            h('input', {
              type: 'checkbox',
              checked: settings.categories.includes(category),
              onchange: (event) => toggleInList('categories', category, event.target.checked),
            }),
            h('span', {}, category),
          ),
        ),
      ),
    difficulties.length > 0 &&
      h(
        'fieldset',
        { class: 'fieldset', disabled: locked('difficulties') },
        h('legend', {}, S.difficulties),
        difficulties.map((difficulty) =>
          h(
            'label',
            { class: 'check check-inline' },
            h('input', {
              type: 'checkbox',
              checked: settings.difficulties.includes(difficulty),
              onchange: (event) => toggleInList('difficulties', difficulty, event.target.checked),
            }),
            h('span', {}, '★'.repeat(difficulty)),
          ),
        ),
      ),
    h('p', { class: warning ? 'notice notice-warning' : 'muted small' }, warning ? S.notEnoughWords(info.unused, remainingRounds) : S.wordsAvailable(info.matching)),

    h('h3', {}, S.points),
    pointsField('correctVote', S.pointsCorrect),
    pointsField('perFooled', S.pointsFooled),
    pointsField('markedCorrect', S.pointsMarked),
    pointsField('favorite', S.pointsFavorite),
    view.host.devShortTimers && h('p', { class: 'notice notice-warning small' }, 'DEV_SHORT_TIMERS aktiv'),
  );
}
