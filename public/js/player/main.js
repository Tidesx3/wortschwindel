import { $, add, h, replace, svg, vibrate } from '../lib/dom.js';
import { createConnection } from '../lib/socket.js';
import { createTimer } from '../lib/timer.js';
import { storage } from '../lib/storage.js';
import { keepAwake } from '../lib/wakelock.js';
import { confirmDialog, initTheme, toast } from '../lib/ui.js';
import { normalizeDefinition } from '/shared/normalize.js';
import { t, errorText } from '../i18n.js';

const P = t.player;
initTheme('light');

const app = $('#app');
const headerEl = $('#player-header');

const pathCode = (() => {
  const parts = location.pathname.split('/').filter(Boolean);
  return parts[0] === 'join' && parts[1] ? decodeURIComponent(parts[1]).toUpperCase().slice(0, 8) : '';
})();

const local = {
  view: null,
  mode: 'loading', // loading | join | game | kicked | closed
  joinError: '',
  renderKey: null,
  editing: false,
  pendingVote: null,
  lastPhase: null,
  draftTimer: null,
  lastSentDraft: null,
};

const connection = createConnection({
  onState: handleState,
  onConnect: resumeOrShowJoin,
  onEvent: {
    kicked: () => {
      storage.remove('room');
      showMode('kicked');
    },
    roomClosed: () => {
      storage.remove('room');
      showMode('closed');
    },
  },
});

const writingTimer = createTimer({ variant: 'bar', serverNow: connection.serverNow });
const votingTimer = createTimer({ variant: 'bar', serverNow: connection.serverNow });

// ---------------------------------------------------------------- session

async function resumeOrShowJoin() {
  const room = storage.get('room');
  const sessionId = storage.get('sessionId');
  if (room && sessionId && (!pathCode || pathCode === room)) {
    const result = await connection.emit('player:resume', { code: room, sessionId });
    if (result.ok) return;
    if (result.error === 'kicked') return showMode('kicked');
    if (result.error === 'timeout') return;
    storage.remove('room');
  }
  if (local.mode !== 'game') showMode('join');
}

async function join(form) {
  const data = new FormData(form);
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  button.textContent = P.joining;
  const result = await connection.emit('player:join', {
    code: String(data.get('code') ?? '').trim().toUpperCase(),
    name: String(data.get('name') ?? ''),
    members: String(data.get('members') ?? ''),
    sessionId: storage.get('sessionId') ?? undefined,
  });
  button.disabled = false;
  button.textContent = P.joinButton;
  if (!result.ok) {
    const errorEl = form.querySelector('.form-error');
    errorEl.textContent = errorText(result.error);
    if (result.error === 'kicked') showMode('kicked');
    return;
  }
  storage.set('sessionId', result.sessionId);
  storage.set('room', result.code);
  storage.set('lastName', String(data.get('name') ?? ''));
  storage.set('lastMembers', String(data.get('members') ?? ''));
  if (location.pathname !== '/') history.replaceState(null, '', '/');
}

async function leave() {
  if (!(await confirmDialog(P.leaveConfirm, { confirmLabel: P.leave }))) return;
  await connection.emit('player:leave');
  storage.remove('room');
  local.view = null;
  showMode('join');
}

// ---------------------------------------------------------------- rendering

function showMode(mode) {
  local.mode = mode;
  local.renderKey = null;
  if (mode !== 'game') {
    headerEl.hidden = true;
    keepAwake(false);
  }
  if (mode === 'join') renderJoin();
  if (mode === 'kicked') renderMessage(P.kickedTitle, t.errors.kicked, false);
  if (mode === 'closed') renderMessage(P.closedTitle, P.closedText, true);
}

function renderMessage(title, text, allowRejoin) {
  replace(
    app,
    h(
      'section',
      { class: 'card message-card' },
      h('h1', {}, title),
      h('p', {}, text),
      allowRejoin && h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => showMode('join') }, P.rejoin),
    ),
  );
}

function renderJoin() {
  const form = h(
    'form',
    {
      class: 'card join-card',
      autocomplete: 'off',
      onsubmit: (event) => {
        event.preventDefault();
        join(form);
      },
    },
    h('h1', { class: 'join-logo' }, t.appName),
    h('p', { class: 'muted' }, t.tagline),
    h(
      'label',
      { class: 'field' },
      h('span', {}, P.codeLabel),
      h('input', {
        class: 'input input-code',
        name: 'code',
        required: true,
        maxlength: 8,
        autocapitalize: 'characters',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: P.codePlaceholder,
        value: pathCode || storage.get('room') || '',
        oninput: (event) => {
          event.target.value = event.target.value.toUpperCase().replace(/[^A-Z]/g, '');
        },
      }),
    ),
    h(
      'label',
      { class: 'field' },
      h('span', {}, P.nameLabel),
      h('input', {
        class: 'input',
        name: 'name',
        required: true,
        minlength: 2,
        maxlength: 20,
        autocomplete: 'nickname',
        placeholder: P.namePlaceholder,
        value: storage.get('lastName') ?? '',
      }),
    ),
    h(
      'label',
      { class: 'field' },
      h('span', {}, P.membersLabel),
      h('input', {
        class: 'input',
        name: 'members',
        maxlength: 60,
        placeholder: P.membersPlaceholder,
        value: storage.get('lastMembers') ?? '',
      }),
    ),
    h('p', { class: 'form-error', role: 'alert' }, local.joinError),
    h('button', { class: 'btn btn-primary btn-block btn-large', type: 'submit' }, P.joinButton),
  );
  replace(app, form);
  const codeInput = form.querySelector('[name=code]');
  (codeInput.value ? form.querySelector('[name=name]') : codeInput).focus({ preventScroll: true });
}

function renderHeader(view) {
  const you = view.you;
  headerEl.hidden = false;
  replace(
    headerEl,
    h('span', { class: 'ph-name' }, you.name),
    h('span', { class: 'ph-score' }, t.common.points(you.score)),
    view.roundNumber > 0 && view.phase !== 'LOBBY' && h('span', { class: 'ph-round' }, t.common.round(view.roundNumber, view.totalRounds)),
    connection.dot,
  );
}

function handleState(view) {
  if (view.role !== 'player' || !view.you) return;
  local.view = view;
  if (local.mode !== 'game') {
    local.mode = 'game';
    local.renderKey = null;
    keepAwake(true);
  }
  renderHeader(view);
  const stepId = `${view.phase}:${view.roundNumber}:${view.word?.term ?? ''}`;
  const phaseChanged = stepId !== local.lastPhase;
  if (phaseChanged) {
    if (local.lastPhase) vibrate(80);
    local.editing = false;
    local.pendingVote = null;
    local.pendingFavorite = undefined;
    local.lastPhase = stepId;
  }
  hostAwayBanner(view);

  writingTimer.update(view.phase === 'WRITING' ? view.timer : null);
  votingTimer.update(view.phase === 'VOTING' ? view.timer : null);

  const key = phaseKey(view);
  if (key === local.renderKey) {
    updateInPlace(view);
    return;
  }
  local.renderKey = key;
  const screen = h('div', { class: ['phase', phaseChanged && 'phase-enter'] });
  (PHASES[view.phase] ?? (() => {}))(screen, view);
  replace(app, screen);
  updateInPlace(view);
}

let hostAwayEl = null;
function hostAwayBanner(view) {
  const show = !view.hostConnected && view.phase !== 'LOBBY' && view.phase !== 'GAME_OVER';
  if (show && !hostAwayEl) {
    hostAwayEl = h('div', { class: 'host-away-banner', role: 'status' }, t.connection.hostAway);
    document.body.append(hostAwayEl);
  } else if (!show && hostAwayEl) {
    hostAwayEl.remove();
    hostAwayEl = null;
  }
}

/** Only re-render the phase when something structural changed (keeps text input focus). */
function phaseKey(view) {
  const you = view.you;
  const base = [view.phase, view.roundNumber, view.word?.term, you.participant, you.waitingForNextRound];
  switch (view.phase) {
    case 'LOBBY':
      return JSON.stringify([...base, you.name, you.members]);
    case 'WRITING':
      // While editing, the submission text must not trigger a re-render (keeps focus).
      return JSON.stringify([...base, you.submitted, local.editing, !local.editing && you.submission, Boolean(view.timer?.expired)]);
    case 'VOTING':
      return JSON.stringify([
        ...base,
        view.ballot.entries.map((e) => e.id),
        view.ballot.votingOpen,
        you.ownEntryId,
        you.vote,
        you.favorite,
        view.ballot.favoriteEnabled,
        view.highlight,
        Boolean(view.timer?.expired),
      ]);
    case 'REVEAL':
      return JSON.stringify([...base, view.reveal.done, view.reveal.current, you.roundResult]);
    case 'SCOREBOARD':
    case 'GAME_OVER':
      return JSON.stringify([...base, you.score, you.rank, you.delta, view.stats]);
    default:
      return JSON.stringify(base);
  }
}

function updateInPlace(view) {
  const progress = app.querySelector('[data-progress]');
  if (progress && view.progress) {
    progress.textContent =
      view.phase === 'VOTING'
        ? t.stage.votedCount(view.progress.done, view.progress.total)
        : t.stage.submittedCount(view.progress.done, view.progress.total);
  }
}

function wordHeader(view) {
  const word = view.word;
  if (!word) return null;
  const meta = t.stage.wordClass(word.article, word.wordClass);
  return h(
    'div',
    { class: 'p-word' },
    h('div', { class: 'p-word-term', lang: 'de' }, word.term),
    (meta || word.category) && h('div', { class: 'p-word-meta' }, [meta, word.category].filter(Boolean).join(' · ')),
  );
}

function modifierRow(view) {
  const list = view.modifiers?.list ?? [];
  if (!list.length) return null;
  return h(
    'div',
    { class: 'p-modifiers' },
    h(
      'div',
      { class: 'p-modifier-chips' },
      list.map((id) => {
        const mod = t.modifiers[id];
        return mod && h('span', { class: `p-modifier mod-${id}`, title: mod.desc }, mod.icon, ' ', mod.name);
      }),
    ),
    view.you.catchup && h('p', { class: 'notice notice-success small' }, P.catchupNote),
  );
}

function waitingScreen(el, title, sub) {
  add(el, h('section', { class: 'card center-card' }, h('div', { class: 'spinner' }), h('h2', {}, title), sub && h('p', { class: 'muted' }, sub)));
}

// ---------------------------------------------------------------- phases

const PHASES = {
  LOBBY(el, view) {
    const you = view.you;
    add(el, 
      h(
        'section',
        { class: 'card center-card' },
        h('div', { class: 'big-emoji', 'aria-hidden': 'true' }, '🎉'),
        h('h1', {}, P.lobbyTitle),
        h('p', { class: 'p-you-name' }, you.name),
        you.members && h('p', { class: 'muted' }, you.members),
        h('p', {}, P.lobbyWait),
        h('p', { class: 'muted' }, t.common.players(view.players.length)),
      ),
      h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: leave }, P.leave),
    );
  },

  WRITING(el, view) {
    if (view.you.waitingForNextRound) return waitingScreen(el, P.lateJoin);
    const you = view.you;
    const max = view.settings.maxDefinitionLength;
    const expired = Boolean(view.timer?.expired);
    const draftKey = `draft:${view.code}:${view.roundNumber}:${view.word.term}`;
    const editing = !you.submitted || local.editing;

    add(el, h('p', { class: 'p-kicker' }, P.writeTitle), wordHeader(view), modifierRow(view), writingTimer.el);

    if (!editing) {
      add(el, 
        h(
          'section',
          { class: 'card' },
          h('div', { class: 'notice notice-success' }, '✓ ', P.submitted),
          h('p', { class: 'submitted-text' }, normalizeDefinition(you.submission, { standardize: view.settings.standardizeAnswers })),
          !expired &&
            h(
              'button',
              {
                class: 'btn btn-ghost btn-block',
                type: 'button',
                onclick: () => {
                  local.editing = true;
                  local.renderKey = null;
                  handleState(local.view);
                },
              },
              P.edit,
            ),
        ),
        h('p', { class: 'muted center', 'data-progress': '' }),
      );
      return;
    }

    const initial = storage.get(draftKey) ?? you.draft ?? you.submission ?? '';
    const counter = h('span', { class: 'char-counter' });
    const preview = h('p', { class: 'preview-text' });
    const previewBox = h('div', { class: 'preview' }, h('span', { class: 'preview-label' }, P.previewLabel), preview);
    const textarea = h('textarea', {
      class: 'input definition-input',
      maxlength: max,
      rows: 4,
      placeholder: P.textareaPlaceholder,
      disabled: expired,
      enterkeyhint: 'send',
      autocapitalize: 'sentences',
      lang: 'de',
    });
    textarea.value = initial.slice(0, max);
    const submitButton = h('button', { class: 'btn btn-primary btn-block btn-large', type: 'submit', disabled: expired }, you.submitted ? P.update : P.submit);

    const refresh = () => {
      const value = textarea.value;
      // Grow with the content instead of scrolling inside the field.
      textarea.style.height = 'auto';
      if (textarea.scrollHeight) textarea.style.height = `${textarea.scrollHeight + 4}px`;
      counter.textContent = P.chars(value.length, max);
      counter.classList.toggle('near-limit', value.length > max * 0.9);
      const normalized = normalizeDefinition(value, { standardize: view.settings.standardizeAnswers });
      preview.textContent = normalized;
      previewBox.hidden = !normalized;
      submitButton.disabled = expired || value.trim().length < 3;
    };
    textarea.addEventListener('input', () => {
      refresh();
      storage.set(draftKey, textarea.value);
      scheduleDraftSync(textarea.value);
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });

    const form = h(
      'form',
      {
        class: 'card write-card',
        onsubmit: async (event) => {
          event.preventDefault();
          if (submitButton.disabled) return;
          submitButton.disabled = true;
          const result = await connection.emit('player:submit', { text: textarea.value });
          if (!result.ok) {
            toast(errorText(result.error), { type: 'error' });
            refresh();
            return;
          }
          local.editing = false;
          textarea.blur();
          vibrate(40);
          local.renderKey = null;
          if (local.view) handleState(local.view);
        },
      },
      h('p', { class: 'hint' }, P.hint),
      h('details', { class: 'format-hint' }, h('summary', {}, 'ℹ️ So soll der Satz aussehen'), h('p', {}, P.formatHint)),
      textarea,
      h('div', { class: 'write-meta' }, counter),
      previewBox,
      expired && h('div', { class: 'notice notice-warning' }, P.timeUpNoAnswer),
      submitButton,
      you.submitted &&
        h(
          'button',
          {
            class: 'btn btn-ghost btn-block',
            type: 'button',
            onclick: () => {
              local.editing = false;
              local.renderKey = null;
              handleState(local.view);
            },
          },
          P.cancelEdit,
        ),
    );
    refresh();
    add(el, form, h('p', { class: 'muted center', 'data-progress': '' }));
    if (initial && initial !== you.draft && !you.submitted) scheduleDraftSync(initial);
  },

  MODERATION(el, view) {
    waitingScreen(el, P.waitModeration, P.waitModerationSub);
    if (view.you.participant && !view.you.submitted && !view.you.waitingForNextRound) {
      add(el, h('p', { class: 'notice' }, P.noAnswerThisRound));
    }
  },

  VOTING(el, view) {
    if (view.you.waitingForNextRound) return waitingScreen(el, P.lateJoin);
    const you = view.you;
    const ballot = view.ballot;
    const open = ballot.votingOpen;
    const expired = Boolean(view.timer?.expired);
    const selected = local.pendingVote ?? you.vote;
    const favoriteEnabled = ballot.favoriteEnabled;
    const favorite = local.pendingFavorite !== undefined ? local.pendingFavorite : you.favorite;

    add(el, wordHeader(view), modifierRow(view));
    if (open) {
      const complete = you.vote && (!favoriteEnabled || favorite);
      const status = !you.canVote ? P.cannotVote : complete ? P.voted : you.vote ? P.votedWaitingFavorite : P.voteNow;
      add(
        el,
        votingTimer.el,
        h('p', { class: ['vote-status', complete ? 'notice notice-success' : 'notice'], role: 'status' }, status),
        favoriteEnabled && you.canVote && h('p', { class: 'muted small center' }, favorite ? P.favoriteChosen : P.favoritePrompt),
      );
    } else {
      add(el, h('p', { class: 'notice' }, P.presenting, ' ', P.presentingCount(ballot.presentedCount, ballot.total)));
    }
    if (!you.hasEntry && open) add(el, h('p', { class: 'muted small' }, P.noAnswerThisRound));

    const list = h('ol', { class: 'vote-list' });
    for (const entry of ballot.entries) {
      const own = entry.id === you.ownEntryId;
      const isSelected = entry.id === selected;
      const card = h(
        'button',
        {
          type: 'button',
          class: ['card-button', 'vote-card', own && 'own', isSelected && 'selected', view.highlight === entry.number && 'highlight'],
          disabled: own || !open || expired,
          'aria-pressed': isSelected ? 'true' : 'false',
          onclick: () => vote(entry.id),
        },
        h('span', { class: 'vote-number' }, entry.number),
        h('span', { class: 'vote-text' }, entry.text),
        own && h('span', { class: 'own-label' }, P.ownAnswer),
        isSelected &&
          h(
            'span',
            { class: 'vote-check', 'aria-hidden': 'true' },
            svg(
              'svg',
              { viewBox: '0 0 24 24', class: 'check-icon' },
              svg('path', { d: 'M5.5 12.5l4.2 4.2L18.5 7.8', fill: 'none', stroke: 'currentColor', 'stroke-width': 3.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
            ),
          ),
      );
      const isFavorite = entry.id === favorite;
      const star =
        favoriteEnabled &&
        open &&
        !own &&
        h(
          'button',
          {
            type: 'button',
            class: ['favorite-button', isFavorite && 'active'],
            disabled: expired,
            'aria-pressed': String(isFavorite),
            'aria-label': isFavorite ? P.favoriteRemove : P.favoriteButton,
            title: isFavorite ? P.favoriteRemove : P.favoriteButton,
            onclick: () => voteFavorite(isFavorite ? null : entry.id),
          },
          isFavorite ? '★' : '☆',
        );
      list.append(h('li', { class: ['vote-item', star && 'has-favorite'] }, card, star));
    }
    add(el, list);
    if (open && you.vote) add(el, h('p', { class: 'muted center' }, P.voteChange));
    if (open) add(el, h('p', { class: 'muted center', 'data-progress': '' }));
    // Keep the highlighted entry visible while the host reads aloud.
    const highlighted = list.querySelector('.highlight');
    if (highlighted) requestAnimationFrame(() => highlighted.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  },

  REVEAL(el, view) {
    const you = view.you;
    const result = you.roundResult;
    if (!view.reveal.done || !result) {
      add(el, 
        h(
          'section',
          { class: 'card center-card' },
          h('div', { class: 'big-emoji', 'aria-hidden': 'true' }, '📽️'),
          h('h2', {}, P.lookAtScreen),
          h('p', { class: 'muted' }, P.revealRunning),
        ),
      );
      return;
    }
    const lines = [];
    if (!result.voted) lines.push(h('p', { class: 'result-line' }, P.resultNoVote));
    else if (result.votedReal) lines.push(h('p', { class: 'result-line good' }, '✓ ', P.resultCorrect(result.correctPoints)));
    else lines.push(h('p', { class: 'result-line bad' }, '✗ ', P.resultWrong));
    if (result.markedCorrect) lines.push(h('p', { class: 'result-line good' }, '★ ', P.resultMarkedCorrect(result.markedPoints)));
    if (result.fooledCount > 0) {
      lines.push(h('p', { class: 'result-line good' }, '🎭 ', P.resultFooledPoints(result.fooledCount, result.fooledPoints)));
    } else if (result.hadEntry && !result.markedCorrect) {
      lines.push(h('p', { class: 'result-line muted' }, P.resultNobodyFooled));
    }
    if (result.favoritePoints > 0) lines.push(h('p', { class: 'result-line good' }, '⭐ ', P.resultFavorite(result.favoritePoints)));
    if (view.modifiers?.list.length) lines.push(modifierRow(view));
    add(el, 
      h(
        'section',
        { class: 'card center-card result-card' },
        h('div', { class: 'result-total' }, P.resultTotal(result.total)),
        lines,
      ),
    );
    vibrate(result.total > 0 ? [60, 40, 60] : 60);
  },

  SCOREBOARD(el, view) {
    const you = view.you;
    add(el, 
      h(
        'section',
        { class: 'card center-card' },
        h('div', { class: 'rank-big' }, t.common.rank(you.rank)),
        h('p', {}, P.yourRank(you.rank, you.playerCount)),
        h('div', { class: 'score-big' }, t.common.points(you.score)),
        you.delta ? h('div', { class: 'delta-badge' }, t.common.plus(you.delta)) : null,
        h('p', { class: 'muted' }, t.common.round(view.roundNumber, view.totalRounds)),
      ),
    );
  },

  GAME_OVER(el, view) {
    const you = view.you;
    const medal = { 1: '🥇', 2: '🥈', 3: '🥉' }[you.rank] ?? '🏁';
    const stats = view.stats;
    const mine = (award) => award?.names.includes(you.name);
    add(el, 
      h(
        'section',
        { class: 'card center-card' },
        h('h1', {}, P.finalTitle),
        h('div', { class: 'big-emoji', 'aria-hidden': 'true' }, medal),
        h('div', { class: 'rank-big' }, t.common.rank(you.rank)),
        h('p', {}, P.yourRank(you.rank, you.playerCount)),
        h('div', { class: 'score-big' }, t.common.points(you.score)),
        mine(stats?.bestBluffer) && h('p', { class: 'chip chip-accent' }, '🎭 ', t.stage.statsBluffer),
        mine(stats?.dictionaryPro) && h('p', { class: 'chip chip-accent' }, '📖 ', t.stage.statsPro),
        h('p', { class: 'muted' }, P.thanks),
      ),
    );
    keepAwake(false);
  },
};

// ---------------------------------------------------------------- actions

function scheduleDraftSync(text) {
  if (text === local.lastSentDraft) return;
  clearTimeout(local.draftTimer);
  local.draftTimer = setTimeout(() => {
    local.lastSentDraft = text;
    connection.emit('player:draft', { text: text.slice(0, 400) });
  }, 700);
}

async function voteFavorite(entryId) {
  const previous = local.pendingFavorite;
  local.pendingFavorite = entryId;
  local.renderKey = null;
  handleState(local.view);
  vibrate(30);
  const result = await connection.emit('player:favorite', { definitionId: entryId });
  if (!result.ok) {
    toast(errorText(result.error), { type: 'error' });
    local.pendingFavorite = previous;
    local.renderKey = null;
    if (local.view) handleState(local.view);
  }
}

async function vote(entryId) {
  const previous = local.pendingVote;
  local.pendingVote = entryId;
  local.renderKey = null;
  handleState(local.view);
  vibrate(30);
  const result = await connection.emit('player:vote', { definitionId: entryId });
  if (!result.ok) {
    local.pendingVote = previous;
    toast(errorText(result.error), { type: 'error' });
    local.renderKey = null;
    if (local.view) handleState(local.view);
  }
}

// Drafts from earlier rounds are no longer useful.
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith('wortschwindel:draft:') && !key.includes(`:${storage.get('room')}:`)) localStorage.removeItem(key);
  }
} catch {
  // Storage unavailable.
}

// Show the join form quickly if the server is slow to answer.
setTimeout(() => {
  if (local.mode === 'loading') showMode('join');
}, 2500);
