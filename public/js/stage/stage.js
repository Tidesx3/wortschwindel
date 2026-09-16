import { add, h, replace, flip, rectsByKey, prefersReducedMotion } from '../lib/dom.js';
import { createTimer } from '../lib/timer.js';
import { sound } from '../lib/sound.js';
import { confetti } from '../lib/confetti.js';
import { t } from '../i18n.js';

const S = t.stage;

/**
 * Projector view shared by /host (presentation area) and /screen.
 * Only uses public view fields – never `view.host`.
 */
export function createStage(root, { serverNow }) {
  const timer = createTimer({
    variant: 'ring',
    serverNow,
    onTick: (seconds) => {
      if (seconds <= 5 && seconds > 0) sound.tick(seconds === 1);
    },
  });
  const seen = new Set();
  let lastKey = null;
  let lastPhase = null;
  let lastRevealStep = null;
  let lastView = null;

  root.classList.add('stage');
  const hostAway = h('div', { class: 'stage-host-away', hidden: true }, h('div', { class: 'spinner' }), S.hostAway);
  const content = h('div', { class: 'stage-content' });
  replace(root, content, hostAway);

  function update(view) {
    timer.update(view.timer);
    hostAway.hidden = view.role !== 'screen' || view.hostConnected || view.phase === 'LOBBY';

    const key = renderKey(view);
    if (key === lastKey) return;
    lastKey = key;

    const phaseChanged = view.phase !== lastPhase;
    playSounds(view, phaseChanged);
    const renderer = RENDERERS[view.phase];
    const previousRects = view.phase === 'SCOREBOARD' || view.phase === 'LOBBY' ? rectsByKey(content.querySelector('.flip-list')) : new Map();
    const next = h('div', { class: ['stage-phase', `stage-${view.phase.toLowerCase()}`, phaseChanged && 'phase-enter'] });
    renderer?.(next, view, { timer, seen, phaseChanged, previousRects });
    replace(content, next);
    if (view.phase === 'SCOREBOARD' && phaseChanged) animateScoreboard(next, view);
    else if (previousRects.size) flip(next.querySelector('.flip-list'), previousRects);
    for (const el of next.querySelectorAll('.fit')) fitToBox(el);
    if (view.phase === 'GAME_OVER' && phaseChanged) {
      confetti({ duration: 6000 });
    }
    lastPhase = view.phase;
    lastView = view;
  }

  function playSounds(view, phaseChanged) {
    if (phaseChanged) {
      if (view.phase === 'WRITING') sound.gong();
      if (view.phase === 'MODERATION' || view.phase === 'VOTING') sound.whoosh();
      if (view.phase === 'GAME_OVER') sound.fanfare();
      if (view.phase === 'SCOREBOARD') sound.pop();
    }
    if (view.phase === 'WRITING' && !phaseChanged && lastView?.word?.term !== view.word?.term) {
      sound.gong();
    }
    if (view.phase === 'VOTING' && !phaseChanged && view.ballot.presentedCount !== lastView?.ballot?.presentedCount) {
      sound.pop();
    }
    if (view.phase === 'REVEAL') {
      const step = view.reveal.step;
      if (step !== lastRevealStep && step > 0 && view.reveal.current) {
        const current = view.reveal.current;
        const item = view.reveal.items.find((i) => i.id === current.id);
        if (current.type === 'text') sound.whoosh();
        if (current.type === 'voters') (item?.voters?.length ? sound.fooled() : sound.pop());
        if (current.type === 'authors') sound.pop();
        if (current.type === 'real' || current.type === 'bonus') sound.reveal();
      }
      lastRevealStep = step;
    } else {
      lastRevealStep = null;
    }
  }

  return { update, timer };
}

/** Shrinks the element's font (via --fit) until its content fits without scrolling. */
function fitToBox(el) {
  let scale = 1;
  el.style.setProperty('--fit', '1');
  while (scale > 0.45 && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
    scale -= 0.05;
    el.style.setProperty('--fit', scale.toFixed(2));
  }
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => document.querySelectorAll('.stage .fit').forEach(fitToBox), 150);
});

function renderKey(view) {
  const { serverNow, timer, host, version, join, ...rest } = view;
  return JSON.stringify({ ...rest, hasTimer: Boolean(timer), joinUrl: join?.url });
}

// ---------------------------------------------------------------- shared pieces

function header(view, extra = null) {
  return h(
    'header',
    { class: 'stage-header' },
    h('span', { class: 'stage-brand' }, t.appName),
    view.roundNumber > 0 && view.phase !== 'LOBBY' && h('span', { class: 'stage-round' }, t.common.round(view.roundNumber, view.totalRounds)),
    extra,
    h('span', { class: 'stage-code' }, view.code),
  );
}

function wordBlock(view, { compact = false } = {}) {
  const word = view.word;
  if (!word) return null;
  const meta = S.wordClass(word.article, word.wordClass);
  return h(
    'div',
    { class: ['word', compact && 'word-compact'] },
    h('div', { class: 'word-term', lang: 'de' }, word.term),
    (meta || word.category) &&
      h('div', { class: 'word-meta' }, meta && h('span', {}, meta), word.category && h('span', { class: 'chip chip-accent' }, word.category)),
  );
}

function markNew(seen, key, el, className = 'appear') {
  if (!seen.has(key)) {
    seen.add(key);
    if (!prefersReducedMotion()) el.classList.add(className);
  }
  return el;
}

function playerChips(view, seen, { status } = {}) {
  const list = h('ul', { class: 'player-chips flip-list' });
  for (const player of view.players) {
    if (status && !player.active) continue;
    const done = status === 'submitted' ? player.submitted : status === 'voted' ? player.voted : false;
    const chip = h(
      'li',
      {
        class: ['player-chip', done && 'done', !player.connected && 'offline', player.away && 'away'],
        dataset: { key: player.id },
      },
      status && h('span', { class: 'player-check', 'aria-hidden': 'true' }, done ? '✓' : ''),
      h('span', { class: 'player-name' }, player.name),
      !status && player.members && h('span', { class: 'player-members' }, player.members),
    );
    list.append(markNew(seen, `player:${player.id}`, chip, 'pop'));
  }
  return list;
}

// ---------------------------------------------------------------- phases

const RENDERERS = {
  LOBBY(el, view, { seen }) {
    const count = view.players.length;
    add(el, 
      h(
        'div',
        { class: 'lobby-grid' },
        h(
          'section',
          { class: 'lobby-join card' },
          h('h1', { class: 'lobby-title' }, t.appName),
          h('p', { class: 'lobby-tagline' }, t.tagline),
          view.join?.qr && h('img', { class: 'lobby-qr', src: view.join.qr, alt: 'QR-Code zum Beitreten' }),
          h('div', { class: 'lobby-url-label' }, S.joinAt),
          h('div', { class: 'lobby-url' }, view.join?.url?.replace(/^https?:\/\//, '').replace(/\/join\/.*$/, '') ?? ''),
          h('div', { class: 'lobby-code-label' }, S.codeLabel),
          h('div', { class: 'lobby-code' }, view.code),
          view.locked && h('div', { class: 'notice notice-warning' }, S.lobbyLocked),
        ),
        h(
          'section',
          { class: 'lobby-players' },
          h('h2', { class: 'lobby-count' }, t.common.players(count)),
          count ? playerChips(view, seen) : h('p', { class: 'lobby-waiting muted' }, S.waitingPlayers),
        ),
      ),
    );
  },

  WRITING(el, view, { timer, seen }) {
    add(el, 
      header(view),
      h('div', { class: 'writing-main' }, wordBlock(view), h('div', { class: 'stage-timer' }, timer.el)),
      h(
        'section',
        { class: 'writing-status' },
        view.progress && h('div', { class: 'progress-text' }, S.submittedCount(view.progress.done, view.progress.total)),
        playerChips(view, seen, { status: 'submitted' }),
      ),
    );
  },

  MODERATION(el, view) {
    add(el, 
      header(view),
      wordBlock(view, { compact: true }),
      h(
        'div',
        { class: 'shuffle' },
        h('div', { class: 'shuffle-cards', 'aria-hidden': 'true' }, [0, 1, 2, 3].map((i) => h('div', { class: `shuffle-card c${i}` }, '?'))),
        h('p', { class: 'shuffle-text' }, S.shuffling),
      ),
    );
  },

  VOTING(el, view, { timer, seen }) {
    const ballot = view.ballot;
    const total = ballot.total;
    const presenting = !ballot.votingOpen;
    const list = h('ol', {
      class: ['ballot', 'fit', total > 6 && 'ballot-two-cols', total > 10 && 'ballot-dense'],
      style: { '--count': String(total) },
    });
    for (const entry of ballot.entries) {
      const item = h(
        'li',
        { class: ['ballot-entry', view.highlight === entry.number && 'highlight'] },
        h('span', { class: 'ballot-number' }, entry.number),
        h('span', { class: 'ballot-text' }, entry.text),
      );
      list.append(markNew(seen, `ballot:${entry.id}`, item));
    }
    if (presenting) {
      for (let n = ballot.entries.length + 1; n <= total; n++) {
        list.append(h('li', { class: 'ballot-entry placeholder' }, h('span', { class: 'ballot-number' }, n), h('span', { class: 'ballot-text' }, '…')));
      }
    }
    const status = presenting
      ? h(
          'div',
          { class: 'voting-status' },
          h('div', { class: 'voting-callout' }, ballot.presentedCount >= total ? S.votingStartsSoon : S.presentingTitle),
          ballot.presentedCount > 0 && h('div', { class: 'progress-text' }, S.presentingSub(ballot.presentedCount, total)),
        )
      : h(
          'div',
          { class: 'voting-status' },
          h('div', { class: 'voting-callout accent' }, S.voteNow),
          h('div', { class: 'stage-timer small' }, timer.el),
          view.progress && h('div', { class: 'progress-text' }, S.votedCount(view.progress.done, view.progress.total)),
        );
    add(el, header(view), h('div', { class: 'voting-layout' }, h('div', { class: 'voting-side' }, wordBlock(view, { compact: true }), status), list));
  },

  REVEAL(el, view, { seen }) {
    const reveal = view.reveal;
    const current = reveal.current;
    const items = reveal.items;
    const focusId = current && current.type !== 'bonus' ? current.id : null;
    const focus = items.find((i) => i.id === focusId);
    const others = items.filter((i) => i.id !== focusId);

    let main;
    if (!current) {
      main = h('div', { class: 'reveal-intro' }, h('h1', {}, S.revealTitle), h('p', {}, S.revealIntro));
    } else if (current.type === 'bonus') {
      main = h(
        'div',
        { class: 'reveal-bonus appear' },
        h('h2', {}, S.bonusTitle),
        reveal.bonus.map((b) =>
          h(
            'div',
            { class: 'reveal-card bonus' },
            h('p', { class: 'reveal-text' }, b.text),
            h('div', { class: 'reveal-authors' }, b.authors.map((name) => h('span', { class: 'chip chip-accent' }, name, h('span', { class: 'points-badge' }, t.common.plus(b.points))))),
          ),
        ),
      );
    } else {
      main = revealCard(focus, seen, true);
    }

    const done = reveal.done
      ? h('div', { class: 'reveal-done' }, S.revealDone, ' →')
      : null;

    add(el, 
      header(view),
      h('div', { class: 'reveal-top' }, wordBlock(view, { compact: true })),
      h('div', { class: 'reveal-main fit' }, main),
      others.length > 0 && h('div', { class: 'reveal-history' }, others.map((item) => revealMini(item))),
      done,
    );
  },

  SCOREBOARD(el, view) {
    add(el, 
      header(view),
      h('h1', { class: 'scoreboard-title' }, S.scoreboardTitle),
      rankingList(view.ranking, { withDelta: true }),
    );
  },

  GAME_OVER(el, view, { seen }) {
    const ranking = view.ranking ?? [];
    const podium = h('div', { class: 'podium' });
    const places = [2, 1, 3];
    for (const place of places) {
      const players = ranking.filter((r) => r.rank === place);
      if (!players.length) continue;
      podium.append(
        h(
          'div',
          { class: `podium-place place-${place}` },
          h(
            'div',
            { class: 'podium-names' },
            players.map((p) => h('div', { class: 'podium-name' }, p.name, p.members && h('small', {}, p.members))),
          ),
          h('div', { class: 'podium-score' }, t.common.points(players[0].score)),
          h('div', { class: 'podium-block' }, place),
        ),
      );
    }
    const rest = ranking.filter((r) => r.rank > 3);
    const stats = view.stats;
    add(el, 
      h('h1', { class: 'final-title' }, S.finalTitle),
      podium,
      h(
        'div',
        { class: 'final-bottom' },
        stats &&
          h(
            'div',
            { class: 'stats' },
            statCard('🎭', S.statsBluffer, stats.bestBluffer && stats.bestBluffer.names.join(', '), stats.bestBluffer && S.statsFooled(stats.bestBluffer.count)),
            statCard('📖', S.statsPro, stats.dictionaryPro && stats.dictionaryPro.names.join(', '), stats.dictionaryPro && S.statsCorrect(stats.dictionaryPro.count)),
            stats.mostConvincing &&
              statCard(
                '🏆',
                S.statsConvincing,
                `„${stats.mostConvincing.text}“`,
                `${stats.mostConvincing.term} · ${stats.mostConvincing.authors.join(', ')} · ${S.statsVotes(stats.mostConvincing.votes)}`,
              ),
          ),
        rest.length > 0 &&
          h(
            'ol',
            { class: 'final-chips fit' },
            rest.map((row) =>
              h('li', { class: 'final-chip' }, h('span', { class: 'muted' }, t.common.rank(row.rank)), ' ', h('strong', {}, row.name), ` · ${row.score}`),
            ),
          ),
      ),
    );
    markNew(seen, 'gameover', podium, 'rise');
  },
};

function statCard(icon, title, value, detail) {
  const long = (value ?? '').length > 30;
  return h(
    'div',
    { class: 'stat card' },
    h('div', { class: 'stat-icon', 'aria-hidden': 'true' }, icon),
    h('div', { class: 'stat-title' }, title),
    h('div', { class: ['stat-value', long && 'stat-value-long'] }, value || S.none),
    detail && h('div', { class: 'stat-detail muted' }, detail),
  );
}

function revealCard(item, seen, large) {
  if (!item) return null;
  const card = h('div', { class: ['reveal-card', item.isReal ? 'real' : 'fake', large && 'large'] });
  card.append(
    h(
      'div',
      { class: 'reveal-card-head' },
      h('span', { class: 'ballot-number' }, item.number),
      markNew(seen, `verdict:${item.id}:${item.isReal}`, h('span', { class: ['verdict', item.isReal ? 'verdict-real' : 'verdict-fake'] }, item.isReal ? S.real : S.invented), item.isReal ? 'celebrate' : 'stamp'),
    ),
    h('p', { class: 'reveal-text' }, item.text),
  );
  if (item.voters) {
    const voters = h(
      'div',
      { class: 'reveal-voters' },
      h('span', { class: 'reveal-label' }, item.isReal ? S.votedByReal : S.votedBy),
      item.voters.length
        ? item.voters.map((name, i) => {
            const chip = h('span', { class: 'chip voter', style: { animationDelay: `${i * 120}ms` } }, name, item.isReal && h('span', { class: 'points-badge' }, t.common.plus(item.points)));
            return markNew(seen, `voter:${item.id}:${name}`, chip, 'pop');
          })
        : h('span', { class: 'muted' }, S.noVotes),
    );
    card.append(voters);
  }
  if (item.authors) {
    card.append(
      h(
        'div',
        { class: 'reveal-authors' },
        h('span', { class: 'reveal-label' }, S.writtenBy),
        item.authors.map((author) =>
          markNew(
            seen,
            `author:${item.id}:${author.name}`,
            h('span', { class: 'chip chip-accent author' }, author.name, h('span', { class: 'points-badge big' }, t.common.plus(author.points))),
            'pop',
          ),
        ),
      ),
    );
  }
  return card;
}

function revealMini(item) {
  return h(
    'div',
    { class: ['reveal-mini', item.isReal ? 'real' : 'fake'] },
    h('span', { class: 'ballot-number' }, item.number),
    h('span', { class: 'reveal-mini-text' }, item.text),
    item.voters && h('span', { class: 'chip' }, S.statsVotes(item.voters.length)),
    item.authors && h('span', { class: 'reveal-mini-authors' }, item.authors.map((a) => a.name).join(', ')),
  );
}

function rankingList(ranking, { withDelta = false, withMembers = false } = {}) {
  const list = h('ol', { class: ['ranking', 'fit', 'flip-list', ranking.length > 10 && 'ranking-two-cols'] });
  for (const row of ranking) {
    const movement = withDelta && row.previousRank ? row.previousRank - row.rank : 0;
    list.append(
      h(
        'li',
        { class: ['ranking-row', row.rank <= 3 && `top-${row.rank}`], dataset: { key: row.id, delta: row.delta, score: row.score } },
        h('span', { class: 'ranking-rank' }, t.common.rank(row.rank)),
        h('span', { class: 'ranking-name' }, row.name, withMembers && row.members && h('small', {}, row.members)),
        withDelta && movement !== 0 && h('span', { class: ['ranking-move', movement > 0 ? 'up' : 'down'] }, movement > 0 ? `▲${movement}` : `▼${-movement}`),
        withDelta && row.delta !== 0 && h('span', { class: 'points-badge' }, t.common.plus(row.delta)),
        h('span', { class: 'ranking-score' }, row.score),
      ),
    );
  }
  return list;
}

/** Shows the old order and scores first, then moves rows to their new places. */
function animateScoreboard(container, view) {
  const list = container.querySelector('.ranking');
  if (!list || prefersReducedMotion()) return;
  const rows = [...list.children];
  const finalOrder = rows.slice();
  const previous = rows.slice().sort((a, b) => {
    const ra = view.ranking.find((r) => r.id === a.dataset.key);
    const rb = view.ranking.find((r) => r.id === b.dataset.key);
    return (ra.previousRank ?? ra.rank) - (rb.previousRank ?? rb.rank) || rb.score - rb.delta - (ra.score - ra.delta);
  });
  for (const row of previous) {
    list.append(row);
    const score = row.querySelector('.ranking-score');
    score.textContent = String(Number(row.dataset.score) - Number(row.dataset.delta));
    row.querySelector('.points-badge')?.classList.add('waiting');
  }
  setTimeout(() => {
    const rects = rectsByKey(list);
    for (const row of finalOrder) {
      list.append(row);
      const score = row.querySelector('.ranking-score');
      score.textContent = row.dataset.score;
      if (Number(row.dataset.delta)) score.classList.add('bump');
      row.querySelector('.points-badge')?.classList.remove('waiting');
    }
    flip(list, rects);
  }, 1200);
}
