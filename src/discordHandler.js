import discordJs from 'discord.js';
import fs from 'fs';
import { getDevice } from '@whiskeysockets/baileys';

import state from './state.js';
import utils from './utils.js';
import storage from './storage.js';
import groupMetadataCache from './groupMetadataCache.js';
import messageStore from './messageStore.js';
import { createDiscordClient } from './clientFactories.js';
import { resolveRestartFlagPath } from './runnerLogic.js';

const { Intents, Constants, MessageActionRow, MessageButton } = discordJs;

const DEFAULT_AVATAR_URL = 'https://cdn.discordapp.com/embed/avatars/0.png';
const PIN_DURATION_PRESETS = {
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
};

const client = createDiscordClient({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
    Intents.FLAGS.GUILD_MESSAGE_TYPING,
    Intents.FLAGS.MESSAGE_CONTENT,
  ],
});
let controlChannel;
let slashRegisterWarned = false;
const pendingAlbums = {};
const deliveredMessages = new Set();
const BOT_PERMISSIONS = 536879120;
const UPDATE_BUTTON_IDS = utils.discord.updateButtonIds;
const ROLLBACK_BUTTON_ID = utils.discord.rollbackButtonId;
const bridgePinnedMessages = new Set();
const pinExpiryTimers = new Map();
let restartInProgress = false;

const requestSafeRestart = async (ctx, { message = 'Reiniciando...', exitCode = 0 } = {}) => {
  if (restartInProgress) {
    await ctx.reply('El reinicio ya está en progreso.');
    return;
  }
  restartInProgress = true;
  state.shutdownRequested = true;

  try {
    await storage.save();
  } catch (err) {
    restartInProgress = false;
    state.shutdownRequested = false;
    state.logger?.error({ err }, 'No se pudo guardar el estado antes del reinicio');
    await ctx.reply('No se pudo guardar el estado; reinicio abortado. Revisa los logs.');
    return;
  }

  const flagPath = resolveRestartFlagPath(process.env.WA2DC_RESTART_FLAG_PATH, process.cwd());
  let flagWritten = true;
  let resolvedExitCode = exitCode;
  try {
    await fs.promises.writeFile(flagPath, '');
  } catch (err) {
    flagWritten = false;
    resolvedExitCode = resolvedExitCode === 0 ? 1 : resolvedExitCode;
    state.logger?.error({ err, flagPath }, 'No se pudo escribir el indicador de reinicio; se reiniciará tras el fallo');
  }

  const suffix = flagWritten ? '' : ' (no se pudo escribir el indicador de reinicio; se reiniciará tras el fallo)';
  try {
    await ctx.reply(`${message}${suffix}`);
  } catch (err) {
    state.logger?.warn?.({ err }, 'No se pudo enviar el mensaje de confirmación de reinicio');
  }

  try {
    utils.stopDownloadServer();
  } catch {
    /* ignore */
  }
  try {
    void Promise.resolve(state.waClient?.end?.(new Error('Reinicio solicitado'))).catch(() => { });
  } catch {
    /* ignore */
  }
  try {
    state.waClient?.ws?.close?.();
  } catch {
    /* ignore */
  }
  try {
    state.dcClient?.destroy?.();
  } catch {
    /* ignore */
  }

  setTimeout(() => process.exit(resolvedExitCode), 250);
};

const getPinDurationSeconds = () => {
  const configured = Number(state.settings.PinDurationSeconds);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return PIN_DURATION_PRESETS['7d'];
};

const schedulePinExpiryNotice = (message, durationSeconds) => {
  const durationMs = durationSeconds * 1000;
  if (!message || durationMs <= 0) {
    return;
  }
  const existing = pinExpiryTimers.get(message.id);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(async () => {
    pinExpiryTimers.delete(message.id);
    let target = message;
    try {
      target = await message.fetch();
    } catch {
      /* best-effort */
    }
    if (!target?.pinned) return;
    bridgePinnedMessages.add(target.id);
    try {
      await target.unpin();
    } catch {
      /* ignore */
    } finally {
      bridgePinnedMessages.delete(target.id);
    }
    await target.channel?.send(`El pin expiró después de ${Math.round(durationSeconds / 86400)} día${durationSeconds === 86400 ? '' : 's'}.`).catch(() => { });
  }, durationMs);
  pinExpiryTimers.set(message.id, timer);
};

const clearPinExpiryNotice = (messageId) => {
  const timer = pinExpiryTimers.get(messageId);
  if (timer) {
    clearTimeout(timer);
    pinExpiryTimers.delete(messageId);
  }
};

class CommandResponder {
  constructor({ interaction, channel }) {
    this.interaction = interaction;
    this.channel = channel;
    this.replied = false;
    this.deferred = false;
    this.firstEditSent = false;
    this.ephemeral = interaction ? interaction.channelId !== state.settings.ControlChannelID : false;
  }

  async defer() {
    if (!this.interaction || this.deferred || this.replied) {
      return;
    }
    this.deferred = true;
    this.replied = true;
    await this.interaction.deferReply({ ephemeral: this.ephemeral });
  }

  async send(payload) {
    const normalized = typeof payload === 'string' ? { content: payload } : payload;
    if (this.interaction) {
      if (this.deferred) {
        if (!this.firstEditSent) {
          this.firstEditSent = true;
          return this.interaction.editReply(normalized);
        }
        return this.interaction.followUp({ ...normalized, ephemeral: this.ephemeral });
      }
      if (!this.replied) {
        this.replied = true;
        return this.interaction.reply({ ...normalized, ephemeral: this.ephemeral });
      }
      return this.interaction.followUp({ ...normalized, ephemeral: this.ephemeral });
    }

    return this.channel?.send(normalized);
  }

  async sendPartitioned(text) {
    const parts = utils.discord.partitionText(text || '');
    for (const part of parts) {
      // eslint-disable-next-line no-await-in-loop
      await this.send(part);
    }
  }
}

class CommandContext {
  constructor({ interaction, responder }) {
    this.interaction = interaction;
    this.responder = responder;
  }

  get channel() {
    return this.interaction?.channel ?? null;
  }

  get createdTimestamp() {
    return this.interaction?.createdTimestamp ?? Date.now();
  }

  get isControlChannel() {
    return this.channel?.id === state.settings.ControlChannelID;
  }

  async reply(payload) {
    return this.responder.send(payload);
  }

  async replyPartitioned(text) {
    return this.responder.sendPartitioned(text);
  }

  async defer() {
    return this.responder.defer();
  }

  getStringOption(name) {
    return this.interaction?.options?.getString(name);
  }

  getBooleanOption(name) {
    return this.interaction?.options?.getBoolean(name);
  }

  getIntegerOption(name) {
    return this.interaction?.options?.getInteger(name);
  }

  getNumberOption(name) {
    return this.interaction?.options?.getNumber(name);
  }

  getChannelOption(name) {
    return this.interaction?.options?.getChannel(name);
  }

  getUserOption(name) {
    return this.interaction?.options?.getUser(name);
  }

}

const sendWhatsappMessage = async (message, mediaFiles = [], messageIds = []) => {
  let msgContent = '';
  const files = [];
  const largeFiles = [];
  let components = [];
  const webhook = await utils.discord.getOrCreateChannel(message.channelJid);
  const avatarURL = message.profilePic || DEFAULT_AVATAR_URL;
  const mentionIdsRaw = Array.isArray(message?.discordMentions) ? message.discordMentions : [];
  const mentionIds = [...new Set(mentionIdsRaw.map((id) => String(id)).filter((id) => /^\d+$/.test(id)))];
  const allowedMentions = mentionIds.length ? { parse: [], users: mentionIds } : undefined;
  const content = utils.discord.convertWhatsappFormatting(message.content);
  const quoteContent = message.quote ? utils.discord.convertWhatsappFormatting(message.quote.content) : null;

  if (message.isGroup && state.settings.WAGroupPrefix) { msgContent += `[${message.name}] `; }

  if (message.isForwarded) {
    msgContent += `Mensaje reenviado:\n${(content || '').split('\n').join('\n> ')}`;
  }
  else if (message.quote) {
    const lines = [];

    const qContentRaw = quoteContent ?? '';
    const qContent = qContentRaw ? qContentRaw.split('\n').join('\n> ') : '';
    if (message.quote.name || qContent) {
      let quoteLine = '> ';
      if (message.quote.name) {
        quoteLine += message.quote.name;
        quoteLine += qContent ? ': ' : ':';
      }
      if (qContent) {
        quoteLine += qContent;
      }
      lines.push(quoteLine.trimEnd());
    }

    let segment = lines.join('\n');
    if (content) {
      segment += (segment ? '\n' : '') + content;
    }
    msgContent += segment || content || '';

    if (message.quote.file) {
      if (message.quote.file.largeFile && state.settings.LocalDownloads) {
        largeFiles.push(message.quote.file);
      } else if (message.quote.file === -1 && !state.settings.LocalDownloads) {
        msgContent += "WA2DC Aviso: Se recibió un archivo, pero supera el límite de subida de Discord. Revísalo en WhatsApp desde tu teléfono o habilita las descargas locales.";
      } else {
        files.push(message.quote.file);
      }
    }
  }
  else {
    msgContent += content;
  }

  for (const file of mediaFiles) {
    if (file.largeFile && state.settings.LocalDownloads) {
      largeFiles.push(file);
    }
    else if (file === -1 && !state.settings.LocalDownloads) {
      msgContent += "WA2DC Aviso: Se recibió un archivo, pero supera el límite de subida de Discord. Revísalo en WhatsApp desde tu teléfono o habilita las descargas locales.";
    } else if (file !== -1) {
      files.push(file);
    }
  }

  if (!msgContent && !files.length && largeFiles.length) {
    const count = largeFiles.length;
    msgContent = `WA2DC: Se recibieron ${count} archivo${count === 1 ? '' : 's'} adjunto${count === 1 ? '' : 's'} que superan el límite de subida de Discord. ${count === 1 ? 'El enlace de descarga se publicará' : 'Los enlaces de descarga se publicarán'} en breve.`;
  }

  if (message.isPoll && Array.isArray(message.pollOptions) && message.pollOptions.length) {
    const note = '\n\nLa votación solo está disponible en WhatsApp. Por favor vota desde tu teléfono.';
    msgContent = (msgContent || message.content || 'Encuesta') + note;
    components = [];
  }

  if (state.settings.WASenderPlatformSuffix) {
    const idForDevice = typeof messageIds?.[0] === 'string' ? messageIds[0] : message?.id;
    let platformLabel = null;
    if (typeof idForDevice === 'string' && idForDevice.trim()) {
      try {
        const device = getDevice(idForDevice);
        if (device === 'ios') platformLabel = 'iOS';
        else if (device === 'web') platformLabel = 'Web';
        else if (device === 'android') platformLabel = 'Android';
        else if (device === 'desktop') platformLabel = 'Desktop';
      } catch {
        platformLabel = null;
      }
    }

    if (platformLabel) {
      const tag = `*(${platformLabel})*`;
      if (msgContent) {
        msgContent = `${msgContent}\n\n${tag}`;
      } else if (files.length || largeFiles.length) {
        msgContent = tag;
      }
    }
  }

  if (msgContent) {
    const normalization = utils.discord.ensureExplicitUrlScheme(msgContent);
    msgContent = normalization.text;
  }

  if (message.isEdit) {
    const dcMessageId = state.lastMessages[message.id];
    if (dcMessageId) {
      try {
        await utils.discord.safeWebhookEdit(webhook, dcMessageId, { content: msgContent || null, components, allowedMentions }, message.channelJid);
        return;
      } catch (err) {
        state.logger?.error(err);
      }
    }
    msgContent = `Mensaje editado:\n${msgContent}`;
    const dcMessage = await utils.discord.safeWebhookSend(webhook, {
      content: msgContent,
      username: message.name,
      avatarURL,
      components,
      allowedMentions,
    }, message.channelJid);
    if (message.id != null) {
      // bidirectional map automatically stores both directions
      state.lastMessages[dcMessage.id] = message.id;
    }
    return;
  }

  if (msgContent || files.length) {
    msgContent = utils.discord.partitionText(msgContent);
    while (msgContent.length > 1) {
      // eslint-disable-next-line no-await-in-loop
      await utils.discord.safeWebhookSend(webhook, {
        content: msgContent.shift(),
        username: message.name,
        avatarURL,
        components,
        allowedMentions,
      }, message.channelJid);
    }

    const chunkArray = (arr, size) => {
      const chunks = [];
      for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
      }
      return chunks;
    };

    const fileChunks = chunkArray(files, 10);
    const idChunks = chunkArray(messageIds.length ? messageIds : [message.id], 10);

    if (!fileChunks.length) fileChunks.push([]);

    let lastDcMessage;
    for (let i = 0; i < fileChunks.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const sendArgs = {
        content: i === 0 ? (msgContent.shift() || null) : null,
        username: message.name,
        files: fileChunks[i],
        avatarURL,
        components,
        allowedMentions,
      };
      lastDcMessage = await utils.discord.safeWebhookSend(webhook, sendArgs, message.channelJid);

      if (i === 0 && lastDcMessage.channel.type === 'GUILD_NEWS' && state.settings.Publish) {
        // eslint-disable-next-line no-await-in-loop
        await lastDcMessage.crosspost();
      }

      if (message.id != null) {
        for (const waId of idChunks[i] || []) {
          // bidirectional map automatically stores both directions
          state.lastMessages[waId] = lastDcMessage.id;
        }
        if (i === 0) {
          // store mapping for Discord -> first WhatsApp id for edits
          state.lastMessages[lastDcMessage.id] = message.id;
        }
      }
    }

    if (largeFiles.length) {
      const placeholders = [];
      for (const file of largeFiles) {
        // eslint-disable-next-line no-await-in-loop
        const placeholder = await utils.discord.safeWebhookSend(webhook, {
          content: `WA2DC: descargando "${file?.name || 'adjunto'}"...`,
          username: message.name,
          avatarURL,
          components: [],
        }, message.channelJid);
        placeholders.push(placeholder);
      }

      void (async () => {
        for (let i = 0; i < largeFiles.length; i += 1) {
          const file = largeFiles[i];
          const placeholder = placeholders[i];
          let downloadMessage;
          try {
            // eslint-disable-next-line no-await-in-loop
            downloadMessage = await utils.discord.downloadLargeFile(file);
          } catch (err) {
            state.logger?.error({ err }, 'No se pudo descargar el archivo adjunto grande de WhatsApp para su entrega local');
            downloadMessage = `WA2DC Aviso: No se pudo descargar "${file?.name || 'adjunto'}". Por favor, revisa WhatsApp.`;
          }
          const content = String(downloadMessage || '').replace(/^\n+/, '').trim() || 'WA2DC Aviso: Descarga completada, pero no se generó ningún mensaje.';
          try {
            // eslint-disable-next-line no-await-in-loop
            await utils.discord.safeWebhookEdit(webhook, placeholder.id, { content }, message.channelJid);
          } catch (err) {
            state.logger?.warn?.({ err }, 'No se pudo actualizar el mensaje de marcador de descarga local');
          }
        }
      })();
    }
  }
};

const flushAlbum = async (key) => {
  const album = pendingAlbums[key];
  if (!album) return;
  clearTimeout(album.timer);
  delete pendingAlbums[key];
  try {
    await sendWhatsappMessage(album.message, album.files, album.ids);
  } catch (err) {
    state.logger?.error({ err }, 'No se pudo enviar el álbum de WhatsApp a Discord');
  }
};

const setControlChannel = async () => {
  controlChannel = await utils.discord.getControlChannel();
};

client.on('ready', async () => {
  await setControlChannel();
  await registerSlashCommands();
});

client.on('channelDelete', async (channel) => {
  if (channel.id === state.settings.ControlChannelID) {
    controlChannel = await utils.discord.getControlChannel();
  } else {
    const jid = utils.discord.channelIdToJid(channel.id);
    delete state.chats[jid];
    delete state.goccRuns[jid];
    state.settings.Categories = state.settings.Categories.filter((id) => channel.id !== id);
  }
});

const WA_TYPING_IDLE_MS = 12_000;
const WA_TYPING_REFRESH_MS = 8_000;
const WA_TYPING_MIN_SEND_GAP_MS = 3_000;

const typingPresenceSessions = new Map();

const endTypingPresenceSession = (channelId) => {
  const session = typingPresenceSessions.get(channelId);
  if (!session) return;
  typingPresenceSessions.delete(channelId);

  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.refreshTimer) clearInterval(session.refreshTimer);

  state.waClient?.sendPresenceUpdate?.('paused', session.jid).catch(() => { });
};

const maybeSendComposingPresence = (channelId) => {
  const session = typingPresenceSessions.get(channelId);
  if (!session || !session.jid) return;
  if (!state.waClient?.sendPresenceUpdate) return;

  const now = Date.now();
  if (now - session.lastComposingSentAt < WA_TYPING_MIN_SEND_GAP_MS) return;
  session.lastComposingSentAt = now;

  state.waClient.sendPresenceUpdate('composing', session.jid).catch(() => { });
};

const noteDiscordTypingInChannel = (channelId, jid) => {
  const now = Date.now();
  let session = typingPresenceSessions.get(channelId);
  if (!session) {
    session = {
      jid,
      lastActivityAt: now,
      lastComposingSentAt: 0,
      idleTimer: null,
      refreshTimer: null,
    };
    typingPresenceSessions.set(channelId, session);
  } else {
    session.jid = jid;
    session.lastActivityAt = now;
  }

  maybeSendComposingPresence(channelId);

  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => endTypingPresenceSession(channelId), WA_TYPING_IDLE_MS);
  session.idleTimer?.unref?.();

  if (session.refreshTimer) return;
  session.refreshTimer = setInterval(() => {
    const current = typingPresenceSessions.get(channelId);
    if (!current) {
      clearInterval(session.refreshTimer);
      return;
    }

    const age = Date.now() - current.lastActivityAt;
    if (age >= WA_TYPING_IDLE_MS) {
      endTypingPresenceSession(channelId);
      return;
    }
    if (Date.now() - current.lastComposingSentAt >= WA_TYPING_REFRESH_MS) {
      maybeSendComposingPresence(channelId);
    }
  }, WA_TYPING_REFRESH_MS);
  session.refreshTimer?.unref?.();
};

client.on('typingStart', async (typing) => {
  if ((state.settings.oneWay >> 1 & 1) === 0) return;

  const user = typing?.user;
  if (user?.bot) return;
  if (user?.id && client.user?.id && user.id === client.user.id) return;

  const channelId = typing?.channel?.id;
  const jid = channelId ? utils.discord.channelIdToJid(channelId) : null;
  if (!jid || !state.waClient?.sendPresenceUpdate) return;

  noteDiscordTypingInChannel(channelId, jid);
});

client.on('whatsappMessage', async (message) => {
  if ((state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }
  try {
    const key = `${message.channelJid}:${message.name}`;

    if (message.file && !message.isEdit) {
      if (pendingAlbums[key]) {
        pendingAlbums[key].files.push(message.file);
        pendingAlbums[key].ids.push(message.id);
        clearTimeout(pendingAlbums[key].timer);
        pendingAlbums[key].timer = setTimeout(() => flushAlbum(key), 500);
        return;
      }
      pendingAlbums[key] = {
        message,
        files: [message.file],
        ids: [message.id],
        timer: setTimeout(() => flushAlbum(key), 500),
      };
      return;
    }

    if (pendingAlbums[key]) {
      await flushAlbum(key);
    }

    await sendWhatsappMessage(message, message.file ? [message.file] : []);
  } catch (err) {
    state.logger?.error({ err }, 'No se pudo procesar el mensaje entrante de WhatsApp');
  }
});

client.on('whatsappReaction', async (reaction) => {
  if ((state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }

  const channelId = state.chats[reaction.jid]?.channelId;
  const messageId = state.lastMessages[reaction.id];
  if (channelId == null || messageId == null) { return; }

  const channel = await utils.discord.getChannel(channelId);
  const message = await channel.messages.fetch(messageId);
  const msgReactions = state.reactions[messageId] || (state.reactions[messageId] = {});
  const prev = msgReactions[reaction.author];
  if (prev) {
    await message.reactions.cache.get(prev)?.remove().catch(() => { });
    delete msgReactions[reaction.author];
  }
  if (reaction.text) {
    await message.react(reaction.text).catch(async err => {
      if (err.code === 10014) {
        await channel.send(`Se recibió una reacción con un emoji no compatible o no reconocida (${reaction.text}). Revisa la aplicación de WhatsApp para verlo.`);
      }
    });
    msgReactions[reaction.author] = reaction.text;
  }
  if (!Object.keys(msgReactions).length) {
    delete state.reactions[messageId];
  }
});

client.on('whatsappRead', async ({ id, jid }) => {
  if ((state.settings.oneWay >> 0 & 1) === 0 || !state.settings.ReadReceipts) { return; }
  const channelId = state.chats[jid]?.channelId;
  const messageId = state.lastMessages[id];
  if (!channelId || !messageId || deliveredMessages.has(messageId)) { return; }
  deliveredMessages.add(messageId);
  const channel = await utils.discord.getChannel(channelId);
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) { return; }
  const receiptMode = state.settings.ReadReceiptMode;

  if (message.webhookId) {
    await message.react('☑️').catch(() => { });
    return;
  }

  if (receiptMode === 'dm') {
    const name = utils.whatsapp.jidToName(jid);
    const messageContent = (message.cleanContent ?? message.content ?? '').trim();
    let quote = null;

    if (messageContent) {
      const truncated = messageContent.length > 1800 ? `${messageContent.slice(0, 1797)}...` : messageContent;
      quote = truncated
        .split('\n')
        .map((line) => `> ${line || ' '}`)
        .join('\n');
    } else if (message.attachments?.size) {
      const attachments = [...message.attachments.values()].map((attachment) => attachment.name || attachment.url);
      const [firstAttachment, ...restAttachments] = attachments;
      quote = `> [Adjunto] ${firstAttachment}`;
      if (restAttachments.length) {
        quote += `\n> ... (${restAttachments.length} más adjuntos${restAttachments.length === 1 ? '' : 's'})`;
      }
    } else {
      quote = '> *(No contenido de texto)*';
    }

    const receiptLines = [`✅ Tu mensaje a ${name} fue leído.`];
    if (quote) {
      receiptLines.push('', quote);
    }
    if (message.url) {
      receiptLines.push('', message.url);
    }

    message.author.send(receiptLines.join('\n')).catch(() => { });
    return;
  }

  if (receiptMode === 'reaction') {
    await message.react('☑️').catch(() => { });
    return;
  }

  const receipt = await channel.send({ content: '✅ Leído', reply: { messageReference: messageId } }).catch(() => null);
  if (receipt) {
    setTimeout(() => receipt.delete().catch(() => { }), 5000);
  }
});

client.on('whatsappDelete', async ({ id, jid }) => {
  if (!state.settings.DeleteMessages || (state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }

  const messageId = state.lastMessages[id];
  if (state.chats[jid] == null || messageId == null) {
    return;
  }

  const webhook = await utils.discord.getOrCreateChannel(jid);
  try {
    await utils.discord.safeWebhookDelete(webhook, messageId, jid);
  } catch {
    try {
      await utils.discord.safeWebhookEdit(
        webhook,
        messageId,
        { content: 'Mensaje eliminado' },
        jid,
      );
    } catch (err) {
      state.logger?.error(err);
    }
  }
  delete state.lastMessages[id];
  delete state.lastMessages[messageId];
});

client.on('whatsappCall', async ({ call, jid }) => {
  if ((state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }

  const webhook = await utils.discord.getOrCreateChannel(jid);

  const name = utils.whatsapp.jidToName(jid);
  const callType = call.isVideo ? 'videollamada' : 'llamada de voz';
  let content = '';

  switch (call.status) {
    case 'offer':
      content = `${name} te está llamando (${callType}). Revisa tu teléfono para responder.`;
      break;
    case 'timeout':
      content = `Llamada perdida (${callType}) de ${name}.`;
      break;
  }

  if (content !== '') {
    const avatarURL = (await utils.whatsapp.getProfilePic(call)) || DEFAULT_AVATAR_URL;
    await utils.discord.safeWebhookSend(webhook, {
      content,
      username: name,
      avatarURL,
    }, jid);
  }
});

client.on('whatsappPin', async ({ jid, key, pinned }) => {
  if ((state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }
  const channelId = state.chats[jid]?.channelId;
  const dcMessageId = state.lastMessages[key.id];
  if (!channelId || !dcMessageId) {
    return;
  }
  const channel = await utils.discord.getChannel(channelId);
  const message = await channel.messages.fetch(dcMessageId).catch(() => null);
  if (!message) {
    return;
  }
  bridgePinnedMessages.add(message.id);
  try {
    if (pinned) {
      await message.pin();
      schedulePinExpiryNotice(message, getPinDurationSeconds());
    } else {
      await message.unpin();
      clearPinExpiryNotice(message.id);
    }
  } catch (err) {
    state.logger?.warn({ err }, 'No se pudo sincronizar el pin de WhatsApp con Discord');
  } finally {
    setTimeout(() => bridgePinnedMessages.delete(message.id), 5000);
  }
});

const { ApplicationCommandOptionTypes } = Constants;

const commandHandlers = {
  ping: {
    description: 'Comprueba la latencia del bot.',
    async execute(ctx) {
      await ctx.reply(`Pong ${Date.now() - ctx.createdTimestamp}ms!`);
    },
  },
  chatinfo: {
    description: 'Muestra qué chat de WhatsApp está vinculado a este canal.',
    async execute(ctx) {
      const jid = utils.discord.channelIdToJid(ctx.channel?.id);
      if (!jid) {
        await ctx.reply('Este canal no está vinculado a un chat de WhatsApp.');
        return;
      }

      const name = utils.whatsapp.jidToName(jid);
      const displayJid = utils.whatsapp.formatJidForDisplay(jid) || jid;
      const type = jid === 'status@broadcast'
        ? 'Status'
        : (jid.endsWith('@g.us') ? 'Group' : 'DM');

      await ctx.reply(`Chat vinculado: **${name}**\nJID: \`${displayJid}\`\nTipo: ${type}`);
    },
  },
  pairwithcode: {
    description: 'Solicitar un código de vinculación de WhatsApp.',
    options: [
      {
        name: 'number',
        description: 'Número de teléfono con código de país.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const number = ctx.getStringOption('number');
      if (!number) {
        await ctx.reply('Por favor, ingresa tu número. Uso: `pairWithCode <número>`. No uses "+" ni otros caracteres especiales.');
        return;
      }

      const code = await state.waClient.requestPairingCode(number);
      await ctx.reply(`Tu código de vinculación es: ${code}`);
    },
  },
  start: {
    description: 'Iniciar una conversación con un contacto o número.',
    options: [
      {
        name: 'contact',
        description: 'Número con código de país o nombre de contacto.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const contact = ctx.getStringOption('contact');
      if (!contact) {
        await ctx.reply('Por favor, ingresa un número de teléfono o nombre de contacto. Uso: `start <número con código de país o nombre>`.');
        return;
      }

      // eslint-disable-next-line no-restricted-globals
      const jid = utils.whatsapp.toJid(contact);
      if (!jid) {
        await ctx.reply(`No se pudo encontrar \`${contact}\`.`);
        return;
      }
      const webhook = await utils.discord.getOrCreateChannel(jid);
      if (!webhook) {
        await ctx.reply('No se pudo iniciar la conversación. Por favor, intenta de nuevo.');
        return;
      }

      if (state.settings.Whitelist.length) {
        const normalized = utils.whatsapp.formatJid(jid);
        if (normalized && !state.settings.Whitelist.includes(normalized)) {
          state.settings.Whitelist.push(normalized);
        }
      }

      const channelMention = webhook.channelId ? `<#${webhook.channelId}>` : 'the linked channel';
      await ctx.reply(`Se inició una conversación en ${channelMention}.`);
    },
  },
  poll: {
    description: 'Crear un encuesta de WhatsApp en este canal.',
    options: [
      {
        name: 'question',
        description: 'Pregunta o título de la encuesta.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
      {
        name: 'options',
        description: 'Opciones separadas por comas (mínimo 2).',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
      {
        name: 'select',
        description: '¿Cuántas opciones pueden ser seleccionadas?',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: false,
      },
      {
        name: 'announcement',
        description: 'Enviar como encuesta de grupo de anuncios.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: false,
      },
    ],
    async execute(ctx) {
      const jid = utils.discord.channelIdToJid(ctx.channel?.id);
      if (!jid) {
        await ctx.reply('Este comando solo funciona en canales vinculados a chats de WhatsApp.');
        return;
      }
      const question = ctx.getStringOption('question')?.trim();
      const rawOptions = ctx.getStringOption('options') || '';
      const values = rawOptions.split(',').map((opt) => opt.trim()).filter(Boolean);
      if (!question) {
        await ctx.reply('Por favor, proporciona una pregunta para la encuesta.');
        return;
      }
      if (values.length < 2) {
        await ctx.reply('Por favor, proporciona al menos dos opciones para la encuesta (separadas por comas).');
        return;
      }
      const selectableCount = ctx.getIntegerOption('select') || 1;
      if (selectableCount < 1 || selectableCount > values.length) {
        await ctx.reply('La cantidad de opciones seleccionables debe ser al menos 1 y no más que el número de opciones.');
        return;
      }
      const toAnnouncementGroup = Boolean(ctx.getBooleanOption('announcement'));
      try {
        const sent = await state.waClient.sendMessage(jid, {
          poll: {
            name: question,
            values,
            selectableCount,
            toAnnouncementGroup,
          },
        });
        messageStore.set(sent);
        await ctx.reply('Encuesta enviada a WhatsApp!');
      } catch (err) {
        state.logger?.error({ err }, 'No se pudo enviar la encuesta a WhatsApp');
        await ctx.reply('No se pudo enviar la encuesta a WhatsApp. Por favor, inténtalo de nuevo.');
      }
    },
  },
  setpinduration: {
    description: 'Establecer la duración predeterminada de los pines de WhatsApp.',
    options: [
      {
        name: 'duration',
        description: 'Cuánto tiempo duran los pines por defecto.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
        choices: [
          { name: '24 hours', value: '24h' },
          { name: '7 days', value: '7d' },
          { name: '30 days', value: '30d' },
        ],
      },
    ],
    async execute(ctx) {
      const choice = ctx.getStringOption('duration');
      const seconds = PIN_DURATION_PRESETS[choice];
      if (!seconds) {
        await ctx.reply('Duración inválida. Elige 24h, 7d o 30d.');
        return;
      }
      state.settings.PinDurationSeconds = seconds;
      await ctx.reply(`Duración predeterminada de los pines establecida en ${choice}.`);
    },
  },
  link: {
    description: 'Vincular un chat de WhatsApp a un canal existente.',
    options: [
      {
        name: 'contact',
        description: 'Número con código de país o nombre de contacto.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
      {
        name: 'channel',
        description: 'Canal de Discord destino.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
      {
        name: 'force',
        description: 'Sobreescribir un enlace existente.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: false,
      },
    ],
    async execute(ctx) {
      const force = Boolean(ctx.getBooleanOption('force'));
      const channel = ctx.getChannelOption('channel');
      const contactQuery = ctx.getStringOption('contact');

      if (!channel || !contactQuery) {
        await ctx.reply('Por favor, proporciona un contacto y un canal. Uso: `link <número con código de país o nombre> #<canal>`');
        return;
      }

      if (channel.id === state.settings.ControlChannelID) {
        await ctx.reply('El canal de control no puede ser vinculado. Por favor, elige otro canal.');
        return;
      }

      if (channel.guildId !== state.settings.GuildID) {
        await ctx.reply('Por favor, elige un canal del servidor de Discord configurado.');
        return;
      }

      if (!['GUILD_TEXT', 'GUILD_NEWS'].includes(channel.type)) {
        await ctx.reply('Solo los canales de texto pueden ser vinculados. Por favor, elige un canal de texto.');
        return;
      }

      const jid = utils.whatsapp.toJid(contactQuery);
      const normalizedJid = utils.whatsapp.formatJid(jid);
      if (!normalizedJid) {
        await ctx.reply(`No se pudo encontrar \`${contactQuery}\`.`);
        return;
      }

      const existingJid = utils.discord.channelIdToJid(channel.id);
      const forcedTakeover = Boolean(existingJid && existingJid !== normalizedJid && force);
      let displacedChat;
      let displacedRun;
      if (existingJid && existingJid !== normalizedJid) {
        if (!force) {
          await ctx.reply('Ese canal ya está vinculado a otra conversación de WhatsApp. Activa la opción de forzar (o usa el comando move) para sobreescribirlo.');
          return;
        }
        displacedChat = state.chats[existingJid];
        displacedRun = state.goccRuns[existingJid];
        delete state.chats[existingJid];
        delete state.goccRuns[existingJid];
      }

      let webhook;
      try {
        const webhooks = await channel.fetchWebhooks();
        webhook = webhooks.find((hook) => hook.token && hook.owner?.id === client.user.id);
        if (!webhook) {
          webhook = await channel.createWebhook('WA2DC');
        }
      } catch (err) {
        state.logger?.error(err);
        await ctx.reply('No se pudo acceder o crear un webhook para ese canal. Verifica los permisos del bot.');
        return;
      }

      const previousChat = state.chats[normalizedJid];
      const previousChannelId = previousChat?.channelId;
      const previousRun = state.goccRuns[normalizedJid];
      state.chats[normalizedJid] = {
        id: webhook.id,
        type: webhook.type,
        token: webhook.token,
        channelId: webhook.channelId,
      };
      delete state.goccRuns[normalizedJid];

      try {
        await utils.discord.getOrCreateChannel(normalizedJid);
        await storage.save();
      } catch (err) {
        state.logger?.error(err);
        if (previousChat) {
          state.chats[normalizedJid] = previousChat;
        } else {
          delete state.chats[normalizedJid];
        }
        if (previousRun) {
          state.goccRuns[normalizedJid] = previousRun;
        } else {
          delete state.goccRuns[normalizedJid];
        }
        if (forcedTakeover) {
          if (displacedChat) {
            state.chats[existingJid] = displacedChat;
          }
          if (displacedRun) {
            state.goccRuns[existingJid] = displacedRun;
          }
        }
        await ctx.reply('Linked the channel, but failed to finalize the setup. Please try again.');
        return;
      }

      if (previousChannelId && previousChannelId !== channel.id && previousChat?.id) {
        try {
          const previousChannel = await utils.discord.getChannel(previousChannelId);
          const previousWebhooks = await previousChannel?.fetchWebhooks();
          const previousWebhook = previousWebhooks?.get(previousChat.id) || previousWebhooks?.find((hook) => hook.id === previousChat.id);
          await previousWebhook?.delete('WA2DC channel relinked');
        } catch (err) {
          state.logger?.warn(err);
        }
      }

      const forcedSuffix = forcedTakeover
        ? ` (overrode the previous link to \`${utils.whatsapp.jidToName(existingJid)}\`).`
        : '.';
      await ctx.reply(`Linked ${channel} with \`${utils.whatsapp.jidToName(normalizedJid)}\`${forcedSuffix}`);
    },
  },
  move: {
    description: 'Move a WhatsApp link from one channel to another.',
    options: [
      {
        name: 'from',
        description: 'Current channel.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
      {
        name: 'to',
        description: 'Destination channel.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
      {
        name: 'force',
        description: 'Override any existing link on the destination.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: false,
      },
    ],
    async execute(ctx) {
      const source = ctx.getChannelOption('from');
      const target = ctx.getChannelOption('to');
      const force = Boolean(ctx.getBooleanOption('force'));

      if (!source || !target) {
        await ctx.reply('Por favor, menciona el canal actual y el nuevo canal. Uso: `move #canal-antiguo #canal-nuevo` (activa la opción force para sobrescribir enlaces existentes).');
        return;
      }

      if (source.id === target.id) {
        await ctx.reply('Por favor, menciona dos canales diferentes para realizar el traslado.');
        return;
      }

      if (source.id === state.settings.ControlChannelID || target.id === state.settings.ControlChannelID) {
        await ctx.reply('El canal de control no puede participar en los traslados. Elige dos canales de texto normales.');
        return;
      }

      if (source.guildId !== state.settings.GuildID || target.guildId !== state.settings.GuildID) {
        await ctx.reply('Por favor, elige canales del servidor de Discord configurado.');
        return;
      }

      if (!['GUILD_TEXT', 'GUILD_NEWS'].includes(target.type)) {
        await ctx.reply('Solo los canales de texto o de anuncios pueden ser destinos. Por favor, elige otro canal.');
        return;
      }

      const sourceJidRaw = utils.discord.channelIdToJid(source.id);
      const normalizedJid = utils.whatsapp.formatJid(sourceJidRaw);
      if (!normalizedJid) {
        await ctx.reply('El canal origen no está vinculado a ninguna conversación de WhatsApp.');
        return;
      }

      const existingTargetJid = utils.discord.channelIdToJid(target.id);
      const forcedTakeover = Boolean(existingTargetJid && existingTargetJid !== normalizedJid && force);
      let displacedChat;
      let displacedRun;

      if (existingTargetJid && existingTargetJid !== normalizedJid) {
        if (!force) {
          await ctx.reply('Ese canal de destino ya está vinculado a otra conversación. Activa la opción force para sobrescribirlo.');
          return;
        }
        displacedChat = state.chats[existingTargetJid];
        displacedRun = state.goccRuns[existingTargetJid];
        delete state.chats[existingTargetJid];
        delete state.goccRuns[existingTargetJid];
      }

      let webhook;
      try {
        const webhooks = await target.fetchWebhooks();
        webhook = webhooks.find((hook) => hook.token && hook.owner?.id === client.user.id);
        if (!webhook) {
          webhook = await target.createWebhook('WA2DC');
        }
      } catch (err) {
        state.logger?.error(err);
        if (forcedTakeover) {
          if (displacedChat) state.chats[existingTargetJid] = displacedChat;
          if (displacedRun) state.goccRuns[existingTargetJid] = displacedRun;
        }
        await ctx.reply('No se pudo acceder o crear un webhook para el canal de destino. Verifica los permisos del bot.');
        return;
      }

      const previousChat = state.chats[normalizedJid];
      const previousRun = state.goccRuns[normalizedJid];
      state.chats[normalizedJid] = {
        id: webhook.id,
        type: webhook.type,
        token: webhook.token,
        channelId: webhook.channelId,
      };
      delete state.goccRuns[normalizedJid];

      try {
        await utils.discord.getOrCreateChannel(normalizedJid);
        await storage.save();
      } catch (err) {
        state.logger?.error(err);
        if (previousChat) state.chats[normalizedJid] = previousChat;
        else delete state.chats[normalizedJid];

        if (previousRun) state.goccRuns[normalizedJid] = previousRun;
        else delete state.goccRuns[normalizedJid];

        if (forcedTakeover) {
          if (displacedChat) state.chats[existingTargetJid] = displacedChat;
          if (displacedRun) state.goccRuns[existingTargetJid] = displacedRun;
        }

        await ctx.reply('Se trasladó el canal, pero no se pudo finalizar la configuración. Por favor, inténtalo de nuevo.');
        return;
      }

      if (previousChat?.channelId && previousChat.channelId !== webhook.channelId && previousChat.id) {
        try {
          const previousChannel = await utils.discord.getChannel(previousChat.channelId);
          const previousWebhooks = await previousChannel?.fetchWebhooks();
          const previousWebhook = previousWebhooks?.get(previousChat.id) || previousWebhooks?.find((hook) => hook.id === previousChat.id);
          await previousWebhook?.delete('WA2DC canal trasladado');
        } catch (err) {
          state.logger?.warn(err);
        }
      }

      const forcedSuffix = forcedTakeover
        ? ` (se sobrescribió el enlace previo de \`${utils.whatsapp.jidToName(existingTargetJid)}\`).`
        : '.';
      await ctx.reply(
        `Se trasladó \`${utils.whatsapp.jidToName(normalizedJid)}\` de ${source} a ${target}${forcedSuffix}`,
      );
    },
  },
  list: {
    description: 'Listar contactos y grupos.',
    options: [
      {
        name: 'query',
        description: 'Texto de búsqueda opcional.',
        type: ApplicationCommandOptionTypes.STRING,
        required: false,
      },
    ],
    async execute(ctx) {
      let contacts = utils.whatsapp.contacts();
      const query = ctx.getStringOption('query')?.toLowerCase();
      if (query) { contacts = contacts.filter((name) => name.toLowerCase().includes(query)); }
      contacts = contacts.sort((a, b) => a.localeCompare(b)).join('\n');
      const message = utils.discord.partitionText(
        contacts.length
          ? `${contacts}\n\n¿No es la lista completa? Puedes actualizar tus contactos escribiendo \`resync\``
          : 'No se encontraron resultados.',
      );
      while (message.length !== 0) {
        // eslint-disable-next-line no-await-in-loop
        await ctx.reply(message.shift());
      }
    },
  },
  linkmention: {
    description: 'Vincula un contacto de WhatsApp a un usuario de Discord para que las menciones (@) de WhatsApp lo notifiquen en Discord.',
    options: [
      {
        name: 'contact',
        description: 'Número con código de país o nombre de contacto.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
      {
        name: 'user',
        description: 'Usuario de Discord al que se le mencionará.',
        type: ApplicationCommandOptionTypes.USER,
        required: true,
      },
    ],
    async execute(ctx) {
      const contact = ctx.getStringOption('contact');
      const user = ctx.getUserOption('user');
      if (!contact || !user?.id) {
        await ctx.reply('Uso: `/linkmention contact:<nombre o número> user:<@usuario>`.');
        return;
      }

      const jid = utils.whatsapp.toJid(contact);
      if (!jid) {
        await ctx.reply(`No se pudo encontrar \`${contact}\`.`);
        return;
      }

      const formatted = utils.whatsapp.formatJid(jid);

      if (!state.settings.WhatsAppDiscordMentionLinks || typeof state.settings.WhatsAppDiscordMentionLinks !== 'object') {
        state.settings.WhatsAppDiscordMentionLinks = {};
      }
      state.settings.WhatsAppDiscordMentionLinks[formatted] = user.id;

      await storage.saveSettings().catch(() => { });

      const name = utils.whatsapp.jidToName(formatted);
      const displayJid = utils.whatsapp.formatJidForDisplay(formatted);
      await ctx.reply(`Contacto de WhatsApp **${name}** (${displayJid}) vinculado a <@${user.id}>.`);
    },
  },
  unlinkmention: {
    description: 'Eliminar la mención de WhatsApp→Discord para un contacto.',
    options: [
      {
        name: 'contact',
        description: 'Número con código de país o nombre de contacto.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const contact = ctx.getStringOption('contact');
      if (!contact) {
        await ctx.reply('Uso: `/unlinkmention contact:<nombre o número>`.');
        return;
      }

      const jid = utils.whatsapp.toJid(contact);
      if (!jid) {
        await ctx.reply(`No se pudo encontrar \`${contact}\`.`);
        return;
      }

      const formatted = utils.whatsapp.formatJid(jid);

      const links = state.settings?.WhatsAppDiscordMentionLinks;
      if (!links || typeof links !== 'object') {
        await ctx.reply('Actualmente no hay enlaces de menciones configurados.');
        return;
      }

      let removed = 0;
      for (const key of Object.keys(links)) {
        if (utils.whatsapp.formatJid(key) !== formatted) continue;
        if (Object.prototype.hasOwnProperty.call(links, key)) {
          delete links[key];
          removed += 1;
        }
      }

      await storage.saveSettings().catch(() => { });

      const name = utils.whatsapp.jidToName(formatted);
      const displayJid = utils.whatsapp.formatJidForDisplay(formatted);
      if (!removed) {
        await ctx.reply(`No se encontró un enlace de mención para **${name}** (${displayJid}).`);
        return;
      }
      await ctx.reply(`Enlace de mención eliminado para **${name}** (${displayJid}).`);
    },
  },
  mentionlinks: {
    description: 'Listar las mención de WhatsApp→Discord para un contacto.',
    async execute(ctx) {
      const links = state.settings?.WhatsAppDiscordMentionLinks;
      if (!links || typeof links !== 'object' || !Object.keys(links).length) {
        await ctx.reply('No se encontraron enlaces de mención.');
        return;
      }

      const byDiscordId = new Map();
      const isDiscordId = (value) => typeof value === 'string' && /^\d+$/.test(value.trim());

      for (const [jid, discordIdRaw] of Object.entries(links)) {
        const discordId = typeof discordIdRaw === 'string' ? discordIdRaw.trim() : '';
        if (!jid || !isDiscordId(discordId)) continue;
        const normalizedJid = utils.whatsapp.formatJid(jid) || jid;
        const existing = byDiscordId.get(discordId) || new Set();
        existing.add(normalizedJid);
        byDiscordId.set(discordId, existing);
      }

      if (!byDiscordId.size) {
        await ctx.reply('No se encontraron enlaces de mención.');
        return;
      }

      const lines = [];
      for (const [discordId, jids] of byDiscordId.entries()) {
        const jidList = [...jids].filter(Boolean);
        const preferred = state.settings?.HidePhoneNumbers
          ? (jidList.find((jid) => !utils.whatsapp.isPhoneJid(jid)) || jidList[0])
          : (jidList.find((jid) => utils.whatsapp.isPhoneJid(jid)) || jidList[0]);
        const name = preferred ? utils.whatsapp.jidToName(preferred) : 'Desconocido';
        const displayJid = preferred ? utils.whatsapp.formatJidForDisplay(preferred) : 'Desconocido';
        const suffix = jidList.length > 1 ? ` (aliases: ${jidList.length})` : '';
        lines.push(`- **${name}** (${displayJid})${suffix} -> <@${discordId}>`);
      }

      await ctx.replyPartitioned(lines.join('\n'));
    },
  },
  jidinfo: {
    description: 'Mostrar variantes conocidas de JID de WhatsApp (PN/LID) para un contacto y si están vinculadas para menciones.',
    options: [
      {
        name: 'contact',
        description: 'Number with country code or contact name.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const contact = ctx.getStringOption('contact');
      if (!contact) {
        await ctx.reply('Uso: `/jidinfo contact:<nombre o número>`.');
        return;
      }

      const jid = utils.whatsapp.toJid(contact);
      if (!jid) {
        await ctx.reply(`No se pudo encontrar \`${contact}\`.`);
        return;
      }

      const formatted = utils.whatsapp.formatJid(jid);
      const name = utils.whatsapp.jidToName(formatted);
      const normalizedName = String(name || '')
        .trim()
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\s+/g, ' ');

      const isSameName = (value) => {
        if (typeof value !== 'string') return false;
        const normalized = value
          .trim()
          .normalize('NFKC')
          .toLowerCase()
          .replace(/\s+/g, ' ');
        return normalized && normalized === normalizedName;
      };

      const candidates = new Set([formatted]);
      const addIfMatch = (jidCandidate, storedName) => {
        if (!jidCandidate) return;
        if (!isSameName(storedName)) return;
        const normalized = utils.whatsapp.formatJid(jidCandidate);
        if (normalized) candidates.add(normalized);
      };

      for (const [jidCandidate, storedName] of Object.entries(state.contacts || {})) {
        addIfMatch(jidCandidate, storedName);
      }
      for (const [jidCandidate, storedName] of Object.entries(state.waClient?.contacts || {})) {
        addIfMatch(jidCandidate, storedName);
      }

      const links = state.settings?.WhatsAppDiscordMentionLinks;
      const linkEntries = [];
      if (links && typeof links === 'object') {
        for (const [linkJid, discordIdRaw] of Object.entries(links)) {
          const normalizedLinkJid = utils.whatsapp.formatJid(linkJid);
          if (!normalizedLinkJid) continue;
          if (!candidates.has(normalizedLinkJid)) continue;
          linkEntries.push({
            key: linkJid,
            jid: normalizedLinkJid,
            discordId: typeof discordIdRaw === 'string' ? discordIdRaw.trim() : '',
          });
        }
      }

      const classify = (jidValue) => {
        if (utils.whatsapp.isPhoneJid(jidValue)) return 'PN';
        if (utils.whatsapp.isLidJid(jidValue)) return 'LID';
        if (typeof jidValue === 'string' && jidValue.endsWith('@g.us')) return 'GROUP';
        return 'OTHER';
      };

      const jidList = [...candidates].filter(Boolean).sort((a, b) => a.localeCompare(b));
      const lines = [];
      lines.push(`Contacto: **${name}**`);
      lines.push(`Resuelto: \`${utils.whatsapp.formatJidForDisplay(formatted)}\` (${classify(formatted)})`);
      lines.push('JIDs conocidos:');
      for (const jidValue of jidList) {
        const linked = linkEntries.filter((entry) => entry.jid === jidValue && /^\d+$/.test(entry.discordId));
        const linkSuffix = linked.length
          ? ` -> ${linked.map((entry) => `<@${entry.discordId}>`).join(', ')}`
          : '';
        lines.push(`- \`${utils.whatsapp.formatJidForDisplay(jidValue)}\` (${classify(jidValue)})${linkSuffix}`);
      }
      if (linkEntries.length) {
        lines.push('Enlaces de mención sin procesar:');
        for (const entry of linkEntries) {
          const suffix = /^\d+$/.test(entry.discordId) ? ` -> <@${entry.discordId}>` : '';
          lines.push(`- \`${utils.whatsapp.formatJidForDisplay(entry.key)}\`${suffix}`);
        }
      }

      await ctx.replyPartitioned(lines.join('\n'));
    },
  },
  addtowhitelist: {
    description: 'Agrega un canal a la lista blanca.',
    options: [
      {
        name: 'channel',
        description: 'Canal vinculado a un chat de WhatsApp.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
    ],
    async execute(ctx) {
      const channel = ctx.getChannelOption('channel');
      if (!channel) {
        await ctx.reply('Por favor ingresa un nombre de canal válido. Uso: `addToWhitelist #<canal objetivo>`.');
        return;
      }

      const jid = utils.discord.channelIdToJid(channel.id);
      if (!jid) {
        await ctx.reply('No se encontró un chat con el canal proporcionado.');
        return;
      }

      const normalized = utils.whatsapp.formatJid(jid);
      if (normalized && !state.settings.Whitelist.includes(normalized)) {
        state.settings.Whitelist.push(normalized);
      }
      await ctx.reply('¡Agregado a la lista blanca!');
    },
  },
  removefromwhitelist: {
    description: 'Elimina un canal de la lista blanca.',
    options: [
      {
        name: 'channel',
        description: 'Canal vinculado a un chat de WhatsApp.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
    ],
    async execute(ctx) {
      const channel = ctx.getChannelOption('channel');
      if (!channel) {
        await ctx.reply('Por favor ingresa un nombre de canal válido. Uso: `removeFromWhitelist #<canal objetivo>`.');
        return;
      }

      const jid = utils.discord.channelIdToJid(channel.id);
      if (!jid) {
        await ctx.reply('No se encontró un chat con el canal proporcionado.');
        return;
      }

      const normalized = utils.whatsapp.formatJid(jid);
      state.settings.Whitelist = state.settings.Whitelist.filter((el) => el !== normalized);
      await ctx.reply('¡Eliminado de la lista blanca!');
    },
  },
  listwhitelist: {
    description: 'Muestra los canales en lista blanca.',
    async execute(ctx) {
      await ctx.reply(
        state.settings.Whitelist.length
          ? `\`\`\`${state.settings.Whitelist.map((jid) => utils.whatsapp.jidToName(jid)).join('\n')}\`\``
          : 'La lista blanca está vacía o inactiva.',
      );
    },
  },
  setdcprefix: {
    description: 'Establece un prefijo fijo para mensajes de Discord.',
    options: [
      {
        name: 'prefix',
        description: 'Texto del prefijo. Déjalo vacío para restablecer al nombre de usuario.',
        type: ApplicationCommandOptionTypes.STRING,
        required: false,
      },
    ],
    async execute(ctx) {
      const prefix = ctx.getStringOption('prefix');
      if (prefix) {
        state.settings.DiscordPrefixText = prefix;
        await ctx.reply(`¡El prefijo de Discord se estableció en ${prefix}!`);
      } else {
        state.settings.DiscordPrefixText = null;
        await ctx.reply('¡El prefijo de Discord se estableció a tu nombre de usuario!');
      }
    },
  },
  dcprefix: {
    description: 'Activa o desactiva los prefijos de nombres de usuario de Discord.',
    options: [
      {
        name: 'enabled',
        description: 'Si se deben usar los prefijos de nombres de usuario de Discord.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.DiscordPrefix = enabled;
      await ctx.reply(`El prefijo de nombre de usuario de Discord está configurado en ${state.settings.DiscordPrefix}.`);
    },
  },
  waprefix: {
    description: 'Activa o desactiva los prefijos de nombres de WhatsApp en Discord.',
    options: [
      {
        name: 'enabled',
        description: 'Si se deben anteponer los nombres de remitente de WhatsApp en los mensajes de Discord.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.WAGroupPrefix = enabled;
      await ctx.reply(`El prefijo de nombre de WhatsApp está configurado en ${state.settings.WAGroupPrefix}.`);
    },
  },
  waplatformsuffix: {
    description: 'Activa o desactiva el sufijo de plataforma del remitente de WhatsApp en Discord.',
    options: [
      {
        name: 'enabled',
        description: 'Si los mensajes de WhatsApp reflejados en Discord deben incluir un sufijo de plataforma del remitente.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.WASenderPlatformSuffix = enabled;
      await ctx.reply(`El sufijo de plataforma de remitente de WhatsApp está configurado en ${state.settings.WASenderPlatformSuffix}.`);
    },
  },
  hidephonenumbers: {
    description: 'Oculta números de teléfono de WhatsApp en Discord (usa seudónimos cuando sea necesario).',
    options: [
      {
        name: 'enabled',
        description: 'Si se deben ocultar los números de teléfono en Discord.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.HidePhoneNumbers = enabled;
      if (enabled) {
        utils.whatsapp.ensurePrivacySalt();
      }
      await ctx.reply(`La ocultación de números de teléfono está configurada en ${state.settings.HidePhoneNumbers}.`);
    },
  },
  waupload: {
    description: 'Activa o desactiva la subida de adjuntos a WhatsApp.',
    options: [
      {
        name: 'enabled',
        description: 'Si los adjuntos de Discord deben subirse a WhatsApp (en vez de enviar como enlaces).',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.UploadAttachments = enabled;
      await ctx.reply(`La subida de adjuntos a WhatsApp está configurada en ${state.settings.UploadAttachments}.`);
    },
  },
  deletes: {
    description: 'Activa o desactiva la eliminación de mensajes reflejados.',
    options: [
      {
        name: 'enabled',
        description: 'Si las eliminaciones de mensajes deben reflejarse entre Discord y WhatsApp.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.DeleteMessages = enabled;
      await ctx.reply(`Las eliminaciones de mensajes reflejados están configuradas en ${state.settings.DeleteMessages}.`);
    },
  },
  readreceipts: {
    description: 'Activa o desactiva las confirmaciones de lectura.',
    options: [
      {
        name: 'enabled',
        description: 'Si las confirmaciones de lectura están activadas.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.ReadReceipts = enabled;
      await ctx.reply(`Las confirmaciones de lectura están configuradas en ${state.settings.ReadReceipts}.`);
    },
  },
  dmreadreceipts: {
    description: 'Envía confirmaciones de lectura por mensaje directo.',
    async execute(ctx) {
      state.settings.ReadReceiptMode = 'dm';
      await ctx.reply('Las confirmaciones de lectura se enviarán por mensaje directo.');
    },
  },
  publicreadreceipts: {
    description: 'Envía confirmaciones de lectura como respuestas en el canal.',
    async execute(ctx) {
      state.settings.ReadReceiptMode = 'public';
      await ctx.reply('Las confirmaciones de lectura se publicarán públicamente.');
    },
  },
  reactionreadreceipts: {
    description: 'Envía confirmaciones de lectura como reacciones.',
    async execute(ctx) {
      state.settings.ReadReceiptMode = 'reaction';
      await ctx.reply('Las confirmaciones de lectura se agregarán como reacciones .');
    },
  },
  help: {
    description: 'Muestra enlace de ayuda.',
    async execute(ctx) {
      await ctx.reply('Puedes ver todos los comandos disponibles en la sección de commands.md');
    },
  },
  resync: {
    description: 'Vuelve a sincronizar contactos y grupos de WhatsApp.',
    options: [
      {
        name: 'rename',
        description: 'Renombra canales para que coincidan con nombres de WhatsApp.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: false,
      },
    ],
    async execute(ctx) {
      await ctx.defer();
      await state.waClient.authState.keys.set({
        'app-state-sync-version': { critical_unblock_low: null },
      });
      await state.waClient.resyncAppState(['critical_unblock_low']);
      const participatingGroups = await state.waClient.groupFetchAllParticipating();
      groupMetadataCache.prime(participatingGroups);
      for (const [jid, attributes] of Object.entries(participatingGroups)) {
        state.waClient.contacts[jid] = attributes.subject;
      }
      const shouldRename = Boolean(ctx.getBooleanOption('rename'));
      if (shouldRename) {
        try {
          await utils.discord.renameChannels();
        } catch (err) {
          state.logger?.error(err);
        }
      }
      await ctx.reply('¡Sincronizado!');
    },
  },
  localdownloads: {
    description: 'Activa o desactiva descargas locales para archivos grandes.',
    options: [
      {
        name: 'enabled',
        description: 'Si los adjuntos grandes de WhatsApp deben descargarse localmente.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.LocalDownloads = enabled;
      await ctx.reply(`Las descargas locales están configuradas en ${state.settings.LocalDownloads}.`);
    },
  },
  getdownloadmessage: {
    description: 'Muestra la plantilla de mensaje de descarga actual.',
    async execute(ctx) {
      await ctx.reply(`El formato de mensaje de descarga está configurado en "${state.settings.LocalDownloadMessage}"`);
    },
  },
  setdownloadmessage: {
    description: 'Actualiza la plantilla de mensaje de descarga.',
    options: [
      {
        name: 'message',
        description: 'Texto de la plantilla.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const message = ctx.getStringOption('message');
      state.settings.LocalDownloadMessage = message;
      await ctx.reply(`El formato de mensaje de descarga se estableció en "${state.settings.LocalDownloadMessage}"`);
    },
  },
  getdownloaddir: {
    description: 'Muestra el directorio de descargas.',
    async execute(ctx) {
      await ctx.reply(`La ruta de descarga está configurada en "${state.settings.DownloadDir}"`);
    },
  },
  setdownloaddir: {
    description: 'Establece el directorio de descargas.',
    options: [
      {
        name: 'path',
        description: 'Ruta del directorio para descargas.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const dir = ctx.getStringOption('path');
      state.settings.DownloadDir = dir;
      await ctx.reply(`La ruta de descarga se estableció en "${state.settings.DownloadDir}"`);
    },
  },
  setdownloadlimit: {
    description: 'Establece el límite de tamaño del directorio de descargas locales en GB.',
    options: [
      {
        name: 'size',
        description: 'Límite de tamaño en gigabytes.',
        type: ApplicationCommandOptionTypes.NUMBER,
        required: true,
      },
    ],
    async execute(ctx) {
      const gb = ctx.getNumberOption('size');
      if (!Number.isNaN(gb) && gb >= 0) {
        state.settings.DownloadDirLimitGB = gb;
        await ctx.reply(`El límite de tamaño del directorio de descargas se estableció en ${gb} GB.`);
      } else {
        await ctx.reply('Por favor proporciona un tamaño válido en gigabytes.');
      }
    },
  },
  setfilesizelimit: {
    description: 'Establece el límite de tamaño de subida de Discord usado por el bot.',
    options: [
      {
        name: 'bytes',
        description: 'Tamaño máximo en bytes.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const size = ctx.getIntegerOption('bytes');
      if (!Number.isNaN(size) && size > 0) {
        state.settings.DiscordFileSizeLimit = size;
        await ctx.reply(`El límite de tamaño de archivo de Discord se estableció en ${size} bytes.`);
      } else {
        await ctx.reply('Por favor proporciona un tamaño válido en bytes.');
      }
    },
  },
  localdownloadserver: {
    description: 'Activa o desactiva el servidor de descargas local.',
    options: [
      {
        name: 'enabled',
        description: 'Si el servidor de descargas local debe estar ejecutándose.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.LocalDownloadServer = enabled;
      if (enabled) {
        utils.ensureDownloadServer();
        await ctx.reply(`El servidor de descargas local está activado (puerto ${state.settings.LocalDownloadServerPort}).`);
        return;
      }

      utils.stopDownloadServer();
      await ctx.reply('El servidor de descargas local está desactivado.');
    },
  },
  setlocaldownloadserverport: {
    description: 'Establece el puerto del servidor de descargas.',
    options: [
      {
        name: 'port',
        description: 'Número de puerto.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const port = ctx.getIntegerOption('port');
      if (!Number.isNaN(port) && port > 0 && port <= 65535) {
        state.settings.LocalDownloadServerPort = port;
        utils.stopDownloadServer();
        utils.ensureDownloadServer();
        await ctx.reply(`El puerto del servidor de descargas local se estableció en ${port}.`);
      } else {
        await ctx.reply('Por favor proporciona un puerto válido.');
      }
    },
  },
  setlocaldownloadserverhost: {
    description: 'Establece el host del servidor de descargas.',
    options: [
      {
        name: 'host',
        description: 'Dirección del host.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const host = ctx.getStringOption('host');
      state.settings.LocalDownloadServerHost = host;
      utils.stopDownloadServer();
      utils.ensureDownloadServer();
      await ctx.reply(`El host del servidor de descargas local se estableció en ${host}.`);
    },
  },
  setlocaldownloadserverbindhost: {
    description: 'Establece el host de enlace/escucha del servidor de descargas.',
    options: [
      {
        name: 'host',
        description: 'Host de enlace (ej., 127.0.0.1 o 0.0.0.0).',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const host = ctx.getStringOption('host');
      state.settings.LocalDownloadServerBindHost = host;
      utils.stopDownloadServer();
      utils.ensureDownloadServer();
      await ctx.reply(`El host de enlace del servidor de descargas local se estableció en ${host}.`);
    },
  },
  setdownloadlinkttl: {
    description: 'Establece la expiración de enlaces de descarga local en segundos (0 = nunca).',
    options: [
      {
        name: 'seconds',
        description: 'Segundos hasta que los enlaces expiran.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const seconds = ctx.getIntegerOption('seconds');
      if (!Number.isNaN(seconds) && seconds >= 0) {
        state.settings.LocalDownloadLinkTTLSeconds = seconds;
        await ctx.reply(`El TTL de enlaces de descarga local se estableció en ${seconds} segundos.`);
      } else {
        await ctx.reply('Por favor proporciona un número válido de segundos (0 o superior).');
      }
    },
  },
  setdownloadmaxage: {
    description: 'Establece el vencimiento máximo (días) para archivos en el directorio de descargas (0 = mantener para siempre).',
    options: [
      {
        name: 'days',
        description: 'Vencimiento máximo en días.',
        type: ApplicationCommandOptionTypes.NUMBER,
        required: true,
      },
    ],
    async execute(ctx) {
      const days = ctx.getNumberOption('days');
      if (!Number.isNaN(days) && days >= 0) {
        state.settings.DownloadDirMaxAgeDays = days;
        await ctx.reply(`El vencimiento máximo del directorio de descargas se estableció en ${days} día(s).`);
      } else {
        await ctx.reply('Por favor proporciona un número válido de días (0 o superior).');
      }
    },
  },
  setdownloadminfree: {
    description: 'Establece el espacio mínimo libre en disco (GB) para mantener al limpiar descargas (0 = desactivado).',
    options: [
      {
        name: 'gb',
        description: 'Espacio mínimo libre en gigabytes.',
        type: ApplicationCommandOptionTypes.NUMBER,
        required: true,
      },
    ],
    async execute(ctx) {
      const gb = ctx.getNumberOption('gb');
      if (!Number.isNaN(gb) && gb >= 0) {
        state.settings.DownloadDirMinFreeGB = gb;
        await ctx.reply(`El espacio mínimo libre del directorio de descargas se estableció en ${gb} GB.`);
      } else {
        await ctx.reply('Por favor proporciona un tamaño válido en gigabytes (0 o superior).');
      }
    },
  },
  httpsdownloadserver: {
    description: 'Activa o desactiva HTTPS para el servidor de descargas local.',
    options: [
      {
        name: 'enabled',
        description: 'Si HTTPS debe estar activado para el servidor de descargas local.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.UseHttps = enabled;
      utils.stopDownloadServer();
      utils.ensureDownloadServer();
      await ctx.reply(`El servidor de descargas local utiliza HTTPS: ${state.settings.UseHttps}.`);
    },
  },
  sethttpscert: {
    description: 'Establece las rutas de certificados HTTPS para el servidor de descargas.',
    options: [
      {
        name: 'key_path',
        description: 'Ruta a la clave TLS.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
      {
        name: 'cert_path',
        description: 'Ruta al certificado TLS.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const key = ctx.getStringOption('key_path');
      const cert = ctx.getStringOption('cert_path');
      [state.settings.HttpsKeyPath, state.settings.HttpsCertPath] = [key, cert];
      utils.stopDownloadServer();
      utils.ensureDownloadServer();
      await ctx.reply(`La ruta de clave HTTPS se estableció en ${key} y la ruta de certificado en ${cert}.`);
    },
  },
  publishing: {
    description: 'Activa o desactiva la publicación automática de mensajes en canales de noticias.',
    options: [
      {
        name: 'enabled',
        description: 'Si los mensajes enviados a canales de noticias deben publicarse automáticamente.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.Publish = enabled;
      await ctx.reply(`La publicación de mensajes en canales de noticias está configurada en ${state.settings.Publish}.`);
    },
  },
  changenotifications: {
    description: 'Activa o desactiva notificaciones de cambios de perfil/estado (y reflejo de estados de WhatsApp).',
    options: [
      {
        name: 'enabled',
        description: 'Si las notificaciones de cambios y el reflejo de estados de WhatsApp están activados.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.ChangeNotifications = enabled;
      state.settings.MirrorWAStatuses = enabled;
      await ctx.reply(`Las notificaciones de cambios están configuradas en ${state.settings.ChangeNotifications}.`);
    },
  },
  autosaveinterval: {
    description: 'Establece el intervalo de guardado automático (segundos).',
    options: [
      {
        name: 'seconds',
        description: 'Número de segundos entre guardados.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const seconds = ctx.getIntegerOption('seconds');
      state.settings.autoSaveInterval = seconds;
      await ctx.reply(`El intervalo de guardado automático se cambió a ${seconds} segundos.`);
    },
  },
  lastmessagestorage: {
    description: 'Establece cuántos mensajes recientes se pueden editar/eliminar.',
    options: [
      {
        name: 'size',
        description: 'Número de mensajes a mantener.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const size = ctx.getIntegerOption('size');
      state.settings.lastMessageStorage = size;
      await ctx.reply(`El tamaño de almacenamiento de mensajes recientes se cambió a ${size}.`);
    },
  },
  oneway: {
    description: 'Establece el modo de comunicación unilateral.',
    options: [
      {
        name: 'direction',
        description: 'Elige dirección o desactiva comunicación unilateral.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
        choices: [
          { name: 'discord', value: 'discord' },
          { name: 'whatsapp', value: 'whatsapp' },
          { name: 'disabled', value: 'disabled' },
        ],
      },
    ],
    async execute(ctx) {
      const direction = ctx.getStringOption('direction');

      if (direction === 'disabled') {
        state.settings.oneWay = 0b11;
        await ctx.reply('La comunicación bilateral está habilitada.');
      } else if (direction === 'whatsapp') {
        state.settings.oneWay = 0b10;
        await ctx.reply('Los mensajes solo se enviarán a WhatsApp.');
      } else if (direction === 'discord') {
        state.settings.oneWay = 0b01;
        await ctx.reply('Los mensajes solo se enviarán a Discord.');
      }
    },
  },
  redirectbots: {
    description: 'Activa o desactiva el redireccionamiento de mensajes de bots a WhatsApp.',
    options: [
      {
        name: 'enabled',
        description: 'Si los mensajes de bots deben redireccionarse.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.redirectBots = enabled;
      await ctx.reply(`El redireccionamiento de bots está configurado en ${state.settings.redirectBots}.`);
    },
  },
  redirectwebhooks: {
    description: 'Activa o desactiva el redireccionamiento de mensajes de webhook a WhatsApp.',
    options: [
      {
        name: 'enabled',
        description: 'Si los mensajes de webhook deben redireccionarse.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabled = Boolean(ctx.getBooleanOption('enabled'));
      state.settings.redirectWebhooks = enabled;
      await ctx.reply(`El redireccionamiento de webhooks está configurado en ${state.settings.redirectWebhooks}.`);
    },
  },
  restart: {
    description: 'Reinicia el bot de forma segura.',
    async execute(ctx) {
      if (!ctx.isControlChannel) {
        await ctx.reply('Por seguridad, `/restart` solo puede usarse en el canal de control.');
        return;
      }

      await requestSafeRestart(ctx, { message: 'Estado guardado. Reiniciando...' });
    },
  },
  // Código de actualizaciones removido - modo empresarial sin auto-actualizaciones
  // updatechannel: {
  //   description: 'Cambia el canal de actualizaciones entre estable y inestable.',
  //   options: [
  //     {
  //       name: 'channel',
  //       description: 'Canal de lanzamiento.',
  //       type: ApplicationCommandOptionTypes.STRING,
  //       required: true,
  //       choices: [
  //         { name: 'stable', value: 'stable' },
  //         { name: 'unstable', value: 'unstable' },
  //       ],
  //     },
  //   ],
  //   async execute(ctx) {
  //     const channel = ctx.getStringOption('channel');

  //     state.settings.UpdateChannel = channel;
  //     await ctx.reply(`Update channel set to ${channel}. Checking for new releases...`);
  //     await utils.updater.run(state.version, { prompt: false });
  //     await utils.discord.syncUpdatePrompt();
  //     await utils.discord.syncRollbackPrompt();
  //     if (state.updateInfo) {
  //       const message = utils.updater.formatUpdateMessage(state.updateInfo);
  //       await ctx.replyPartitioned(message);
  //     } else {
  //       await ctx.reply('No updates are available on that channel right now.');
  //     }
  //   },
  // },
  // update: {
  //   description: 'Instala la actualización disponible.',
  //   async execute(ctx) {
  //     await ctx.defer();
  //     if (!state.updateInfo) {
  //       await ctx.reply('No hay actualizaciones disponibles.');
  //       return;
  //     }
  //     if (!state.updateInfo.canSelfUpdate) {
  //       await ctx.replyPartitioned(
  //         `Una nueva ${state.updateInfo.channel || 'estable'} release (${state.updateInfo.version}) está disponible, pero esta instalación no puede autoactualizarse.\n` +
  //         'Extrae la nueva imagen o binaria para la versión solicitada y reinicia el bot.',
  //       );
  //       return;
  //     }

  //     await ctx.reply('Actualizando...');
  //     const success = await utils.updater.update(state.updateInfo.version);
  //     if (!success) {
  //       await ctx.reply('Actualización fallida. Ver logs.');
  //       return;
  //     }

  //     state.updateInfo = null;
  //     await utils.discord.syncUpdatePrompt();
  //     await utils.discord.syncRollbackPrompt();
  //     await requestSafeRestart(ctx, { message: 'Update downloaded. Restarting...' });
  //   },
  // },
  // checkupdate: {
  //   description: 'Comprobar actualizaciones ahora.',
  //   async execute(ctx) {
  //     await ctx.defer();
  //     await utils.updater.run(state.version, { prompt: false });
  //     await utils.discord.syncUpdatePrompt();
  //     await utils.discord.syncRollbackPrompt();
  //     if (state.updateInfo) {
  //       const message = utils.updater.formatUpdateMessage(state.updateInfo);
  //       const components = [
  //         new MessageActionRow().addComponents(
  //           new MessageButton()
  //             .setCustomId(UPDATE_BUTTON_IDS.APPLY)
  //             .setLabel('Actualizar')
  //             .setStyle('PRIMARY')
  //             .setDisabled(!state.updateInfo.canSelfUpdate),
  //           new MessageButton()
  //             .setCustomId(UPDATE_BUTTON_IDS.SKIP)
  //             .setLabel('Omitir actualización')
  //             .setStyle('SECONDARY'),
  //         ),
  //       ];
  //       await ctx.reply({ content: message, components });
  //     } else {
  //       await ctx.reply('No existen actualizaciones disponibles.');
  //     }
  //   },
  // },
  // skipupdate: {
  //   description: 'Ignorar la actualización actual.',
  //   async execute(ctx) {
  //     state.updateInfo = null;
  //     await utils.discord.syncUpdatePrompt();
  //     await utils.discord.syncRollbackPrompt();
  //     await ctx.reply('Actualización ignorada.');
  //   },
  // },
  // rollback: {
  //   description: 'Revertir a la binaria empaquetada anterior.',
  //   async execute(ctx) {
  //     await ctx.defer();
  //     const result = await utils.updater.rollback();
  //     if (result.success) {
  //       await utils.discord.syncRollbackPrompt();
  //       await requestSafeRestart(ctx, { message: 'Revertido a la binaria empaquetada anterior. Reiniciando...' });
  //       return;
  //     }

  //     if (result.reason === 'node') {
  //       await ctx.replyPartitioned(
  //         'Revertir solo está disponible para binarias empaquetadas. Para revertir una instalación de Docker o fuente, extrae la imagen/etiqueta anterior y reinicia.'
  //       );
  //       return;
  //     }

  //     if (result.reason === 'no-backup') {
  //       await ctx.reply('No se puede revertir. No hay una copia de seguridad de la binaria empaquetada anterior.');
  //       return;
  //     }

  //     await ctx.reply('Revertir fallido. Ver logs para detalles.');
  //   },
  // },
  unknown: {
    register: false,
    async execute(ctx) {
      await ctx.reply('Comando desconocido.');
    },
  },
};

const slashCommands = Object.entries(commandHandlers)
  .filter(([, def]) => def.register !== false)
  .map(([name, def]) => ({
    name,
    description: def.description || 'No description provided.',
    options: def.options || [],
  }));

const buildInviteLink = () => (
  client?.user?.id
    ? `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}`
    : null
);

const registerSlashCommands = async () => {
  try {
    const guild = await utils.discord.getGuild();
    if (!guild) {
      state.logger?.error('No se pudo cargar el servidor al registrar los comandos.');
      return;
    }
    await guild.commands.set(slashCommands);
  } catch (err) {
    state.logger?.error({ err }, 'No se pudieron registrar los comandos slash');
    const missingAccess = err?.code === 50001 || /Missing Access/i.test(err?.message || '');
    if (missingAccess && !slashRegisterWarned) {
      slashRegisterWarned = true;
      const link = buildInviteLink();
      const warning = link
        ? `No se pudieron registrar los comandos slash (falta el permiso applications.commands). Vuelve a invitar al bot con este enlace:\n${link}`
        : 'No se pudieron registrar los comandos slash (falta el permiso applications.commands). Vuelve a invitar al bot con los permisos bot y applications.commands.';
      controlChannel?.send(warning).catch(() => { });
    }
  }
};

const executeCommand = async (name, ctx) => {
  const handler = commandHandlers[name] || commandHandlers.unknown;
  await handler.execute(ctx);
};

const handleInteractionCommand = async (interaction, commandName) => {
  const responder = new CommandResponder({ interaction, channel: interaction.channel });
  await responder.defer();
  const ctx = new CommandContext({ interaction, responder });
  await executeCommand(commandName, ctx);
};

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId === UPDATE_BUTTON_IDS.APPLY) {
      await handleInteractionCommand(interaction, 'update');
      return;
    }
    if (interaction.customId === UPDATE_BUTTON_IDS.SKIP) {
      await handleInteractionCommand(interaction, 'skipupdate');
      return;
    }
    if (interaction.customId === ROLLBACK_BUTTON_ID) {
      await handleInteractionCommand(interaction, 'rollback');
      return;
    }
    return;
  }

  if (!interaction.isCommand?.() && !interaction.isChatInputCommand?.()) {
    return;
  }

  const commandName = interaction.commandName?.toLowerCase();
  await handleInteractionCommand(interaction, commandName);
});

client.on('messageCreate', async (message) => {
  const isWebhookMessage = message.webhookId != null;

  if (message.author === client.user || message.applicationId === client.user.id) {
    return;
  }

  if (isWebhookMessage) {
    if (!state.settings.redirectWebhooks) {
      return;
    }
  } else if (message.author?.bot && !state.settings.redirectBots) {
    return;
  }

  const messageType = typeof message.type === 'number' ? Constants.MessageTypes?.[message.type] : message.type;
  if (messageType === 'CHANNEL_PINNED_MESSAGE') {
    return;
  }

  if (message.channel.id === state.settings.ControlChannelID) {
    await message.channel.send('Los comandos tradicionales han sido eliminados. Por favor, usa los comandos slash (/) de Discord en su lugar.');
    return;
  }

  const jid = utils.discord.channelIdToJid(message.channel.id);
  if (jid == null) {
    return;
  }

  state.waClient.ev.emit('discordMessage', { jid, message });
});

client.on('messageUpdate', async (oldMessage, message) => {
  const isWebhookMessage = message.webhookId != null;

  if (message.partial) {
    try {
      await message.fetch();
    } catch (err) {
      state.logger?.warn(err);
      return;
    }
  }

  const jid = utils.discord.channelIdToJid(message.channelId);
  if (jid == null) {
    return;
  }

  const oldPinned = typeof oldMessage?.pinned === 'boolean' ? oldMessage.pinned : undefined;
  const newPinned = Boolean(message.pinned);
  const pinChanged = typeof oldPinned === 'boolean' ? oldPinned !== newPinned : newPinned === true;

  if (pinChanged) {
    const waId = state.lastMessages[message.id];
    if (waId == null) {
      await message.channel.send(`No se pudo ${newPinned ? 'fijar' : 'desfijar'} en WhatsApp. Solo puedes fijar mensajes sincronizados con WhatsApp.`);
    } else if (bridgePinnedMessages.has(message.id)) {
      bridgePinnedMessages.delete(message.id);
    } else {
      const stored = messageStore.get({ id: waId, remoteJid: jid });
      const key = stored?.key || { id: waId, remoteJid: jid, fromMe: stored?.key?.fromMe || false };
      const pinType = newPinned ? 1 : 0;
      try {
        state.sentPins.add(key.id);
        const sentPinMsg = await state.waClient.sendMessage(jid, {
          pin: key,
          type: pinType,
          ...(pinType === 1 ? { time: getPinDurationSeconds() } : {}),
        });
        const pinNoticeKey = sentPinMsg?.key
          ? {
            ...sentPinMsg.key,
            remoteJid: utils.whatsapp.formatJid(sentPinMsg.key.remoteJid || jid),
            participant: utils.whatsapp.formatJid(sentPinMsg.key.participant || sentPinMsg.key.participantAlt),
          }
          : null;
        if (pinNoticeKey?.id) {
          state.sentPins.add(pinNoticeKey.id);
        }
        if (newPinned) {
          schedulePinExpiryNotice(message, getPinDurationSeconds());
        } else {
          clearPinExpiryNotice(message.id);
        }
        setTimeout(() => state.sentPins.delete(key.id), 5 * 60 * 1000);
        if (pinNoticeKey?.id) {
          setTimeout(() => state.sentPins.delete(pinNoticeKey.id), 5 * 60 * 1000);
          try {
            await state.waClient.sendMessage(pinNoticeKey.remoteJid, { delete: pinNoticeKey });
          } catch (err) {
            state.logger?.debug?.({ err }, 'No se pudo eliminar la notificación local de fijación');
          }
        }
      } catch (err) {
        state.logger?.error({ err }, 'No se pudo sincronizar la fijación de Discord con WhatsApp');
      }
    }
  }

  if (message.editedTimestamp == null || isWebhookMessage) {
    return;
  }

  const messageId = state.lastMessages[message.id];
  if (messageId == null) {
    if (message.author?.bot && !state.settings.redirectBots) {
      return;
    }
    await message.channel.send(`No se pudo editar el mensaje. Solo puedes editar los últimos ${state.settings.lastMessageStorage} mensajes.`);
    return;
  }

  if ((message.content || '').trim() === '') {
    await message.channel.send('El mensaje editado no tiene texto para enviar a WhatsApp.');
    return;
  }

  state.waClient.ev.emit('discordEdit', { jid, message });
});

client.on('messageDelete', async (message) => {
  if (!state.settings.DeleteMessages) {
    return;
  }

  const jid = utils.discord.channelIdToJid(message.channelId);
  if (jid == null) {
    return;
  }

  const waIds = [];
  for (const [waId, dcId] of Object.entries(state.lastMessages)) {
    if (dcId === message.id && waId !== message.id) {
      waIds.push(waId);
    }
  }

  if (message.webhookId != null && waIds.length === 0) {
    return;
  }

  if (message.author?.bot && !state.settings.redirectBots && waIds.length === 0) {
    return;
  }

  if (message.author?.id === client.user.id) {
    return;
  }

  if (waIds.length === 0) {
    await message.channel.send(`No se pudo eliminar el mensaje. Solo puedes eliminar los últimos ${state.settings.lastMessageStorage} mensajes.`);
    return;
  }

  for (const waId of waIds) {
    state.waClient.ev.emit('discordDelete', { jid, id: waId });
    delete state.lastMessages[waId];
  }
  delete state.lastMessages[message.id];
  clearPinExpiryNotice(message.id);
});

client.on('messageReactionAdd', async (reaction, user) => {
  const jid = utils.discord.channelIdToJid(reaction.message.channel.id);
  if (jid == null) {
    return;
  }
  const isBotUser = user?.id === state.dcClient?.user?.id;
  if (
    isBotUser
    && reaction.emoji?.name === '☑️'
    && (
      reaction.message.webhookId != null
      || deliveredMessages.has(reaction.message.id)
    )
  ) {
    return;
  }
  const messageId = state.lastMessages[reaction.message.id];
  if (messageId == null) {
    if (reaction.message.webhookId == null && reaction.message.author?.bot && !state.settings.redirectBots) {
      return;
    }
    await reaction.message.channel.send(`No se pudo enviar la reacción. Solo puedes reaccionar a los últimos ${state.settings.lastMessageStorage} mensajes.`);
    return;
  }
  if (isBotUser) {
    return;
  }
  const selfJid = state.waClient?.user?.id && utils.whatsapp.formatJid(state.waClient.user.id);
  if (selfJid && state.reactions[reaction.message.id]?.[selfJid]) {
    const prev = state.reactions[reaction.message.id][selfJid];
    await reaction.message.reactions.cache.get(prev)?.remove().catch(() => { });
    delete state.reactions[reaction.message.id][selfJid];
    if (!Object.keys(state.reactions[reaction.message.id]).length) {
      delete state.reactions[reaction.message.id];
    }
  }
  state.waClient.ev.emit('discordReaction', { jid, reaction, removed: false });
});

client.on('messageReactionRemove', async (reaction, user) => {
  const jid = utils.discord.channelIdToJid(reaction.message.channel.id);
  if (jid == null) {
    return;
  }
  const isBotUser = user?.id === state.dcClient?.user?.id;
  if (
    isBotUser
    && reaction.emoji?.name === '☑️'
    && (
      reaction.message.webhookId != null
      || deliveredMessages.has(reaction.message.id)
    )
  ) {
    return;
  }
  const messageId = state.lastMessages[reaction.message.id];
  if (messageId == null) {
    if (reaction.message.webhookId == null && reaction.message.author?.bot && !state.settings.redirectBots) {
      return;
    }
    await reaction.message.channel.send(`No se pudo eliminar la reacción. Solo puedes reaccionar a los últimos ${state.settings.lastMessageStorage} mensajes.`);
    return;
  }
  if (isBotUser) {
    return;
  }
  const selfJid = state.waClient?.user?.id && utils.whatsapp.formatJid(state.waClient.user.id);
  if (selfJid && state.reactions[reaction.message.id]?.[selfJid]) {
    const prev = state.reactions[reaction.message.id][selfJid];
    await reaction.message.reactions.cache.get(prev)?.remove().catch(() => { });
    delete state.reactions[reaction.message.id][selfJid];
    if (!Object.keys(state.reactions[reaction.message.id]).length) {
      delete state.reactions[reaction.message.id];
    }
  }
  state.waClient.ev.emit('discordReaction', { jid, reaction, removed: true });
});

const discordHandler = {
  start: async () => {
    await client.login(state.settings.Token);
    return client;
  },
  setControlChannel,
};

export default discordHandler;
