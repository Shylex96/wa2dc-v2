# WhatsApp To Discord

WhatsAppToDiscord es un bot de Discord que utiliza WhatsApp Web como puente entre Discord y WhatsApp. Está construido sobre las librerías [discord.js](https://github.com/discordjs/discord.js) y [Baileys](https://github.com/WhiskeySockets/Baileys).

## Requisitos

- Node.js 24 o superior

## Características

- Soporta medios (Imagen, Video, Audio, Documento, Stickers) y reacciones.
- Permite listas blancas para controlar qué mensajes ver en Discord.
- Traduce menciones entre WhatsApp y Discord.
- Permite usar WhatsApp desde el overlay de Discord.
- Sincroniza ediciones de mensajes entre WhatsApp y Discord.
- Refleja encuestas de WhatsApp en Discord (creación y actualización en vivo; votación permanece en WhatsApp).
- Usa recursos mínimos porque no simula un navegador.
- Código abierto: puedes ver, modificar y ejecutar tu propia versión.
- Autoalojado: tus datos nunca salen de tu computadora.
- Se reinicia automáticamente si se bloquea.
- Comprueba actualizaciones cada pocos días y puede aplicar actualizaciones firmadas bajo demanda (solo versiones empaquetadas).

**Nota:** Debido a limitaciones del protocolo WhatsApp Web, el bot solo notifica llamadas entrantes o perdidas. No puede reenviar audio o video de llamadas en tiempo real.

## Notas de seguridad

- WA2DC no implementa autorización por usuario/rol para comandos. Usa permisos de canales/roles de Discord para controlar el acceso.
- Mantén `#sala-de-control` privada: contiene códigos QR y es donde gestionas enlaces, actualizaciones y configuraciones.
- Las vistas previas de enlaces se generan desde el host del bot. Por seguridad, se bloquean direcciones locales o privadas y se aplican límites de tamaño y tiempo.

## Migración a Baileys 7

Se utiliza Baileys `7.0.0-rc.9`.  

- Los Identificadores Locales (LIDs) son ahora preferidos sobre JIDs basados en PN.
- Se migran chats y listas blancas automáticamente según los pares PN↔LID revelados por WhatsApp.
- El store de autenticación de Signal genera los namespaces requeridos (`lid-mapping`, `tctoken`, `device-list`, `device-index`) para evitar fallos.

**Problemas comunes y soluciones**

- **Duplicación de canales Discord tras migración LID:** Reenlaza la conversación al canal original con `link --force <contact> #old-channel`.
- **Logs repetidos "Connection was lost":** WhatsApp puede desconectar ocasionalmente. El bot reintenta con backoff exponencial. Si falla, escanea nuevamente el QR.

## Reinstalación del bot

- Elimina `logs.txt` si existe.
- Asegúrate de que el bot no esté activo en Discord.
- Borra la categoría `whatsapp` y todos los canales asociados.
- Borra la carpeta `storage`.

Esto garantiza un inicio limpio.

## Configuración

- Instrucciones detalladas [aquí](setup.md).

## Comandos

- Listado completo de comandos [aquí](commands.md).