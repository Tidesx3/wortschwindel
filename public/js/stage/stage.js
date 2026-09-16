import { add, h, replace, flip, rectsByKey, prefersReducedMotion, svg } from '../lib/dom.js';
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
  replace(root, ambientLayer(), content, hostAway);
  const announcer = createAnnouncer(root);
  let announcedRound = null;
  watchSize(root);

  function update(view) {
    timer.update(view.timer);
    root.dataset.phase = view.phase;
    hostAway.hidden = view.role !== 'screen' || view.hostConnected || view.phase === 'LOBBY';

    const key = renderKey(view);
    if (key === lastKey) return;
    lastKey = key;

    const phaseChanged = view.phase !== lastPhase;
    // A new game starts in the lobby: forget which elements were already animated.
    if (phaseChanged && view.phase === 'LOBBY' && lastPhase) seen.clear();
    playSounds(view, phaseChanged);
    const renderer = RENDERERS[view.phase];
    const previousRects = view.phase === 'SCOREBOARD' || view.phase === 'LOBBY' ? rectsByKey(content.querySelector('.flip-list')) : new Map();
    const next = h('div', { class: ['stage-phase', `stage-${view.phase.toLowerCase()}`, phaseChanged && 'phase-enter'] });
    renderer?.(next, view, { timer, seen, phaseChanged, previousRects });
    replace(content, next);
    if (view.phase === 'SCOREBOARD' && phaseChanged) animateScoreboard(next, view);
    else if (previousRects.size) flip(next.querySelector('.flip-list'), previousRects);
    for (const el of next.querySelectorAll('.fit')) fitToBox(el);
    const progress = next.querySelector('.progress-text');
    if (progress && !phaseChanged && lastView?.progress?.done !== view.progress?.done) progress.classList.add('bump');
    if (view.phase === 'GAME_OVER' && phaseChanged) {
      // Burst when the winner appears on the podium.
      setTimeout(() => confetti({ duration: 6000 }), prefersReducedMotion() ? 0 : 3000);
    }
    // Announce modifiers once per round – not when a screen joins mid-round.
    const roundKey = view.modifiers ? `${view.code}:${view.modifiers.roundNumber}` : null;
    if (roundKey && roundKey !== announcedRound) {
      if (lastView && view.phase === 'WRITING' && view.modifiers.list.length) announcer.show(view.modifiers);
      announcedRound = roundKey;
    }
    if (view.phase !== 'WRITING' && phaseChanged) announcer.hide();
    lastPhase = view.phase;
    lastView = view;
  }

  function playSounds(view, phaseChanged) {
    // A screen that (re)loads mid-game should not replay the current effect.
    if (!lastView) {
      lastRevealStep = view.reveal?.step ?? null;
      return;
    }
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
        if (current.type === 'real' || current.type === 'bonus' || current.type === 'favorite') sound.reveal();
        if (current.type === 'real' || current.type === 'favorite') setTimeout(() => confetti({ count: 90, duration: 2600 }), 350);
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
  // Measure without running entrance animations (their transforms count as overflow).
  el.classList.add('measuring');
  let scale = 1;
  el.style.setProperty('--fit', '1');
  while (scale > 0.45 && el.scrollHeight > el.clientHeight + 1) {
    scale -= 0.05;
    el.style.setProperty('--fit', scale.toFixed(2));
  }
  el.classList.remove('measuring');
}

/** Re-fits text whenever the stage itself changes size (window, side panel, console reveal). */
function watchSize(root) {
  let frame = null;
  const refit = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => root.querySelectorAll('.fit').forEach(fitToBox));
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(refit).observe(root);
  else window.addEventListener('resize', refit);
}

/** Slowly drifting letters behind the lobby / waiting screens (persistent, never re-rendered). */
function ambientLayer() {
  const letters = 'AÄBßWÖ?ZüK!eQxß'.split('');
  return h(
    'div',
    { class: 'ambient', 'aria-hidden': 'true' },
    letters.map((letter, i) =>
      h(
        'span',
        {
          class: 'ambient-letter',
          style: {
            '--x': `${(i * 37) % 100}%`,
            '--size': String(4 + ((i * 7) % 6)),
            '--duration': `${18 + ((i * 5) % 14)}s`,
            '--delay': `${-((i * 3.7) % 30)}s`,
          },
        },
        letter,
      ),
    ),
  );
}

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
    view.phase !== 'SCOREBOARD' && modifierBadges(view.modifiers),
    extra,
    h('span', { class: 'stage-code' }, view.code),
  );
}

function wordBlock(view, { compact = false, seen = null } = {}) {
  const word = view.word;
  if (!word) return null;
  const meta = S.wordClass(word.article, word.wordClass);
  // The big term drops in letter by letter the first time it is shown.
  const key = `word:${view.roundNumber}:${word.term}`;
  const animate = seen && !seen.has(key) && !prefersReducedMotion();
  if (seen) seen.add(key);
  const term = animate && [...word.term].length > 16
    ? h('span', { class: 'word-letters bounce-in' }, word.term)
    : animate
    ? h(
        'span',
        { class: 'word-letters', 'aria-hidden': 'true' },
        [...word.term].map((char, i) => h('span', { class: 'word-letter', style: { '--i': String(i) } }, char)),
      )
    : word.term;
  return h(
    'div',
    { class: ['word', compact && 'word-compact', animate && 'word-enter'] },
    h('div', { class: 'word-term', lang: 'de', 'aria-label': word.term }, term),
    (meta || word.category) &&
      h('div', { class: 'word-meta' }, meta && h('span', {}, meta), word.category && h('span', { class: 'chip chip-accent' }, word.category)),
  );
}

/** Geometric check mark: font glyphs sit off-centre inside small circles. */
function checkIcon() {
  return svg(
    'svg',
    { viewBox: '0 0 24 24', class: 'check-icon' },
    svg('path', { d: 'M5.5 12.5l4.2 4.2L18.5 7.8', fill: 'none', stroke: 'currentColor', 'stroke-width': 3.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
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
    // Only the chip that just turned green animates, not all of them on every update.
    const doneKey = `done:${view.phase}:${view.roundNumber}:${view.word?.term}:${player.id}`;
    const justDone = done && !seen.has(doneKey);
    if (done) seen.add(doneKey);
    const chip = h(
      'li',
      {
        class: ['player-chip', done && 'done', justDone && 'just-done', !player.connected && 'offline', player.away && 'away'],
        dataset: { key: player.id },
      },
      status && h('span', { class: 'player-check', 'aria-hidden': 'true' }, done && checkIcon()),
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
      h('div', { class: 'writing-main' }, wordBlock(view, { seen }), h('div', { class: 'stage-timer' }, timer.el)),
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
    const fresh = ballot.entries.filter((entry) => !seen.has(`ballot:${entry.id}`)).length;
    ballot.entries.forEach((entry, index) => {
      const item = h(
        'li',
        { class: ['ballot-entry', view.highlight === entry.number && 'highlight'], style: { '--i': String(index) } },
        h('span', { class: 'ballot-number' }, entry.number),
        h('span', { class: 'ballot-text' }, entry.text),
      );
      // A single new entry is "dealt" like a card; many at once cascade in.
      list.append(markNew(seen, `ballot:${entry.id}`, item, fresh === 1 ? 'deal' : 'appear'));
    });
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
          markNew(seen, `callout:${view.roundNumber}:${view.word?.term}`, h('div', { class: 'voting-callout accent' }, S.voteNow), 'bounce-in'),
          ballot.favoriteEnabled && h('div', { class: 'favorite-hint' }, S.favoriteHint),
          h('div', { class: 'stage-timer small' }, timer.el),
          view.progress && h('div', { class: 'progress-text' }, S.votedCount(view.progress.done, view.progress.total)),
        );
    add(el, header(view), h('div', { class: 'voting-layout' }, h('div', { class: 'voting-side' }, wordBlock(view, { compact: true }), status), list));
  },

  REVEAL(el, view, { seen }) {
    const reveal = view.reveal;
    const current = reveal.current;
    const items = reveal.items;
    const focusId = current && current.id ? current.id : null;
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
    } else if (current.type === 'favorite') {
      main = favoriteReveal(reveal.favorite);
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
      // Bonus/favourite steps need the whole space; the history is hidden there.
      others.length > 0 &&
        !['bonus', 'favorite'].includes(current?.type) &&
        h('div', { class: 'reveal-history' }, others.map((item) => markNew(seen, `mini:${item.id}`, revealMini(item)))),
      done,
    );
  },

  SCOREBOARD(el, view, { phaseChanged }) {
    add(el,
      header(view),
      h('h1', { class: 'scoreboard-title' }, S.scoreboardTitle),
      rankingList(view.ranking, { withDelta: true, withMovement: view.roundNumber > 1, cascade: phaseChanged }),
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
          place === 1 && h('div', { class: 'podium-crown', 'aria-hidden': 'true' }, '👑'),
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
        { class: ['final-bottom', !seen.has('gameover') && !prefersReducedMotion() && 'stagger'] },
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

function favoriteReveal(favorite) {
  const box = h('div', { class: 'reveal-favorite' }, h('h2', { class: 'favorite-title' }, '⭐ ', S.favoriteTitle, ' ⭐'));
  if (!favorite || !favorite.winners.length) {
    add(box, h('p', { class: 'muted' }, S.favoriteNone));
    return box;
  }
  const multi = favorite.winners.length > 1;
  add(
    box,
    h(
      'div',
      { class: ['favorite-winners', multi && 'multi'] },
      favorite.winners.map((winner, i) =>
      h(
        'div',
        { class: 'reveal-card favorite-card', style: { animationDelay: `${200 + i * 150}ms` } },
        h('div', { class: 'reveal-card-head' }, h('span', { class: 'ballot-number' }, winner.number), h('span', { class: 'chip chip-gold' }, S.favoriteVotes(favorite.votes))),
        h('p', { class: 'reveal-text' }, winner.text),
        h(
          'div',
          { class: 'reveal-authors' },
          h('span', { class: 'reveal-label' }, S.writtenBy),
          winner.authors.map((author) =>
            h('span', { class: 'chip chip-accent author pop' }, author.name, h('span', { class: 'points-badge big' }, t.common.plus(author.points))),
          ),
        ),
      ),
      ),
    ),
  );
  return box;
}

function modifierBadges(modifiers) {
  if (!modifiers?.list?.length) return null;
  return h(
    'span',
    { class: 'modifier-badges' },
    modifiers.list.map((id) => {
      const mod = t.modifiers[id];
      return mod && h('span', { class: `modifier-badge mod-${id}`, title: mod.desc }, mod.icon, ' ', mod.name);
    }),
  );
}

/** Full-screen announcement of the round's modifiers; spins a reel for the wheel. */
function createAnnouncer(root) {
  const overlay = h('div', { class: 'announce', hidden: true, onclick: () => hide() });
  root.append(overlay);
  let timers = [];

  function hide() {
    timers.forEach(clearTimeout);
    timers = [];
    root.classList.remove('announcing');
    overlay.classList.remove('visible');
    timers.push(setTimeout(() => (overlay.hidden = true), 400));
  }

  function card(id, extra = '') {
    const mod = t.modifiers[id];
    return h(
      'div',
      { class: `announce-card mod-${id} ${extra}` },
      h('div', { class: 'announce-icon' }, mod.icon),
      h('div', { class: 'announce-name' }, mod.name),
      h('div', { class: 'announce-desc' }, mod.desc),
    );
  }

  function show(modifiers) {
    timers.forEach(clearTimeout);
    timers = [];
    const reduced = prefersReducedMotion();
    const cards = h('div', { class: 'announce-cards' });
    const title = h('div', { class: 'announce-title' }, modifiers.wheel ? `${t.modifiers.wheel.icon} ${S.wheelTitle}` : S.modifierIntro);
    replace(overlay, h('div', { class: 'announce-inner' }, title, cards));
    // Keep the result secret in the header while the wheel spins.
    root.classList.add('announcing');
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('visible'));

    const HOLD_MS = 3800;
    if (modifiers.wheel && !reduced) {
      // Slot-machine reel: cycle quickly, slow down, land on the result.
      // The overlay is hidden relative to the landing, so throttled timers cannot cut it short.
      const ids = Object.keys(t.modifiers).filter((id) => id !== 'wheel');
      const result = modifiers.list[0];
      const reel = h('div', { class: 'announce-reel' });
      cards.append(reel);
      let step = 0;
      const total = 22;
      const stepDelay = (n) => 50 + n * n * 0.9;
      const spin = () => {
        const id = step >= total ? result : ids[(ids.indexOf(result) + step + 1) % ids.length];
        const mod = t.modifiers[id];
        replace(reel, h('span', { class: 'reel-item' }, mod.icon, ' ', mod.name));
        if (step < total) {
          sound.tick(false);
          step += 1;
          timers.push(setTimeout(spin, stepDelay(step)));
        } else {
          sound.reveal();
          reel.classList.add('landed');
          timers.push(
            setTimeout(() => {
              replace(cards, card(result, 'pop-big'));
              timers.push(setTimeout(hide, HOLD_MS));
            }, 700),
          );
        }
      };
      spin();
    } else {
      modifiers.list.forEach((id, i) => {
        const el = card(id, 'pop-big');
        el.style.animationDelay = `${i * 180}ms`;
        cards.append(el);
      });
      sound.reveal();
      timers.push(setTimeout(hide, HOLD_MS));
    }
  }

  return { show, hide };
}

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
  const verdictKey = `verdict:${item.id}:${item.isReal}`;
  const verdictIsNew = !seen.has(verdictKey);
  markNew(seen, `card:${item.id}`, card, 'card-in');
  if (verdictIsNew && !prefersReducedMotion()) card.classList.add(item.isReal ? 'spotlight-in' : 'shake');
  // The real card keeps its glow after the first reveal.
  if (item.isReal) card.classList.add('spotlight');
  card.append(
    h(
      'div',
      { class: 'reveal-card-head' },
      h('span', { class: 'ballot-number' }, item.number),
      markNew(seen, verdictKey, h('span', { class: ['verdict', item.isReal ? 'verdict-real' : 'verdict-fake'] }, item.isReal ? S.real : S.invented), item.isReal ? 'celebrate' : 'stamp'),
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
            const points = item.voterPoints?.[i];
            const chip = h(
              'span',
              { class: ['chip voter', item.isReal ? 'voter-right' : 'voter-fooled'], style: { animationDelay: `${i * 120}ms` } },
              name,
              item.isReal && points != null && h('span', { class: 'points-badge' }, t.common.plus(points)),
            );
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
            h('span', { class: 'chip chip-accent author' }, author.name, h('span', { class: ['points-badge big', author.points === 0 && 'zero'] }, t.common.plus(author.points))),
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

function rankingList(ranking, { withDelta = false, withMovement = false, withMembers = false, cascade = false } = {}) {
  const list = h('ol', { class: ['ranking', 'fit', 'flip-list', ranking.length > 10 && 'ranking-two-cols', cascade && !prefersReducedMotion() && 'cascade'] });
  for (const [index, row] of ranking.entries()) {
    const movement = withMovement && row.previousRank ? row.previousRank - row.rank : 0;
    list.append(
      h(
        'li',
        {
          class: ['ranking-row', row.rank <= 3 && `top-${row.rank}`],
          dataset: { key: row.id, delta: row.delta, score: row.score },
          style: { '--i': String(index) },
        },
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
      const badge = row.querySelector('.points-badge');
      badge?.classList.remove('waiting');
      badge?.classList.add('points-new');
      // The cascade is over; plain rows keep the FLIP transform working.
      row.style.animation = 'none';
    }
    flip(list, rects);
  }, 1200);
}
