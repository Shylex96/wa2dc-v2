const estado = {
  configuracion: {
    ListaBlanca: [],
    PrefijoTextoDiscord: null,
    PrefijoDiscord: false,
    PrefijoGrupoWA: false,
    SufijoPlataformaEmisorWA: false,
    SubirAdjuntos: true,
    Token: '',
    IDGuild: '',
    Categorias: [],
    IDCanalControl: '',
    DescargasLocales: false,
    MensajeDescargaLocal: 'Se descargó un archivo más grande que el límite de subida, revisalo en {url}',
    DirectorioDescargas: './downloads',
    LimiteGBDirectorioDescargas: 0,
    EdadMaximaDiasDirectorioDescargas: 0,
    EspacioMinimoGBDirectorioDescargas: 0,
    LimiteTamanoArchivoDiscord: 8 * 1024 * 1024,
    ServidorDescargaLocal: false,
    HostServidorDescargaLocal: 'localhost',
    HostBindServidorDescargaLocal: '127.0.0.1',
    PuertoServidorDescargaLocal: 8080,
    SecretoServidorDescargaLocal: '',
    TTLSegundosEnlaceDescargaLocal: 0,
    UsarHttps: false,
    RutaClaveHttps: '',
    RutaCertificadoHttps: '',
    Publicar: false,
    NotificacionesCambios: false,
    ReflejarEstadosWA: true,
    intervaloGuardadoAutomatico: 5 * 60,
    almacenamientoUltimoMensaje: 500,
    unaVía: 0b11,
    redirigirBots: true,
    redirigirWebhooks: false,
    EliminarMensajes: true,
    ConfirmacionesLectura: true,
    ModoConfirmacionLectura: 'public',
    CanalActualizacion: 'stable',
    MantenerBinarioAntiguo: true,
    MensajePromptActualizacion: null,
    MensajePromptReversion: null,
    DuracionSegundosFijado: 7 * 24 * 60 * 60,
    EnlacesMencionWhatsAppDiscord: {},
    OcultarNumerosTelefono: false,
    SalPrivacidad: '',
  },
  clienteDiscord: null,
  clienteWA: null,
  chats: {},
  contactos: {},
  tiempoInicio: 0,
  registrador: null,
  ultimosMensajes: null,
  /**
   * Almacena IDs de mensajes de WhatsApp que se originan de Discord para que
   * no sean devueltos a Discord cuando se reciben de WhatsApp.
   */
  mensajesEnviados: new Set(),
  /**
   * Rastrea reacciones de Discord que reflejan reacciones de WhatsApp para poder
   * actualizarlas o eliminarlas cuando los usuarios de WhatsApp cambian su reacción.
   * Estructura: { [idMensajeDiscord]: { [jidWA]: emoji } }
   */
  reacciones: {},
  /**
   * Almacena IDs de mensajes de WhatsApp para reacciones que se originan de Discord
   * para evitar devolverlas cuando WhatsApp envía eventos de confirmación.
   */
  reaccionesEnviadas: new Set(),
  /**
   * Rastrea acciones de fijado que iniciamos para evitar devolverlas cuando
   * WhatsApp emite eventos de fijado en chat.
   */
  fijadosEnviados: new Set(),
  ejecucionesGocc: {},
  informacionActualizacion: null,
  version: '',
  apagadoSolicitado: false,
};

export const settings = estado.configuracion;
export const dcClient = () => estado.clienteDiscord;
export const waClient = () => estado.clienteWA;
export const chats = estado.chats;
export const contacts = estado.contactos;
export const startTime = () => estado.tiempoInicio;
export const logger = () => estado.registrador;
export const lastMessages = () => estado.ultimosMensajes;
export const sentMessages = estado.mensajesEnviados;
export const reactions = estado.reacciones;
export const sentReactions = estado.reaccionesEnviadas;
export const sentPins = estado.fijadosEnviados;
export const goccRuns = estado.ejecucionesGocc;
export const updateInfo = () => estado.informacionActualizacion;
export const version = () => estado.version;

export default estado;
