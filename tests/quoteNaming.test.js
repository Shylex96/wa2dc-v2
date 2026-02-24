import assert from 'node:assert/strict';
import test from 'node:test';

import state from '../src/state.js';
import utils from '../src/utils.js';
import messageStore from '../src/messageStore.js';

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};

test('getQuote prefiere el nombre en caché del remitente original', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);

  try {
    restoreObject(state.contacts, {});
    messageStore.cache.clear();

    state.waClient = { contacts: state.contacts, user: { id: '0@s.whatsapp.net' } };

    const chatJid = '12345@g.us';
    const stanzaId = 'stanza-1';

    messageStore.set({
      key: {
        id: stanzaId,
        remoteJid: chatJid,
        fromMe: false,
        participant: '14155550123@s.whatsapp.net',
      },
      pushName: 'Esteban',
      message: { conversation: 'Voy a hacer una prueba, no le des importancia' },
    });

    const quote = await utils.whatsapp.getQuote({
      key: { remoteJid: chatJid, fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'Ok',
          contextInfo: {
            stanzaId,
            participant: '67465430188278@lid',
            quotedMessage: { conversation: 'Voy a hacer una prueba, no le des importancia' },
          },
        },
      },
    });

    assert.equal(quote?.name, 'Esteban');
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    messageStore.cache.clear();
  }
});

test('getQuote resuelve autores con LID usando lidMapping cuando está disponible', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);

  try {
    restoreObject(state.contacts, {});
    messageStore.cache.clear();

    const pnJid = '14155550123@s.whatsapp.net';
    const lidJid = '67465430188278@lid';
    state.contacts[pnJid] = 'Esteban';

    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: {
        lidMapping: {
          getPNForLID: async (jid) =>
            (utils.whatsapp.formatJid(jid) === lidJid ? pnJid : null),
        },
      },
    };

    const quote = await utils.whatsapp.getQuote({
      key: { remoteJid: '12345@g.us', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'Ok',
          contextInfo: {
            stanzaId: 'stanza-2',
            participant: lidJid,
            quotedMessage: {
              conversation: 'Voy a hacer una prueba, no le des importancia',
            },
          },
        },
      },
    });

    assert.equal(quote?.name, 'Esteban');
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    messageStore.cache.clear();
  }
});