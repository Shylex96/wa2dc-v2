import assert from 'node:assert/strict';
import test from 'node:test';

import state from '../src/state.js';
import utils from '../src/utils.js';

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};

test('Las menciones de WhatsApp pueden convertirse en menciones vinculadas de usuarios en Discord', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const discordUserId = '123456789012345678';
    state.contacts[pnJid] = 'Esteban';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const msg = {
      text: 'Hola @14155550123',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hola <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Las menciones de WhatsApp no vinculadas recurren a los nombres de contacto de WhatsApp', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    state.contacts[pnJid] = 'Esteban';
    state.settings.WhatsAppDiscordMentionLinks = {};

    const msg = {
      text: 'Hola @14155550123',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, 'Hola @Esteban');
    assert.deepEqual(result.discordMentions, []);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Las menciones de WhatsApp vinculadas usan los nombres de Discord en caché en el modo name-target', async () => {
  const originalWaClient = state.waClient;
  const originalDcClient = state.dcClient;
  const originalGuildId = state.settings.GuildID;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const discordUserId = '123456789012345678';

    state.dcClient = {
      users: {
        cache: new Map([
          [discordUserId, { id: discordUserId, username: 'Panos' }],
        ]),
      },
      guilds: { cache: new Map() },
    };
    state.settings.GuildID = 'guild-1';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const msg = {
      text: 'Hola @14155550123',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'name' });
    assert.equal(result.content, 'Hola @Esteban');
    assert.deepEqual(result.discordMentions, []);
  } finally {
    state.waClient = originalWaClient;
    state.dcClient = originalDcClient;
    state.settings.GuildID = originalGuildId;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Las menciones vinculadas funcionan cuando WhatsApp proporciona JIDs LID pero el texto del mensaje contiene el token PN', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});

    const pnJid = '14155550123@s.whatsapp.net';
    const lidJid = '161040050426060@lid';
    const discordUserId = '123456789012345678';

    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: {
        lidMapping: {
          getPNForLID: async (jid) => (jid === lidJid ? pnJid : null),
        },
      },
    };

    state.contacts[pnJid] = 'Esteban';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const msg = {
      text: 'Hola @14155550123',
      contextInfo: { mentionedJid: [lidJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hola <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Las menciones vinculadas se resuelven cuando los enlaces de mención se guardaron con un JID de teléfono con prefijo +', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const legacyKey = '+14155550123@s.whatsapp.net';
    const discordUserId = '123456789012345678';
    state.contacts[pnJid] = 'Esteban';
    state.settings.WhatsAppDiscordMentionLinks = { [legacyKey]: discordUserId };

    const msg = {
      text: 'Hola @14155550123',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hola <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Las menciones vinculadas hacen ping cuando el texto del mensaje de WhatsApp usa el token del nombre del contacto', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const discordUserId = '123456789012345678';
    state.contacts[pnJid] = 'Esteban';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const msg = {
      text: 'Hola @Esteban',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hola <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Las menciones vinculadas se resuelven para menciones LID sin mapeo si los nombres de contacto almacenados coinciden', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});

    const pnJid = '14155550123@s.whatsapp.net';
    const lidJid = '161040050426060@lid';
    const discordUserId = '123456789012345678';

    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    // Both JIDs exist locally but there is no PN<->LID mapping helper available.
    state.contacts[pnJid] = 'Esteban';
    state.contacts[lidJid] = 'Esteban';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const msg = {
      text: 'Hola @Esteban',
      contextInfo: { mentionedJid: [lidJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hola <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Las menciones de usuario de Discord pueden convertirse en menciones de WhatsApp mediante enlaces de mención', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const discordUserId = '123456789012345678';
    state.contacts[pnJid] = 'Esteban';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const input = 'Hola @María';
    const result = await utils.whatsapp.applyDiscordMentionLinks(input, [
      { discordUserId, displayTokens: ['María'] },
    ]);

    assert.equal(result.text, 'Hola @14155550123');
    assert.deepEqual(result.mentionJids, [pnJid]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('El parseo de menciones salientes soporta tokens de número de teléfono', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const mentions = utils.whatsapp.getMentionedJids('hola @+14155550123 y @14155550123!');
    assert.deepEqual([...new Set(mentions)].sort(), ['14155550123@s.whatsapp.net']);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
  }
});

test('Las menciones de Discord priorizan los JIDs PN cuando existen enlaces tanto PN como LID', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const lidJid = '161040050426060@lid';
    const discordUserId = '123456789012345678';
    state.contacts[pnJid] = 'Esteban';
    state.contacts[lidJid] = 'Esteban';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId, [lidJid]: discordUserId };

    const input = 'Hola <@123456789012345678>';
    const result = await utils.whatsapp.applyDiscordMentionLinks(input, [
      {
        discordUserId,
        rawTokens: ['<@123456789012345678>', '<@!123456789012345678>'],
        displayTokens: ['Esteban'],
      },
    ], { chatJid: '123456789@g.us' });

    assert.equal(result.text, 'Hola @14155550123');
    assert.deepEqual(result.mentionJids, [pnJid]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});
