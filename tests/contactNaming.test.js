import assert from 'node:assert/strict';
import test from 'node:test';

import state from '../src/state.js';
import utils from '../src/utils.js';

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};

test('updateContacts no sobrescribe los nombres existentes con las actualizaciones pushName', () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);

  try {
    restoreObject(state.contacts, {});
    state.waClient = { contacts: state.contacts };

    const jid = '14155550123@s.whatsapp.net';
    state.contacts[jid] = 'Esteban Albarrán';

    utils.whatsapp.updateContacts([{
      id: jid,
      notify: 'Esteban',
      pushName: 'Esteban',
    }]);

    assert.equal(state.contacts[jid], 'Esteban Albarrán');
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
  }
});

prueba('updateContacts sobrescribe los números de teléfono de respaldo con nombres mejores', () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);

  try {
    restoreObject(state.contacts, {});
    state.waClient = { contacts: state.contacts };

    const jid = '14155550123@s.whatsapp.net';
    state.contacts[jid] = '14155550123';

    utils.whatsapp.updateContacts([{
      id: jid,
      notify: 'Esteban',
    }]);

    assert.equal(state.contacts[jid], 'Esteban');
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
  }
});

prueba('updateContacts almacena nombres tanto para PN como para LID cuando están disponibles', () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);

  try {
    restoreObject(state.contacts, {});
    state.waClient = { contacts: state.contacts, user: { id: '0@s.whatsapp.net' } };

    const pnJid = '14155550123@s.whatsapp.net';
    const lidJid = '161040050426060@lid';

    utils.whatsapp.updateContacts([{
      id: pnJid,
      lid: lidJid,
      notify: 'Esteban Albarrán',
    }]);

    assert.equal(state.contacts[pnJid], 'Esteban Albarrán');
    assert.equal(state.contacts[lidJid], 'Esteban Albarrán');
    assert.equal(utils.whatsapp.jidToName(lidJid), 'Esteban Albarrán');
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
  }
});

test('jidToName se devalúa cuando el nombre del contacto está en blanco o contiene espacios en blanco', () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);

  try {
    restoreObject(state.contacts, {});
    state.waClient = { contacts: state.contacts, user: { id: '0@s.whatsapp.net' } };

    const jid = '14155550123@s.whatsapp.net';
    state.contacts[jid] = '   ';

    assert.equal(utils.whatsapp.jidToName(jid), '14155550123');
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
  }
});

test('updateContacts ignora candidatos de nombres en blanco o con espacios en blanco', () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);

  try {
    restoreObject(state.contacts, {});
    state.waClient = { contacts: state.contacts, user: { id: '0@s.whatsapp.net' } };

    const jid = '14155550123@s.whatsapp.net';
    state.contacts[jid] = '14155550123';

    utils.whatsapp.updateContacts([{
      id: jid,
      notify: '   ',
      pushName: '',
    }]);

    assert.equal(state.contacts[jid], '14155550123');
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
  }
});
