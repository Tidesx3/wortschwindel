import { $, h, replace } from '../lib/dom.js';
import { createConnection } from '../lib/socket.js';
import { storage } from '../lib/storage.js';
import { sound } from '../lib/sound.js';
import { confirmDialog, dialog, initTheme, toast, toggleFullscreen, toggleTheme } from '../lib/ui.js';
import { createStage } from '../stage/stage.js';
import { createPanel } from './panel.js';
import { renderSetup } from './setup.js';
import { initShortcuts, showShortcutHelp } from './shortcuts.js';
import { t, errorText } from '../i18n.js';

const H = t.host;
initTheme('light');

const setupEl = $('#setup');
const consoleEl = $('#console');
const controlBar = $('#control-bar');

const host = {
  view: null,
  code: null,
  panelOpen: storage.get('panelOpen', true),
};

const connection = createConnection({
  onState: handleState,
  onConnect: authenticate,
  onEvent: {
    roomClosed: () => {
      storage.remove('hostRoom');
      host.code = null;
      host.view = null;
      toast(t.player.closedText);
      authenticate();
    },
  },
});

/** Emits and shows errors as toasts. Returns the response or null. */
export async function act(event, payload = {}) {
  const result = await connection.emit(event, payload);
  if (!result.ok) {
    if (result.error === 'hostAuthExpired') {
      storage.remove('hostToken');
      showLogin();
    }
    toast(errorText(result.error), { type: 'error' });
    return null;
  }
  return result;
}

const stage = createStage($('#stage'), { serverNow: connection.serverNow });
const panel = createPanel($('#panel'), { act, getView: () => host.view, onNext: () => next() });

// ---------------------------------------------------------------- auth & setup

async function authenticate() {
  const token = storage.get('hostToken');
  if (!token) return showLogin();
  const result = await connection.emit('host:auth', { hostToken: token });
  if (!result.ok) {
    if (result.error !== 'timeout') storage.remove('hostToken');
    return showLogin(result.error === 'timeout' ? null : result.error);
  }
  const lastRoom = storage.get('hostRoom');
  if (lastRoom && result.rooms.some((room) => room.code === lastRoom)) {
    const resumed = await connection.emit('host:resume', { code: lastRoom });
    if (resumed.ok) return enterConsole(resumed.code);
  }
  showSetup(result);
}

function showLogin(error = null) {
  consoleEl.hidden = true;
  setupEl.hidden = false;
  renderSetup(setupEl, {
    mode: 'login',
    error: error && error !== 'hostAuthExpired' ? errorText(error) : null,
    onLogin: async (pin) => {
      const result = await connection.emit('host:login', { pin });
      if (!result.ok) return errorText(result.error);
      storage.set('hostToken', result.hostToken);
      await authenticate();
      return null;
    },
  });
}

function showSetup(auth) {
  consoleEl.hidden = true;
  setupEl.hidden = false;
  renderSetup(setupEl, {
    mode: 'rooms',
    auth,
    onCreate: async (settings) => {
      const result = await act('host:createRoom', { settings });
      if (result) enterConsole(result.code);
    },
    onResume: async (code) => {
      const result = await act('host:resume', { code });
      if (result) enterConsole(result.code);
    },
    onLogout: () => {
      storage.remove('hostToken');
      storage.remove('hostRoom');
      showLogin();
    },
  });
}

function enterConsole(code) {
  host.code = code;
  storage.set('hostRoom', code);
  setupEl.hidden = true;
  consoleEl.hidden = false;
  document.title = `Wortschwindel – ${code}`;
  applyPanelState();
}

function applyPanelState() {
  consoleEl.classList.toggle('panel-closed', !host.panelOpen);
}

export function togglePanel() {
  host.panelOpen = !host.panelOpen;
  storage.set('panelOpen', host.panelOpen);
  applyPanelState();
}

// ---------------------------------------------------------------- state

function handleState(view) {
  if (view.role !== 'host') return;
  if (consoleEl.hidden) enterConsole(view.code);
  host.view = view;
  stage.update(view);
  renderControls(view);
  panel.update(view);
}

// ---------------------------------------------------------------- actions

function everyoneDone(view) {
  return !view.progress || view.progress.done >= view.progress.total;
}

/** Primary "next" action (button, space bar). */
export async function next({ fromKeyboard = false } = {}) {
  const view = host.view;
  if (!view) return;
  switch (view.phase) {
    case 'LOBBY':
      return act('host:startGame');
    case 'WRITING':
    case 'VOTING': {
      if (view.phase === 'VOTING' && !view.ballot.votingOpen) return act('host:present', { action: 'next' });
      const timerRunning = view.timer && !view.timer.expired;
      if (!everyoneDone(view) && (timerRunning || fromKeyboard)) {
        const ok = await confirmDialog(`${t.stage[view.phase === 'WRITING' ? 'submittedCount' : 'votedCount'](view.progress.done, view.progress.total)}. ${H.endNow}?`, {
          confirmLabel: H.next[view.phase],
          danger: false,
        });
        if (!ok) return null;
      }
      return act('host:next');
    }
    case 'MODERATION': {
      if (view.host.moderationWarning) {
        const choice = await dialog({
          message: H.fewDefinitions,
          buttons: [
            { label: t.common.cancel, value: 'cancel', class: 'btn-ghost' },
            { label: H.skipRound, value: 'skip' },
            { label: H.next.MODERATION, value: 'go', class: 'btn-primary' },
          ],
        });
        if (choice === 'skip') return act('host:skipWord');
        if (choice !== 'go') return null;
      }
      return act('host:startVoting');
    }
    case 'REVEAL':
    case 'SCOREBOARD':
      return act('host:next');
    case 'GAME_OVER':
      if (fromKeyboard) return null;
      return playAgain();
    default:
      return null;
  }
}

async function playAgain() {
  if (await confirmDialog(H.playAgainConfirm, { confirmLabel: H.playAgain, danger: false })) act('host:playAgain');
}

export function togglePause() {
  const timer = host.view?.timer;
  if (!timer || timer.expired) return;
  act('host:timer', { action: timer.paused ? 'resume' : 'pause' });
}

function timerEditable(view) {
  return view?.phase === 'WRITING' || (view?.phase === 'VOTING' && view.ballot?.votingOpen);
}

export function addTime() {
  if (timerEditable(host.view)) act('host:timer', { action: 'add' });
}

/** Set, replace or remove the countdown while the round is running. */
export async function setTimer() {
  const view = host.view;
  if (!timerEditable(view)) return;
  const choice = await dialog({
    title: H.setTimer,
    message: view.timer ? H.setTimerReplace : H.setTimerNew,
    buttons: [
      { label: t.common.cancel, value: 'cancel', class: 'btn-ghost' },
      view.timer && { label: t.common.noLimit, value: '0' },
      ...[30, 60, 90, 120, 180].map((s) => ({ label: H.timerOption(s), value: String(s), class: 'btn-primary' })),
    ].filter(Boolean),
  });
  if (choice === null) return;
  act('host:timer', { action: 'set', seconds: Number(choice) });
}

export function moveHighlight(direction) {
  const view = host.view;
  if (view?.phase !== 'VOTING') return;
  const ballot = view.ballot;
  if (!ballot.votingOpen) {
    act('host:present', { action: direction > 0 ? 'next' : 'prev' });
    return;
  }
  const count = ballot.entries.length;
  if (!count) return;
  const current = view.highlight ?? (direction > 0 ? 0 : count + 1);
  const target = current + direction;
  act('host:highlight', { number: target < 1 || target > count ? null : target });
}

async function skipWord() {
  const choice = await dialog({
    title: H.skipWord,
    message: H.skipWordConfirm,
    buttons: [
      { label: t.common.cancel, value: 'cancel', class: 'btn-ghost' },
      { label: H.skipReasonUnfit, value: 'unfit', class: 'btn-danger' },
      { label: H.skipReasonKnown, value: 'known', class: 'btn-danger' },
    ],
  });
  if (choice) act('host:skipWord');
}

async function endGame() {
  if (await confirmDialog(H.endGameConfirm, { confirmLabel: H.endGame })) act('host:endGame');
}

async function closeRoom() {
  if (await confirmDialog(H.closeRoomConfirm, { confirmLabel: H.closeRoom })) act('host:closeRoom');
}

async function exportCsv() {
  const result = await act('host:exportCsv');
  if (!result) return;
  const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: result.filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function screenUrl() {
  const view = host.view;
  return `${location.origin}/screen/${encodeURIComponent(view.code)}?token=${encodeURIComponent(view.host.screenToken)}`;
}

function openScreen() {
  window.open(screenUrl(), `wortschwindel-screen-${host.view.code}`, 'noopener');
}

async function copyScreenLink() {
  try {
    await navigator.clipboard.writeText(screenUrl());
    toast(H.copied, { type: 'success' });
  } catch {
    await dialog({ message: screenUrl(), buttons: [{ label: t.common.ok, value: 'ok', class: 'btn-primary' }] });
  }
}

// ---------------------------------------------------------------- control bar

function nextLabel(view) {
  switch (view.phase) {
    case 'VOTING':
      if (!view.ballot.votingOpen) {
        return view.ballot.presentedCount < view.ballot.total ? H.next.presenting : H.next.openVoting;
      }
      return H.next.VOTING;
    case 'REVEAL':
      return view.reveal.done ? H.next.revealDone : H.next.REVEAL;
    case 'SCOREBOARD':
      return view.isLastRound ? H.next.lastRound : H.next.SCOREBOARD;
    default:
      return H.next[view.phase];
  }
}

/** Active modifiers during a round, planned ones while preparing the next round. */
function modifierChips(view) {
  const prep = view.host.nextRound;
  const planned = prep && (view.phase === 'LOBBY' || view.phase === 'SCOREBOARD');
  const ids = planned ? (prep.wheel ? ['wheel'] : prep.modifiers) : view.phase === 'SCOREBOARD' ? [] : view.modifiers?.list ?? [];
  if (!ids.length) return null;
  return h(
    'span',
    { class: ['cb-modifiers', planned && 'planned'], title: planned ? t.host.tabs.prep : '' },
    ids.map((id) => h('span', { class: 'chip small', title: t.modifiers[id]?.desc }, t.modifiers[id]?.icon, ' ', t.modifiers[id]?.name)),
  );
}

function button(label, onclick, { cls = '', title = null, pressed = null, disabled = false } = {}) {
  return h(
    'button',
    { class: `btn btn-small ${cls}`, type: 'button', title: title ?? label, onclick, disabled, 'aria-pressed': pressed === null ? null : String(pressed) },
    label,
  );
}

function renderControls(view) {
  const timer = view.timer;
  const phaseButtons = [];
  const timerControls = () => [
    button(`⏱ ${H.setTimer}`, setTimer, { title: `${H.setTimer} (T)` }),
    button(H.addTime, addTime),
    timer && button(timer.paused ? `▶ ${H.resume}` : `⏸ ${H.pause}`, togglePause, { disabled: timer.expired }),
  ].filter(Boolean);

  if (view.phase === 'WRITING') phaseButtons.push(...timerControls(), button(H.skipWord, skipWord));
  if (view.phase === 'MODERATION') phaseButtons.push(button(H.skipRound, skipWord));
  if (view.phase === 'VOTING') {
    if (view.ballot.votingOpen) phaseButtons.push(...timerControls());
    else {
      phaseButtons.push(
        button(`← ${H.prev}`, () => act('host:present', { action: 'prev' }), { disabled: view.ballot.presentedCount === 0 }),
        button(H.showAll, () => act('host:present', { action: 'all' })),
      );
    }
  }
  if (view.phase === 'REVEAL' && !view.reveal.done) phaseButtons.push(button(H.revealAll, () => act('host:revealAll')));
  if (view.phase === 'GAME_OVER') phaseButtons.push(button(H.export, exportCsv));
  if (!['LOBBY', 'GAME_OVER'].includes(view.phase)) phaseButtons.push(button(H.endGame, endGame, { cls: 'btn-ghost danger-text' }));
  if (['LOBBY', 'GAME_OVER'].includes(view.phase)) phaseButtons.push(button(H.closeRoom, closeRoom, { cls: 'btn-ghost danger-text' }));
  if (['SCOREBOARD', 'REVEAL'].includes(view.phase) && view.roundNumber > 0) phaseButtons.push(button(H.export, exportCsv, { cls: 'btn-ghost' }));

  const primaryDisabled = view.phase === 'LOBBY' && view.players.length === 0;

  replace(
    controlBar,
    h(
      'div',
      { class: 'cb-group cb-info' },
      h('span', { class: 'cb-brand' }, t.appName),
      h('span', { class: 'cb-code', title: 'Raumcode' }, view.code),
      h('span', { class: 'chip' }, H.phase[view.phase]),
      view.roundNumber > 0 && view.phase !== 'LOBBY' && h('span', { class: 'cb-round' }, t.common.round(view.roundNumber, view.totalRounds)),
      modifierChips(view),
      connection.dot,
    ),
    h(
      'div',
      { class: 'cb-group cb-actions' },
      h(
        'button',
        { class: 'btn btn-primary cb-next', type: 'button', onclick: () => next(), disabled: primaryDisabled, title: 'Leertaste' },
        view.phase === 'GAME_OVER' ? H.playAgain : `${nextLabel(view)} →`,
      ),
      phaseButtons,
    ),
    h(
      'div',
      { class: 'cb-group cb-tools' },
      button(`📺 ${H.openScreen}`, openScreen),
      button('🔗', copyScreenLink, { title: H.copyScreenLink, cls: 'btn-icon' }),
      button(sound.isMuted() ? '🔇' : '🔊', () => sound.toggle(), { title: `${H.sound} (M)`, cls: 'btn-icon' }),
      button('◐', toggleTheme, { title: `${H.theme}`, cls: 'btn-icon' }),
      button('⛶', toggleFullscreen, { title: `${H.fullscreen} (F)`, cls: 'btn-icon' }),
      button('☰', togglePanel, { title: `${H.panel} (S)`, cls: 'btn-icon', pressed: host.panelOpen }),
      button('?', showShortcutHelp, { title: H.help, cls: 'btn-icon' }),
    ),
  );
}

sound.onChange(() => host.view && renderControls(host.view));

initShortcuts({
  next: () => next({ fromKeyboard: true }),
  back: () => moveHighlight(-1),
  forward: () => {
    const view = host.view;
    if (view?.phase === 'VOTING') moveHighlight(1);
    else next({ fromKeyboard: true });
  },
  pause: togglePause,
  addTime,
  setTimer,
  fullscreen: toggleFullscreen,
  panel: () => {
    togglePanel();
    if (host.view) renderControls(host.view);
  },
  mute: () => sound.toggle(),
});
