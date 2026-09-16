import { $, h } from './lib/dom.js';
import { createConnection } from './lib/socket.js';
import { createStage } from './stage/stage.js';
import { sound } from './lib/sound.js';
import { initTheme, toggleTheme, toggleFullscreen } from './lib/ui.js';
import { t, errorText } from './i18n.js';

initTheme('light');

const code = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] ?? '').toUpperCase();
const token = new URLSearchParams(location.search).get('token') ?? '';
const errorBox = $('#screen-error');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

const connection = createConnection({
  onState: (view) => {
    errorBox.hidden = true;
    stage.update(view);
  },
  onConnect: async () => {
    const result = await connection.emit('screen:join', { code, screenToken: token });
    if (!result.ok) showError(errorText(result.error));
  },
  onEvent: {
    roomClosed: () => showError(t.player.closedText),
  },
});

const stage = createStage($('#stage'), { serverNow: connection.serverNow });

const muteButton = h('button', { class: 'btn btn-small btn-icon', type: 'button', title: t.host.sound, onclick: () => sound.toggle() });
const updateMute = () => {
  muteButton.textContent = sound.isMuted() ? '🔇' : '🔊';
};
sound.onChange(updateMute);
updateMute();

$('#screen-tools').append(
  connection.dot,
  muteButton,
  h('button', { class: 'btn btn-small btn-icon', type: 'button', title: t.host.theme, onclick: toggleTheme }, '◐'),
  h('button', { class: 'btn btn-small btn-icon', type: 'button', title: t.host.fullscreen, onclick: toggleFullscreen }, '⛶'),
);

document.addEventListener('keydown', (event) => {
  if (event.key === 'f' || event.key === 'F') toggleFullscreen();
  if (event.key === 'm' || event.key === 'M') sound.toggle();
});
