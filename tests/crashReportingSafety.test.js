import assert from 'node:assert/strict';
import test from 'node:test';

import state from '../src/state.js';
import utils from '../src/utils.js';

test('Las utilidades de reporte de errores toleran la ausencia del cliente de Discord', async () => {
  const originalClient = state.dcClient;
  const originalSettings = { ...state.settings };

  try {
    state.dcClient = null;
    state.settings.GuildID = '';
    state.settings.ControlChannelID = '';

    const channel = await utils.discord.getControlChannel();
    assert.equal(channel, null);
  } finally {
    state.dcClient = originalClient;
    Object.keys(state.settings).forEach((key) => { delete state.settings[key]; });
    Object.assign(state.settings, originalSettings);
  }
});

