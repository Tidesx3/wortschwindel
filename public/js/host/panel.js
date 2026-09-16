import { add, h, replace } from '../lib/dom.js';
import { confirmDialog, promptDialog } from '../lib/ui.js';
import { renderSettings } from './settings.js';
import { renderImport } from './import.js';
import { t } from '../i18n.js';

const H = t.host;

/**
 * Right-hand control panel with tabs. Each tab re-renders only when its data
 * changed, and never while the user is typing inside the panel.
 */
export function createPanel(root, { act, getView, onNext }) {
  const local = {
    tab: 'players',
    lastPhase: null,
    roundKey: null,
    showSecrets: false,
    selected: new Set(),
    renderedKey: null,
    dirty: false,
  };

  const tabBar = h('nav', { class: 'panel-tabs', role: 'tablist' });
  const body = h('div', { class: 'panel-body' });
  replace(root, tabBar, body);

  root.addEventListener('focusout', () => {
    setTimeout(() => {
      if (local.dirty && !root.contains(document.activeElement)) {
        local.dirty = false;
        render(getView(), true);
      }
    }, 0);
  });

  const TABS = {
    prep: {
      label: () => `🎛 ${H.tabs.prep}`,
      visible: (view) => Boolean(view.host.nextRound),
      key: (view) => JSON.stringify([view.host.nextRound, local.showSecrets, view.roundNumber]),
      render: renderPrep,
    },
    players: {
      label: () => `${H.tabs.players} (${getView()?.players.length ?? 0})`,
      visible: () => true,
      key: (view) => JSON.stringify([view.players, view.host.players, view.locked, view.phase]),
      render: renderPlayers,
    },
    moderation: {
      label: () => H.tabs.moderation,
      visible: (view) => view.phase === 'MODERATION',
      key: (view) => JSON.stringify([view.host.definitions, view.host.missing, view.host.moderationWarning, local.showSecrets, [...local.selected]]),
      render: renderModeration,
    },
    voting: {
      label: () => H.tabs.voting,
      visible: (view) => view.phase === 'VOTING' || view.phase === 'REVEAL',
      key: (view) => JSON.stringify([view.host.ballot, local.showSecrets, view.highlight]),
      render: renderBallot,
    },
    settings: {
      label: () => H.tabs.settings,
      visible: () => true,
      key: (view) => JSON.stringify([view.host.settings, view.host.wordlist, view.phase === 'LOBBY' || view.phase === 'GAME_OVER', view.host.wordlists]),
      render: (container, view) => renderSettings(container, view, { act }),
    },
    wordlist: {
      label: () => H.tabs.wordlist,
      visible: (view) => view.phase === 'LOBBY' || view.phase === 'GAME_OVER',
      key: (view) => JSON.stringify([view.host.wordlist]),
      render: (container, view) => renderImport(container, view, { act }),
    },
  };

  function update(view) {
    const roundKey = `${view.roundNumber}:${view.word?.term}`;
    if (roundKey !== local.roundKey) {
      local.roundKey = roundKey;
      local.showSecrets = false;
      local.selected.clear();
    }
    if (view.phase !== local.lastPhase) {
      if (view.phase === 'MODERATION') local.tab = 'moderation';
      else if (view.phase === 'SCOREBOARD' && TABS.prep.visible(view)) local.tab = 'prep';
      else if (!TABS[local.tab].visible(view)) local.tab = 'players';
      local.lastPhase = view.phase;
    }
    render(view);
  }

  function render(view, force = false) {
    if (!view) return;
    replace(
      tabBar,
      Object.entries(TABS)
        .filter(([, tab]) => tab.visible(view))
        .map(([name, tab]) =>
          h(
            'button',
            {
              class: ['panel-tab', name === local.tab && 'active'],
              type: 'button',
              role: 'tab',
              'aria-selected': String(name === local.tab),
              onclick: () => {
                local.tab = name;
                render(getView(), true);
              },
            },
            tab.label(),
          ),
        ),
    );
    const tab = TABS[local.tab];
    const key = `${local.tab}:${tab.key(view)}`;
    if (!force && key === local.renderedKey) return;
    if (!force && root.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) {
      local.dirty = true;
      return;
    }
    local.renderedKey = key;
    const scroll = body.scrollTop;
    const container = h('div', { class: 'panel-content' });
    tab.render(container, view);
    replace(body, container);
    body.scrollTop = scroll;
  }

  function rerender() {
    render(getView(), true);
  }

  // ------------------------------------------------------------ next round preparation

  function renderPrep(container, view) {
    const P = H.prep;
    const prep = view.host.nextRound;
    const selected = new Set(prep.modifiers);
    const setModifiers = (next) => act('host:setNextRound', { modifiers: [...next] });

    const modifierList = h(
      'div',
      { class: ['modifier-grid', prep.wheel && 'disabled'] },
      Object.keys(t.modifiers)
        .filter((id) => id !== 'wheel')
        .map((id) => {
          const mod = t.modifiers[id];
          const active = selected.has(id);
          return h(
            'button',
            {
              type: 'button',
              class: ['modifier-card', active && 'active'],
              'aria-pressed': String(active),
              disabled: prep.wheel,
              onclick: () => {
                const next = new Set(selected);
                if (active) next.delete(id);
                else next.add(id);
                setModifiers(next);
              },
            },
            h('span', { class: 'modifier-icon', 'aria-hidden': 'true' }, mod.icon),
            h('span', { class: 'modifier-text' }, h('strong', {}, mod.name), h('small', {}, mod.desc)),
          );
        }),
    );

    const wheel = t.modifiers.wheel;
    const word = prep.word;
    const select = h(
      'select',
      {
        class: 'input',
        'aria-label': P.chooseLabel,
        onchange: (event) => {
          if (event.target.value) act('host:nextWord', { action: 'choose', term: event.target.value });
        },
      },
      h('option', { value: '' }, P.choose),
      prep.availableTerms.map((term) => h('option', { value: term, selected: word?.term === term }, term)),
    );

    add(
      container,
      h('h3', {}, P.title(prep.roundNumber)),
      h('p', { class: 'muted small' }, P.modifiersHint),
      h(
        'button',
        {
          type: 'button',
          class: ['modifier-card wheel-card', prep.wheel && 'active'],
          'aria-pressed': String(prep.wheel),
          onclick: () => act('host:setNextRound', { wheel: !prep.wheel }),
        },
        h('span', { class: 'modifier-icon', 'aria-hidden': 'true' }, wheel.icon),
        h('span', { class: 'modifier-text' }, h('strong', {}, P.wheelLabel), h('small', {}, prep.wheel ? P.wheelActive : wheel.desc)),
      ),
      modifierList,
      selected.has('catchup') && prep.roundNumber === 1 && h('p', { class: 'notice small' }, P.catchupFirstRound),
      h('h3', {}, P.wordTitle),
      secretToggle(),
      secretBox(
        word
          ? h(
              'div',
              { class: 'real-definition' },
              h('strong', {}, [word.article, word.term].filter(Boolean).join(' ')),
              word.category && h('span', { class: 'chip small', style: { marginLeft: '0.5em' } }, word.category),
              h('div', {}, word.definition),
            )
          : h('p', { class: 'muted' }, P.wordRandom),
        h(
          'div',
          { class: 'panel-row' },
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => act('host:nextWord', { action: 'draw' }) }, word ? P.redraw : P.draw),
          word && h('button', { class: 'btn btn-small btn-ghost', type: 'button', onclick: () => act('host:nextWord', { action: 'random' }) }, P.random),
        ),
        select,
        h('p', { class: 'muted small' }, P.available(prep.availableTerms.length)),
      ),
      h(
        'div',
        { class: 'panel-footer' },
        h(
          'button',
          { class: 'btn btn-primary btn-block', type: 'button', onclick: () => onNext() },
          `${view.phase === 'LOBBY' ? H.next.LOBBY : H.next.SCOREBOARD} →`,
        ),
      ),
    );
  }

  // ------------------------------------------------------------ players

  function renderPlayers(container, view) {
    const inLobby = view.phase === 'LOBBY';
    add(container, 
      h(
        'div',
        { class: 'panel-row' },
        h(
          'button',
          { class: ['btn btn-small', view.locked && 'btn-danger'], type: 'button', onclick: () => act('host:lockLobby', { locked: !view.locked }) },
          view.locked ? `🔒 ${H.unlock}` : `🔓 ${H.lock}`,
        ),
        h('span', { class: 'muted small' }, view.host.settings.allowLateJoin ? H.settings.allowLateJoin : ''),
      ),
    );
    if (!view.host.players.length) {
      add(container, h('p', { class: 'muted' }, H.noPlayersYet));
      return;
    }
    const list = h('ul', { class: 'host-players' });
    const publicById = new Map(view.players.map((p) => [p.id, p]));
    const sorted = [...view.host.players].sort((a, b) => (inLobby ? 0 : b.score - a.score));
    for (const player of sorted) {
      const pub = publicById.get(player.id);
      const joinsLater = view.roundNumber > 0 && player.activeFromRound > view.roundNumber && !inLobby && view.phase !== 'GAME_OVER';
      list.append(
        h(
          'li',
          { class: ['host-player', !player.connected && 'offline'] },
          h(
            'div',
            { class: 'hp-main' },
            h('span', { class: ['conn-dot', player.connected ? 'online' : 'offline'], title: player.connected ? H.connected : H.disconnected }),
            h('span', { class: 'hp-name' }, player.name),
            pub?.submitted && h('span', { class: 'chip small' }, '✓'),
            pub?.voted && h('span', { class: 'chip small' }, '✓'),
            joinsLater && h('span', { class: 'chip small' }, H.joinsNextRound),
            h('span', { class: 'hp-score' }, t.common.pointsShort(player.score)),
          ),
          player.members && h('div', { class: 'hp-members muted small' }, player.members),
          h(
            'div',
            { class: 'hp-actions' },
            h('button', { class: 'btn btn-small btn-ghost', type: 'button', title: H.scoreAdjust, onclick: () => act('host:adjustScore', { playerId: player.id, delta: -1 }) }, '−1'),
            h('button', { class: 'btn btn-small btn-ghost', type: 'button', title: H.scoreAdjust, onclick: () => act('host:adjustScore', { playerId: player.id, delta: 1 }) }, '+1'),
            h(
              'button',
              {
                class: 'btn btn-small btn-ghost',
                type: 'button',
                onclick: async () => {
                  const name = await promptDialog(H.renamePrompt, player.name, { maxLength: 20 });
                  if (name && name !== player.name) act('host:renamePlayer', { playerId: player.id, name });
                },
              },
              H.rename,
            ),
            h(
              'button',
              {
                class: 'btn btn-small btn-ghost danger-text',
                type: 'button',
                onclick: async () => {
                  if (await confirmDialog(H.kickConfirm(player.name), { confirmLabel: H.kick })) {
                    act('host:kickPlayer', { playerId: player.id });
                  }
                },
              },
              H.kick,
            ),
          ),
        ),
      );
    }
    add(container, list);
  }

  // ------------------------------------------------------------ secrets toggle

  function secretToggle() {
    return h(
      'div',
      { class: 'secret-toggle' },
      !local.showSecrets && h('p', { class: 'notice notice-warning' }, '⚠️ ', H.moderationMirrorWarning),
      h(
        'button',
        {
          class: ['btn btn-small', local.showSecrets ? 'btn-ghost' : 'btn-primary'],
          type: 'button',
          onclick: () => {
            local.showSecrets = !local.showSecrets;
            rerender();
          },
        },
        local.showSecrets ? `🙈 ${H.hideAnswers}` : `👁 ${H.showAnswers}`,
      ),
    );
  }

  function secretBox(...children) {
    return h(
      'div',
      { class: ['secret', !local.showSecrets && 'blurred'], 'aria-hidden': local.showSecrets ? null : 'true', inert: local.showSecrets ? null : '' },
      ...children,
    );
  }

  // ------------------------------------------------------------ moderation

  function renderModeration(container, view) {
    const definitions = view.host.definitions ?? [];
    const topLevel = definitions.filter((d) => !d.mergedInto);
    const childrenOf = (id) => definitions.filter((d) => d.mergedInto === id);

    const list = h('ol', { class: 'mod-list' });
    for (const def of topLevel) {
      const children = childrenOf(def.id);
      list.append(moderationItem(def, children));
    }

    const selectedCount = local.selected.size;
    add(container, 
      secretToggle(),
      view.host.moderationWarning && h('p', { class: 'notice notice-warning' }, H.fewDefinitions),
      view.host.missing?.length > 0 && h('p', { class: 'muted small' }, H.missing(view.host.missing.join(', '))),
      secretBox(
        h('div', { class: 'real-definition' }, h('strong', {}, `${H.realDefinition}: `), view.host.realDefinition),
        h(
          'div',
          { class: 'panel-row' },
          h(
            'button',
            {
              class: 'btn btn-small',
              type: 'button',
              disabled: selectedCount < 2,
              onclick: async () => {
                const result = await act('host:mergeDefinitions', { ids: [...local.selected] });
                if (result) {
                  local.selected.clear();
                  rerender();
                }
              },
            },
            `🔗 ${H.merge} (${selectedCount})`,
          ),
        ),
        list,
      ),
      h(
        'div',
        { class: 'panel-footer' },
        h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => onNext() }, `${H.next.MODERATION} →`),
      ),
    );
  }

  function moderationItem(def, children) {
    const checkbox = h('input', {
      type: 'checkbox',
      checked: local.selected.has(def.id),
      disabled: def.deleted,
      'aria-label': H.merge,
      onchange: (event) => {
        if (event.target.checked) local.selected.add(def.id);
        else local.selected.delete(def.id);
        rerender();
      },
    });
    const authors = [...def.authors, ...children.flatMap((c) => c.authors)];
    const badges = [
      def.deleted && h('span', { class: 'chip small chip-danger' }, H.deleted),
      def.markedCorrect && h('span', { class: 'chip small chip-success' }, H.correct),
      def.auto && h('span', { class: 'chip small' }, H.autoSubmitted),
    ];
    const edited = def.originalText && def.text.replace(/\.$/, '') !== def.originalText.replace(/\.$/, '');
    return h(
      'li',
      { class: ['mod-item', def.deleted && 'deleted', def.markedCorrect && 'correct'] },
      h(
        'div',
        { class: 'mod-head' },
        checkbox,
        h('span', { class: 'mod-authors' }, authors.join(', ')),
        badges,
      ),
      h('p', { class: 'mod-text' }, def.text),
      edited && h('p', { class: 'mod-original muted small' }, `${H.original} ${def.originalText}`),
      children.map((child) =>
        h(
          'div',
          { class: 'mod-child' },
          h('span', { class: 'muted small' }, `🔗 ${child.authors.join(', ')}: `),
          h('span', { class: 'small' }, child.text),
          h('button', { class: 'btn btn-small btn-ghost', type: 'button', onclick: () => act('host:unmerge', { id: child.id }) }, H.unmerge),
        ),
      ),
      h(
        'div',
        { class: 'mod-actions' },
        h(
          'button',
          {
            class: 'btn btn-small btn-ghost',
            type: 'button',
            disabled: def.deleted,
            onclick: async () => {
              const text = await promptDialog(H.editPrompt, def.text, { maxLength: 300, multiline: true });
              if (text !== null && text !== def.text) act('host:editDefinition', { id: def.id, text });
            },
          },
          `✏️ ${H.edit}`,
        ),
        h(
          'button',
          { class: 'btn btn-small btn-ghost', type: 'button', onclick: () => act('host:deleteDefinition', { id: def.id, deleted: !def.deleted }) },
          def.deleted ? `↩ ${H.restore}` : `🗑 ${H.delete}`,
        ),
        h(
          'button',
          { class: 'btn btn-small btn-ghost', type: 'button', disabled: def.deleted, onclick: () => act('host:markCorrect', { id: def.id, correct: !def.markedCorrect }) },
          def.markedCorrect ? H.unmarkCorrect : `★ ${H.markCorrect}`,
        ),
        children.length > 0 &&
          h('button', { class: 'btn btn-small btn-ghost', type: 'button', onclick: () => act('host:unmerge', { id: def.id }) }, H.unmerge),
      ),
    );
  }

  // ------------------------------------------------------------ ballot (secret)

  function renderBallot(container, view) {
    const ballot = view.host.ballot ?? [];
    add(container, 
      secretToggle(),
      h('p', { class: 'notice notice-danger small' }, H.ballotSecret),
      secretBox(
        h(
          'ol',
          { class: 'mod-list' },
          ballot.map((entry) =>
            h(
              'li',
              { class: ['mod-item', entry.isReal && 'correct', view.highlight === entry.number && 'highlight'] },
              h(
                'div',
                { class: 'mod-head' },
                h('span', { class: 'ballot-number small-number' }, entry.number),
                entry.isReal ? h('span', { class: 'chip small chip-success' }, H.realMark) : h('span', { class: 'mod-authors' }, entry.authors.join(', ')),
                h('span', { class: 'chip small' }, t.stage.statsVotes(entry.voters.length)),
              ),
              h('p', { class: 'mod-text' }, entry.text),
              entry.voters.length > 0 && h('p', { class: 'muted small' }, entry.voters.join(', ')),
            ),
          ),
        ),
      ),
      view.phase === 'VOTING' && h('p', { class: 'muted small' }, H.highlightHint),
    );
  }

  return { update };
}
