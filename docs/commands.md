# Comandos

Todos los controles del bot ahora se ejecutan exclusivamente a través de comandos de barra de Discord. Escribe `/` en cualquier canal para ver los comandos disponibles (el bot debe estar en el servidor) o reduce la lista escribiendo `/wa` y seleccionando la acción deseada. Los comandos se pueden invocar en cualquier lugar, pero las respuestas son efímeras fuera del canal de control. Los comandos de texto heredados de `#sala-de-control` han sido eliminados: usa los comandos de barra o los botones persistentes en el canal de control.

---

## Gestión de Conversaciones

### `/pairwithcode`
Solicita un código de emparejamiento para un número de teléfono específico.  
Uso: `/pairwithcode number:<número de teléfono E.164>`
**Nota:** Siempre que se utilice el comando `/pairwithcode`, se debe especificar el número de teléfono con formato E.164 (ej., `+34123456789`).

### `/chatinfo`
Muestra a qué chat de WhatsApp está vinculado el canal actual (JID + tipo).  
Uso: `/chatinfo`

### `/start`
Crea una conversación de WhatsApp completamente nueva y un enlace de canal.  
Uso: `/start contact:<número de teléfono o nombre de contacto guardado>`

### `/link`
Vincula un canal de texto/noticias de Discord existente a un chat de WhatsApp existente sin crear nada nuevo.  
Uso: `/link contact:<nombre o número> channel:<#canal> force:<true|false>`  
Habilita `force` para anular un canal que ya está vinculado a otro chat.

### `/move`
Mueve un enlace de WhatsApp existente (y webhook) de un canal a otro.  
Uso: `/move from:<#canal-actual> to:<#canal-nuevo> force:<true|false>`

### `/list`
Lista todos los contactos y grupos conocidos, opcionalmente filtrados.  
Uso: `/list query:<texto opcional>`

### `/poll`
Crea una encuesta de WhatsApp desde Discord.  
Uso: `/poll question:"texto" options:"opción1,opción2,..." select:<cantidad> announcement:<true|false>`  
**Nota:** Los mensajes de encuesta y actualizaciones de votos en vivo se reflejan en Discord, la votación solo se puede hacer directamente en WhatsApp.

### `/setpinduration`
Establece el tiempo de vencimiento predeterminado (24h, 7d, o 30d) para pines de WhatsApp creados desde Discord.  
Uso: `/setpinduration duration:<24h|7d|30d>`

---

## Controles de Lista Blanca

### `/listwhitelist`
Muestra las conversaciones que actualmente están permitidas para enlazarse cuando la lista blanca está habilitada.

### `/addtowhitelist`
Agrega un canal vinculado a la lista blanca.  
Uso: `/addtowhitelist channel:<#canal>`

### `/removefromwhitelist`
Elimina un canal vinculado de la lista blanca.  
Uso: `/removefromwhitelist channel:<#canal>`

---

## Formato y Prefijos

### `/setdcprefix`
Anula el prefijo que se antepone a los mensajes de Discord → WhatsApp.  
Uso: `/setdcprefix prefix:<texto opcional>` (omite para restablecer a nombres de usuario)

### `/dcprefix`
Alterna si se usa el prefijo configurado.  
Uso: `/dcprefix enabled:<true|false>`

### `/waprefix`
Alterna si los nombres de remitente de WhatsApp se anteponen dentro de los mensajes de Discord.  
Uso: `/waprefix enabled:<true|false>`

### `/waplatformsuffix`
Alterna si los mensajes de WhatsApp reflejados en Discord incluyen un sufijo que muestra la plataforma del remitente (Android/iOS/Desktop/Web).  
Uso: `/waplatformsuffix enabled:<true|false>`

---

## Privacidad

### `/hidephonenumbers`
Oculta los números de teléfono de WhatsApp en Discord (usa seudónimos cuando no hay un nombre de contacto real disponible).  
Uso: `/hidephonenumbers enabled:<true|false>`

---

## Menciones

WA2DC puede opcionalmente traducir las @menciones de WhatsApp en menciones de usuario de Discord, si vinculas un contacto de WhatsApp a un usuario de Discord.
Esto solo funciona para **menciones reales de WhatsApp** (selecciona la persona del selector de menciones de WhatsApp); escribir manualmente `@nombre` sin seleccionar no incluirá metadatos de mención y no se puede traducir de manera confiable.
Si un contacto de WhatsApp está vinculado, WA2DC también traducirá las **@menciones de usuario de Discord** en **menciones de WhatsApp** al reenviar mensajes de Discord a WhatsApp (debes usar una mención real de Discord — selecciona el usuario del autocompletado para que Discord inserte una mención `<@...>`).

### `/linkmention`
Vincula un contacto de WhatsApp con un usuario de Discord para que las futuras menciones @ en WhatsApp le envíen una notificación en Discord.
Uso: `/linkmention contact:<número de teléfono o nombre de contacto guardado> user:<@usuario>`
**Nota:** los números de teléfono pueden incluir `+`, espacios o guiones; WA2DC los normaliza automáticamente.
**Nota:** WhatsApp puede representar a la misma persona como un JID de teléfono (`...@s.whatsapp.net`, "PN") y/o un ID de Dispositivo Vinculado (`...@lid`, "LID"). Si las menciones no notifican aunque exista el enlace, podrías estar recibiendo **menciones LID**. Puedes vincular el LID directamente pasándolo como valor de contacto, ej. `/linkmention contact:<algunid@lid> user:<@usuario>`. En versiones anteriores, es posible que necesites vincular **tanto** el PN como el LID para el mismo contacto.

### `/unlinkmention`
Elimina un enlace de mención de WhatsApp→Discord para un contacto.  
Uso: `/unlinkmention contact:<número de teléfono o nombre de contacto guardado>`

### `/mentionlinks`
Lista todos los enlaces de mención de WhatsApp→Discord configurados.

### `/jidinfo`
Muestra los IDs de WhatsApp conocidos (PN `@s.whatsapp.net` y/o LID `@lid`) para un contacto, y si esos IDs están vinculados para notificaciones de mención.  
Uso: `/jidinfo contact:<número de teléfono o nombre de contacto guardado>`
Cómo encontrar PN/LID:
- Más fácil: ejecuta `/jidinfo contact:<nombre o número>` y busca las líneas marcadas `(PN)` y `(LID)`.
- Avanzado: abre `storage/contacts` y busca el nombre del contacto; las claves que terminan en `@s.whatsapp.net` son PN, las claves que terminan en `@lid` son LID.

---

## Adjuntos y Descargas

Valores predeterminados:

- Las descargas locales están deshabilitadas (`/localdownloads enabled:true` para activar).
- El directorio de descarga es `./downloads` y la limpieza automática está deshabilitada (`/setdownloadlimit`, `/setdownloadmaxage`, `/setdownloadminfree` tienen como valor predeterminado 0 = desactivado).
- El servidor de descarga local está deshabilitado; cuando se habilita, por defecto solo permite acceso local (enlace a `127.0.0.1`, URLs `localhost`, puerto `8080`).
- Los enlaces de descarga están firmados (persisten tras reinicios) y nunca expiran por defecto (`/setdownloadlinkttl seconds:0`).

Para que los enlaces de descarga sean accesibles desde otros dispositivos (teléfono/PC), generalmente quieres:

- `/setlocaldownloadserverbindhost host:0.0.0.0` (escuchar en todas las interfaces)
- `/setlocaldownloadserverhost host:<IP LAN o dominio>` (generar URLs que los destinatarios puedan alcanzar)
- Asegurarse de que el firewall/reenvío de puertos permita el puerto configurado (predeterminado `8080`)

### `/waupload`
Alterna si los adjuntos de Discord se suben a WhatsApp (vs enviar como enlaces).  
Uso: `/waupload enabled:<true|false>`

### `/localdownloads`
Controla si los adjuntos grandes de WhatsApp se descargan localmente cuando exceden el límite de subida de Discord.  
Uso: `/localdownloads enabled:<true|false>`

### `/getdownloadmessage`
Muestra la plantilla de notificación de descarga local actual.

### `/setdownloadmessage`
Actualiza la plantilla de notificación.  
Uso: `/setdownloadmessage message:"texto con {url}/{fileName}/..."`.

### `/getdownloaddir`
Muestra la carpeta utilizada para archivos descargados.

### `/setdownloaddir`
Cambia el directorio de descarga.  
Uso: `/setdownloaddir path:<carpeta>`

### `/setdownloadlimit`
Limita el tamaño del directorio de descarga (GB).  
Uso: `/setdownloadlimit size:<número>`

### `/setdownloadmaxage`
Elimina automáticamente los archivos descargados que superen la antigüedad indicada (en días).  
Uso: `/setdownloadmaxage days:<número>` (0 desactiva la eliminación automática basada en antigüedad)

### `/setdownloadminfree`
Mantiene al menos el espacio libre en disco dado (GB) limpiando descargas antiguas.  
Uso: `/setdownloadminfree gb:<número>` (0 desactiva la limpieza automática por espacio libre)

### `/setfilesizelimit`
Anula el límite de tamaño de subida de Discord utilizado para decidir cuándo descargar en lugar de volver a subir.  
Uso: `/setfilesizelimit bytes:<entero>`

### `/setdownloadlinkttl`
Establece el vencimiento del enlace de descarga local en segundos.  
Uso: `/setdownloadlinkttl seconds:<entero>` (0 = nunca expira)

### `/localdownloadserver`
Inicia/detiene el servidor HTTP(S) incorporado que sirve archivos descargados.  
Uso: `/localdownloadserver enabled:<true|false>`

### `/setlocaldownloadserverhost`
Configura el nombre de host utilizado en las URLs de descarga generadas.  
Uso: `/setlocaldownloadserverhost host:<valor>`

### `/setlocaldownloadserverbindhost`
Configura en qué interfaz escucha el servidor de descarga.  
Uso: `/setlocaldownloadserverbindhost host:<valor>` (ej., `127.0.0.1` o `0.0.0.0`)

### `/setlocaldownloadserverport`
Configura en qué puerto escucha el servidor de descarga.  
Uso: `/setlocaldownloadserverport port:<1-65535>`

### `/httpsdownloadserver`
Alterna HTTPS para el servidor de descarga (requiere certificados).  
Uso: `/httpsdownloadserver enabled:<true|false>`

### `/sethttpscert`
Establece las rutas de certificados TLS para el servidor de descarga.  
Uso: `/sethttpscert key_path:<archivo> cert_path:<archivo>`

---

## Comportamiento de Mensajes

### `/deletes`
Alterna las eliminaciones de mensajes reflejadas entre Discord y WhatsApp.  
Uso: `/deletes enabled:<true|false>`

### `/readreceipts`
Activa o desactiva las confirmaciones de lectura por completo.  
Uso: `/readreceipts enabled:<true|false>`

### `/dmreadreceipts`, `/publicreadreceipts`, `/reactionreadreceipts`
Elige el estilo de entrega cuando las confirmaciones de lectura están habilitadas (DM, respuesta corta de canal, o reacción ☑️).

### `/changenotifications`
Alterna las alertas de cambios de foto de perfil/estado y el reflejo de Estado de WhatsApp (historias) (publicadas en el canal `status@broadcast` / `#status`).  
Uso: `/changenotifications enabled:<true|false>`

### `/oneway`
Restringe el puente a una dirección o lo mantiene bidireccional.  
Uso: `/oneway direction:<discord|whatsapp|disabled>`

### `/redirectbots`
Permite o bloquea que los mensajes de bots de Discord se reenvíen a WhatsApp.  
Uso: `/redirectbots enabled:<true|false>`

### `/redirectwebhooks`
Permite o bloquea que los mensajes de webhook de Discord se reenvíen a WhatsApp.  
Uso: `/redirectwebhooks enabled:<true|false>`

### Indicadores de escritura (automáticos)
Cuando alguien comienza a escribir en un canal vinculado de Discord, WA2DC envía actualizaciones de presencia de WhatsApp (`composing` / `paused`) al chat vinculado para que tu cuenta de WhatsApp muestre "escribiendo…". Esto solo funciona cuando el puente Discord → WhatsApp está habilitado (bidireccional o `/oneway direction:whatsapp`). WhatsApp no puede indicar *qué* usuario de Discord está escribiendo—solo que la cuenta del puente lo está.

### `/publishing`
Alterna la publicación cruzada automática para mensajes enviados a canales de noticias de Discord.  
Uso: `/publishing enabled:<true|false>`

### `/ping`
Devuelve la latencia actual del bot.

---

## Mantenimiento y Configuración

### `/restart`
Guarda el estado de forma segura y reinicia el bot (requiere ejecutar a través del watchdog runner).  
Uso: `/restart` (solo canal de control)

### `/resync`
Vuelve a sincronizar los contactos/grupos de WhatsApp. Establece `rename:true` para renombrar los canales de Discord para que coincidan con los asuntos de WhatsApp.

### `/autosaveinterval`
Cambia la frecuencia con la que el bot persiste el estado (segundos).  
Uso: `/autosaveinterval seconds:<entero>`

### `/lastmessagestorage`
Limita cuántos mensajes de WhatsApp permanecen editables/eliminables desde Discord.  
Uso: `/lastmessagestorage size:<entero>`

### `/localdownloadserver`, `/setlocaldownloadserverhost`, `/setlocaldownloadserverbindhost`, `/setlocaldownloadserverport`, `/setdownloadlinkttl`, `/httpsdownloadserver`, `/sethttpscert`
Ver "Adjuntos y Descargas" arriba (listados aquí de nuevo para visibilidad).

---

## Gestión de Actualizaciones

> [!WARNING]
Comandos desactivados por defecto, disponibles solo para el administrador del bot

El canal de sala de control ahora muestra una tarjeta de actualización persistente con botones "Actualizar", "Omitir actualización" y "Revertir" que sobreviven a los reinicios. Estos botones activan los mismos comandos de barra que se enumeran a continuación.

### `/updatechannel`
Cambia entre los canales de lanzamiento estable e inestable.  
Uso: `/updatechannel channel:<stable|unstable>`

### `/checkupdate`
Verifica manualmente si hay actualizaciones en el canal activo.

### `/skipupdate`
Descarta la notificación de actualización actual sin instalar.

### `/update`
Descarga e instala el lanzamiento disponible (solo instalaciones empaquetadas). Las implementaciones de Docker/fuente serán recordadas de extraer y reiniciar manualmente.

### `/rollback`
Restaura el binario empaquetado anterior cuando uno está disponible. El botón dedicado "Revertir" solo aparece si existe una copia de seguridad.

---

¿Necesitas ayuda para recordar los nombres de los comandos? Escribe `/wa` dentro de Discord y deja que el cliente autocomplete cada comando de barra junto con sus opciones requeridas. Todos los comandos están autodocumentados a través de la interfaz de Discord, por lo que ya no tienes que memorizar formatos de texto heredados.
