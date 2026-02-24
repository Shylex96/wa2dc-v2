import nodeCrypto from 'crypto';
import pino from 'pino';
import pretty from 'pino-pretty';
import fs from 'fs';

import discordHandler from './discordHandler.js';
import state from './state.js';
import utils from './utils.js';
import storage from './storage.js';
import whatsappHandler from './whatsappHandler.js';
import { isRecoverableUnhandledRejection } from './processErrors.js';

const isSmokeTest = process.env.WA2DC_SMOKE_TEST === '1';

if (!globalThis.crypto) {
  globalThis.crypto = nodeCrypto.webcrypto;
}

(async () => {
  const version = 'v2.1.5';
  state.version = version;
  const streams = [
    { stream: pino.destination('logs.txt') },
    { stream: pretty({ colorize: true }) },
  ];
  state.logger = pino({ mixin() { return { version }; } }, pino.multistream(streams));
  let autoSaver = setInterval(() => storage.save(), 5 * 60 * 1000);
  let shuttingDown = false;
  ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'].forEach((eventName) => {
    process.on(eventName, async (err) => {
      if (eventName === 'unhandledRejection' && isRecoverableUnhandledRejection(err)) {
        state.logger.warn({ err }, 'Ignorando rechazo de red recuperable');
        return;
      }
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      clearInterval(autoSaver);
      if (err != null) {
        state.logger.error(err);
      }
      state.logger.info('¡Saliendo!');
      let logs = '';
      try {
        logs = await fs.promises.readFile('logs.txt', 'utf8');
        logs = logs.split('\n').slice(-20).join('\n');
      } catch (readErr) {
        // ignorar errores de lectura
      }
      const content = `El bot falló: \n\n\`\`\`\n${err?.stack || err}\n\`\`\`` +
        (logs ? `\nRegistros recientes:\n\`\`\`\n${logs}\n\`\`\`` : '');
      let sent = false;
      try {
        const ctrl = await utils.discord.getControlChannel();
        if (ctrl) {
          if (content.length > 2000) {
            await ctrl.send({
              content: `${content.slice(0, 1997)}...`,
              files: [{ attachment: Buffer.from(content, 'utf8'), name: 'crash.txt' }],
            });
          } else {
            await ctrl.send(content);
          }
          sent = true;
        }
      } catch (e) {
        state.logger.error('Falló el envío de información del crash a Discord');
        state.logger.error(e);
      }
      if (!sent) {
        try {
          await fs.promises.writeFile('crash-report.txt', content, 'utf8');
        } catch (e) {
          state.logger.error('Falló la escritura del reporte del crash en disco');
          state.logger.error(e);
        }
      }
      try {
        await storage.save();
      } catch (e) {
        state.logger.error('Falló el guardado del almacenamiento');
        state.logger.error(e);
      }
      process.exit(['SIGINT', 'SIGTERM'].includes(eventName) ? 0 : 1);
    });
  });

  state.logger.info('Iniciando');

  const conversion = await utils.sqliteToJson.convert();
  if (!conversion) {
    state.logger.error('¡La conversión falló!');
    process.exit(1);
  }
  state.logger.info('Conversión completada.');

  state.settings = await storage.parseSettings();
  state.logger.info('Configuración cargada.');
  if (isSmokeTest) {
    state.logger.info('Ejecutando en modo prueba de smoke; clientes externos omitidos.');
  }
  if (utils.whatsapp.normalizeMentionLinks()) {
    await storage.saveSettings().catch(() => {});
    state.logger.info('Enlaces de mención WhatsApp→Discord normalizados.');
  }

  utils.ensureDownloadServer();

  clearInterval(autoSaver);
  autoSaver = setInterval(() => storage.save(), state.settings.autoSaveInterval * 1000);
  state.logger.info('Intervalo de guardado automático cambiado.');

  state.contacts = await storage.parseContacts();
  state.logger.info('Contactos cargados.');

  state.chats = await storage.parseChats();
  state.logger.info('Chats cargados.');

  state.startTime = await storage.parseStartTime();
  state.logger.info('Última marca de tiempo cargada.');

  state.lastMessages = await storage.parseLastMessages();
  state.logger.info('Últimos mensajes cargados.');

  if (!isSmokeTest) {
    state.dcClient = await discordHandler.start();
    state.logger.info('Cliente de Discord iniciado.');

    await utils.discord.repairChannels();
    await discordHandler.setControlChannel();
    state.logger.info('Canales reparados.');
  } else {
    state.logger.info('Omitiendo inicio de Discord para prueba de smoke.');
  }

  if (!isSmokeTest) {
    // Enviar cualquier reporte de falla en cola
    try {
      const crashFile = 'crash-report.txt';
      const queued = await fs.promises.readFile(crashFile, 'utf8');
      const ctrl = await utils.discord.getControlChannel();
      if (ctrl) {
        if (queued.length > 2000) {
          await ctrl.send({
            content: `${queued.slice(0, 1997)}...`,
            files: [{ attachment: Buffer.from(queued, 'utf8'), name: 'crash.txt' }],
          });
        } else {
          await ctrl.send(queued);
        }
        await fs.promises.unlink(crashFile);
        state.logger.info('Reporte de crash en cola enviado.');
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        state.logger.error('Falló el envío del reporte del crash en cola');
        state.logger.error(e);
      }
    }
  } else {
    state.logger.info('Omitiendo reproducción de reporte del crash para prueba de smoke.');
  }

  if (!isSmokeTest) {
    await whatsappHandler.start();
    state.logger.info('Cliente de WhatsApp iniciado.');
  } else {
    state.logger.info('Omitiendo inicio de WhatsApp para prueba de smoke.');
  }

  // Código de actualizaciones removido - modo empresarial sin auto-actualizaciones
  // if (!isSmokeTest) {
  //   await utils.updater.run(version, { prompt: false });
  //   state.logger.info('Update checked.');
  //   await utils.discord.syncUpdatePrompt();
  //   await utils.discord.syncRollbackPrompt();

  //   setInterval(async () => {
  //     await utils.updater.run(version, { prompt: false });
  //     await utils.discord.syncUpdatePrompt();
  //     await utils.discord.syncRollbackPrompt();
  //   }, 2 * 24 * 60 * 60 * 1000);
  // } else {
  //   state.logger.info('Skipping update checks for smoke test.');
  // }

  state.logger.info('El bot ahora está ejecutándose. Presiona CTRL-C para salir.');

  if (isSmokeTest) {
    clearInterval(autoSaver);
    state.logger.info('Prueba de smoke completada exitosamente.');
    process.exit(0);
  }
})();
