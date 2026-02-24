# Preguntas Frecuentes

## ¿Qué es una lista blanca?
Una lista blanca permite recibir mensajes únicamente de las conversaciones que están incluidas en la lista. Una lista negra haría lo contrario, pero WhatsApp ya cuenta con esa función llamada bloqueo.

## ¿Puedo usar este bot en un servidor público?
No, este bot ha sido desarrollado específicamente para uso interno por nuestro equipo de desarrollo dentro de la empresa. No está diseñado para funcionar en servidores públicos. Si necesitas utilizarlo, primero debes consultarme (Esteban); de lo contrario, probablemente debas buscar otra alternativa que se ajuste a tus necesidades.

## Marcado como virus
Es posible que el bot sea marcado como virus. Microsoft SmartScreen también intenta prevenir que los usuarios ejecuten archivos de desarrolladores desconocidos. Un certificado de firma de código probablemente ayudaría, pero son costosos y, en mi opinión, no justifican su uso para un proyecto de este tipo. Si quieres asegurarte de que todo sea seguro, puedes hablar conmigo (Esteban) y clonar el repositorio para compilar tu propia versión del bot.

## Ping negativo o extremadamente alto
Esto se debe a la diferencia de tiempo entre los servidores de Discord y tu ordenador. Como el ping se mide en milisegundos, incluso pequeñas diferencias pueden generar un número muy alto o extraño. Esto se puede corregir, pero sincronizar la hora del sistema suele ser la solución más sencilla.

## El bot solo responde con `Unknown command type help...`
Esto se debe a los [Discord Intents](https://discord.com/developers/docs/topics/gateway#privileged-intents). Debes habilitar el intent de contenido de mensajes. Para ello, ve a [Discord Developer Portal](https://discord.com/developers/applications/) > Tu aplicación > Bot > Desplázate hacia abajo > habilita *"MESSAGE CONTENT INTENT"*.

## Perdí mi token de bot, ¿cómo generar uno nuevo?
Ve a [Discord Developer Portal](https://discord.com/developers/applications/) > Tu aplicación > Bot > Haz clic en *"Reset Token"*. Se emitirá un token nuevo. Simplemente cópialo y pégalo en el bot.

## ¿Dónde escribo los comandos?
Cuando invitas al bot, debería crear un canal de texto llamado `#sala-de-control`. Allí podrás usar todos los [comandos](commands.md).

## ¿Puedo alojar el bot en un servidor para que funcione 24/7?
Posiblemente, pero ten en cuenta que podrías ser baneado. En GitHub he visto dos casos ([#1](https://github.com/FKLC/WhatsAppToDiscord/issues/75#issuecomment-1179018481), [#2](https://github.com/FKLC/WhatsAppToDiscord/issues/88#issuecomment-1229547828)) de ejecución del bot en servidores, y aparentemente funciona, pero siempre hay que tener precaución.

## Enviar mensajes de voz en Discord
Hay 3 opciones que puedes usar:  
1. Puedes grabar usando el software integrado de tu ordenador y subirlo a Discord.  
2. Si usas Discord Web (en lugar del cliente de escritorio), tienes 2 opciones:  
   1. Usar la [extensión de Discord Voice Messages](https://chrome.google.com/webstore/detail/discord-voice-messages/emfegmjcadbmdcmdecepfkmhnenpnfip) y cambiar la extensión de los archivos a *"mp3"* en lugar de *"wav"*.  
   2. Usar la [Discord Voice Messages](https://github.com/magadan/discord-voice-messages-mp3), una versión modificada de la extensión anterior. Esta crea archivos *"mp3"* automáticamente en lugar de *"wav"*, evitando que tengas que renombrarlos cada vez. Su configuración es un poco más larga; debes construir e instalar la extensión siguiendo el archivo readme.

## ¿Puedo hacer un puente de llamadas de WhatsApp a Discord?
No. El protocolo WhatsApp Web utilizado por el bot no expone los flujos de audio o video en tiempo real de una llamada. Las llamadas entrantes y perdidas solo se envían como notificaciones a Discord, por lo que el bot no puede retransmitir ni recibir llamadas en vivo.

## ¿Es posible ejecutar en Docker?
Sí. Puedes construir la imagen manualmente o usar el `docker-compose.yml` proporcionado. Copia `.env.example` a `.env`, coloca tu token de Discord y ejecuta `docker compose up -d` para iniciar el contenedor.

## Cómo construir un ejecutable del programa
El bot se puede construir siguiendo estos pasos:  
1. Instala Node y NPM [aquí](https://nodejs.org/en/download).  
1. Instala Git [aquí](https://git-scm.com/downloads).  
1. Ejecuta los siguientes comandos para entrar en la carpeta del bot:  
   1. `cd WhatsAppToDiscord`  
1. Ejecuta `npm ci` para instalar las dependencias.  
1. Ejecuta `npm run build:bin` para empaquetar y generar un binario para tu OS/CPU actual (la salida va a `build/`).  
   - Test opcional: `npm run build:bin:smoke`.  
1. ¡Listo! Tendrás tu ejecutable en la carpeta `build`.