// ============================================================
// 1) CREDENCIALES: se guardan como propiedades del script (Apps Script > Configuración del proyecto >
//    Propiedades del script): VS_USUARIO, VS_CLAVE y, si hace falta, VS_TOKEN. No van en el código.
// ============================================================
function leerCredenciales_() {
  const props = PropertiesService.getScriptProperties();
  const usuario = String(props.getProperty('VS_USUARIO') || '').trim();
  const clave = String(props.getProperty('VS_CLAVE') || '');
  if (!usuario || !clave) {
    throw new Error('Faltan credenciales');
  }
  return { USUARIO: usuario, CLAVE: clave, TOKEN: String(props.getProperty('VS_TOKEN') || '') };
}

// ===== CONFIGURACIÓN =====
// Versión de este código (se sube con cada cambio y se anota en el mensaje del commit). La muestra la hoja "Control API" en la lista de archivos.
const VSR_VERSION = '2026-11-19.2';

const VSR_CONFIG = {
  LOGIN_HOST: 'https://virtualseller-1792.my.salesforce.com',
  API_VERSION: '59.0',
  HOJA_CONFIG: 'API',
  SUFIJO_TEMP: '_TEMP',
  TAMANO_LOTE: 2000,
  TIEMPO_MAX_MS: 270000,
  TIEMPO_POR_INFORME_MS: 120000,
  MAX_CELDAS_ARCHIVO: 9000000,
  LOCK_TIMEOUT_MS: 5000,
  MAX_EJECUCIONES_HORA: 300,
  PAUSA_CUPO_MS: 1800000,
  MAX_BYTES_JOB: 8500,
  // UrlFetchApp rechaza URL de más de 2 KB: las consultas más largas viajan en el cuerpo de un POST (recurso Composite).
  MAX_LARGO_URL: 1900,
  // "Forzar" sigue lanzando ejecuciones una tras otra hasta terminar los informes pendientes; tope de seguridad de ejecuciones seguidas.
  MAX_ENCADENADAS: 30,
  ENCABEZADOS_API: ['Reporte', 'SheetName', 'ExecTime', 'State', 'Dias', 'Desde', 'Hasta', 'Horarios',
                    'LastExecute', 'Estado', 'Filas', 'Mensaje', 'Llamadas ultima', 'Llamadas 24h', 'Llamadas 48h'],
  DIAS_GENERAL: 'L-D',
  DESDE_GENERAL: 0,
  HASTA_GENERAL: 24,
  FORMATO_FECHA: 'dd/MM/yyyy HH:mm:ss',
  FILAS_INICIALES: 100,
  MINUTOS_ACTIVADOR: 5,
  // Solo si el hijo tiene más de un lookup hacia el padre y el script no puede elegir solo.
  // Formato: 'ObjetoHijo|ObjetoPadre': 'NombreApiDelCampoLookup'. El error del informe lista los nombres posibles.
  RELACIONES_PADRE: {},
  // Un informe con ExecTime N se considera vencido N minutos menos esta tolerancia después de su última bajada.
  // Sin tolerancia, un ExecTime de 10 con activador cada 5 min terminaría corriendo cada 15 (la última bajada se anota al terminar).
  TOLERANCIA_MS: 150000,
  // Reintentos ante timeouts del servicio Hojas de cálculo (el archivo no responde a tiempo).
  REINTENTOS_SHEETS: 3,
  ESPERA_REINTENTO_MS: 3000,
  // Tras un timeout de Hojas, el informe que lo causó no se vuelve a intentar durante este tiempo (salvo que se fuerce a mano).
  PAUSA_TRAS_FALLA_SHEETS_MS: 1800000,
  // Tras un error de un informe (no cupo ni timeout de Hojas), no se reintenta durante este tiempo (salvo que se fuerce a mano).
  // Cada reintento gasta llamadas de API; sin esta espera un informe con error se reintentaría en cada ciclo de 5 minutos.
  PAUSA_TRAS_ERROR_MS: 1800000,
  // Tras detener una descarga a mano, el informe no se vuelve a bajar solo durante este tiempo (salvo que se fuerce). Para dejarlo
  // apagado del todo, poné State 0 en la hoja API.
  PAUSA_TRAS_DETENER_MS: 21600000,
  ERRORES_SHEETS_REINTENTABLES: ['tiempo de espera', 'timed out', 'Servicio no disponible', 'Service unavailable',
                                 'Service invoked too many times', 'temporalmente']
};

// Llamadas a la API de Salesforce hechas en esta ejecución (se cuentan todas, también las rechazadas).
let VSR_LLAMADAS_API = 0;

const VSR_PROP_JOB = 'JOB_';
const VSR_PROP_CONSUMO = 'CONS_';
const VSR_PROP_CADENA = 'CADENA_INMEDIATA';
const VSR_PROP_FORZADAS = 'FORZADAS_MANUAL';
const VSR_PROP_FALLA_SHEETS = 'FALLA_SHEETS_';
const VSR_PROP_ERROR_INFORME = 'ERROR_INFORME_';
const VSR_PROP_DETENIDO = 'DETENIDO_';
const VSR_PROP_PAUSA_API = 'PAUSA_API';
const VSR_PROP_PAUSA_INFORMES = 'PAUSA_INFORMES';
const VSR_PROP_EJECUCIONES = 'EJECUCIONES_INFORMES';
const VSR_ERR_LOGIN = 'LOGIN_RECHAZADO';
const VSR_ERR_API = 'CUPO_API';
const VSR_ERR_INFORMES = 'CUPO_INFORMES';
const VSR_DIA_MS = 24 * 60 * 60 * 1000;
const VSR_COLORES_ESTADO = {
  'EN_COLA': '#eeeeee',
  'EJECUTANDO': '#fff2cc',
  'EN_CURSO': '#cfe2f3',
  'COMPLETO': '#d9ead3',
  'COMPLETO CON DIFERENCIA': '#fce5cd',
  'EN_PAUSA': '#fce5cd',
  'INTERRUMPIDO': '#fce5cd',
  'DETENIDO': '#d9d9d9',
  'ERROR': '#f4cccc',
  'ERROR CONFIG': '#f4cccc',
  'ACTUALIZAR CLAVE': '#f4cccc'
};
const VSR_DIAS_LETRAS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const VSR_TIPOS_TEXTO = ['string', 'picklist', 'multipicklist', 'textarea', 'phone',
                     'email', 'url', 'id', 'reference', 'combobox'];
const VSR_TIPOS_NUMERO = ['double', 'int', 'long', 'currency', 'percent'];

// ===== MENÚ Y PUESTA EN MARCHA =====
// Los menús los arma un activador instalado "al abrir" (se crea solo: ver asegurarMenuReportes_). Este archivo NO declara
// "function onOpen", así que no pisa el onOpen del proyecto: los dos corren al abrir el Sheet, sin importar el orden de los archivos.
function menuReportes(e) {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('VirtualSeller')
    .addItem('Forzar ejecución...', 'forzarEjecucion')
    .addItem('Detener descargas en curso...', 'detenerDescargas')
    .addSeparator()
    .addItem('Crear hoja API', 'crearHojaAPI')
    .addItem('Crear activadores (despachador + vigía) cada ' + VSR_CONFIG.MINUTOS_ACTIVADOR + ' min', 'crearActivador')
    .addSeparator()
    .addItem('Quitar activadores (despachador + vigía)', 'killswitchQuitarActivadores')
    .addSeparator()
    .addSubMenu(ui.createMenu('Diagnóstico')
      .addItem('Revisar aptitud para incremental', 'revisarIncremental')
      .addSeparator()
      .addItem('Listar mis informes', 'listarMisInformes')
      .addItem('Revisar informes', 'revisarInformes')
      .addItem('Listar y revisar todo', 'revisarTodo')
      .addSeparator()
      .addItem('Ver cupo de API', 'verCupoApi')
      .addSeparator()
      .addItem('Ver informe (pide ID)', 'verInformeMenu')
      .addItem('Explorar objetos', 'explorarObjetos')
      .addItem('Explorar campos', 'explorarCampos'))
    .addToUi();

  // Compatibilidad: si un proyecto tiene su menú viejo renombrado a onOpenOriginal, se sigue ejecutando.
  if (typeof onOpenOriginal === 'function') {
    try {
      onOpenOriginal(e);
    } catch (err) {
      Logger.log('onOpenOriginal falló: ' + err.message);
    }
  }
}

// Crea (una sola vez) el activador instalado "al abrir" que ejecuta menuReportes. Lo llaman el vigía (cada 5 min) y crearActivador.
// Sin llamadas a Salesforce. Si no se puede crear, lo deja en el registro y reintenta en la próxima pasada.
function asegurarMenuReportes_() {
  try {
    const hay = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'menuReportes' && t.getEventType() === ScriptApp.EventType.ON_OPEN;
    });
    if (hay) return;
    ScriptApp.newTrigger('menuReportes').forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onOpen().create();
    Logger.log('Menú de Reportes: activador "al abrir" creado.');
  } catch (e) {
    Logger.log('Menú de Reportes: no se pudo crear el activador: ' + e.message);
  }
}

// Cuadro único: "Forzar TODOS" o tildar solo algunos informes de la lista.
// "Forzar" = borrar LastExecute y lanzar una ejecución inmediata del despachador.
function forzarEjecucion() {
  const tabla = leerTabla_(SpreadsheetApp.getActiveSpreadsheet());
  if (!tabla.filas.length) {
    SpreadsheetApp.getUi().alert('No hay informes en la hoja ' + VSR_CONFIG.HOJA_CONFIG + '.');
    return;
  }
  let items = '';
  tabla.filas.forEach(function (f) {
    items += '<label><input type="checkbox" class="it" value="' + f.fila + '"> ' + escHtml_(f.hoja || '(sin SheetName)') +
             ' <small>' + escHtml_(f.id) + (f.activo ? '' : ' - State 0') + '</small></label>';
  });
  const avisoOff = '<div style="margin-bottom:8px;color:#555">Forzar descarga los informes elegidos aunque estén en State 0 o el Control API esté en OFF.</div>';
  const html =
    '<style>body{font-family:Arial,sans-serif;font-size:13px;margin:12px}' +
    '#lista{max-height:320px;overflow:auto;border:1px solid #ccc;padding:6px;margin-top:6px}' +
    '#lista.apagada{opacity:.45}label{display:block;padding:3px 0}.off{color:#999}' +
    'button{margin-top:10px;padding:6px 14px}#err{color:#b00;margin-top:8px}</style>' +
    avisoOff +
    '<label><b><input type="checkbox" id="todos"> Forzar TODOS los informes</b></label>' +
    '<div style="margin-top:8px">O tildá solo los que quieras forzar:</div>' +
    '<div id="lista">' + items + '</div>' +
    '<button id="ok">Forzar</button> ' +
    '<button onclick="google.script.host.close()">Cancelar</button><div id="err"></div>' +
    '<script>' +
    'var its=document.querySelectorAll(".it"),todos=document.getElementById("todos"),lista=document.getElementById("lista");' +
    'todos.onchange=function(){lista.className=todos.checked?"apagada":"";' +
    'for(var i=0;i<its.length;i++){if(!its[i].hasAttribute("data-off")){its[i].disabled=todos.checked;if(todos.checked)its[i].checked=false;}}};' +
    'document.getElementById("ok").onclick=function(){var sel=[];' +
    'for(var i=0;i<its.length;i++){if(its[i].checked)sel.push(Number(its[i].value));}' +
    'if(!todos.checked&&!sel.length){document.getElementById("err").textContent="Tildá \'Forzar TODOS\' o elegí al menos un informe.";return;}' +
    'this.disabled=true;' +
    'google.script.run.withSuccessHandler(function(){google.script.host.close();})' +
    '.withFailureHandler(function(e){document.getElementById("err").textContent=e.message;document.getElementById("ok").disabled=false;})' +
    '.forzarSeleccion(todos.checked,sel);};' +
    '</script>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(460).setHeight(540), 'Forzar ejecución');
}

// ===== DETENER DESCARGAS EN CURSO =====
// Para frenar un informe muy grande que sigue bajando. Descarta su progreso (propiedad JOB_) y la hoja temporal; la hoja destino
// queda como estaba (la descarga solo la reemplaza al terminar). El informe no se vuelve a bajar solo durante
// PAUSA_TRAS_DETENER_MS, salvo que se fuerce.
function detenerDescargas() {
  const tabla = leerTabla_(SpreadsheetApp.getActiveSpreadsheet());
  const props = PropertiesService.getScriptProperties();
  const enCurso = tabla.filas.filter(function (f) {
    return ['EN_CURSO', 'EN_COLA', 'EJECUTANDO', 'EN_PAUSA'].indexOf(f.estado) !== -1 || !!props.getProperty(VSR_PROP_JOB + claveJob_(f));
  });
  if (!enCurso.length) {
    SpreadsheetApp.getUi().alert('No hay descargas en curso.');
    return;
  }
  let items = '';
  enCurso.forEach(function (f) {
    items += '<label><input type="checkbox" class="it" value="' + f.fila + '"> ' + escHtml_(f.hoja || '(sin SheetName)') +
             ' <small>' + escHtml_(f.estado) + '</small></label>';
  });
  const html =
    '<style>body{font-family:Arial,sans-serif;font-size:13px;margin:12px}' +
    '#lista{max-height:300px;overflow:auto;border:1px solid #ccc;padding:6px;margin-top:6px}' +
    'label{display:block;padding:3px 0}button{margin-top:10px;padding:6px 14px}#err{color:#b00;margin-top:8px}</style>' +
    '<div style="color:#555;margin-bottom:8px">Elegí las descargas a detener. La hoja destino queda con los datos anteriores; ' +
    'el informe no se baja solo por ' + (VSR_CONFIG.PAUSA_TRAS_DETENER_MS / 3600000) + ' h (o hasta que lo fuerces).</div>' +
    '<label><b><input type="checkbox" id="todos"> Detener TODAS</b></label>' +
    '<div id="lista">' + items + '</div>' +
    '<button id="ok">Detener</button> <button onclick="google.script.host.close()">Cancelar</button><div id="err"></div>' +
    '<script>' +
    'var its=document.querySelectorAll(".it"),todos=document.getElementById("todos");' +
    'todos.onchange=function(){for(var i=0;i<its.length;i++){its[i].checked=todos.checked;}};' +
    'document.getElementById("ok").onclick=function(){var sel=[];' +
    'for(var i=0;i<its.length;i++){if(its[i].checked)sel.push(Number(its[i].value));}' +
    'if(!sel.length){document.getElementById("err").textContent="Elegí al menos una descarga.";return;}' +
    'this.disabled=true;' +
    'google.script.run.withSuccessHandler(function(){google.script.host.close();})' +
    '.withFailureHandler(function(e){document.getElementById("err").textContent=e.message;document.getElementById("ok").disabled=false;})' +
    '.detenerSeleccion(sel);};' +
    '</script>';
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(460).setHeight(480), 'Detener descargas en curso');
}

// Llamada desde el cuadro. Primero marca los informes como detenidos (lo ve de inmediato una descarga que esté corriendo,
// que se frena al terminar su lote actual); si no hay ninguna corriendo, limpia en el acto.
function detenerSeleccion(filasElegidas) {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let tabla = leerTabla_(ss);
  const elegidos = tabla.filas.filter(function (f) { return filasElegidas.indexOf(f.fila) !== -1; });
  elegidos.forEach(function (f) { props.setProperty(VSR_PROP_DETENIDO + claveJob_(f), String(Date.now())); });
  guardarForzadas_(forzadasGuardadas_().filter(function (c) {
    return !elegidos.some(function (f) { return claveJob_(f) === c; });
  }));
  props.deleteProperty(VSR_PROP_CADENA);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    Logger.log('Detener: hay una descarga corriendo; se frena sola al terminar su lote actual.');
    return;
  }
  try {
    tabla = leerTabla_(ss);
    elegidos.forEach(function (f) {
      const actual = tabla.filas.filter(function (x) { return x.fila === f.fila; })[0] || f;
      cancelarDescarga_(tabla, actual);
    });
  } finally {
    lock.releaseLock();
  }
}

function cancelarDescarga_(tabla, f) {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(VSR_PROP_JOB + claveJob_(f));
  try {
    const ss = abrirArchivo_(f.archivo);
    const temp = ss.getSheetByName(f.hoja + VSR_CONFIG.SUFIJO_TEMP);
    if (temp) ss.deleteSheet(temp);
  } catch (e) {
    Logger.log('Detener: no se pudo borrar la hoja temporal de ' + f.hoja + ': ' + e.message);
  }
  escribirEstado_(tabla, f, 'DETENIDO', null, 'Detenido a mano. No se baja solo por ' +
                  (VSR_CONFIG.PAUSA_TRAS_DETENER_MS / 3600000) + ' h (o hasta que lo fuerces).');
  Logger.log('Descarga detenida: ' + f.id + ' (' + f.hoja + ').');
}

function detenidoDesde_(f) {
  const ms = Number(PropertiesService.getScriptProperties().getProperty(VSR_PROP_DETENIDO + claveJob_(f))) || 0;
  return ms && ms + VSR_CONFIG.PAUSA_TRAS_DETENER_MS > Date.now() ? ms : 0;
}

// Llamada desde el cuadro: todos = true fuerza todos; si no, solo las filas elegidas.
function forzarSeleccion(todos, filasElegidas) {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(VSR_PROP_CADENA);
  // Forzar es una orden manual: se descarta una pausa vieja por cupo y se intenta ya. Si Salesforce vuelve a rechazar, se pausa de nuevo sola.
  props.deleteProperty(VSR_PROP_PAUSA_API);
  props.deleteProperty(VSR_PROP_PAUSA_INFORMES);
  limpiarFechas_(todos ? null : filasElegidas);
  programarEjecucionInmediata_();
}

// Deja un activador de una sola vez que lanza el despachador en cuanto Google lo ejecuta (unos segundos o poco más de un minuto).
function programarEjecucionInmediata_() {
  const yaHay = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'despachadorInmediato';
  });
  if (!yaHay) ScriptApp.newTrigger('despachadorInmediato').timeBased().after(1000).create();
}

// Lo llama el activador de una sola vez: se borra a sí mismo y corre el despachador.
function despachadorInmediato() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'despachadorInmediato') ScriptApp.deleteTrigger(t);
  });
  despachador();
  continuarCadena_();
}

// Después de una ejecución forzada: si quedan informes a medias (EN_CURSO) o en cola (EN_COLA), programa otra ejecución
// inmediata para que "Forzar" termine todo sin tener que volver a forzar. Se corta solo ante una pausa por límite de API
// o al llegar a CONFIG.MAX_ENCADENADAS ejecuciones seguidas.
function continuarCadena_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const n = Number(props.getProperty(VSR_PROP_CADENA) || 0) + 1;
    props.setProperty(VSR_PROP_CADENA, String(n));
    if (n >= VSR_CONFIG.MAX_ENCADENADAS) {
      Logger.log('Forzar: se llegó al tope de ' + VSR_CONFIG.MAX_ENCADENADAS + ' ejecuciones seguidas; sigue el activador normal.');
      return;
    }
    if (pausaActiva_(VSR_PROP_PAUSA_API)) return;
    const tabla = leerTabla_(SpreadsheetApp.getActiveSpreadsheet());
    const bloqueado = capiBloqueado_();
    const pendientes = forzadasPendientes_(tabla);
    const quedan = tabla.filas.some(function (f) {
      const cuenta = pendientes.indexOf(claveJob_(f)) !== -1 || (!bloqueado && f.activo);
      return cuenta && (f.estado === 'EN_CURSO' || f.estado === 'EN_COLA');
    });
    if (quedan) programarEjecucionInmediata_();
  } catch (e) {
    Logger.log('No se pudo encadenar la siguiente ejecución: ' + e.message);
  }
}

// ===== FORZADO MANUAL CON EL CONTROL API EN OFF =====
// "Forzar" es una orden manual: baja el informe elegido sin mirar el State ni el Control API. Los informes forzados se
// anotan en la propiedad FORZADAS_MANUAL; despachador() los procesa siempre, y con el interruptor en OFF procesa SOLO esos.
function forzadasGuardadas_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(VSR_PROP_FORZADAS) || '[]'); } catch (e) { return []; }
}

function guardarForzadas_(claves) {
  const props = PropertiesService.getScriptProperties();
  if (claves.length) props.setProperty(VSR_PROP_FORZADAS, JSON.stringify(claves));
  else props.deleteProperty(VSR_PROP_FORZADAS);
}

// Forzados que siguen pendientes: con descarga a medias, o sin LastExecute y sin haber terminado en error.
function forzadasPendientes_(tabla) {
  const guardadas = forzadasGuardadas_();
  if (!guardadas.length) return [];
  const props = PropertiesService.getScriptProperties();
  return tabla.filas.filter(function (f) {
    if (guardadas.indexOf(claveJob_(f)) === -1) return false;
    if (props.getProperty(VSR_PROP_JOB + claveJob_(f))) return true;
    return f.ultima === null && f.estado.indexOf('ERROR') !== 0 && f.estado !== 'ACTUALIZAR CLAVE';
  }).map(function (f) { return claveJob_(f); });
}

// Deja en la propiedad solo los forzados pendientes (los terminados o con error se sacan).
function depurarForzadas_() {
  try {
    if (!forzadasGuardadas_().length) return;
    guardarForzadas_(forzadasPendientes_(leerTabla_(SpreadsheetApp.getActiveSpreadsheet())));
  } catch (e) {
    Logger.log('No se pudo depurar la lista de forzados: ' + e.message);
  }
}

function limpiarFechas_(filasElegidas) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(VSR_CONFIG.LOCK_TIMEOUT_MS)) {
    throw new Error('Hay una ejecución en curso; intentá de nuevo en un momento.');
  }
  try {
    const tabla = leerTabla_(SpreadsheetApp.getActiveSpreadsheet());
    const forzadas = [];
    const marcar = function (f) {
      if (!f.hoja) return;   // sin SheetName no hay destino
      PropertiesService.getScriptProperties().deleteProperty(VSR_PROP_DETENIDO + claveJob_(f));
      escribirEstado_(tabla, f, 'EN_COLA', null, 'Forzado: se inicia en breve.');
      forzadas.push(claveJob_(f));
    };
    if (filasElegidas === null) {
      tabla.hoja.getRange(2, tabla.cols.lastexecute, Math.max(tabla.hoja.getLastRow() - 1, 1), 1).clearContent();
      tabla.filas.forEach(marcar);
      guardarForzadas_(forzadas);
      Logger.log('LastExecute borrado en todos los informes.');
      return;
    }
    let n = 0;
    filasElegidas.forEach(function (fila) {
      const f = tabla.filas.filter(function (x) { return x.fila === Number(fila); })[0];
      if (f) {
        tabla.hoja.getRange(f.fila, tabla.cols.lastexecute).clearContent();
        marcar(f);
        n++;
      }
    });
    guardarForzadas_(forzadas);
    Logger.log('LastExecute borrado en ' + n + ' informe(s).');
  } finally {
    lock.releaseLock();
  }
}

function escHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// DESINSTALAR: borra los activadores de los informes (despachador, despachadorInmediato, reanudarDescarga,
// revisarInformes, explorarObjetos) y el vigía del Control API (capiVigia). Van juntos, igual que al crearlos.
// No toca otros activadores, la hoja ni las propiedades. Para volver a arrancar: menú "Crear activadores".
function killswitchQuitarActivadores() {
  const handlers = ['despachador', 'despachadorInmediato', 'reanudarDescarga', 'revisarInformes', 'explorarObjetos', 'capiVigia'];
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  Logger.log('Activadores quitados (despachador + vigía): ' + n + '.');
}

// Crea (o recrea) los dos activadores, que van juntos: despachador (descarga) y vigía del Control API.
function crearActivador() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const f = t.getHandlerFunction();
    if (f === 'despachador' || f === 'reanudarDescarga' || f === 'despachadorInmediato') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('despachador').timeBased().everyMinutes(VSR_CONFIG.MINUTOS_ACTIVADOR).create();
  Logger.log('Activador creado: despachador cada ' + VSR_CONFIG.MINUTOS_ACTIVADOR + ' minutos.');
  capiAsegurarVigia_();
  asegurarMenuReportes_();
}

// Crea la hoja API y deja las columnas en el orden de CONFIG.ENCABEZADOS_API.
// Si ya existe, no pierde datos: inserta las columnas que falten y mueve las que estén fuera de lugar.
// Al final también crea (o recrea) los activadores.
function crearHojaAPI() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let hoja = ss.getSheetByName(VSR_CONFIG.HOJA_CONFIG);
  if (!hoja) hoja = ss.insertSheet(VSR_CONFIG.HOJA_CONFIG);

  const leerEncabezados = function () {
    return hoja.getRange(1, 1, 1, Math.max(hoja.getLastColumn(), 1)).getValues()[0]
      .map(function (h) { return String(h).trim().toLowerCase(); });
  };

  VSR_CONFIG.ENCABEZADOS_API.forEach(function (nombre, i) {
    const destino = i + 1;
    const actual = leerEncabezados().indexOf(nombre.toLowerCase()) + 1;
    if (actual === 0) {
      if (destino <= hoja.getLastColumn()) hoja.insertColumnBefore(destino);
      hoja.getRange(1, destino).setValue(nombre);
    } else if (actual !== destino) {
      hoja.moveColumns(hoja.getRange(1, actual, hoja.getMaxRows(), 1), destino);
    }
  });

  const encabezados = leerEncabezados();
  hoja.getRange(1, 1, 1, hoja.getLastColumn()).setFontWeight('bold');
  hoja.setFrozenRows(1);
  const colFecha = encabezados.indexOf('lastexecute') + 1;
  if (colFecha > 0) {
    hoja.getRange(2, colFecha, VSR_CONFIG.FILAS_INICIALES, 1).setNumberFormat(VSR_CONFIG.FORMATO_FECHA);
  }
  ['dias', 'horarios'].forEach(function (n) {
    const col = encabezados.indexOf(n) + 1;
    if (col > 0) hoja.getRange(2, col, VSR_CONFIG.FILAS_INICIALES, 1).setNumberFormat('@');
  });
  const colState = encabezados.indexOf('state') + 1;
  if (colState > 0) {
    hoja.getRange(2, colState, VSR_CONFIG.FILAS_INICIALES, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['0', '1'], true).setAllowInvalid(false).build());
  }

  crearActivador();
}

// ===== PUNTO DE ENTRADA (activador cada 5 minutos) =====
function despachador() {
  capiAsegurarVigia_();
  // Control API (segunda barrera): solo frena con un OFF leído; si no se puede leer, sigue. Sin llamadas a Salesforce.
  // En OFF solo sigue adelante si hay informes forzados a mano (el forzado es una orden manual y se respeta).
  const bloqueado = capiBloqueado_();
  if (bloqueado && !forzadasGuardadas_().length) {
    Logger.log('Control API en OFF; se omite este ciclo.');
    return;
  }
  const inicio = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(VSR_CONFIG.LOCK_TIMEOUT_MS)) {
    Logger.log('Hay otra ejecución en curso; se omite este ciclo.');
    return;
  }
  try {
    if (pausaActiva_(VSR_PROP_PAUSA_API)) {
      Logger.log('Pausa por límite de API de Salesforce; se omite este ciclo.');
      return;
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tabla = leerTabla_(ss);
    // Detenidos a mano mientras había otra ejecución corriendo: se termina de limpiar acá.
    tabla.filas.forEach(function (f) {
      if (detenidoDesde_(f) && (f.estado === 'EN_CURSO' || f.estado === 'EN_COLA' || f.estado === 'EN_PAUSA' ||
          f.estado === 'EJECUTANDO' || PropertiesService.getScriptProperties().getProperty(VSR_PROP_JOB + claveJob_(f)))) {
        cancelarDescarga_(tabla, f);
        f.estado = 'DETENIDO';
      }
    });
    tabla.filas.forEach(function (f) {
      if (f.estado === 'EJECUTANDO') {
        const hasta = fallaSheetsHasta_(f);
        escribirEstado_(tabla, f, 'INTERRUMPIDO', null, hasta
          ? 'Hojas de cálculo no respondió; se reintenta después de las ' +
            Utilities.formatDate(new Date(hasta), Session.getScriptTimeZone(), 'HH:mm') + '.'
          : 'La ejecución anterior se cortó; se reintenta.');
      }
    });
    const forzadas = forzadasPendientes_(tabla);
    if (bloqueado && !forzadas.length) {
      Logger.log('Control API en OFF y sin informes forzados pendientes; se omite este ciclo.');
      depurarForzadas_();
      return;
    }
    if (forzadas.length) {
      Logger.log('Forzados a mano pendientes: ' + forzadas.length +
                 (bloqueado ? ' (Control API en OFF: se descargan solo esos).' : '.'));
    }
    const turno = elegirInformes_(tabla, forzadas, bloqueado);
    if (!turno.length) {
      Logger.log('Nada para descargar en este ciclo.');
      depurarForzadas_();
      return;
    }
    Logger.log(turno.length + ' informe(s) para este ciclo.');
    turno.forEach(function (f) {
      if (f.estado !== 'EN_CURSO') escribirEstado_(tabla, f, 'EN_COLA', null, 'En cola para este ciclo.');
    });

    const sesion = abrirSesion_(tabla, turno);
    if (!sesion) return;
    const props = PropertiesService.getScriptProperties();
    const consumo = [];

    for (let i = 0; i < turno.length; i++) {
      if (Date.now() - inicio >= VSR_CONFIG.TIEMPO_MAX_MS) {
        Logger.log('Se agotó el tiempo del ciclo; el resto sigue en el próximo.');
        break;
      }
      const f = turno[i];
      if (detenidoDesde_(f) && forzadas.indexOf(claveJob_(f)) === -1) continue;
      const limite = Math.min(inicio + VSR_CONFIG.TIEMPO_MAX_MS,
                              Date.now() + VSR_CONFIG.TIEMPO_POR_INFORME_MS);
      const llamadasAntes = VSR_LLAMADAS_API;
      let resultado = 'OK';
      try {
        escribirEstado_(tabla, f, 'EJECUTANDO', null, 'Iniciando descarga...');
        procesarInforme_(sesion, tabla, f, limite);
      } catch (e) {
        const job = leerJob_(f);
        const escritas = job ? job.escritas : 0;
        if (e.message.indexOf(VSR_ERR_API) === 0) {
          resultado = 'PAUSA API';
          Logger.log('Límite de API de Salesforce alcanzado; pausa de ' +
                     (VSR_CONFIG.PAUSA_CUPO_MS / 60000) + ' min. ' + e.message);
          escribirEstado_(tabla, f, 'EN_PAUSA', escritas, 'Límite de API de Salesforce; reintenta solo');
          break;
        }
        if (e.message.indexOf(VSR_ERR_INFORMES) === 0) {
          resultado = 'PAUSA INFORMES';
          Logger.log('Cupo de ejecuciones de informes agotado para ' + f.id + ': ' + e.message);
          escribirEstado_(tabla, f, 'EN_PAUSA', escritas, 'Cupo de informes de Salesforce; reintenta solo');
          continue;
        }
        if (esTimeoutSheets_(e)) {
          // Después del primer timeout todas las llamadas a Hojas de esta ejecución fallan: se corta el ciclo (sin tocar la hoja)
          // y el informe queda en pausa; el próximo ciclo arranca limpio con los demás.
          resultado = 'TIMEOUT HOJAS';
          props.setProperty(VSR_PROP_FALLA_SHEETS + claveJob_(f), String(Date.now()));
          Logger.log('Hojas de cálculo no respondió en ' + f.id + ' (' + f.hoja + '), paso "' + (e.pasoSheets || '?') +
                     '". Se corta el ciclo; ese informe queda en pausa ' +
                     (VSR_CONFIG.PAUSA_TRAS_FALLA_SHEETS_MS / 60000) + ' min.');
          break;
        }
        resultado = 'ERROR';
        props.setProperty(VSR_PROP_ERROR_INFORME + claveJob_(f), String(Date.now()));
        Logger.log('ERROR en ' + f.id + ' (' + f.hoja + '): ' + e.message + ' Se reintenta en ' +
                   (VSR_CONFIG.PAUSA_TRAS_ERROR_MS / 60000) + ' min (o al forzarlo).');
        escribirEstado_(tabla, f, 'ERROR', escritas, e.message);
        props.deleteProperty(VSR_PROP_JOB + claveJob_(f));
      } finally {
        const usadas = VSR_LLAMADAS_API - llamadasAntes;
        if (usadas > 0) consumo.push({ f: f, usadas: usadas });
      }
    }
    registrarConsumo_(tabla, consumo);
    depurarForzadas_();
  } finally {
    lock.releaseLock();
  }
}

// ===== LECTURA DE LA TABLA DE CONFIGURACIÓN =====
function leerTabla_(ss) {
  const hoja = ss.getSheetByName(VSR_CONFIG.HOJA_CONFIG);
  if (!hoja) throw new Error('No existe la pestaña de configuración: ' + VSR_CONFIG.HOJA_CONFIG);

  const encabezados = hoja.getRange(1, 1, 1, Math.max(hoja.getLastColumn(), 1)).getValues()[0];
  const cols = {};
  encabezados.forEach(function (h, i) { cols[String(h).trim().toLowerCase()] = i + 1; });
  ['reporte', 'sheetname', 'exectime', 'state', 'lastexecute'].forEach(function (n) {
    if (!cols[n]) throw new Error('Falta la columna "' + n + '" en la pestaña ' + VSR_CONFIG.HOJA_CONFIG);
  });

  let siguiente = hoja.getLastColumn() + 1;
  [['estado', 'Estado'], ['filas', 'Filas'], ['mensaje', 'Mensaje'],
   ['llamadas ultima', 'Llamadas ultima'], ['llamadas 24h', 'Llamadas 24h'], ['llamadas 48h', 'Llamadas 48h']].forEach(function (par) {
    if (!cols[par[0]]) {
      hoja.getRange(1, siguiente).setValue(par[1]);
      cols[par[0]] = siguiente;
      siguiente++;
    }
  });

  const filas = [];
  const ultimaFila = hoja.getLastRow();
  if (ultimaFila >= 2) {
    const datos = hoja.getRange(2, 1, ultimaFila - 1, hoja.getLastColumn()).getValues();
    datos.forEach(function (d, i) {
      const id = String(d[cols.reporte - 1]).trim();
      if (!id) return;
      filas.push({
        fila: i + 2,
        id: id,
        hoja: String(d[cols.sheetname - 1]).trim(),
        minutos: Number(d[cols.exectime - 1]),
        unaVez: String(d[cols.exectime - 1]).trim() === '0',   // ExecTime = 0 escrito: se baja una sola vez
        activo: Number(d[cols.state - 1]) === 1,
        ultima: aFecha_(d[cols.lastexecute - 1]),
        archivo: cols.spreadsheetid ? String(d[cols.spreadsheetid - 1]).trim() : '',
        estado: cols.estado ? String(d[cols.estado - 1]).trim() : '',
        dias: cols.dias ? String(d[cols.dias - 1]).trim() : '',
        desde: cols.desde ? d[cols.desde - 1] : '',
        hasta: cols.hasta ? d[cols.hasta - 1] : '',
        horarios: cols.horarios ? d[cols.horarios - 1] : ''
      });
    });
  }
  return { hoja: hoja, cols: cols, filas: filas };
}

function aFecha_(valor) {
  if (valor instanceof Date) return isNaN(valor.getTime()) ? null : valor.getTime();
  if (typeof valor === 'string' && valor.trim() !== '') {
    const ms = Date.parse(valor);
    return isNaN(ms) ? null : ms;
  }
  return null;
}

// forzadas: claves forzadas a mano; se bajan siempre, sin mirar State ni calendario. soloForzadas = true (Control API en OFF):
// no se elige ningún otro informe.
function elegirInformes_(tabla, forzadas, soloForzadas) {
  const ahora = Date.now();
  const reloj = relojActual_();
  const props = PropertiesService.getScriptProperties();
  const elegidas = [];

  tabla.filas.forEach(function (f) {
    const forzada = forzadas.indexOf(claveJob_(f)) !== -1;
    if (!forzada && (soloForzadas || !f.activo)) return;
    if (!f.hoja) {
      Logger.log('Fila ' + f.fila + ' ignorada: falta SheetName.');
      return;
    }
    if (!forzada && detenidoDesde_(f)) return;   // detenido a mano
    if (!forzada && errorHasta_(f)) {
      Logger.log('Fila ' + f.fila + ' con error reciente; se reintenta después de las ' +
                 Utilities.formatDate(new Date(errorHasta_(f)), Session.getScriptTimeZone(), 'HH:mm') + '.');
      return;
    }
    if (!forzada && fallaSheetsHasta_(f)) {
      Logger.log('Fila ' + f.fila + ' en pausa por timeout de Hojas de cálculo; se omite en este ciclo.');
      return;
    }
    if (forzada || props.getProperty(VSR_PROP_JOB + claveJob_(f)) || f.estado === 'ACTUALIZAR CLAVE') {
      elegidas.push(f);   // forzado a mano, descarga a medias, o informe reactivado tras cambiar la clave: se baja ya
      return;
    }
    try {
      if (tocaEjecutar_(f, ahora, reloj)) elegidas.push(f);
    } catch (e) {
      Logger.log('Fila ' + f.fila + ' ignorada: ' + e.message);
      escribirEstado_(tabla, f, 'ERROR CONFIG', 0, e.message);
    }
  });
  // Los más atrasados primero (los que nunca bajaron, antes que todos): así ninguno queda al final de la hoja sin turno.
  // Los que quedaron en ERROR van al final: un informe que falla siempre no puede frenar a los demás.
  elegidas.sort(function (a, b) {
    const ea = a.estado === 'ERROR' ? 1 : 0;
    const eb = b.estado === 'ERROR' ? 1 : 0;
    if (ea !== eb) return ea - eb;
    return (a.ultima === null ? 0 : a.ultima) - (b.ultima === null ? 0 : b.ultima);
  });
  return elegidas;
}

// ===== CALENDARIO: DÍAS, FRANJAS Y HORARIOS FIJOS =====
function relojActual_() {
  const tz = Session.getScriptTimeZone();
  const d = new Date();
  const fmt = function (p) { return Utilities.formatDate(d, tz, p); };
  const ymd = fmt('yyyy-MM-dd').split('-');
  return {
    dia: Number(fmt('u')),
    hora: Number(fmt('H')) + Number(fmt('m')) / 60,
    inicioDia: new Date(Number(ymd[0]), Number(ymd[1]) - 1, Number(ymd[2])).getTime()
  };
}

// Decide si un informe debe bajarse ahora. Lanza error si la configuración de la fila es inválida.
// ExecTime = 0 (escrito, no vacío) y sin Horarios: se baja una sola vez (mientras LastExecute esté vacío).
function tocaEjecutar_(f, ahora, reloj) {
  const dias = parsearDias_(f.dias) || parsearDias_(VSR_CONFIG.DIAS_GENERAL);
  const horarios = parsearHorarios_(f.horarios);
  if (f.unaVez && !horarios.length) return f.ultima === null;
  if (!horarios.length && !(f.minutos > 0)) {
    throw new Error('Falta ExecTime (o Horarios) en la fila ' + f.fila + '.');
  }
  let desde = parsearHora_(f.desde, 'Desde');
  let hasta = parsearHora_(f.hasta, 'Hasta');
  if (desde === null) desde = VSR_CONFIG.DESDE_GENERAL;
  if (hasta === null) hasta = VSR_CONFIG.HASTA_GENERAL;

  if (f.ultima === null) return true;          // nunca bajó o se forzó: baja ya
  if (!dias[reloj.dia]) return false;

  if (horarios.length) {                       // horarios fijos: ignora ExecTime, Desde y Hasta
    let programado = null;
    horarios.forEach(function (h) { if (h <= reloj.hora) programado = h; });
    if (programado === null) return false;
    return f.ultima < reloj.inicioDia + programado * 3600000;
  }
  if (!enFranja_(reloj.hora, desde, hasta)) return false;
  return ahora - f.ultima >= f.minutos * 60000 - VSR_CONFIG.TOLERANCIA_MS;
}

function enFranja_(hora, desde, hasta) {
  if (desde === hasta) return true;
  if (desde < hasta) return hora >= desde && hora < hasta;
  return hora >= desde || hora < hasta;        // franja que cruza la medianoche (ej. 22 a 6)
}

// "L-S", "L,X,V", "S-L" (cruza el fin de semana). Vacío = null (se usa DIAS_GENERAL).
function parsearDias_(texto) {
  const t = String(texto === null || texto === undefined ? '' : texto).toUpperCase().replace(/\s+/g, '');
  if (t === '') return null;
  const set = {};
  t.split(',').forEach(function (parte) {
    if (!parte) return;
    const m = /^([LMXJVSD])(?:-([LMXJVSD]))?$/.exec(parte);
    if (!m) {
      throw new Error('Dias inválido: "' + texto + '". Usá L,M,X,J,V,S,D (ej: L-S o L,X,V).');
    }
    let i = VSR_DIAS_LETRAS.indexOf(m[1]);
    const fin = VSR_DIAS_LETRAS.indexOf(m[2] || m[1]);
    for (let k = 0; k < 7; k++) {
      set[i + 1] = true;
      if (i === fin) break;
      i = (i + 1) % 7;
    }
  });
  if (!Object.keys(set).length) throw new Error('Dias inválido: "' + texto + '".');
  return set;
}

// Acepta número (8, 8.5) o texto ("8", "08:30"). Vacío = null.
function parsearHora_(valor, nombre) {
  if (valor === '' || valor === null || valor === undefined) return null;
  if (valor instanceof Date) {
    throw new Error(nombre + ': escribilo como número (8) o texto (08:30), no como hora de celda.');
  }
  if (typeof valor === 'number') {
    if (valor < 0 || valor > 24) throw new Error(nombre + ' fuera de rango (0 a 24): ' + valor);
    return valor;
  }
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(valor).trim());
  if (!m || (m[2] && Number(m[2]) > 59)) throw new Error(nombre + ' inválido: "' + valor + '".');
  const h = Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0);
  if (h > 24) throw new Error(nombre + ' fuera de rango (0 a 24): ' + valor);
  return h;
}

// "09:00-18:00", "5-15" o "09:00, 18:00" -> [9, 18]. Separador: guion, coma o punto y coma. Vacío -> [].
function parsearHorarios_(valor) {
  if (valor === '' || valor === null || valor === undefined) return [];
  if (valor instanceof Date) {
    throw new Error('Horarios: la celda tiene formato de hora. Escribilo como texto, ej: 09:00, 18:00.');
  }
  const horas = [];
  String(valor).split(/[-,;]/).forEach(function (parte) {
    if (parte.trim() === '') return;
    const h = parsearHora_(parte, 'Horarios');
    if (h >= 24) throw new Error('Horarios fuera de rango (0 a 23:59): ' + parte);
    horas.push(h);
  });
  return horas.sort(function (a, b) { return a - b; });
}

// ===== SESIÓN =====
// Los informes del turno que no están activos (State 0, por ejemplo un forzado con el Control API en OFF) también
// quedan marcados con el motivo, así no se quedan en EN_COLA sin explicación.
function abrirSesion_(tabla, turno) {
  try {
    return loginSalesforce_();
  } catch (e) {
    const enTurno = turno || [];
    if (e.message.indexOf(VSR_ERR_LOGIN) !== 0) {
      Logger.log('No se pudo abrir sesión en Salesforce: ' + e.message);
      enTurno.forEach(function (f) {
        escribirEstado_(tabla, f, 'ERROR', null, e.message);
      });
      return null;
    }
    Logger.log('Salesforce rechazó el login: ' + e.message + ' Se desactivan los informes (State = 0).');
    tabla.filas.forEach(function (f) {
      if (!f.activo) return;
      tabla.hoja.getRange(f.fila, tabla.cols.state).setValue(0);
      escribirEstado_(tabla, f, 'ACTUALIZAR CLAVE', 0, 'Salesforce rechazó el login. Actualizá VS_USUARIO / VS_CLAVE en las propiedades del script y volvé State a 1.');
    });
    enTurno.forEach(function (f) {
      if (f.activo) return;
      escribirEstado_(tabla, f, 'ACTUALIZAR CLAVE', null, 'Salesforce rechazó el login. Actualizá VS_USUARIO / VS_CLAVE en las propiedades del script.');
    });
    return null;
  }
}

// ===== CONTROL DE CADA INFORME =====
function procesarInforme_(sesion, tabla, f, limite) {
  if (f.hoja === VSR_CONFIG.HOJA_CONFIG && !f.archivo) {
    throw new Error('La hoja destino no puede ser la hoja de configuración (' + VSR_CONFIG.HOJA_CONFIG + ').');
  }
  let job = leerJob_(f);
  if (!job) {
    job = iniciarJob_(sesion, tabla, f);
    if (!job) return;
  }
  avanzarJob_(sesion, tabla, f, job, limite);
}

function iniciarJob_(sesion, tabla, f) {
  const ss = abrirArchivo_(f.archivo);

  let plan = null;
  let motivo = '';
  try {
    plan = planificar_(sesion, f.id);
  } catch (e) {
    if (esCupo_(e)) throw e;
    motivo = e.message;
  }
  if (!plan) {
    Logger.log(f.id + ': no se pudo traducir a consulta directa (' + motivo + '). Se usa el informe.');
    return iniciarPorInforme_(sesion, tabla, f, ss, motivo);
  }

  const job = {
    fase: 'DESCARGA',
    desde: plan.desde,
    select: plan.select,
    where: plan.where,
    mapeo: plan.mapeo,
    columnas: plan.columnas,
    tipos: plan.tipos,
    orden: plan.orden,
    tz: plan.tz,
    total: 0,
    ultimoId: '',
    escritas: 0,
    inicio: new Date().toISOString()
  };

  const primero = traerLote_(sesion, job);
  if (primero.cantidad < VSR_CONFIG.TAMANO_LOTE) {
    conReintento_('escribir hoja destino', function () {
      escribirDirecto_(ss, f.hoja, job.columnas, job.tipos, primero.filas);
      ordenarRango_(ss.getSheetByName(f.hoja), primero.cantidad, job.columnas.length, job.orden);
    });
    if (primero.cantidad === 0) {
      Logger.log(f.id + ': la consulta devolvió 0 filas. FROM ' + job.desde + ' WHERE ' + String(job.where || '').substring(0, 1800));
    }
    terminar_(tabla, f, primero.cantidad, 'COMPLETO',
              primero.cantidad === 0 ? 'Descargado por consulta directa: 0 filas (la consulta quedó en el registro de ejecución)'
                                     : 'Descargado por consulta directa');
    Logger.log(f.id + ' → ' + f.hoja + ': OK, ' + primero.cantidad + ' filas.');
    return null;
  }

  job.total = contar_(sesion, job);
  const nombreTemp = f.hoja + VSR_CONFIG.SUFIJO_TEMP;
  verificarEspacio_(ss, (job.total + 1) * job.columnas.length, nombreTemp);
  const temp = conReintento_('crear hoja temporal', function () {
    prepararTemp_(ss, nombreTemp, job.columnas, job.tipos, job.total);
    const t = ss.getSheetByName(nombreTemp);
    t.getRange(2, 1, primero.cantidad, job.columnas.length).setValues(primero.filas);
    return t;
  });
  job.escritas = primero.cantidad;
  job.ultimoId = primero.ultimoId;
  guardarJob_(f, job);
  escribirEstado_(tabla, f, 'EJECUTANDO', job.escritas, 'Descargando: ' + job.escritas + ' de ' + job.total);
  return job;
}

function iniciarPorInforme_(sesion, tabla, f, ss, motivo) {
  const informe = ejecutarInforme_(sesion, f.id);
  if (!informe.completo) {
    throw new Error('El informe tiene más de 2000 filas (la API de informes entrega 2000) y no se pudo ' +
                    'traducir a consulta directa: ' + motivo);
  }
  conReintento_('escribir hoja destino', function () {
    escribirDirecto_(ss, f.hoja, informe.columnas, informe.tiposColumna, informe.filas);
  });
  terminar_(tabla, f, informe.filas.length, 'COMPLETO', 'Descargado vía informe');
  Logger.log(f.id + ' → ' + f.hoja + ': OK vía informe, ' + informe.filas.length + ' filas.');
  return null;
}

function planificar_(sesion, reportId) {
  const json = get_(sesion, '/analytics/reports/' + reportId + '/describe');
  const colKeys = json.reportMetadata.detailColumns;
  const info = json.reportExtendedMetadata.detailColumnInfo;
  const ctx = { sesion: sesion, tz: sesion.zonaHoraria, describe: {}, meta: json.reportMetadata, ext: json.reportExtendedMetadata };
  const consulta = construirSoql_(ctx);
  const orden = (json.reportMetadata.sortBy || []).map(function (s) {
    return { col: colKeys.indexOf(s.sortColumn) + 1, asc: String(s.sortOrder).toLowerCase() !== 'desc' };
  }).filter(function (o) { return o.col > 0; });
  return {
    orden: orden,
    desde: consulta.desde,
    select: consulta.select,
    where: consulta.where,
    mapeo: consulta.mapeo,
    columnas: colKeys.map(function (k) { return info[k] ? info[k].label : k; }),
    tipos: colKeys.map(function (k) { return info[k] ? info[k].dataType : 'string'; }),
    tz: sesion.zonaHoraria
  };
}

function avanzarJob_(sesion, tabla, f, job, limite) {
  const ss = abrirArchivo_(f.archivo);
  const nombreTemp = f.hoja + VSR_CONFIG.SUFIJO_TEMP;

  if (job.fase === 'DESCARGA') {
    const temp = ss.getSheetByName(nombreTemp);
    if (!temp) throw new Error('Falta la hoja temporal ' + nombreTemp + '. Se reinicia la descarga en el próximo ciclo.');

    let terminado = false;
    while (!terminado && Date.now() < limite) {
      if (detenidoDesde_(f)) { cancelarDescarga_(tabla, f); return; }
      const lote = traerLote_(sesion, job);
      if (lote.cantidad > 0) {
        conReintento_('escribir lote en hoja temporal', function () {
          temp.getRange(job.escritas + 2, 1, lote.cantidad, job.columnas.length)
              .setValues(lote.filas);
        });
        job.escritas += lote.cantidad;
        job.ultimoId = lote.ultimoId;
        guardarJob_(f, job);
        escribirEstado_(tabla, f, 'EJECUTANDO', job.escritas, 'Descargando: ' + job.escritas + ' de ' + job.total);
      }
      terminado = lote.cantidad < VSR_CONFIG.TAMANO_LOTE;
    }
    if (detenidoDesde_(f)) { cancelarDescarga_(tabla, f); return; }

    if (!terminado) {
      escribirEstado_(tabla, f, 'EN_CURSO', job.escritas,
                      'Descargando: ' + job.escritas + ' de ' + job.total);
      return;
    }
    job.fase = 'COPIA';
    guardarJob_(f, job);
  }

  if (Date.now() >= limite) {
    escribirEstado_(tabla, f, 'EN_CURSO', job.escritas, 'Descarga lista, falta copiar al destino');
    return;
  }
  escribirEstado_(tabla, f, 'EJECUTANDO', job.escritas, 'Ordenando y copiando al destino...');
  finalizar_(sesion, tabla, f, job);
}

function finalizar_(sesion, tabla, f, job) {
  const ss = abrirArchivo_(f.archivo);
  const nombreTemp = f.hoja + VSR_CONFIG.SUFIJO_TEMP;
  const temp = ss.getSheetByName(nombreTemp);
  if (!temp) throw new Error('Falta la hoja temporal al copiar.');

  const destino = ss.getSheetByName(f.hoja) || ss.insertSheet(f.hoja);
  const filasNecesarias = job.escritas + 1;
  if (destino.getMaxRows() < filasNecesarias) {
    destino.insertRowsAfter(destino.getMaxRows(), filasNecesarias - destino.getMaxRows());
  }
  if (destino.getMaxColumns() < job.columnas.length) {
    destino.insertColumnsAfter(destino.getMaxColumns(), job.columnas.length - destino.getMaxColumns());
  }
  conReintento_('ordenar hoja temporal', function () {
    ordenarRango_(temp, job.escritas, job.columnas.length, job.orden);
  });
  // Se pisa el destino directamente (sin vaciarlo antes) para que las fórmulas que lo leen nunca lo vean vacío;
  // recién después se borran las filas que sobren de la descarga anterior. Las columnas a la derecha no se tocan nunca.
  conReintento_('copiar al destino', function () {
    const filasAntes = destino.getLastRow();
    temp.getRange(1, 1, filasNecesarias, job.columnas.length)
        .copyTo(destino.getRange(1, 1));
    if (filasAntes > filasNecesarias) {
      destino.getRange(filasNecesarias + 1, 1, filasAntes - filasNecesarias, destino.getMaxColumns()).clearContent();
    }
  });
  ss.deleteSheet(temp);

  PropertiesService.getScriptProperties().deleteProperty(VSR_PROP_JOB + claveJob_(f));

  const ahora = contar_(sesion, job);
  const coincide = ahora === job.escritas;
  Logger.log(f.id + ' → ' + f.hoja + ': ' + job.escritas + ' filas. Esperadas al inicio: ' +
             job.total + ', ahora: ' + ahora + '. ' + (coincide ? 'COINCIDE.' : 'DIFERENCIA.'));
  terminar_(tabla, f, job.escritas,
            coincide ? 'COMPLETO' : 'COMPLETO CON DIFERENCIA',
            coincide ? 'Verificado: ' + ahora + ' filas'
                     : 'Cambiaron datos durante la descarga (al inicio: ' + job.total + ', ahora: ' + ahora + ')');
}

function traerLote_(sesion, job) {
  const partes = [];
  if (job.where) partes.push('(' + job.where + ')');
  if (job.ultimoId) partes.push("Id > '" + job.ultimoId + "'");
  const select = job.select.split(', ').indexOf('Id') >= 0 ? job.select : job.select + ', Id';
  const soql = 'SELECT ' + select + ' FROM ' + job.desde +
               (partes.length ? ' WHERE ' + partes.join(' AND ') : '') +
               ' ORDER BY Id LIMIT ' + VSR_CONFIG.TAMANO_LOTE;

  const registros = get_(sesion, '/query?q=' + encodeURIComponent(soql)).records;
  const mapas = job.mapeo.map(function (m) { return m.bucket ? mapaBucket_(m.bucket) : null; });
  const filas = [];
  for (let i = 0; i < registros.length; i++) {
    const rec = registros[i];
    filas.push(job.mapeo.map(function (m, c) {
      const valor = valorRuta_(rec, m.expr);
      return m.bucket ? etiquetaBucket_(m.bucket, mapas[c], valor) : formato_(valor, m.tipo, job.tz);
    }));
  }
  return {
    filas: filas,
    cantidad: registros.length,
    ultimoId: registros.length ? registros[registros.length - 1].Id : job.ultimoId
  };
}

function contar_(sesion, job) {
  const soql = 'SELECT COUNT() FROM ' + job.desde + (job.where ? ' WHERE ' + job.where : '');
  return get_(sesion, '/query?q=' + encodeURIComponent(soql)).totalSize;
}

// ===== ESTADO Y UTILIDADES DE HOJAS =====
function terminar_(tabla, f, filas, estado, mensaje) {
  PropertiesService.getScriptProperties().deleteProperty(VSR_PROP_FALLA_SHEETS + claveJob_(f));
  PropertiesService.getScriptProperties().deleteProperty(VSR_PROP_ERROR_INFORME + claveJob_(f));
  conReintento_('anotar LastExecute', function () {
    const celda = tabla.hoja.getRange(f.fila, tabla.cols.lastexecute);
    celda.setValue(new Date());
    celda.setNumberFormat('dd/MM/yyyy HH:mm:ss');
  });
  escribirEstado_(tabla, f, estado, filas, mensaje);
}

// Consumo de llamadas a la API por informe, dentro de la misma hoja API (columnas Llamadas ultima / 24h / 48h).
// Se guarda por hora en las propiedades del script (48 cubetas por informe) y se recalcula en cada ciclo.
// Las sumas de 24 h y 48 h se cuentan por hora calendario. Si falla, no corta nada: solo lo anota en el registro.
function registrarConsumo_(tabla, consumo) {
  try {
    const c = tabla.cols;
    if (!c['llamadas ultima'] || !c['llamadas 24h'] || !c['llamadas 48h']) return;
    const props = PropertiesService.getScriptProperties();
    const horaActual = Math.floor(Date.now() / 3600000);

    consumo.forEach(function (x) {
      const clave = VSR_PROP_CONSUMO + claveJob_(x.f);
      let cubetas = [];
      try { cubetas = JSON.parse(props.getProperty(clave) || '[]'); } catch (e) { cubetas = []; }
      cubetas = cubetas.filter(function (b) { return b[0] > horaActual - 48; });
      const hoy = cubetas.filter(function (b) { return b[0] === horaActual; })[0];
      if (hoy) { hoy[1] += x.usadas; } else { cubetas.push([horaActual, x.usadas]); }
      props.setProperty(clave, JSON.stringify(cubetas));
      tabla.hoja.getRange(x.f.fila, c['llamadas ultima']).setValue(x.usadas);
    });

    // 24 h y 48 h de todos los informes de la tabla (los que no corrieron en este ciclo también cambian con el tiempo).
    const ultimaFila = tabla.hoja.getLastRow();
    if (ultimaFila < 2) return;
    const sumas = [];
    for (let i = 0; i < ultimaFila - 1; i++) sumas.push(['', '']);
    tabla.filas.forEach(function (f) {
      let cubetas = [];
      try { cubetas = JSON.parse(props.getProperty(VSR_PROP_CONSUMO + claveJob_(f)) || '[]'); } catch (e) { cubetas = []; }
      let h24 = 0, h48 = 0;
      cubetas.forEach(function (b) {
        if (b[0] > horaActual - 48) h48 += b[1];
        if (b[0] > horaActual - 24) h24 += b[1];
      });
      sumas[f.fila - 2] = [h24, h48];
    });
    if (c['llamadas 48h'] === c['llamadas 24h'] + 1) {
      tabla.hoja.getRange(2, c['llamadas 24h'], sumas.length, 2).setValues(sumas);
    } else {
      tabla.hoja.getRange(2, c['llamadas 24h'], sumas.length, 1).setValues(sumas.map(function (r) { return [r[0]]; }));
      tabla.hoja.getRange(2, c['llamadas 48h'], sumas.length, 1).setValues(sumas.map(function (r) { return [r[1]]; }));
    }
  } catch (e) {
    Logger.log('No se pudo registrar el consumo de API: ' + e.message);
  }
}

// Reintenta con espera si el servicio Hojas de cálculo no responde a tiempo; cualquier otro error se propaga igual.
// Si agota los reintentos, el error lleva en pasoSheets el nombre del paso que falló (para el log).
function conReintento_(a, b) {
  const fn = typeof a === 'function' ? a : b;
  const etiqueta = typeof a === 'function' ? '' : a;
  for (let intento = 1; intento <= VSR_CONFIG.REINTENTOS_SHEETS; intento++) {
    try {
      return fn();
    } catch (e) {
      if (!esTimeoutSheets_(e)) throw e;
      if (intento === VSR_CONFIG.REINTENTOS_SHEETS) {
        e.pasoSheets = e.pasoSheets ? etiqueta + ' > ' + e.pasoSheets : etiqueta;
        throw e;
      }
      Logger.log('Hojas de cálculo no respondió en "' + etiqueta + '" (intento ' + intento + ' de ' +
                 VSR_CONFIG.REINTENTOS_SHEETS + '): ' + e.message + ' Se reintenta.');
      Utilities.sleep(VSR_CONFIG.ESPERA_REINTENTO_MS * intento);
    }
  }
}

function esTimeoutSheets_(e) {
  const msg = String(e && e.message);
  return VSR_CONFIG.ERRORES_SHEETS_REINTENTABLES.some(function (t) { return msg.indexOf(t) !== -1; });
}

// Hasta cuándo (ms) el informe está en pausa por un error en su última descarga; 0 si no lo está.
function errorHasta_(f) {
  const ms = Number(PropertiesService.getScriptProperties().getProperty(VSR_PROP_ERROR_INFORME + claveJob_(f))) || 0;
  const hasta = ms + VSR_CONFIG.PAUSA_TRAS_ERROR_MS;
  return ms && hasta > Date.now() ? hasta : 0;
}

// Hasta cuándo (ms) el informe está en pausa por un timeout de Hojas; 0 si no lo está.
function fallaSheetsHasta_(f) {
  const ms = Number(PropertiesService.getScriptProperties().getProperty(VSR_PROP_FALLA_SHEETS + claveJob_(f))) || 0;
  const hasta = ms + VSR_CONFIG.PAUSA_TRAS_FALLA_SHEETS_MS;
  return ms && hasta > Date.now() ? hasta : 0;
}

// Escribe Estado (con color), Filas (si no es null) y Mensaje. Nunca corta el ciclo: si la hoja no responde después de
// los reintentos, lo deja en el log y sigue (el estado es solo informativo).
function escribirEstado_(tabla, f, estado, filas, mensaje) {
  try {
    conReintento_('escribir estado', function () {
      const hora = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm:ss');
      const celda = tabla.hoja.getRange(f.fila, tabla.cols.estado);
      celda.setValue(estado);
      celda.setBackground(VSR_COLORES_ESTADO[estado] || null);
      if (filas !== null) tabla.hoja.getRange(f.fila, tabla.cols.filas).setValue(filas);
      tabla.hoja.getRange(f.fila, tabla.cols.mensaje).setValue(('[' + hora + '] ' + mensaje).substring(0, 500));
      SpreadsheetApp.flush();
    });
  } catch (e) {
    Logger.log('No se pudo escribir el estado de ' + f.id + ' (' + estado + '): ' + e.message);
  }
}

function abrirArchivo_(archivoId) {
  return conReintento_('abrir archivo', function () {
    return archivoId ? SpreadsheetApp.openById(archivoId) : SpreadsheetApp.getActiveSpreadsheet();
  });
}

function claveJob_(f) {
  return f.id + '|' + f.hoja;
}

function leerJob_(f) {
  const txt = PropertiesService.getScriptProperties().getProperty(VSR_PROP_JOB + claveJob_(f));
  return txt ? JSON.parse(txt) : null;
}

function guardarJob_(f, job) {
  const txt = JSON.stringify(job);
  if (txt.length > VSR_CONFIG.MAX_BYTES_JOB) {
    throw new Error('El informe tiene demasiadas columnas/filtros para guardar su progreso (' + txt.length + ' bytes).');
  }
  PropertiesService.getScriptProperties().setProperty(VSR_PROP_JOB + claveJob_(f), txt);
}

// ===== CUPOS Y PAUSAS =====
function esCupo_(e) {
  return e.message.indexOf(VSR_ERR_API) === 0 || e.message.indexOf(VSR_ERR_INFORMES) === 0;
}

function pausaActiva_(nombre) {
  const t = Number(PropertiesService.getScriptProperties().getProperty(nombre) || 0);
  return Date.now() < t;
}

function ponerPausa_(nombre) {
  PropertiesService.getScriptProperties().setProperty(nombre, String(Date.now() + VSR_CONFIG.PAUSA_CUPO_MS));
}

function registrarEjecucionInforme_() {
  if (pausaActiva_(VSR_PROP_PAUSA_INFORMES)) {
    throw new Error(VSR_ERR_INFORMES + ': pausa activa por cupo de Salesforce.');
  }
  const props = PropertiesService.getScriptProperties();
  const hace1h = Date.now() - 3600000;
  let lista = [];
  try { lista = JSON.parse(props.getProperty(VSR_PROP_EJECUCIONES) || '[]'); } catch (e) { lista = []; }
  lista = lista.filter(function (t) { return t > hace1h; });
  if (lista.length >= VSR_CONFIG.MAX_EJECUCIONES_HORA) {
    throw new Error(VSR_ERR_INFORMES + ': ' + lista.length + ' ejecuciones de informe en la última hora (tope propio ' +
                    VSR_CONFIG.MAX_EJECUCIONES_HORA + ').');
  }
  lista.push(Date.now());
  props.setProperty(VSR_PROP_EJECUCIONES, JSON.stringify(lista));
}

// ===== LLAMADAS A SALESFORCE =====
function get_(sesion, ruta) {
  VSR_LLAMADAS_API++;
  const base = sesion.instancia + '/services/data/v' + VSR_CONFIG.API_VERSION;
  if (ruta.indexOf('/query?q=') === 0 && (base + ruta).length > VSR_CONFIG.MAX_LARGO_URL) {
    return consultarPorComposite_(sesion, base, ruta);
  }
  const resp = UrlFetchApp.fetch(base + ruta, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + sesion.sessionId },
    muteHttpExceptions: true
  });
  return resolverRespuesta_(resp.getResponseCode(), resp.getContentText(), ruta);
}

// Consulta larga (muchos filtros): la URL no entra en UrlFetchApp, así que va dentro del cuerpo de un POST al recurso
// Composite. Cuenta como una sola llamada a la API.
function consultarPorComposite_(sesion, base, ruta) {
  const resp = UrlFetchApp.fetch(base + '/composite', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + sesion.sessionId },
    payload: JSON.stringify({
      allOrNone: false,
      compositeRequest: [{ method: 'GET', url: '/services/data/v' + VSR_CONFIG.API_VERSION + ruta, referenceId: 'consulta' }]
    }),
    muteHttpExceptions: true
  });
  const codigo = resp.getResponseCode();
  const txt = resp.getContentText();
  if (codigo !== 200) return resolverRespuesta_(codigo, txt, ruta);
  const sub = (JSON.parse(txt).compositeResponse || [])[0];
  if (!sub) throw new Error('Respuesta Composite sin resultado en ' + ruta.substring(0, 80) + ': ' + txt.substring(0, 300));
  if (sub.httpStatusCode === 200) return sub.body;
  return resolverRespuesta_(sub.httpStatusCode, JSON.stringify(sub.body), ruta);
}

function resolverRespuesta_(codigo, txt, ruta) {
  if (codigo === 200) return JSON.parse(txt);

  if (codigo === 403 && txt.indexOf('REQUEST_LIMIT_EXCEEDED') >= 0) {
    ponerPausa_(VSR_PROP_PAUSA_API);
    throw new Error(VSR_ERR_API + ': ' + txt.substring(0, 300));
  }
  if (codigo === 403 && ruta.indexOf('/analytics/') === 0 && /sincroniz|synchronous/i.test(txt)) {
    if (ruta.indexOf('/describe') < 0) ponerPausa_(VSR_PROP_PAUSA_INFORMES);
    throw new Error(VSR_ERR_INFORMES + ': ' + txt.substring(0, 300));
  }
  throw new Error('Salesforce respondió HTTP ' + codigo + ' en ' + ruta.substring(0, 80) + ': ' + txt.substring(0, 400));
}

function verificarEspacio_(ss, celdasNuevas, nombreTemp) {
  let usadas = 0;
  ss.getSheets().forEach(function (h) {
    if (h.getName() !== nombreTemp) usadas += h.getMaxRows() * h.getMaxColumns();
  });
  const proyectadas = usadas + celdasNuevas * 2;
  if (proyectadas > VSR_CONFIG.MAX_CELDAS_ARCHIVO) {
    throw new Error('El informe necesita unas ' + celdasNuevas + ' celdas (hoja temporal + destino) y el ' +
                    'archivo ya usa ' + usadas + '. El límite de Google Sheets es 10.000.000 por archivo. ' +
                    'Usá otro archivo para este informe o una base de datos.');
  }
}

// Si la hoja temporal ya existe (una descarga anterior que no terminó) se reutiliza: borrar y crear hojas obliga a Google a
// recalcular las fórmulas de todo el archivo. Cada subpaso queda anotado para que el log diga cuál falló.
function prepararTemp_(ss, nombreTemp, columnas, tipos, total) {
  let paso = 'buscar hoja previa';
  try {
    let temp = ss.getSheetByName(nombreTemp);
    if (temp) {
      paso = 'vaciar hoja previa';
      temp.clear();
      if (temp.getMaxColumns() < columnas.length) {
        paso = 'agregar columnas';
        temp.insertColumnsAfter(temp.getMaxColumns(), columnas.length - temp.getMaxColumns());
      }
    } else {
      paso = 'crear hoja';
      temp = ss.insertSheet(nombreTemp);
      if (temp.getMaxColumns() > columnas.length) {
        paso = 'quitar columnas sobrantes';
        temp.deleteColumns(columnas.length + 1, temp.getMaxColumns() - columnas.length);
      }
    }
    paso = 'escribir encabezados';
    temp.getRange(1, 1, 1, columnas.length).setValues([columnas]);
    paso = 'formato de texto';
    formatoTexto_(temp, tipos, Math.max(total, 1));
  } catch (e) {
    e.pasoSheets = paso;
    throw e;
  }
}

// Formato de texto para las columnas 'string', agrupando las contiguas en un solo rango (menos llamadas a Sheets).
function formatoTexto_(hoja, tipos, cantidadFilas) {
  let c = 0;
  while (c < tipos.length) {
    if (tipos[c] !== 'string') { c++; continue; }
    let fin = c;
    while (fin + 1 < tipos.length && tipos[fin + 1] === 'string') fin++;
    hoja.getRange(2, c + 1, cantidadFilas, fin - c + 1).setNumberFormat('@');
    c = fin + 1;
  }
}

// Ordena las filas de datos (sin encabezado) con el mismo orden que tiene el informe en VirtualSeller.
function ordenarRango_(hoja, filas, columnas, orden) {
  if (!orden || !orden.length || filas < 2) return;
  hoja.getRange(2, 1, filas, columnas).sort(orden.map(function (o) {
    return { column: o.col, ascending: o.asc };
  }));
}

function escribirDirecto_(ss, nombreHoja, columnas, tiposColumna, filas) {
  const hoja = ss.getSheetByName(nombreHoja) || ss.insertSheet(nombreHoja);
  // Sin vaciar antes: se escribe encima y después se borran las filas que sobren, así las fórmulas no ven la hoja vacía.
  // Las columnas a la derecha no se tocan nunca.
  const filasAntes = hoja.getLastRow();
  hoja.getRange(1, 1, 1, columnas.length).setValues([columnas]);
  if (filas.length) {
    formatoTexto_(hoja, tiposColumna, filas.length);
    hoja.getRange(2, 1, filas.length, columnas.length).setValues(filas);
  }
  const filasAhora = filas.length + 1;
  if (filasAntes > filasAhora) {
    hoja.getRange(filasAhora + 1, 1, filasAntes - filasAhora, hoja.getMaxColumns()).clearContent();
  }
}

// ===== SALESFORCE: LOGIN E INFORME =====
function loginSalesforce_() {
  const CREDENCIALES = leerCredenciales_();
  const esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body>' +
    '<n1:login xmlns:n1="urn:partner.soap.sforce.com">' +
    '<n1:username>' + esc(CREDENCIALES.USUARIO) + '</n1:username>' +
    '<n1:password>' + esc(CREDENCIALES.CLAVE + CREDENCIALES.TOKEN) + '</n1:password>' +
    '</n1:login></env:Body></env:Envelope>';

  const resp = UrlFetchApp.fetch(
    VSR_CONFIG.LOGIN_HOST + '/services/Soap/u/' + VSR_CONFIG.API_VERSION,
    {
      method: 'post',
      contentType: 'text/xml; charset=UTF-8',
      headers: { SOAPAction: 'login' },
      payload: body,
      muteHttpExceptions: true
    }
  );
  const txt = resp.getContentText();
  const sid = txt.match(/<sessionId>([^<]+)<\/sessionId>/);
  const srv = txt.match(/<serverUrl>(https:\/\/[^\/<]+)/);
  if (!sid || !srv) {
    const fault = txt.match(/<faultstring>([^<]*)<\/faultstring>/);
    if (fault) throw new Error(VSR_ERR_LOGIN + ': ' + fault[1]);
    throw new Error('Login sin respuesta válida (HTTP ' + resp.getResponseCode() + '): ' + txt.substring(0, 300));
  }
  const tz = txt.match(/<userTimeZone>([^<]+)<\/userTimeZone>/);
  return {
    sessionId: sid[1],
    instancia: srv[1],
    zonaHoraria: tz ? tz[1] : Session.getScriptTimeZone()
  };
}

function ejecutarInforme_(sesion, reportId) {
  registrarEjecucionInforme_();
  const json = get_(sesion, '/analytics/reports/' + reportId + '?includeDetails=true');
  const colKeys = json.reportMetadata.detailColumns;
  const info = json.reportExtendedMetadata.detailColumnInfo;
  const columnas = colKeys.map(function (k) { return info[k] ? info[k].label : k; });
  const tiposColumna = colKeys.map(function (k) { return info[k] ? info[k].dataType : 'string'; });

  const filas = [];
  Object.keys(json.factMap).forEach(function (k) {
    (json.factMap[k].rows || []).forEach(function (r) {
      filas.push(r.dataCells.map(function (cel) {
        if (typeof cel.value === 'number') return cel.value;
        return cel.label !== null && cel.label !== undefined ? cel.label : '';
      }));
    });
  });

  let total = null;
  const resumen = json.factMap['T!T'];
  if (resumen && resumen.aggregates && resumen.aggregates.length) {
    total = resumen.aggregates[0].value;
  }
  return {
    columnas: columnas,
    tiposColumna: tiposColumna,
    filas: filas,
    total: total,
    completo: json.allData === true
  };
}

// ===== TRADUCCIÓN DEL INFORME A CONSULTA =====
function construirSoql_(ctx) {
  const meta = ctx.meta;
  const tipoInforme = meta.reportType ? meta.reportType.type : '';
  const m = /^(?:CustomEntity)+\$([^@]+)(?:@(.+))?$/.exec(tipoInforme || '');
  if (!m) {
    resolverPorColumnas_(ctx, tipoInforme);   // tipo personalizado (ej. Zonas_Tarifarias_con_Destino__c)
    return armarConsulta_(ctx);
  }

  const objetos = m[1].split('$');
  if (objetos.length > 2) {
    throw new Error('Tipo de informe con más de dos objetos encadenados: ' + tipoInforme);
  }
  ctx.padre = null;
  ctx.padreRel = null;
  if (objetos.length === 1) {
    ctx.desde = objetos[0];
  } else {
    ctx.padre = objetos[0];
    ctx.desde = objetos[1];
    ctx.padreRel = relacionConPadre_(ctx).relationshipName;
  }
  ctx.pc = ctx.padre ? ctx.padreRel + '.' : '';

  const cadena = m[2] || '';
  ctx.union = null;
  ctx.unionRel = null;
  ctx.unionObj = null;
  ctx.prefTitular = '';
  if (cadena.indexOf('.') >= 0) {
    const titular = cadena.substring(0, cadena.lastIndexOf('.'));
    ctx.union = cadena.substring(cadena.lastIndexOf('.') + 1);
    if (titular === ctx.desde) {
      ctx.prefTitular = '';
    } else if (ctx.padre && titular === ctx.padre) {
      ctx.prefTitular = ctx.pc;
    } else {
      throw new Error('No se pudo ubicar el objeto de la relación del informe: ' + titular);
    }
    const def = camposDe_(ctx, titular)[ctx.union];
    if (!def || !def.relationshipName) {
      throw new Error('No se pudo resolver la relación del informe: ' + ctx.union);
    }
    ctx.unionRel = def.relationshipName;
    ctx.unionObj = def.referenceTo[0];
  }

  return armarConsulta_(ctx);
}

// Arma SELECT, WHERE y mapeo de columnas a partir del contexto ya resuelto (objeto base y prefijos).
function armarConsulta_(ctx) {
  const meta = ctx.meta;
  const mapeo = meta.detailColumns.map(function (c) { return mapearColumna_(ctx, c); });
  // SOQL rechaza campos repetidos en el SELECT (pasa cuando una columna bucket y su columna de origen están las dos en el informe).
  const select = mapeo.map(function (x) { return x.expr; })
                      .filter(function (e, i, todos) { return todos.indexOf(e) === i; }).join(', ');

  const filtros = meta.reportFilters || [];
  const condiciones = filtros.map(function (f) { return condicion_(ctx, f); });
  const partesWhere = [];
  if (condiciones.length) {
    if (meta.reportBooleanFilter) {
      partesWhere.push(logicaFiltrosSoql_(meta.reportBooleanFilter, condiciones));
    } else {
      partesWhere.push(condiciones.join(' AND '));
    }
  }
  const cFecha = condicionFecha_(ctx);
  if (cFecha) partesWhere.push(cFecha);

  return { desde: ctx.desde, select: select, where: partesWhere.join(' AND '), mapeo: mapeo };
}

// Convierte la lógica de filtros del informe (ej. "1 AND 2 AND (3 AND 4) OR 5") en un WHERE de SOQL.
// SOQL no admite mezclar AND y OR en el mismo nivel sin paréntesis, así que se interpreta con la precedencia habitual
// (AND antes que OR) y cada grupo sale entre paréntesis. Soporta NOT.
function logicaFiltrosSoql_(logica, condiciones) {
  const tokens = String(logica).toUpperCase().match(/\d+|AND|OR|NOT|\(|\)/g) || [];
  let pos = 0;
  const atom = function () {
    const t = tokens[pos++];
    if (t === '(') {
      const e = disyuncion();
      if (tokens[pos++] !== ')') throw new Error('Lógica de filtros con paréntesis sin cerrar: ' + logica);
      return e;
    }
    if (t === 'NOT') return 'NOT ' + atom();
    if (/^\d+$/.test(t || '')) {
      const c = condiciones[Number(t) - 1];
      if (c === undefined) throw new Error('La lógica de filtros usa el filtro ' + t + ', que no existe: ' + logica);
      return '(' + c + ')';
    }
    throw new Error('Lógica de filtros no interpretable: ' + logica);
  };
  const conjuncion = function () {
    const partes = [atom()];
    while (tokens[pos] === 'AND') { pos++; partes.push(atom()); }
    return partes.length > 1 ? '(' + partes.join(' AND ') + ')' : partes[0];
  };
  const disyuncion = function () {
    const partes = [conjuncion()];
    while (tokens[pos] === 'OR') { pos++; partes.push(conjuncion()); }
    return partes.length > 1 ? '(' + partes.join(' OR ') + ')' : partes[0];
  };
  const res = disyuncion();
  if (pos < tokens.length) throw new Error('Lógica de filtros no interpretable: ' + logica);
  return res;
}

// Busca el lookup del hijo hacia el padre. Si hay varios: usa CONFIG.RELACIONES_PADRE; si no está,
// prefiere el maestro-detalle (cascadeDelete) y después el obligatorio (no nulo). Si sigue ambiguo, avisa con los nombres.
function relacionConPadre_(ctx) {
  const camposHijo = camposDe_(ctx, ctx.desde);
  const refs = Object.keys(camposHijo).map(function (k) { return camposHijo[k]; })
    .filter(function (d) {
      return d.type === 'reference' && d.relationshipName &&
             d.referenceTo && d.referenceTo.indexOf(ctx.padre) >= 0;
    });
  const par = ctx.desde + '|' + ctx.padre;
  const forzado = VSR_CONFIG.RELACIONES_PADRE[par];
  let elegida = null;

  if (forzado) {
    elegida = refs.filter(function (d) { return d.name === forzado; })[0] || null;
    if (!elegida) {
      throw new Error('CONFIG.RELACIONES_PADRE["' + par + '"] = "' + forzado + '" no es un lookup de ' +
                      ctx.desde + ' hacia ' + ctx.padre + '. Posibles: ' +
                      refs.map(function (d) { return d.name; }).join(', ') + '.');
    }
  } else if (refs.length === 1) {
    elegida = refs[0];
  } else if (refs.length > 1) {
    const detalle = refs.filter(function (d) { return d.cascadeDelete; });
    const obligatorios = refs.filter(function (d) { return !d.nillable; });
    if (detalle.length === 1) elegida = detalle[0];
    else if (obligatorios.length === 1) elegida = obligatorios[0];
    if (elegida) {
      Logger.log('Relación ' + par + ': ' + refs.length + ' candidatas, se usa ' + elegida.name + '.');
    }
  }
  if (!elegida) {
    throw new Error('No se pudo determinar la relación entre ' + ctx.padre + ' y ' + ctx.desde +
                    ' (' + refs.length + ' candidatas: ' +
                    refs.map(function (d) { return d.name; }).join(', ') + '). ' +
                    'Indicá cuál en VSR_CONFIG.RELACIONES_PADRE: "' + par + '": "Campo".');
  }
  return elegida;
}

// Informe de tipo personalizado: deduce los objetos de las columnas y la cadena de lookups entre ellos.
// Consulta desde el objeto "más hijo" (el que llega a todos los demás siguiendo lookups).
// Las filas del informe son las del objeto base; los lookups vacíos quedan en blanco (no descarta filas).
function resolverPorColumnas_(ctx, tipoInforme) {
  const objetos = [];
  ctx.meta.detailColumns.forEach(function (c) {
    const i = c.indexOf('.');
    if (i < 0) throw new Error('Tipo de informe no soportado para consulta directa: ' + tipoInforme + ' (columna ' + c + ')');
    const o = c.substring(0, i);
    if (objetos.indexOf(o) < 0) objetos.push(o);
  });
  if (objetos.length > 4) {
    throw new Error('Tipo de informe con más de cuatro objetos: ' + objetos.join(', '));
  }

  const aristas = {};
  objetos.forEach(function (o) {
    aristas[o] = [];
    const campos = camposDe_(ctx, o);
    Object.keys(campos).forEach(function (k) {
      const d = campos[k];
      if (d.type !== 'reference' || !d.relationshipName || !d.referenceTo) return;
      d.referenceTo.forEach(function (dest) {
        if (dest !== o && objetos.indexOf(dest) >= 0) aristas[o].push({ dest: dest, rel: d.relationshipName });
      });
    });
    const vistos = {};
    aristas[o].forEach(function (a) {
      if (vistos[a.dest]) throw new Error('Más de una relación de ' + o + ' hacia ' + a.dest + '.');
      vistos[a.dest] = true;
    });
  });

  const validos = [];
  objetos.forEach(function (base) {
    const pref = {};
    pref[base] = '';
    const cola = [base];
    while (cola.length) {
      const actual = cola.shift();
      aristas[actual].forEach(function (a) {
        if (pref[a.dest] === undefined) {
          pref[a.dest] = pref[actual] + a.rel + '.';
          cola.push(a.dest);
        }
      });
    }
    if (Object.keys(pref).length === objetos.length) validos.push({ base: base, pref: pref });
  });
  if (validos.length !== 1) {
    throw new Error('No se pudo determinar la relación entre ' + objetos.join(', ') +
                    ' (' + validos.length + ' candidatas).');
  }

  ctx.desde = validos[0].base;
  ctx.prefijos = validos[0].pref;
  ctx.padre = null;
  ctx.padreRel = null;
  ctx.pc = '';
  ctx.union = null;
  ctx.unionRel = null;
  ctx.unionObj = null;
  ctx.prefTitular = '';
}

// Prefijo "FK_<algo>." de una columna del objeto relacionado: el informe lo escribe con el nombre del campo de relación
// (FK_Producto__c.) o con el nombre del objeto relacionado (FK_ERPvs__Producto__c.). Devuelve '' si no corresponde.
function prefijoFk_(ctx, col) {
  if (!ctx.union) return '';
  const candidatos = ['FK_' + ctx.union + '.'];
  if (ctx.unionObj) candidatos.push('FK_' + ctx.unionObj + '.');
  for (let i = 0; i < candidatos.length; i++) {
    if (col.indexOf(candidatos[i]) === 0) return candidatos[i];
  }
  return '';
}

function mapearColumna_(ctx, col) {
  const bucket = bucketDe_(ctx, col);
  if (bucket) return mapearBucket_(ctx, bucket);
  const pc = ctx.pc;
  const especiales = {
    CUST_ID: { expr: pc + 'Id', tipo: 'id' },
    CUST_NAME: { expr: pc + 'Name', tipo: 'string' },
    CUST_LAST_UPDATE_NAME: { expr: pc + 'LastModifiedBy.Name', tipo: 'string' },
    CUST_LAST_UPDATE: { expr: pc + 'LastModifiedDate', tipo: 'datetime' },
    CUST_CREATED_NAME: { expr: pc + 'CreatedBy.Name', tipo: 'string' },
    CUST_CREATED_DATE: { expr: pc + 'CreatedDate', tipo: 'datetime' },
    CUST_OWNER_NAME: { expr: pc + 'Owner.Name', tipo: 'string' }
  };
  if (ctx.padre) {
    especiales.CHILD_ID = { expr: 'Id', tipo: 'id' };
    especiales.CHILD_NAME = { expr: 'Name', tipo: 'string' };
    especiales.CHILD_LAST_UPDATE_NAME = { expr: 'LastModifiedBy.Name', tipo: 'string' };
    especiales.CHILD_LAST_UPDATE = { expr: 'LastModifiedDate', tipo: 'datetime' };
    especiales.CHILD_CREATED_NAME = { expr: 'CreatedBy.Name', tipo: 'string' };
    especiales.CHILD_CREATED_DATE = { expr: 'CreatedDate', tipo: 'datetime' };
  }
  if (especiales[col]) return especiales[col];

  if (col === 'FK_NAME') {
    if (!ctx.unionRel) throw new Error('Columna FK_NAME sin relación en el informe.');
    return { expr: ctx.prefTitular + ctx.unionRel + '.Name', tipo: 'string' };
  }
  if (col === 'FK_CUSTENT_ID') {
    if (!ctx.unionRel) throw new Error('Columna FK_CUSTENT_ID sin relación en el informe.');
    return { expr: ctx.prefTitular + ctx.unionRel + '.Id', tipo: 'id' };
  }
  // Columnas de sistema del objeto relacionado (fecha de creación, última modificación, etc.)
  const fkSistema = {
    FK_CREATED_DATE: { campo: 'CreatedDate', tipo: 'datetime' },
    FK_CREATED_NAME: { campo: 'CreatedBy.Name', tipo: 'string' },
    FK_LAST_UPDATE: { campo: 'LastModifiedDate', tipo: 'datetime' },
    FK_LAST_UPDATE_NAME: { campo: 'LastModifiedBy.Name', tipo: 'string' },
    FK_OWNER_NAME: { campo: 'Owner.Name', tipo: 'string' }
  };
  if (fkSistema[col]) {
    if (!ctx.unionRel) throw new Error('Columna ' + col + ' sin relación en el informe.');
    return { expr: ctx.prefTitular + ctx.unionRel + '.' + fkSistema[col].campo, tipo: fkSistema[col].tipo };
  }
  const prefFk = prefijoFk_(ctx, col);
  if (prefFk) {
    const campo = col.substring(prefFk.length);
    const def = camposDe_(ctx, ctx.unionObj)[campo];
    if (!def) throw new Error('Campo no encontrado en ' + ctx.unionObj + ': ' + campo);
    if (def.type === 'reference' && def.relationshipName) {
      // Lookup del objeto relacionado (Familia, Marca, Tamaño de paquete...): el informe muestra el nombre, no el Id.
      return { expr: ctx.prefTitular + ctx.unionRel + '.' + def.relationshipName + '.Name', tipo: 'string' };
    }
    return { expr: ctx.prefTitular + ctx.unionRel + '.' + campo, tipo: def.type, lista: def.lista };
  }

  const objetos = [{ nombre: ctx.desde, pref: '' }];
  if (ctx.padre) objetos.push({ nombre: ctx.padre, pref: ctx.pc });
  if (ctx.prefijos) {
    Object.keys(ctx.prefijos).forEach(function (nombre) {
      if (nombre !== ctx.desde) objetos.push({ nombre: nombre, pref: ctx.prefijos[nombre] });
    });
  }
  for (let i = 0; i < objetos.length; i++) {
    const o = objetos[i];
    if (col.indexOf(o.nombre + '.') === 0) {
      const campo = col.substring(o.nombre.length + 1);
      const def = camposDe_(ctx, o.nombre)[campo];
      if (!def) throw new Error('Campo no encontrado en ' + o.nombre + ': ' + campo);
      if (def.type === 'reference' && def.relationshipName) {
        return { expr: o.pref + def.relationshipName + '.Name', tipo: 'string' };
      }
      return { expr: o.pref + campo, tipo: def.type, lista: def.lista };
    }
  }
  if (/^BucketField_/i.test(col)) throw new Error(errorBucketSinDefinicion_(ctx, col));
  throw new Error('Columna no soportada para consulta directa: ' + col);
}

// ===== COLUMNAS BUCKET (campos de depósito) =====
// Una columna bucket agrupa los valores de otra columna del informe en categorías (ej. SUCURSAL: "Urquiza" = estos vendedores).
// No existe en ninguna tabla: se baja la columna de origen y la categoría se calcula acá con la definición que trae el
// informe (reportMetadata.buckets). Soporta buckets de texto o lista de opciones (valores exactos); los de rangos numéricos no.
function bucketDe_(ctx, col) {
  const lista = (ctx.meta && ctx.meta.buckets) || [];
  for (let i = 0; i < lista.length; i++) {
    if (lista[i] && (lista[i].developerName === col || lista[i].devName === col)) return lista[i];
  }
  if (!/^BucketField_/i.test(col)) return null;
  // Si no está en reportMetadata.buckets, se busca la definición en cualquier parte de lo que devolvió Salesforce.
  return buscarDefinicionBucket_(ctx.meta, col, 0) || buscarDefinicionBucket_(ctx.ext, col, 0);
}

function buscarDefinicionBucket_(nodo, col, profundidad) {
  if (!nodo || typeof nodo !== 'object' || profundidad > 5) return null;
  if (!Array.isArray(nodo) && nodo.sourceColumnName && (nodo.devName === col || nodo.developerName === col || nodo.name === col)) {
    return nodo;
  }
  const claves = Object.keys(nodo);
  for (let i = 0; i < claves.length; i++) {
    const r = buscarDefinicionBucket_(nodo[claves[i]], col, profundidad + 1);
    if (r) return r;
  }
  return null;
}

// Si la definición no aparece, deja en el registro de ejecución qué trae Salesforce para poder ajustar el código.
function errorBucketSinDefinicion_(ctx, col) {
  const meta = ctx.meta || {};
  const ext = ctx.ext || {};
  const conBucket = function (o) {
    return Object.keys(o).filter(function (k) { return /bucket/i.test(k); });
  };
  const info = ext.detailColumnInfo ? ext.detailColumnInfo[col] : null;
  Logger.log('Bucket ' + col + ' sin definición. reportMetadata.buckets: ' +
             (meta.buckets === undefined ? 'no existe' : JSON.stringify(meta.buckets).substring(0, 1500)) +
             ' | claves con "bucket" en reportMetadata: ' + JSON.stringify(conBucket(meta)) +
             ' | en reportExtendedMetadata: ' + JSON.stringify(conBucket(ext)) +
             ' | detailColumnInfo: ' + JSON.stringify(info || null).substring(0, 500) +
             ' | claves de reportMetadata: ' + Object.keys(meta).join(','));
  return 'Columna bucket sin definición en lo que devuelve Salesforce: ' + col + ' (el detalle quedó en el registro de ejecución).';
}

// Devuelve la columna de origen con la definición compacta del bucket: e = etiquetas, v = valores de origen de cada una,
// o = etiqueta de "Otros" ('' si el bucket no muestra los valores sin agrupar como Otros).
function mapearBucket_(ctx, def) {
  const nombre = def.developerName || def.devName;
  const dump = function () { return JSON.stringify(def).substring(0, 300); };
  if (!def.sourceColumnName) throw new Error('Columna bucket sin columna de origen: ' + dump());
  if (bucketDe_(ctx, def.sourceColumnName)) throw new Error('Columna bucket basada en otro bucket: ' + nombre);
  const origen = mapearColumna_(ctx, def.sourceColumnName);
  const etiquetas = [];
  const valores = [];
  (def.values || []).forEach(function (v) {
    if (!v) return;
    if (v.rangeUpperBound !== null && v.rangeUpperBound !== undefined) {
      throw new Error('Columna bucket por rangos numéricos no soportada: ' + dump());
    }
    // Salesforce entrega los valores de cada grupo en sourceDimensionValues (lista de textos); sourceValues se acepta por si cambia.
    const fuente = (v.sourceDimensionValues || v.sourceValues || []).map(function (sv) {
      const valor = typeof sv === 'string' ? sv : (sv ? sv.sourceValue : undefined);
      if (valor === undefined || valor === null) throw new Error('Columna bucket con estructura inesperada: ' + dump());
      return String(valor);
    });
    etiquetas.push(String(v.label));
    valores.push(fuente);
  });
  if (!etiquetas.length) throw new Error('Columna bucket sin grupos: ' + dump());
  const usaOtros = def.useOther === true || (def.useOther === undefined && !!def.otherBucketLabel);
  Logger.log('Bucket ' + nombre + ' (' + def.label + '): origen ' + origen.expr + ', ' + etiquetas.length + ' grupos [' +
             etiquetas.map(function (e, i) { return e + ' (' + valores[i].length + ')'; }).join(', ') + ']' +
             (usaOtros ? ', Otros = "' + (def.otherBucketLabel || 'Other') + '"' : ''));
  const totalValores = valores.reduce(function (n, v) { return n + v.length; }, 0);
  if (!totalValores) {
    Logger.log('Definición completa del bucket ' + nombre + ': ' + JSON.stringify(def).substring(0, 1500));
    throw new Error('Columna bucket sin valores de origen en ningún grupo (estructura inesperada; la definición quedó en el registro de ejecución): ' + dump());
  }
  return {
    expr: origen.expr,
    tipo: origen.tipo,
    bucket: { e: etiquetas, v: valores, o: usaOtros ? String(def.otherBucketLabel || 'Other') : '' }
  };
}

// Valor de origen (en minúscula) -> etiqueta del grupo. El primer grupo que lo lista gana.
function mapaBucket_(b) {
  const mapa = {};
  b.e.forEach(function (etiqueta, i) {
    b.v[i].forEach(function (valor) {
      const clave = String(valor).trim().toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(mapa, clave)) mapa[clave] = etiqueta;
    });
  });
  return mapa;
}

function etiquetaBucket_(b, mapa, valor) {
  const clave = String(valor).trim().toLowerCase();
  if (clave !== '' && Object.prototype.hasOwnProperty.call(mapa, clave)) return mapa[clave];
  return b.o;
}

// Filtro sobre una columna bucket: se convierte en una condición sobre la columna de origen con los valores de los grupos
// que cumplen el filtro (la etiqueta se compara sin distinguir mayúsculas, igual que Salesforce).
// equals / contains / startsWith -> origen IN (valores de esos grupos); notEqual / notContain -> origen NOT IN (...).
function condicionBucket_(m, f) {
  const b = m.bucket;
  const positivos = { equals: 'equals', contains: 'contains', startsWith: 'startsWith' };
  const negativos = { notEqual: 'equals', notContain: 'contains' };
  const negativo = Object.prototype.hasOwnProperty.call(negativos, f.operator);
  const base = positivos[f.operator] || negativos[f.operator];
  if (!base) throw new Error('Operador de filtro no soportado en una columna bucket: ' + f.operator + ' (' + f.column + ')');
  const v = f.value === null || f.value === undefined ? '' : String(f.value);
  const partes = valoresLista_(v.replace(/"/g, '')).map(function (p) { return p.toLowerCase(); });
  if (partes.length === 1 && partes[0] === '') throw new Error('Filtro por bucket vacío no soportado (' + f.column + ').');
  const cumple = function (etiqueta) {
    const e = String(etiqueta).toLowerCase();
    return partes.some(function (p) { return base === 'equals' ? e === p : (base === 'contains' ? e.indexOf(p) >= 0 : e.indexOf(p) === 0); });
  };
  if (b.o && cumple(b.o)) throw new Error('El filtro incluye el grupo "' + b.o + '" del bucket; no soportado (' + f.column + ').');
  const incluidos = [];
  b.e.forEach(function (etiqueta, i) {
    if (!cumple(etiqueta)) return;
    b.v[i].forEach(function (valor) { if (incluidos.indexOf(valor) === -1) incluidos.push(valor); });
  });
  if (!incluidos.length) return negativo ? 'Id != null' : 'Id = null';   // ningún grupo cumple: no excluye nada / no trae nada
  return m.expr + (negativo ? ' NOT IN (' : ' IN (') +
         incluidos.map(function (x) { return literal_(x, m.tipo); }).join(', ') + ')';
}

function camposDe_(ctx, objeto) {
  if (!ctx.describe[objeto]) {
    const cache = CacheService.getScriptCache();
    const clave = 'DESC4_' + objeto;
    let campos = null;
    try {
      const t = cache.get(clave);
      if (t) campos = JSON.parse(t);
    } catch (e) { campos = null; }
    if (!campos) {
      const json = get_(ctx.sesion, '/sobjects/' + objeto + '/describe');
      campos = {};
      json.fields.forEach(function (fl) {
        campos[fl.name] = { name: fl.name, type: fl.type,
                            relationshipName: fl.relationshipName, referenceTo: fl.referenceTo,
                            nillable: fl.nillable, cascadeDelete: fl.cascadeDelete,
                            calculated: fl.calculated === true,
                            lista: (fl.picklistValues || []).filter(function (pv) { return pv.active; })
                                     .map(function (pv) { return [pv.label, pv.value]; }) };
      });
      try { cache.put(clave, JSON.stringify(campos), 21600); } catch (e) { /* demasiado grande: sin caché */ }
    }
    ctx.describe[objeto] = campos;
  }
  return ctx.describe[objeto];
}

function condicion_(ctx, f) {
  const m = mapearColumna_(ctx, f.column);
  if (m.bucket) return condicionBucket_(m, f);
  const v = f.value === null || f.value === undefined ? '' : String(f.value);
  switch (f.operator) {
    case 'equals':
    case 'notEqual': {
      const neg = f.operator === 'notEqual';
      if (v === '') return m.expr + (neg ? ' != null' : ' = null');
      // Número con formato local ("30.000,00" = 30000): la coma es decimal, no separa opciones.
      const unNumero = VSR_TIPOS_NUMERO.indexOf(m.tipo) >= 0 && /^"?\s*-?[\d.]+(,\d+)?\s*"?$/.test(v);
      const crudas = unNumero ? [v.trim()] : v.split(',').map(function (s) { return s.trim(); });
      const partes = crudas.filter(function (s) { return s !== ''; });
      // Una opción vacía en la lista (",ME1,A definir") significa "en blanco": hay que incluirla (o excluirla) también.
      const conVacio = crudas.length > 1 && crudas.length > partes.length;
      if (!partes.length) return m.expr + (neg ? ' != null' : ' = null');
      let cond;
      if (partes.length > 1) {
        cond = m.expr + (neg ? ' NOT IN (' : ' IN (') +
               partes.map(function (p) { return literal_(valorLista_(m, p), m.tipo); }).join(', ') + ')';
      } else {
        cond = m.expr + (neg ? ' != ' : ' = ') + literal_(valorLista_(m, partes[0]), m.tipo);
      }
      if (!conVacio) return cond;
      return neg ? '(' + cond + ' AND ' + m.expr + ' != null)'
                 : '(' + cond + ' OR ' + m.expr + ' = null)';
    }
    case 'lessThan': return m.expr + ' < ' + literal_(v, m.tipo);
    case 'greaterThan': return m.expr + ' > ' + literal_(v, m.tipo);
    case 'lessOrEqual': return m.expr + ' <= ' + literal_(v, m.tipo);
    case 'greaterOrEqual': return m.expr + ' >= ' + literal_(v, m.tipo);
    case 'contains': return '(' + valoresLista_(v).map(function (p) {
      return m.expr + " LIKE '%" + escSoql_(p) + "%'";
    }).join(' OR ') + ')';
    case 'notContain': return '(' + valoresLista_(v).map(function (p) {
      return '(NOT ' + m.expr + " LIKE '%" + escSoql_(p) + "%')";
    }).join(' AND ') + ')';
    case 'startsWith': return '(' + valoresLista_(v).map(function (p) {
      return m.expr + " LIKE '" + escSoql_(p) + "%'";
    }).join(' OR ') + ')';
    default:
      throw new Error('Operador de filtro no soportado: ' + f.operator + ' (' + f.column + ')');
  }
}

// Los filtros del informe guardan la etiqueta de la lista de selección ("activo"); la consulta necesita el valor ("active").
// Solo se usa para filtrar: los datos se descargan tal cual los entrega Salesforce.
function valorLista_(m, v) {
  if (!m.lista) return v;
  const limpio = String(v).replace(/"/g, '').trim().toLowerCase();
  for (let i = 0; i < m.lista.length; i++) {
    if (String(m.lista[i][1]).toLowerCase() === limpio) return m.lista[i][1];
  }
  for (let i = 0; i < m.lista.length; i++) {
    if (String(m.lista[i][0]).toLowerCase() === limpio) return m.lista[i][1];
  }
  return v;
}

// El valor de un filtro puede traer varias opciones separadas por coma ("a,b,c"). Vacío -> [''].
function valoresLista_(v) {
  const partes = String(v).split(',').map(function (s) { return s.trim(); })
                          .filter(function (s) { return s !== ''; });
  return partes.length ? partes : [''];
}

function literal_(valor, tipo) {
  valor = String(valor).replace(/"/g, '').trim();   // algunos filtros guardan el valor entre comillas ("0")
  if (VSR_TIPOS_TEXTO.indexOf(tipo) >= 0) return "'" + escSoql_(valor) + "'";
  if (VSR_TIPOS_NUMERO.indexOf(tipo) >= 0) {
    let n = String(valor);
    // Formato local de VirtualSeller: punto = miles, coma = decimales ("30.000,00" = 30000). Sin coma, solo se toma como miles si cumple "1.234" / "1.234.567".
    if (n.indexOf(',') >= 0) n = n.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(n)) n = n.replace(/\./g, '');
    if (!/^-?\d+(\.\d+)?$/.test(n)) throw new Error('Valor numérico inválido en filtro: ' + valor);
    return n;
  }
  if (tipo === 'boolean') {
    return /^(true|1|verdadero|s[ií])$/i.test(String(valor).trim()) ? 'true' : 'false';
  }
  if (tipo === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
  throw new Error('Filtro con tipo de dato no soportado (' + tipo + '): ' + valor);
}

function escSoql_(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function condicionFecha_(ctx) {
  const f = ctx.meta.standardDateFilter;
  if (!f || !f.column) return null;
  if (!f.startDate && !f.endDate) {
    if (f.durationValue && f.durationValue !== 'CUSTOM') {
      throw new Error('Filtro de fecha relativo sin fechas resueltas: ' + f.durationValue);
    }
    return null;
  }
  const m = mapearColumna_(ctx, f.column);
  const partes = [];
  if (m.tipo === 'date') {
    if (f.startDate) partes.push(m.expr + ' >= ' + f.startDate);
    if (f.endDate) partes.push(m.expr + ' <= ' + f.endDate);
  } else {
    if (f.startDate) {
      partes.push(m.expr + ' >= ' + f.startDate + 'T00:00:00' + offset_(ctx.tz, f.startDate));
    }
    if (f.endDate) {
      const fin = sumarDia_(f.endDate);
      partes.push(m.expr + ' < ' + fin + 'T00:00:00' + offset_(ctx.tz, fin));
    }
  }
  return '(' + partes.join(' AND ') + ')';
}

function sumarDia_(fecha) {
  return Utilities.formatDate(new Date(Date.parse(fecha + 'T00:00:00Z') + VSR_DIA_MS), 'UTC', 'yyyy-MM-dd');
}

function offset_(tz, fecha) {
  return Utilities.formatDate(new Date(Date.parse(fecha + 'T12:00:00Z')), tz, 'XXX');
}

// ===== FORMATO DE VALORES =====
function valorRuta_(registro, ruta) {
  const partes = ruta.split('.');
  let v = registro;
  for (let i = 0; i < partes.length; i++) {
    if (v === null || v === undefined) return '';
    v = v[partes[i]];
  }
  return v === null || v === undefined ? '' : v;
}

function formato_(valor, tipo, tz) {
  if (valor === '') return '';
  if (tipo === 'datetime') {
    const normal = String(valor).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    return Utilities.formatDate(new Date(normal), tz, 'dd/MM/yyyy HH:mm');
  }
  if (tipo === 'date') {
    const p = String(valor).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : valor;
  }
  return valor;
}

// ============================================================
// DIAGNÓSTICO DE INFORMES (archivo aparte, mismo proyecto que Código)
// Usa el login y el traductor del script principal. No descarga datos ni gasta ejecuciones de informe.
// ============================================================
const VSR_DIAG = {
  HOJA_REVISAR: 'Revisar informes',
  HOJA_LISTA: 'Mis informes',
  ENCABEZADOS: ['ID Informe', 'Nombre', 'Formato', 'Tipo de informe', 'Resultado', 'Filas',
                'Detalle', 'Columnas', 'Filtros', 'Fecha', 'Orden', 'Revisado'],
  ENCABEZADOS_LISTA: ['ID Informe', 'Nombre', 'Carpeta', 'Formato', 'Última ejecución', 'Última modificación'],
  COL_RESULTADO: 5,
  TIEMPO_MAX_MS: 270000,
  DIAS_ACTIVIDAD: 60,
  MAX_LISTA: 5000,
  RECHEQUEAR_TODO: false,
  LOCK_TIMEOUT_MS: 5000,
  HOJA_OBJETOS: 'Objetos',
  HOJA_CAMPOS: 'Campos',
  ENCABEZADOS_OBJETOS: ['Objeto', 'Etiqueta', 'Personalizado', 'Registros', 'Ver campos'],
  ENCABEZADOS_CAMPOS: ['Objeto', 'Campo', 'Etiqueta', 'Tipo', 'Largo', 'Apunta a', 'Relación (para consultas)',
                       'Filtrable', 'Ordenable'],
  COL_REGISTROS: 4,
  COL_VER_CAMPOS: 5,
  HOJA_INCREMENTAL: 'Revisar incremental',
  HOJA_INCR_COLUMNAS: 'Incremental columnas',
  ENCABEZADOS_INCREMENTAL: ['ID Informe', 'Nombre', 'Objetos (padre > hijo)', 'Filas', 'Cambiadas última hora',
                            'Cambiadas últimas 24 h', 'Resultado', 'Campos que la fecha de modificación no detecta',
                            'Detalle', 'Revisado', 'Filas del informe real', 'Diferencia (informe real - consulta)',
                            'Objetos vigilados', 'Fórmulas usadas', 'Filtros que sueltan filas',
                            'Borrados últimos 15 días', 'Prueba de consulta de cambios', 'Ventana de fechas',
                            'Requisitos de diseño'],
  ENCABEZADOS_INCR_COLUMNAS: ['ID Informe', 'Dónde', 'Columna o filtro', 'Expresión de consulta', 'Objeto del campo',
                              'Tipo', '¿Calculado o de otro objeto?', 'Registros del objeto', 'Cambiados 24 h (objeto)',
                              'Borrados 15 días (objeto)', 'Fórmula / detalle'],
  // Objeto relacionado con hasta tantos registros = catálogo (si cambia algo, descarga completa).
  CATALOGO_MAX: 2000,
  // Diferencia aceptada entre las filas del informe real y las de la consulta (registros que entran mientras se mide).
  TOLERANCIA_FILAS_MIN: 10,
  TOLERANCIA_FILAS_PCT: 0.005,
  DIAS_BORRADOS: 15,
  MARGEN_BORRADOS_MS: 3600000,   // se pide 1 h menos que el máximo que acepta Salesforce
  MS_HORA: 3600000,
  PROFUNDIDAD_FORMULAS: 3,
  // Gravedad creciente de una fórmula según lo que lee.
  ORDEN_FORMULA: ['PROPIA', 'TIEMPO', 'PROFUNDA', 'RESUMEN', 'OTRO_OBJETO'],
  NIVELES_FORMULA: {
    TIEMPO: 'usa TODAY() o NOW(): cambia sola con el tiempo',
    PROFUNDA: 'encadena demasiadas fórmulas: revisar a mano',
    RESUMEN: 'resumen (roll-up) o fórmula sin texto',
    OTRO_OBJETO: 'lee otro objeto'
  },
  // Campos que solo avanzan o no cambian: un filtro sobre ellos no deja filas afuera salvo por el paso del tiempo.
  CAMPOS_FIJOS: ['CreatedDate', 'Id', 'LastModifiedDate', 'SystemModstamp'],
  CONTAR_ESTANDAR: ['Account', 'Contact', 'User', 'Product2', 'Order', 'OrderItem', 'Opportunity',
                    'Lead', 'Case', 'Pricebook2', 'Contract', 'Asset']
};

// TODO EN UNO: lista tus informes, los carga en "Revisar informes" y los revisa uno por uno.
// Si no alcanza el tiempo de una ejecución, se continúa solo hasta terminar.
function revisarTodo() {
  listarMisInformes();
  revisarInformes();
}

// Revisa los informes cuyo ID esté en la columna A de la hoja "Revisar informes".
// Completa nombre, formato, tipo, si se puede descargar, cantidad de filas, filtros, fecha y orden.
// Solo revisa las filas con "Resultado" vacío (para repetir una, borrale el Resultado).
function revisarInformes() {
  const inicio = Date.now();
  borrarContinuaciones_();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(VSR_DIAG.LOCK_TIMEOUT_MS)) {
    Logger.log('Ya hay una revisión en curso.');
    return;
  }
  try {
    const hoja = prepararHoja_(VSR_DIAG.HOJA_REVISAR, VSR_DIAG.ENCABEZADOS);
    const ultima = hoja.getLastRow();
    const pendientes = [];
    if (ultima >= 2) {
      hoja.getRange(2, 1, ultima - 1, VSR_DIAG.ENCABEZADOS.length).getValues().forEach(function (d, i) {
        const id = String(d[0]).trim();
        if (!id) return;
        if (!VSR_DIAG.RECHEQUEAR_TODO && String(d[VSR_DIAG.COL_RESULTADO - 1]).trim() !== '') return;
        pendientes.push({ fila: i + 2, id: id });
      });
    }
    if (!pendientes.length) {
      Logger.log('Nada para revisar: pegá ID de informe en la columna A de "' + VSR_DIAG.HOJA_REVISAR +
                 '" (con el Resultado vacío).');
      avisarHojaLista_(hoja, 'Pegá los ID de informe en la columna A y volvé a ejecutar.');
      return;
    }
    const sesion = loginSalesforce_();
    let hechos = 0;
    for (let i = 0; i < pendientes.length; i++) {
      if (Date.now() - inicio >= VSR_DIAG.TIEMPO_MAX_MS) {
        Logger.log('Se agotó el tiempo: quedan ' + (pendientes.length - hechos) + ' por revisar; se continúa solo.');
        ScriptApp.newTrigger('revisarInformes').timeBased().after(60000).create();
        break;
      }
      const r = revisarUno_(sesion, pendientes[i].id);
      hoja.getRange(pendientes[i].fila, 2, 1, r.length).setValues([r]);
      hechos++;
    }
    Logger.log('Revisados: ' + hechos + ' informe(s).');
  } finally {
    lock.releaseLock();
  }
}

function revisarUno_(sesion, id) {
  const ahora = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
  let meta;
  try {
    meta = get_(sesion, '/analytics/reports/' + id + '/describe').reportMetadata;
  } catch (e) {
    return ['', '', '', 'NO', '', 'No se pudo leer el informe: ' + e.message.substring(0, 300), '', '', '', '', ahora];
  }

  const tipo = meta.reportType ? meta.reportType.label + ' [' + meta.reportType.type + ']' : '';
  const columnas = (meta.detailColumns || []).length;
  const filtros = (meta.reportFilters || []).length +
                  (meta.reportBooleanFilter ? ' (lógica: ' + meta.reportBooleanFilter + ')' : '');
  const f = meta.standardDateFilter;
  const fecha = f && f.column ? f.column + ' | ' + (f.durationValue || '') + ' | ' +
                                (f.startDate || '') + ' a ' + (f.endDate || '') : '';
  const orden = (meta.sortBy || []).map(function (s) { return s.sortColumn + ' ' + s.sortOrder; }).join(', ');
  const fila = function (resultado, total, detalle) {
    return [meta.name || '', meta.reportFormat || '', tipo, resultado, total, detalle,
            columnas, filtros, fecha, orden, ahora];
  };

  const bloqueos = [];
  if (meta.scope && meta.scope !== 'organization') bloqueos.push('Alcance "' + meta.scope + '" (el script no lo aplica).');
  if (meta.crossFilters && meta.crossFilters.length) bloqueos.push('Tiene filtros cruzados (el script no los aplica).');
  if (meta.topRows && meta.topRows.rowLimit) bloqueos.push('Tiene límite de filas (' + meta.topRows.rowLimit + '; el script no lo aplica).');
  if (!columnas) bloqueos.push('No tiene columnas de detalle.');
  if (bloqueos.length) return fila('NO', '', bloqueos.join(' '));

  const avisos = [];
  if (meta.reportFormat && meta.reportFormat !== 'TABULAR') {
    avisos.push('Formato ' + meta.reportFormat + ': baja solo las filas de detalle, sin agrupaciones ni totales.');
  }
  try {
    const ctx = { sesion: sesion, tz: sesion.zonaHoraria, describe: {}, meta: meta };
    const c = construirSoql_(ctx);
    get_(sesion, '/query?q=' + encodeURIComponent(
      'SELECT ' + c.select + ' FROM ' + c.desde + (c.where ? ' WHERE ' + c.where : '') + ' LIMIT 1'));
    const total = contar_(sesion, { desde: c.desde, where: c.where });
    return fila(avisos.length ? 'REVISAR' : 'SE PUEDE', total,
                avisos.length ? avisos.join(' ') : 'Se traduce y la consulta funciona.');
  } catch (e) {
    return fila('NO', '', e.message.substring(0, 400));
  }
}

// Lista los informes que se ejecutaron en los últimos DIAS_ACTIVIDAD días (los que tu usuario puede ver),
// en la hoja "Mis informes". Copiá de ahí los ID que quieras pasar a "Revisar informes".
function listarMisInformes() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(VSR_DIAG.LOCK_TIMEOUT_MS)) {
    Logger.log('Ya hay una operación en curso.');
    return;
  }
  try {
    const sesion = loginSalesforce_();
    const soql = 'SELECT Id, Name, FolderName, Format, LastRunDate, LastModifiedDate FROM Report ' +
                 'WHERE LastRunDate >= LAST_N_DAYS:' + VSR_DIAG.DIAS_ACTIVIDAD + ' ORDER BY LastRunDate DESC';
    let json = get_(sesion, '/query?q=' + encodeURIComponent(soql));
    const filas = [];
    for (;;) {
      json.records.forEach(function (r) {
        filas.push([r.Id, r.Name, r.FolderName || '', r.Format || '',
                    r.LastRunDate ? formato_(r.LastRunDate, 'datetime', sesion.zonaHoraria) : '',
                    r.LastModifiedDate ? formato_(r.LastModifiedDate, 'datetime', sesion.zonaHoraria) : '']);
      });
      if (json.done || !json.nextRecordsUrl || filas.length >= VSR_DIAG.MAX_LISTA) break;
      json = get_(sesion, json.nextRecordsUrl.replace('/services/data/v' + VSR_CONFIG.API_VERSION, ''));
    }
    const hoja = prepararHoja_(VSR_DIAG.HOJA_LISTA, VSR_DIAG.ENCABEZADOS_LISTA);
    if (hoja.getLastRow() > 1) {
      hoja.getRange(2, 1, hoja.getLastRow() - 1, VSR_DIAG.ENCABEZADOS_LISTA.length).clearContent();
    }
    if (filas.length) hoja.getRange(2, 1, filas.length, VSR_DIAG.ENCABEZADOS_LISTA.length).setValues(filas);
    agregarARevisar_(filas.map(function (f) { return f[0]; }));
    Logger.log('Informes listados: ' + filas.length + ' (ejecutados en los últimos ' + VSR_DIAG.DIAS_ACTIVIDAD + ' días).');
  } finally {
    lock.releaseLock();
  }
}

// Agrega a "Revisar informes" los ID que todavía no estén (no pisa lo ya revisado).
function agregarARevisar_(ids) {
  const hoja = prepararHoja_(VSR_DIAG.HOJA_REVISAR, VSR_DIAG.ENCABEZADOS);
  const ultima = hoja.getLastRow();
  const existentes = {};
  if (ultima >= 2) {
    hoja.getRange(2, 1, ultima - 1, 1).getValues().forEach(function (r) { existentes[String(r[0]).trim()] = true; });
  }
  const nuevos = ids.filter(function (id) { return !existentes[id]; }).map(function (id) { return [id]; });
  if (nuevos.length) hoja.getRange(Math.max(ultima, 1) + 1, 1, nuevos.length, 1).setValues(nuevos);
  Logger.log('ID agregados a "' + VSR_DIAG.HOJA_REVISAR + '": ' + nuevos.length);
}

function borrarContinuaciones_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'revisarInformes') ScriptApp.deleteTrigger(t);
  });
}

// Deja la hoja de entrada a la vista y avisa con un mensaje breve en pantalla (sin cuadros que haya que cerrar).
function avisarHojaLista_(hoja, mensaje) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setActiveSheet(hoja);
  ss.toast(mensaje, 'Hoja "' + hoja.getName() + '" lista', 8);
}

function prepararHoja_(nombre, encabezados) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let hoja = ss.getSheetByName(nombre);
  if (!hoja) hoja = ss.insertSheet(nombre);
  hoja.getRange(1, 1, 1, encabezados.length).setValues([encabezados]).setFontWeight('bold');
  hoja.setFrozenRows(1);
  return hoja;
}

// ============================================================
// EXPLORAR VIRTUALSELLER: qué tablas (objetos) puede leer tu usuario y cuántos registros tiene cada una
// ============================================================
// Lista todos los objetos consultables en la hoja "Objetos". Cuenta registros de los personalizados
// (los de VirtualSeller) y de una lista corta de estándar. Si no alcanza el tiempo, sigue solo.
// Después marcá con una X, en "Ver campos", los objetos que quieras ver en detalle y ejecutá explorarCampos.
function explorarObjetos() {
  const inicio = Date.now();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'explorarObjetos') ScriptApp.deleteTrigger(t);
  });
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(VSR_DIAG.LOCK_TIMEOUT_MS)) {
    Logger.log('Ya hay una exploración en curso.');
    return;
  }
  try {
    const sesion = loginSalesforce_();
    const hoja = prepararHoja_(VSR_DIAG.HOJA_OBJETOS, VSR_DIAG.ENCABEZADOS_OBJETOS);

    const previo = {};
    if (hoja.getLastRow() >= 2) {
      hoja.getRange(2, 1, hoja.getLastRow() - 1, VSR_DIAG.ENCABEZADOS_OBJETOS.length).getValues().forEach(function (r) {
        previo[r[0]] = { registros: r[VSR_DIAG.COL_REGISTROS - 1], marca: r[VSR_DIAG.COL_VER_CAMPOS - 1] };
      });
    }
    const objetos = get_(sesion, '/sobjects').sobjects
      .filter(function (o) { return o.queryable; })
      .sort(function (a, b) {
        if (a.custom !== b.custom) return a.custom ? -1 : 1;
        return a.name < b.name ? -1 : 1;
      });
    const filas = objetos.map(function (o) {
      const p = previo[o.name] || { registros: '', marca: '' };
      return [o.name, o.label, o.custom ? 'SI' : 'NO', p.registros, p.marca];
    });
    if (hoja.getLastRow() > 1) {
      hoja.getRange(2, 1, hoja.getLastRow() - 1, VSR_DIAG.ENCABEZADOS_OBJETOS.length).clearContent();
    }
    hoja.getRange(2, 1, filas.length, VSR_DIAG.ENCABEZADOS_OBJETOS.length).setValues(filas);

    let pendientes = 0;
    for (let i = 0; i < filas.length; i++) {
      const f = filas[i];
      const contable = f[2] === 'SI' || VSR_DIAG.CONTAR_ESTANDAR.indexOf(f[0]) >= 0;
      if (!contable || String(f[VSR_DIAG.COL_REGISTROS - 1]) !== '') continue;
      if (Date.now() - inicio >= VSR_DIAG.TIEMPO_MAX_MS) { pendientes++; continue; }
      let valor;
      try {
        valor = contar_(sesion, { desde: f[0], where: '' });
      } catch (e) {
        if (e.message.indexOf(VSR_ERR_API) === 0) {
          Logger.log('Límite de API de Salesforce: se detiene la exploración. ' + e.message);
          return;
        }
        valor = 'sin acceso o no contable';
      }
      hoja.getRange(i + 2, VSR_DIAG.COL_REGISTROS).setValue(valor);
    }
    if (pendientes) {
      Logger.log('Faltan contar ' + pendientes + ' objeto(s): se continúa solo.');
      ScriptApp.newTrigger('explorarObjetos').timeBased().after(60000).create();
    } else {
      Logger.log('Exploración completa: ' + filas.length + ' objetos consultables.');
    }
  } finally {
    lock.releaseLock();
  }
}

// Escribe en la hoja "Campos" todos los campos de los objetos marcados en la hoja "Objetos".
function explorarCampos() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(VSR_DIAG.LOCK_TIMEOUT_MS)) {
    Logger.log('Ya hay una exploración en curso.');
    return;
  }
  try {
    const hojaObj = prepararHoja_(VSR_DIAG.HOJA_OBJETOS, VSR_DIAG.ENCABEZADOS_OBJETOS);
    const marcados = [];
    if (hojaObj.getLastRow() >= 2) {
      hojaObj.getRange(2, 1, hojaObj.getLastRow() - 1, VSR_DIAG.ENCABEZADOS_OBJETOS.length).getValues().forEach(function (r) {
        if (String(r[VSR_DIAG.COL_VER_CAMPOS - 1]).trim() !== '') marcados.push(r[0]);
      });
    }
    if (!marcados.length) {
      Logger.log('Marcá con una X, en "Ver campos" de la hoja "' + VSR_DIAG.HOJA_OBJETOS + '", los objetos a detallar.');
      return;
    }
    const sesion = loginSalesforce_();
    const filas = [];
    marcados.forEach(function (nombre) {
      try {
        get_(sesion, '/sobjects/' + nombre + '/describe').fields.forEach(function (f) {
          filas.push([nombre, f.name, f.label, f.type, f.length || '', (f.referenceTo || []).join(', '),
                      f.relationshipName || '', f.filterable ? 'SI' : 'NO', f.sortable ? 'SI' : 'NO']);
        });
      } catch (e) {
        filas.push([nombre, '(error)', e.message.substring(0, 200), '', '', '', '', '', '']);
      }
    });
    const hoja = prepararHoja_(VSR_DIAG.HOJA_CAMPOS, VSR_DIAG.ENCABEZADOS_CAMPOS);
    if (hoja.getLastRow() > 1) {
      hoja.getRange(2, 1, hoja.getLastRow() - 1, VSR_DIAG.ENCABEZADOS_CAMPOS.length).clearContent();
    }
    hoja.getRange(2, 1, filas.length, VSR_DIAG.ENCABEZADOS_CAMPOS.length).setValues(filas);
    Logger.log('Campos listados: ' + filas.length + ' de ' + marcados.length + ' objeto(s).');
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// VER UN INFORME: muestra tipo, columnas, filtros y cómo se relacionan sus objetos
// ============================================================
const VSR_VER = {
  ID_INFORME: '00ORj000005dHFp',
  LOCK_TIMEOUT_MS: 5000
};

function verInforme(idInforme) {
  const lineas = [];
  const sal = function (t) { lineas.push(t); Logger.log(t); };
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(VSR_VER.LOCK_TIMEOUT_MS)) {
    sal('Ya hay una operación en curso.');
    return lineas;
  }
  try {
    const sesion = loginSalesforce_();
    const json = get_(sesion, '/analytics/reports/' + (idInforme || VSR_VER.ID_INFORME) + '/describe');
    const meta = json.reportMetadata;

    sal('Nombre: ' + meta.name + ' | Formato: ' + meta.reportFormat + ' | Alcance: ' + meta.scope);
    sal('Tipo: ' + (meta.reportType ? meta.reportType.label + ' [' + meta.reportType.type + ']' : ''));
    sal('Columnas: ' + meta.detailColumns.join(' | '));
    sal('Filtros: ' + JSON.stringify(meta.reportFilters || []) + ' | Lógica: ' + (meta.reportBooleanFilter || ''));
    sal('Filtro de fecha: ' + JSON.stringify(meta.standardDateFilter || {}));

    const objetos = [];
    meta.detailColumns.forEach(function (c) {
      if (c.indexOf('.') < 0 || c.indexOf('FK_') === 0) return;   // columnas de sistema o del objeto relacionado (FK_)
      const o = c.split('.')[0];
      if (objetos.indexOf(o) < 0) objetos.push(o);
    });
    sal('Objetos en las columnas: ' + objetos.join(', '));

    objetos.forEach(function (o) {
      try {
        get_(sesion, '/sobjects/' + o + '/describe').fields.forEach(function (f) {
          if (f.type !== 'reference' || !f.referenceTo) return;
          f.referenceTo.forEach(function (destino) {
            if (destino !== o && objetos.indexOf(destino) >= 0) {
              sal('Relación: ' + o + '.' + f.name + ' (' + f.relationshipName + ') apunta a ' + destino);
            }
          });
        });
        sal('Registros en ' + o + ': ' + contar_(sesion, { desde: o, where: '' }));
      } catch (e) {
        sal('No se pudo leer ' + o + ': ' + e.message.substring(0, 200));
      }
    });
  } finally {
    lock.releaseLock();
  }
  return lineas;
}

// Menú Diagnóstico > Ver informe: pide el ID y muestra el resultado en un cuadro para copiar.
function verInformeMenu() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Ver informe', 'ID del informe (ej. 00ORj0000054ytxMAA):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const id = r.getResponseText().trim();
  if (!id) return;
  let texto;
  try {
    texto = verInforme(id).join('\n');
  } catch (e) {
    texto = 'Error: ' + e.message;
  }
  const html = HtmlService.createHtmlOutput(
    '<textarea style="width:100%;height:320px;font:12px monospace" readonly onfocus="this.select()">' +
    texto.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</textarea>')
    .setWidth(700).setHeight(380);
  ui.showModalDialog(html, 'Informe ' + id);
}

// ============================================================
// VER CUPO DE API: hace una consulta mínima y muestra el uso diario que informa Salesforce
// ============================================================
const VSR_CUPO = {
  LOCK_TIMEOUT_MS: 5000
};

function verCupoApi() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(VSR_CUPO.LOCK_TIMEOUT_MS)) {
    Logger.log('Ya hay una operación en curso.');
    return;
  }
  try {
    const sesion = loginSalesforce_();
    const resp = UrlFetchApp.fetch(
      sesion.instancia + '/services/data/v' + VSR_CONFIG.API_VERSION + '/query?q=' +
      encodeURIComponent('SELECT COUNT() FROM User'),
      { method: 'get', headers: { Authorization: 'Bearer ' + sesion.sessionId }, muteHttpExceptions: true });
    Logger.log('HTTP ' + resp.getResponseCode());

    const headers = resp.getHeaders();
    let info = '';
    Object.keys(headers).forEach(function (k) {
      if (k.toLowerCase() === 'sforce-limit-info') info = String(headers[k]);
    });
    if (!info) {
      Logger.log('Salesforce no devolvió el encabezado Sforce-Limit-Info.');
      return;
    }
    Logger.log('Sforce-Limit-Info (crudo): ' + info);

    const m = info.match(/api-usage=(\d+)\/(\d+)/i);
    if (!m) {
      Logger.log('No se pudo leer api-usage en el encabezado.');
      return;
    }
    const usadas = Number(m[1]);
    const total = Number(m[2]);
    const libres = total - usadas;
    const pct = total > 0 ? Math.round(usadas / total * 1000) / 10 : 0;
    const hora = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss');

    Logger.log('===== VSR_CUPO API VIRTUALSELLER (' + hora + ') =====');
    Logger.log('Usadas (últimas 24 h): ' + usadas);
    Logger.log('Cupo diario:            ' + total);
    Logger.log('Disponibles:            ' + libres);
    Logger.log('Uso:                    ' + pct + ' %');
    Logger.log('(Incluye esta consulta y el uso de toda la organización, no solo de este script.)');
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// APTITUD PARA DESCARGA INCREMENTAL (bajar solo lo que cambió)
// ============================================================
// Pegá los ID de informe en la columna A de la hoja "Revisar incremental" y ejecutá revisarIncremental.
// No descarga datos. Por cada informe revisa:
//  - Que la consulta directa devuelva la misma cantidad de filas que el informe real.
//  - Cada columna, filtro y filtro de fecha: de qué objeto viene, si es una fórmula y qué lee (texto de la fórmula).
//    Una fórmula que lee otro objeto, usa TODAY()/NOW() o es un resumen NO se detecta con la fecha de modificación.
//  - Cada objeto de la cadena (filas, padre y relacionados): registros, cuántos cambiaron en 24 h, cuántos se
//    borraron en 15 días y si la consulta de cambios funciona (con su tiempo).
//  - Qué filtros pueden dejar una fila afuera del informe y cómo es la ventana de fechas.
// Resultado: APTO (sin bloqueos), REVISAR (algo no se pudo medir) o NO APTO (hay un bloqueo; el motivo va en "Detalle").
// "Requisitos de diseño" lista lo que tendría que hacer la descarga incremental de ese informe.
// El detalle por campo y por objeto queda en la hoja "Incremental columnas".
function revisarIncremental() {
  const inicio = Date.now();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(VSR_DIAG.LOCK_TIMEOUT_MS)) {
    Logger.log('Ya hay una revisión en curso.');
    return;
  }
  try {
    const hoja = prepararHoja_(VSR_DIAG.HOJA_INCREMENTAL, VSR_DIAG.ENCABEZADOS_INCREMENTAL);
    const ultima = hoja.getLastRow();
    const pendientes = [];
    if (ultima >= 2) {
      hoja.getRange(2, 1, ultima - 1, 1).getValues().forEach(function (r, i) {
        const id = String(r[0]).trim();
        if (id) pendientes.push({ fila: i + 2, id: id });
      });
    }
    if (!pendientes.length) {
      Logger.log('Pegá ID de informe en la columna A de "' + VSR_DIAG.HOJA_INCREMENTAL + '".');
      avisarHojaLista_(hoja, 'Pegá los ID de informe en la columna A y volvé a ejecutar.');
      return;
    }
    const sesion = loginSalesforce_();
    const memo = { total: {}, cambios: {}, borrados: {}, completa: {} };
    const detalle = [];
    for (let i = 0; i < pendientes.length; i++) {
      if (Date.now() - inicio >= VSR_DIAG.TIEMPO_MAX_MS) {
        Logger.log('Se agotó el tiempo: faltan ' + (pendientes.length - i) + ' informe(s); ejecutá de nuevo.');
        break;
      }
      const r = revisarIncrementalUno_(sesion, pendientes[i].id, memo);
      hoja.getRange(pendientes[i].fila, 2, 1, r.fila.length).setValues([r.fila]);
      r.detalle.forEach(function (d) { detalle.push([pendientes[i].id].concat(d)); });
    }
    const hd = prepararHoja_(VSR_DIAG.HOJA_INCR_COLUMNAS, VSR_DIAG.ENCABEZADOS_INCR_COLUMNAS);
    if (hd.getLastRow() > 1) {
      hd.getRange(2, 1, hd.getLastRow() - 1, VSR_DIAG.ENCABEZADOS_INCR_COLUMNAS.length).clearContent();
    }
    if (detalle.length) {
      hd.getRange(2, 1, detalle.length, VSR_DIAG.ENCABEZADOS_INCR_COLUMNAS.length).setValues(detalle);
    }
    Logger.log('Revisión incremental terminada: ' + pendientes.length + ' informe(s), ' +
               VSR_LLAMADAS_API + ' llamadas a la API.');
  } finally {
    lock.releaseLock();
  }
}

function revisarIncrementalUno_(sesion, id, memo) {
  const ahora = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
  const salida = function (nombre, objetos, filas, c1h, c24h, resultado, problemas, motivo, detalle, extra) {
    return {
      fila: [nombre, objetos, filas, c1h, c24h, resultado, problemas, motivo, ahora]
        .concat(extra || ['', '', '', '', '', '', '', '', '']),
      detalle: detalle || []
    };
  };
  let json;
  try {
    json = get_(sesion, '/analytics/reports/' + id + '/describe');
  } catch (e) {
    return salida('', '', '', '', '', 'NO APTO', '', 'No se pudo leer el informe: ' + e.message.substring(0, 300));
  }
  const meta = json.reportMetadata;
  const nombre = meta.name || '';
  const ctx = { sesion: sesion, tz: sesion.zonaHoraria, describe: {}, meta: meta };
  let c;
  try {
    c = construirSoql_(ctx);
  } catch (e) {
    return salida(nombre, '', '', '', '', 'NO APTO', '',
                  'No se traduce a consulta directa: ' + e.message.substring(0, 300) +
                  ' | Tipo de informe: ' + ((meta.reportType && meta.reportType.type) || '?') +
                  ' | Columnas: ' + (meta.detailColumns || []).join(', '));
  }
  const objetos = ctx.padre ? ctx.padre + ' > ' + ctx.desde : ctx.desde;

  const bloqueos = [];
  const revisar = [];
  const problemas = [];
  const formulas = [];
  const sueltan = [];
  const requisitos = [];
  const usuarios = [];
  const detalle = [];
  const unicos = function (lista) {
    return lista.filter(function (x, i) { return lista.indexOf(x) === i; });
  };
  const vigilados = [];
  const vistos = {};
  const vigilar = function (ruta, objeto) {
    if (vistos[ruta] !== undefined) return;
    vistos[ruta] = vigilados.length;
    vigilados.push({ ruta: ruta, objeto: objeto });
  };
  vigilar('', ctx.desde);
  if (ctx.padre) vigilar(ctx.padreRel, ctx.padre);

  // Una columna, un filtro o el filtro de fecha: objeto de origen, fórmula y objetos que hay que vigilar.
  const analizar = function (donde, col, etiqueta) {
    let m;
    try {
      m = mapearColumna_(ctx, col);
    } catch (e) {
      detalle.push([donde, etiqueta, '(no soportada)', '', '', 'REVISAR', '', '', '', e.message.substring(0, 200)]);
      bloqueos.push('No se traduce: ' + etiqueta);
      problemas.push(etiqueta + ' (no soportada)');
      return null;
    }
    let r;
    try {
      r = rutaDeExpresion_(ctx, m.expr);
    } catch (e) {
      detalle.push([donde, etiqueta, m.expr, '', m.tipo, 'REVISAR', '', '', '', e.message.substring(0, 200)]);
      revisar.push('No se pudo ubicar el objeto de: ' + etiqueta);
      return null;
    }
    r.pasos.forEach(function (p) {
      if (p.objeto === 'User') {
        if (usuarios.indexOf(etiqueta) < 0) usuarios.push(etiqueta);
      } else {
        vigilar(p.ruta, p.objeto);
      }
    });
    const externo = r.pasos.length > 1;
    const def = camposDe_(ctx, r.objeto)[r.campo];
    const calculado = !!(def && def.calculated);
    let marca = externo ? 'Otro objeto: ' + r.objeto + ' (se vigila)' : 'NO';
    let texto = '';
    let nivel = 'PROPIA';
    if (calculado) {
      const cl = clasificarCampoCalculado_(ctx, memo, r.objeto, r.campo, 0, {});
      nivel = cl.nivel;
      texto = cl.texto;
      if (nivel === 'PROPIA') {
        marca = 'Fórmula propia (segura)' + (externo ? ' de ' + r.objeto : '');
        formulas.push(etiqueta + ' → propia (segura)');
      } else {
        marca = 'PELIGRO: ' + VSR_DIAG.NIVELES_FORMULA[nivel];
        formulas.push(etiqueta + ' → ' + VSR_DIAG.NIVELES_FORMULA[nivel]);
        problemas.push(etiqueta + ' (' + VSR_DIAG.NIVELES_FORMULA[nivel] + ')');
        bloqueos.push('Fórmula que la fecha de modificación no detecta: ' + etiqueta + ' (' + VSR_DIAG.NIVELES_FORMULA[nivel] + ')');
      }
    }
    detalle.push([donde, etiqueta, m.expr, r.objeto, m.tipo, marca, '', '', '', texto]);
    return { m: m, r: r, calculado: calculado, nivel: nivel, externo: externo };
  };

  const info = json.reportExtendedMetadata.detailColumnInfo || {};
  (meta.detailColumns || []).forEach(function (col) {
    analizar('Columna', col, info[col] ? info[col].label : col);
  });

  let puedenSalir = false;
  (meta.reportFilters || []).forEach(function (f) {
    const etiqueta = f.column + ' ' + f.operator + ' ' + (f.value === null || f.value === undefined ? '' : f.value);
    const a = analizar('Filtro', f.column, etiqueta);
    if (!a) return;
    const motivo = motivoSalida_(a);
    if (motivo.sale) puedenSalir = true;
    sueltan.push(etiqueta + ' → ' + motivo.texto);
  });

  let ventana = 'Sin filtro de fecha';
  const fd = meta.standardDateFilter;
  if (fd && fd.column) {
    const a = analizar('Filtro de fecha', fd.column, fd.column);
    const movil = !!(fd.durationValue && fd.durationValue !== 'CUSTOM');
    const posicion = (meta.detailColumns || []).indexOf(fd.column);
    const letra = posicion >= 0 ? letraColumna_(posicion + 1) : '';
    ventana = (movil ? 'Móvil ' + fd.durationValue : 'Fija') +
              ' (' + (fd.startDate || '…') + ' a ' + (fd.endDate || '…') + ')' +
              (posicion >= 0 ? ' · columna ' + letra + ' "' + (info[fd.column] ? info[fd.column].label : fd.column) + '"'
                             : ' · esa columna no está en la hoja');
    if (a) {
      const motivo = motivoSalida_(a);
      if (motivo.sale) puedenSalir = true;
      sueltan.push('Fecha ' + fd.column + ' → ' + (movil ? 'ventana móvil; ' : '') + motivo.texto);
    }
    if (movil) {
      requisitos.push(posicion >= 0
        ? 'Recorte diario de las filas que salen de la ventana, por la columna ' + letra
        : 'La ventana de fechas se mueve y la hoja no tiene esa columna: el recorte solo lo hace la descarga completa');
    }
  }
  if (puedenSalir) {
    requisitos.push('Traer los registros cambiados sin aplicar el filtro del informe y decidir fila por fila si entran, se actualizan o salen');
  }

  // Objetos vigilados: registros, cambios, borrados y prueba de la consulta de cambios.
  const rutasConsulta = [];
  const afectadasPorRuta = {};
  const catalogos = [];
  const borradosPorObjeto = {};
  const textoObjetos = [];
  vigilados.forEach(function (v) {
    let rol = 'RELACIONADO';
    if (v.ruta === '') rol = 'FILAS';
    else if (ctx.padre && v.ruta === ctx.padreRel) rol = 'PADRE';
    let total = '', cambios = '', borrados = '', afectadas = '';
    const tieneFecha = !!camposDe_(ctx, v.objeto).SystemModstamp;
    try {
      total = contarObjeto_(sesion, memo, v.objeto);
    } catch (e) {
      revisar.push('No se pudo contar los registros de ' + v.objeto + ': ' + e.message.substring(0, 120));
    }
    if (rol === 'RELACIONADO' && typeof total === 'number' && total <= VSR_DIAG.CATALOGO_MAX) rol = 'CATÁLOGO';
    textoObjetos.push(v.objeto + ' (' + rol + ')');

    if (!tieneFecha) {
      bloqueos.push('Sin fecha de modificación (SystemModstamp) en ' + v.objeto);
      detalle.push(['Objeto vigilado', v.ruta === '' ? '(filas del informe)' : v.ruta, '', v.objeto, rol,
                    'SIN FECHA DE MODIFICACIÓN', total, '', '', '']);
      return;
    }
    try {
      cambios = contarCambiosObjeto_(sesion, memo, v.objeto, VSR_DIA_MS);
    } catch (e) {
      revisar.push('No se pudo contar los cambios de ' + v.objeto + ': ' + e.message.substring(0, 120));
    }
    try {
      borrados = borradosObjeto_(sesion, memo, v.objeto);
      borradosPorObjeto[v.objeto] = borrados;
    } catch (e) {
      borrados = 'ERROR';
      revisar.push('No se pudo leer los borrados de ' + v.objeto + ': ' + e.message.substring(0, 120));
    }

    let veredicto;
    if (rol === 'CATÁLOGO') {
      catalogos.push(v.objeto);
      veredicto = cambios > 0 ? 'CATÁLOGO: cambió en 24 h → descarga completa' : 'CATÁLOGO: sin cambios en 24 h';
    } else {
      veredicto = 'VIGILAR POR FECHA';
      const t0 = Date.now();
      try {
        const n = contarAfectadas_(sesion, c, [v.ruta], VSR_DIA_MS);
        afectadas = 'Filas del informe afectadas en 24 h: ' + n + ' (' + (Date.now() - t0) + ' ms)';
        afectadasPorRuta[v.ruta] = n;
        rutasConsulta.push(v.ruta);
      } catch (e) {
        veredicto = 'ERROR EN LA CONSULTA DE CAMBIOS';
        afectadas = e.message.substring(0, 200);
        bloqueos.push('La consulta de cambios por ' + v.objeto + ' falló: ' + e.message.substring(0, 120));
      }
    }
    detalle.push(['Objeto vigilado', v.ruta === '' ? '(filas del informe)' : v.ruta, exprFecha_(v.ruta), v.objeto, rol,
                  veredicto, total, cambios, borrados, afectadas]);
  });

  // Filas del informe real contra la consulta directa (la traducción debe ser fiel).
  let filas = '', dif = '';
  try {
    filas = contar_(sesion, { desde: c.desde, where: c.where });
  } catch (e) {
    revisar.push('No se pudo contar las filas de la consulta: ' + e.message.substring(0, 120));
  }
  const real = filasInformeReal_(sesion, id);
  if (real === null) {
    revisar.push('No se pudo leer la cantidad de filas del informe real');
  } else if (typeof filas === 'number') {
    dif = real - filas;
    const tolerancia = Math.max(VSR_DIAG.TOLERANCIA_FILAS_MIN, Math.round(filas * VSR_DIAG.TOLERANCIA_FILAS_PCT));
    if (Math.abs(dif) > tolerancia) {
      bloqueos.push('La consulta no coincide con el informe real: ' + real + ' filas contra ' + filas +
                    ' (diferencia ' + dif + ', tolerancia ' + tolerancia + ')');
    }
  }

  // Cambiadas en la última hora y en 24 h con todos los objetos vigilados en una sola consulta (OR).
  let c1h = '', c24h = '', prueba = '';
  if (rutasConsulta.length) {
    const t0 = Date.now();
    try {
      c1h = contarAfectadas_(sesion, c, rutasConsulta, VSR_DIAG.MS_HORA);
      c24h = contarAfectadas_(sesion, c, rutasConsulta, VSR_DIA_MS);
      prueba = 'Una sola consulta con ' + rutasConsulta.length + ' objeto(s): ' + (Date.now() - t0) + ' ms';
    } catch (e) {
      prueba = 'La consulta única falló (' + e.message.substring(0, 120) + ')';
      let suma = 0;
      rutasConsulta.forEach(function (ruta) { suma += afectadasPorRuta[ruta] || 0; });
      c24h = '≈' + suma + ' (suma por objeto)';
      requisitos.push('Consultar los cambios con una consulta por objeto (la consulta única falló)');
    }
  }

  // Requisitos de diseño.
  let totalBorrados = 0;
  const textoBorrados = Object.keys(borradosPorObjeto).map(function (o) {
    totalBorrados += Number(borradosPorObjeto[o]) || 0;
    return o + ': ' + borradosPorObjeto[o];
  });
  requisitos.push(totalBorrados > 0
    ? 'Hay borrados en ' + VSR_DIAG.DIAS_BORRADOS + ' días: al detectar un borrado, descarga completa (o quitar la fila por Id)'
    : 'Sin borrados en ' + VSR_DIAG.DIAS_BORRADOS + ' días: igual consultar los borrados en cada corrida');
  if (catalogos.length) {
    requisitos.push('Catálogos (' + unicos(catalogos).join(', ') + '): si cambia alguno, descarga completa');
  }
  if (usuarios.length) {
    requisitos.push('Nombres de usuario (' + usuarios.join(', ') + '): solo los cubre la descarga completa nocturna');
  }
  requisitos.push('Clave por fila: Id de ' + ctx.desde + ' (columna del destino a definir)');

  let resultado = 'APTO';
  let motivo = 'Sin bloqueos: todo cambio en los objetos vigilados se detecta por fecha de modificación. Ver "Requisitos de diseño".';
  if (bloqueos.length) {
    resultado = 'NO APTO';
    motivo = unicos(bloqueos).join(' | ');
  } else if (revisar.length) {
    resultado = 'REVISAR';
    motivo = unicos(revisar).join(' | ');
  }
  return salida(nombre, objetos, filas, c1h, c24h, resultado, unicos(problemas).join(' | '), motivo, detalle,
                [real === null ? '' : real, dif, unicos(textoObjetos).join(' | '), unicos(formulas).join(' | ') || 'Ninguna',
                 sueltan.join(' | ') || 'Ninguno', textoBorrados.join(' | '), prueba, ventana, requisitos.join(' | ')]);
}

// Dice si un filtro (o el filtro de fecha) puede dejar una fila afuera del informe y por qué.
function motivoSalida_(a) {
  if (a.externo) {
    return { sale: true, texto: 'campo de otro objeto (' + a.r.objeto + '): la fila puede salir si cambia ese registro o el puntero hacia él' };
  }
  if (a.calculado) {
    return { sale: true, texto: 'fórmula: la fila puede salir si cambian los datos que usa' };
  }
  if (VSR_DIAG.CAMPOS_FIJOS.indexOf(a.r.campo) >= 0) {
    return { sale: false, texto: 'campo que no retrocede: solo sale por el paso del tiempo' };
  }
  return { sale: true, texto: 'campo propio editable: la fila puede salir al editarlo' };
}

// Recorre la expresión de consulta (ej. "ERPvs__Pedido__r.ERPvs__Estado1__r.Name") desde el objeto de las filas
// y devuelve los objetos por los que pasa, con la ruta de relaciones para llegar a cada uno, y el campo final.
function rutaDeExpresion_(ctx, expr) {
  const partes = expr.split('.');
  const campo = partes.pop();
  let objeto = ctx.desde;
  let ruta = '';
  const pasos = [{ objeto: objeto, ruta: '' }];
  partes.forEach(function (rel) {
    const campos = camposDe_(ctx, objeto);
    let def = null;
    Object.keys(campos).forEach(function (k) {
      if (!def && campos[k].relationshipName === rel) def = campos[k];
    });
    if (!def || !def.referenceTo || !def.referenceTo.length) {
      throw new Error('No se pudo seguir la relación "' + rel + '" desde ' + objeto + ' (' + expr + ').');
    }
    objeto = def.referenceTo.indexOf('User') >= 0 ? 'User' : def.referenceTo[0];
    ruta = ruta ? ruta + '.' + rel : rel;
    pasos.push({ objeto: objeto, ruta: ruta });
  });
  return { pasos: pasos, objeto: objeto, campo: campo };
}

// Descripción completa del objeto (con el texto de las fórmulas). Solo para el diagnóstico: una llamada por objeto.
function descripcionCompleta_(ctx, memo, objeto) {
  if (!memo.completa[objeto]) {
    const campos = {};
    get_(ctx.sesion, '/sobjects/' + objeto + '/describe').fields.forEach(function (fl) {
      campos[fl.name] = { calculated: fl.calculated === true, formula: fl.calculatedFormula || '' };
    });
    memo.completa[objeto] = campos;
  }
  return memo.completa[objeto];
}

// Clasifica un campo calculado por lo que lee su fórmula (también las fórmulas que usa, hasta cierta profundidad).
// Niveles (de menor a mayor gravedad): PROPIA, TIEMPO, PROFUNDA, RESUMEN, OTRO_OBJETO.
function clasificarCampoCalculado_(ctx, memo, objeto, campo, profundidad, visitados) {
  const campos = descripcionCompleta_(ctx, memo, objeto);
  const d = campos[campo];
  if (!d || !d.calculated) return { nivel: 'PROPIA', texto: '' };
  visitados[campo] = true;
  let nivel = analizarTextoFormula_(d.formula);
  if (nivel === 'SIN_TEXTO') nivel = 'RESUMEN';
  if (nivel === 'PROPIA') {
    (d.formula.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).forEach(function (nombre) {
      if (visitados[nombre] || !campos[nombre] || !campos[nombre].calculated) return;
      let sub;
      if (profundidad >= VSR_DIAG.PROFUNDIDAD_FORMULAS) {
        sub = { nivel: 'PROFUNDA' };
      } else {
        sub = clasificarCampoCalculado_(ctx, memo, objeto, nombre, profundidad + 1, visitados);
      }
      if (VSR_DIAG.ORDEN_FORMULA.indexOf(sub.nivel) > VSR_DIAG.ORDEN_FORMULA.indexOf(nivel)) nivel = sub.nivel;
    });
  }
  return { nivel: nivel, texto: d.formula };
}

// Qué lee el texto de una fórmula: TIEMPO (TODAY/NOW), OTRO_OBJETO (relaciones, variables globales), PROPIA o SIN_TEXTO.
function analizarTextoFormula_(texto) {
  if (texto === null || texto === undefined || String(texto).trim() === '') return 'SIN_TEXTO';
  const t = String(texto)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/\$Label\.[A-Za-z0-9_.]+/gi, '');
  if (/\b(TODAY|NOW|TIMENOW)\s*\(/i.test(t)) return 'TIEMPO';
  if (/\$(User|Profile|UserRole|Organization|Setup|ObjectType|CustomMetadata|Permission|Api|System|Site|Network|Action)\b/i.test(t)) {
    return 'OTRO_OBJETO';
  }
  if (/\b(VLOOKUP|GETRECORDIDS)\s*\(/i.test(t)) return 'OTRO_OBJETO';
  if (/[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_]/.test(t)) return 'OTRO_OBJETO';
  return 'PROPIA';
}

function letraColumna_(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function fechaSoql_(ms) {
  return Utilities.formatDate(new Date(Date.now() - ms), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
}

function exprFecha_(ruta) {
  return (ruta ? ruta + '.' : '') + 'SystemModstamp';
}

function contarObjeto_(sesion, memo, objeto) {
  if (memo.total[objeto] === undefined) memo.total[objeto] = contar_(sesion, { desde: objeto, where: '' });
  return memo.total[objeto];
}

function contarCambiosObjeto_(sesion, memo, objeto, ms) {
  const clave = objeto + '|' + ms;
  if (memo.cambios[clave] === undefined) {
    const soql = 'SELECT COUNT() FROM ' + objeto + ' WHERE SystemModstamp >= ' + fechaSoql_(ms);
    memo.cambios[clave] = get_(sesion, '/query?q=' + encodeURIComponent(soql)).totalSize;
  }
  return memo.cambios[clave];
}

// Registros borrados en los últimos días (Salesforce solo guarda hasta 15 días de borrados).
function borradosObjeto_(sesion, memo, objeto) {
  if (memo.borrados[objeto] === undefined) {
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - VSR_DIAG.DIAS_BORRADOS * VSR_DIA_MS + VSR_DIAG.MARGEN_BORRADOS_MS);
    const formato = function (d) { return Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'"); };
    const json = get_(sesion, '/sobjects/' + objeto + '/deleted/?start=' + encodeURIComponent(formato(desde)) +
                              '&end=' + encodeURIComponent(formato(hasta)));
    memo.borrados[objeto] = (json.deletedRecords || []).length;
  }
  return memo.borrados[objeto];
}

// Cuántas filas del informe tienen modificado, en los últimos "ms" milisegundos, alguno de los objetos de las rutas
// (ruta '' = el objeto de las filas; las demás son relaciones desde él).
function contarAfectadas_(sesion, c, rutas, ms) {
  const desde = fechaSoql_(ms);
  const cambio = '(' + rutas.map(function (r) { return exprFecha_(r) + ' >= ' + desde; }).join(' OR ') + ')';
  const soql = 'SELECT COUNT() FROM ' + c.desde + ' WHERE ' + (c.where ? '(' + c.where + ') AND ' : '') + cambio;
  return get_(sesion, '/query?q=' + encodeURIComponent(soql)).totalSize;
}

// Cantidad de filas del informe real (sin traer las filas). Cuenta como una ejecución de informe.
function filasInformeReal_(sesion, id) {
  try {
    registrarEjecucionInforme_();
    const json = get_(sesion, '/analytics/reports/' + id + '?includeDetails=false');
    const resumen = json.factMap && json.factMap['T!T'];
    if (resumen && resumen.aggregates && resumen.aggregates.length) return Number(resumen.aggregates[0].value);
  } catch (e) {
    Logger.log('Informe ' + id + ': no se pudo leer la cantidad de filas del informe real (' + e.message.substring(0, 160) + ').');
  }
  return null;
}

// ============================================================
// CONTROL API - parte CLIENTE (viaja dentro de este mismo Reportes.gs a cada archivo de informes)
//
// Un activador "vigía" (capiVigia, cada 5 min) lee el interruptor de la hoja "Control API" del Sheet principal.
// El vigía NO llama a Salesforce: solo lee/escribe Sheets.
//  - Interruptor en OFF: guarda qué informes tenían State 1, pasa todos a State 0 y borra los activadores de descarga
//    (despachador, etc.). El vigía queda vivo para saber cuándo volver.
//  - Interruptor en ON: devuelve State 1 a los informes que estaban activos y recrea el activador del despachador
//    (solo si lo tenía antes de apagarse).
//  - En cada chequeo se anota en la lista de la hoja "Control API" (nombre, estado ON/OFF, fecha, informes activos).
//
// El vigía se crea solo (ver capiAsegurarVigia_); no hay nada que instalar a mano.
// Segunda barrera: despachador() llama a capiBloqueado_() al empezar.
// ============================================================
const CAPI_CLI = {
  ID_CONTROL: '1JpU2mo0DBwHXeXKh3GWthL33gPjGe1z2_hXKWcC_u_s',
  HOJA_CONTROL: 'Control API',
  CELDA_INTERRUPTOR: 'B2',
  FILA_PRIMER_ARCHIVO: 14,
  COL_VERSION: 8,     // H: versión del código de este archivo (VSR_VERSION), a la derecha de Situación
  COL_PROYECTO: 11,   // K: link al proyecto de Apps Script de este archivo
  COL_LLAMADAS: 12,   // L, M y N: llamadas última corrida / 24 h / 48 h (después de Proyecto)
  COL_INFORMES: 16,   // P a AE: tabla por informe (ID archivo, Archivo, Informe, ID informe, última, 24 h, 48 h, actualizado, última ejecución, estado, ExecTime, Dias, Desde, Hasta, Horarios, State); AF = Link (fórmula de la hoja). O queda vacía
  FORMATO_FECHA: 'dd/MM/yyyy HH:mm:ss',
  MINUTOS_SIN_RESPUESTA: 15,
  HOJA_API: 'API',
  MINUTOS_VIGIA: 5,
  MINUTOS_DESPACHADOR: 5,
  LOCK_TIMEOUT_MS: 20000,
  MAX_BYTES_PROP: 8500,
  VALOR_ON: 'ON',
  VALOR_OFF: 'OFF',
  // Activadores que bajan datos de Salesforce y se borran en OFF.
  HANDLERS_DESCARGA: ['despachador', 'despachadorInmediato', 'reanudarDescarga', 'revisarInformes', 'explorarObjetos']
};

const CAPI_PROP_APAGADO = 'CAPI_APAGADO';
const CAPI_PROP_ACTIVOS = 'CAPI_ACTIVOS';
const CAPI_PROP_TENIA_ACTIVADOR = 'CAPI_TENIA_ACTIVADOR';

// ===== PUESTA EN MARCHA (automática) =====
// El vigía siempre debe existir: despachador() y crearActivador() llaman a esta función, así que se crea solo
// (y se vuelve a crear si alguien lo borra). No hay que instalarlo ni quitarlo a mano.
function capiAsegurarVigia_() {
  try {
    const hay = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'capiVigia';
    });
    if (hay) return;
    ScriptApp.newTrigger('capiVigia').timeBased().everyMinutes(CAPI_CLI.MINUTOS_VIGIA).create();
    Logger.log('Control API: vigía creado cada ' + CAPI_CLI.MINUTOS_VIGIA + ' minutos.');
    capiVigia();
  } catch (e) {
    Logger.log('Control API: no se pudo asegurar el vigía: ' + e.message);
  }
}

// ===== VIGÍA (activador cada 5 min) =====
function capiVigia() {
  asegurarMenuReportes_();
  let interruptor;
  try {
    interruptor = capiLeerInterruptor_();
  } catch (e) {
    Logger.log('Control API: no se pudo leer el interruptor: ' + e.message);
    return;
  }
  const props = PropertiesService.getScriptProperties();
  let mensaje = '';
  try {
    const apagado = props.getProperty(CAPI_PROP_APAGADO) === '1';
    Logger.log('Control API: interruptor en ' + interruptor + '; este archivo figura como ' + (apagado ? 'APAGADO' : 'ENCENDIDO') + '.');
    if (interruptor === CAPI_CLI.VALOR_OFF && !apagado) {
      capiApagar_();
      mensaje = 'Apagado: State en 0 y activadores de descarga borrados.';
    } else if (interruptor === CAPI_CLI.VALOR_ON && apagado) {
      const r = capiEncender_();
      mensaje = (r.restaurados < r.guardados ? 'ATENCIÓN: ' : 'Encendido: ') +
                'restaurados ' + r.restaurados + ' de ' + r.guardados + '; activador recreado.';
    } else if (interruptor === CAPI_CLI.VALOR_OFF && apagado) {
      mensaje = capiMantenerApagado_();
    }
  } catch (e) {
    mensaje = 'ERROR: ' + e.message;
    Logger.log('Control API: ' + e.message);
  }
  try {
    capiRegistrar_(mensaje);
  } catch (e) {
    Logger.log('Control API: no se pudo anotar en la lista: ' + e.message);
  }
}

// Con el interruptor en OFF y el archivo ya apagado: si alguien volvió a poner State 1 o recreó el activador del despachador,
// se baja de nuevo en cada pasada. Los forzados a mano no dependen del State, así que no hace falta tenerlos en 1.
// Lo que alguien puso en 1 queda guardado para que el ON lo restaure. Devuelve el mensaje para la lista ('' = sin cambios).
function capiMantenerApagado_() {
  const props = PropertiesService.getScriptProperties();
  const sueltos = capiBorrarActivadoresDescarga_();
  if (sueltos > 0) props.setProperty(CAPI_PROP_TENIA_ACTIVADOR, '1');
  if (!capiLeerApi_().filas.some(function (f) { return f.activo; })) {
    return sueltos > 0 ? 'Re-apagado: activador de descarga borrado.' : '';
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CAPI_CLI.LOCK_TIMEOUT_MS)) {
    Logger.log('Control API: hay una descarga en curso; el State se baja a 0 en la próxima pasada.');
    return '';
  }
  try {
    const t = capiLeerApi_();
    const previos = props.getProperty(CAPI_PROP_ACTIVOS);
    const claves = previos ? JSON.parse(previos) : [];
    const subidos = t.filas.filter(function (f) { return f.activo; });
    subidos.forEach(function (f) {
      if (claves.indexOf(f.clave) === -1) claves.push(f.clave);
    });
    const json = JSON.stringify(claves);
    if (json.length > CAPI_CLI.MAX_BYTES_PROP) {
      throw new Error('Hay demasiados informes activos para guardar su estado (' + json.length + ' bytes).');
    }
    props.setProperty(CAPI_PROP_ACTIVOS, json);
    subidos.forEach(function (f) {
      t.hoja.getRange(f.fila, t.c.state + 1).setValue(0);
      if (t.c.mensaje >= 0) t.hoja.getRange(f.fila, t.c.mensaje + 1).setValue('Control API en OFF: State vuelto a 0.');
    });
    Logger.log('Control API: OFF mantenido. State vuelto a 0 en ' + subidos.length + ' informe(s).');
    return 'Re-apagado: State vuelto a 0 en ' + subidos.length + ' informe(s).';
  } finally {
    lock.releaseLock();
  }
}

// Segunda barrera para el despachador: true = no descargar ahora. No llama a Salesforce.
// Si no puede leer el interruptor, no bloquea (y lo deja en el log).
function capiBloqueado_() {
  try {
    if (PropertiesService.getScriptProperties().getProperty(CAPI_PROP_APAGADO) === '1') return true;
    return capiLeerInterruptor_() === CAPI_CLI.VALOR_OFF;
  } catch (e) {
    Logger.log('Control API: no se pudo leer el interruptor (' + e.message + '); no se bloquea.');
    return false;
  }
}

// ===== LECTURA DEL INTERRUPTOR =====
function capiHojaControl_() {
  const hoja = SpreadsheetApp.openById(CAPI_CLI.ID_CONTROL).getSheetByName(CAPI_CLI.HOJA_CONTROL);
  if (!hoja) throw new Error('No existe la hoja "' + CAPI_CLI.HOJA_CONTROL + '" en el Sheet de control.');
  return hoja;
}

function capiLeerInterruptor_() {
  const valor = String(capiHojaControl_().getRange(CAPI_CLI.CELDA_INTERRUPTOR).getValue()).trim().toUpperCase();
  if (valor !== CAPI_CLI.VALOR_ON && valor !== CAPI_CLI.VALOR_OFF) {
    throw new Error('El interruptor tiene un valor inválido: "' + valor + '".');
  }
  return valor;
}

// ===== TABLA API (lectura propia, independiente de Reportes.gs) =====
function capiLeerApi_() {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CAPI_CLI.HOJA_API);
  if (!hoja) throw new Error('No existe la pestaña ' + CAPI_CLI.HOJA_API + '.');
  const nCol = Math.max(hoja.getLastColumn(), 1);
  const enc = hoja.getRange(1, 1, 1, nCol).getValues()[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const c = { reporte: enc.indexOf('reporte'), hoja: enc.indexOf('sheetname'),
              state: enc.indexOf('state'), mensaje: enc.indexOf('mensaje'),
              llamadasUltima: enc.indexOf('llamadas ultima'), ultimaEjecucion: enc.indexOf('lastexecute'),
              estado: enc.indexOf('estado'), execTime: enc.indexOf('exectime'), dias: enc.indexOf('dias'),
              desde: enc.indexOf('desde'), hasta: enc.indexOf('hasta'), horarios: enc.indexOf('horarios') };
  if (c.reporte < 0 || c.state < 0) throw new Error('Faltan las columnas Reporte y/o State en la pestaña ' + CAPI_CLI.HOJA_API + '.');
  const ultima = hoja.getLastRow();
  const datos = ultima >= 2 ? hoja.getRange(2, 1, ultima - 1, nCol).getValues() : [];
  const filas = [];
  datos.forEach(function (d, i) {
    const id = String(d[c.reporte]).trim();
    if (!id) return;
    filas.push({
      fila: i + 2,
      clave: id + '|' + (c.hoja >= 0 ? String(d[c.hoja]).trim() : ''),
      idInforme: id,
      nombreHoja: c.hoja >= 0 ? String(d[c.hoja]).trim() : '',
      activo: Number(d[c.state]) === 1,
      llamadasUltima: c.llamadasUltima >= 0 ? (Number(d[c.llamadasUltima]) || 0) : 0,
      ultimaEjecucion: c.ultimaEjecucion >= 0 ? d[c.ultimaEjecucion] : '',
      estado: c.estado >= 0 ? String(d[c.estado]).trim() : '',
      execTime: c.execTime >= 0 ? d[c.execTime] : '',
      dias: c.dias >= 0 ? d[c.dias] : '',
      desde: c.desde >= 0 ? d[c.desde] : '',
      hasta: c.hasta >= 0 ? d[c.hasta] : '',
      horarios: c.horarios >= 0 ? d[c.horarios] : ''
    });
  });
  return { hoja: hoja, c: c, filas: filas };
}

// Valor de la hoja API como texto para la hoja "Control API". Una celda con formato hora (que el despachador rechaza)
// se marca para que se vea el problema en vez de mostrar una hora inventada.
function capiTextoConfig_(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (v instanceof Date) return 'REVISAR FORMATO';
  return String(v).trim();
}

function capiBorrarActivadoresDescarga_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const h = t.getHandlerFunction();
    if (CAPI_CLI.HANDLERS_DESCARGA.indexOf(h) !== -1) {
      if (h === 'despachadorInmediato' && forzadasGuardadas_().length) return;   // forzado manual en curso: se respeta
      if (h === 'despachador') n++;
      ScriptApp.deleteTrigger(t);
    }
  });
  return n;
}

// ===== OFF =====
function capiApagar_() {
  const props = PropertiesService.getScriptProperties();
  // 1) Cortar ya los activadores, sin esperar al candado (el despachador en curso termina solo su ciclo).
  const tenia = capiBorrarActivadoresDescarga_();
  if (props.getProperty(CAPI_PROP_TENIA_ACTIVADOR) === null) {
    props.setProperty(CAPI_PROP_TENIA_ACTIVADOR, tenia > 0 ? '1' : '0');
  }
  // 2) Pasar State a 0 guardando antes cuáles estaban en 1.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CAPI_CLI.LOCK_TIMEOUT_MS)) {
    throw new Error('Hay una descarga en curso; el State se pasa a 0 en el próximo chequeo.');
  }
  try {
    const t = capiLeerApi_();
    const previos = props.getProperty(CAPI_PROP_ACTIVOS);
    const claves = previos ? JSON.parse(previos) : [];
    t.filas.forEach(function (f) {
      if (f.activo && claves.indexOf(f.clave) === -1) claves.push(f.clave);
    });
    const json = JSON.stringify(claves);
    if (json.length > CAPI_CLI.MAX_BYTES_PROP) {
      throw new Error('Hay demasiados informes activos para guardar su estado (' + json.length + ' bytes).');
    }
    props.setProperty(CAPI_PROP_ACTIVOS, json);
    t.filas.forEach(function (f) {
      if (!f.activo) return;
      t.hoja.getRange(f.fila, t.c.state + 1).setValue(0);
      if (t.c.mensaje >= 0) t.hoja.getRange(f.fila, t.c.mensaje + 1).setValue('Control API en OFF: State pasado a 0.');
    });
    props.setProperty(CAPI_PROP_APAGADO, '1');
    Logger.log('Control API: OFF aplicado. Informes que estaban activos: ' + claves.length + '.');
  } finally {
    lock.releaseLock();
  }
}

// ===== ON =====
function capiEncender_() {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CAPI_CLI.LOCK_TIMEOUT_MS)) {
    throw new Error('Hay una descarga en curso; se reintenta en el próximo chequeo.');
  }
  try {
    const previos = props.getProperty(CAPI_PROP_ACTIVOS);
    const claves = previos ? JSON.parse(previos) : [];
    let restaurados = 0;
    if (claves.length) {
      const t = capiLeerApi_();
      t.filas.forEach(function (f) {
        if (claves.indexOf(f.clave) === -1) return;
        t.hoja.getRange(f.fila, t.c.state + 1).setValue(1);
        if (t.c.mensaje >= 0) t.hoja.getRange(f.fila, t.c.mensaje + 1).setValue('Control API en ON: State restaurado.');
        restaurados++;
      });
    }
    if (props.getProperty(CAPI_PROP_TENIA_ACTIVADOR) === '1') {
      ScriptApp.getProjectTriggers().forEach(function (t) {
        if (t.getHandlerFunction() === 'despachador') ScriptApp.deleteTrigger(t);
      });
      const minutos = typeof VSR_CONFIG !== 'undefined' && VSR_CONFIG.MINUTOS_ACTIVADOR
        ? VSR_CONFIG.MINUTOS_ACTIVADOR : CAPI_CLI.MINUTOS_DESPACHADOR;
      ScriptApp.newTrigger('despachador').timeBased().everyMinutes(minutos).create();
    }
    props.deleteProperty(CAPI_PROP_ACTIVOS);
    props.deleteProperty(CAPI_PROP_TENIA_ACTIVADOR);
    props.deleteProperty(CAPI_PROP_APAGADO);
    Logger.log('Control API: ON aplicado. Informes restaurados: ' + restaurados + ' de ' + claves.length + '.');
    return { restaurados: restaurados, guardados: claves.length };
  } finally {
    lock.releaseLock();
  }
}

// Llamadas a la API de todos los informes del archivo: [última corrida de cada informe, últimas 24 h, últimas 48 h].
// Última: suma de la columna "Llamadas ultima" de la hoja API. 24 h y 48 h: se suman las cubetas por hora guardadas
// en las propiedades (registrarConsumo_), así siguen bajando con el tiempo aunque el archivo esté en OFF.
function capiSumarLlamadas_(tablaApi) {
  const det = capiLlamadasPorInforme_(tablaApi);
  let ultima = 0, h24 = 0, h48 = 0;
  det.forEach(function (d) { ultima += d.ultima; h24 += d.h24; h48 += d.h48; });
  return [ultima, h24, h48];
}

// Llamadas de cada informe: { f, ultima, h24, h48 }.
function capiLlamadasPorInforme_(tablaApi) {
  const props = PropertiesService.getScriptProperties();
  const horaActual = Math.floor(Date.now() / 3600000);
  return tablaApi.filas.map(function (f) {
    let cubetas = [];
    try { cubetas = JSON.parse(props.getProperty(VSR_PROP_CONSUMO + f.clave) || '[]'); } catch (e) { cubetas = []; }
    let h24 = 0, h48 = 0;
    cubetas.forEach(function (b) {
      if (b[0] > horaActual - 48) h48 += b[1];
      if (b[0] > horaActual - 24) h24 += b[1];
    });
    return { f: f, ultima: f.llamadasUltima, h24: h24, h48: h48 };
  });
}

// Tabla por informe en la hoja "Control API" (columnas P a AE; el Link en AF lo arma la hoja con una fórmula).
// Refleja exactamente la hoja API del archivo: una fila por informe. Cada archivo toca solo sus propias filas:
// las busca por ID de archivo + ID de informe + pestaña, borra las que ya no están en su hoja API (o están repetidas)
// y, si el informe es nuevo, reutiliza primero las filas vacías.
function capiRegistrarInformes_(hoja, ss, tablaApi) {
  const col = CAPI_CLI.COL_INFORMES;
  const ANCHO = 16;   // P a AE
  const primera = CAPI_CLI.FILA_PRIMER_ARCHIVO;
  const idArchivo = ss.getId();
  const filasMax = Math.max(hoja.getMaxRows() - primera + 1, 1);
  const actuales = hoja.getRange(primera, col, filasMax, 5).getValues();   // P a T: ID archivo, Archivo, Informe, ID informe
  const detalle = capiLlamadasPorInforme_(tablaApi);
  const vigentes = {};
  detalle.forEach(function (d) { vigentes[idArchivo + '|' + d.f.idInforme + '|' + d.f.nombreHoja] = true; });

  let ultimaOcupada = 0;
  actuales.forEach(function (r, i) {
    if (String(r[0]).trim() !== '') ultimaOcupada = i + 1;
  });
  const enFila = {};
  const libres = [];
  actuales.forEach(function (r, i) {
    const id = String(r[0]).trim();
    const fila = primera + i;
    if (id === '') {
      if (i < ultimaOcupada) libres.push(fila);
      return;
    }
    if (id !== idArchivo) return;
    const clave = id + '|' + String(r[3]).trim() + '|' + String(r[2]).trim();
    if (vigentes[clave] && !enFila[clave]) {
      enFila[clave] = fila;
    } else {
      hoja.getRange(fila, col, 1, ANCHO).clearContent();   // fila vieja o repetida
      libres.push(fila);
    }
  });
  libres.sort(function (a, b) { return a - b; });

  let siguiente = primera + ultimaOcupada;
  const horaTxt = new Date();
  detalle.forEach(function (d) {
    const clave = idArchivo + '|' + d.f.idInforme + '|' + d.f.nombreHoja;
    let fila = enFila[clave];
    if (!fila) {
      fila = libres.length ? libres.shift() : siguiente++;
      if (fila > hoja.getMaxRows()) hoja.insertRowsAfter(hoja.getMaxRows(), 20);
    }
    // Dias, Desde, Hasta y Horarios van como texto plano (si no, "5-15" o "08:30" se convierten en fecha u hora).
    hoja.getRange(fila, col + 11, 1, 4).setNumberFormat('@');
    hoja.getRange(fila, col, 1, ANCHO).setValues([[idArchivo, ss.getName(), d.f.nombreHoja, d.f.idInforme,
                                               d.ultima, d.h24, d.h48, horaTxt, d.f.ultimaEjecucion, d.f.estado,
                                               d.f.execTime === '' ? '' : Number(d.f.execTime) || capiTextoConfig_(d.f.execTime),
                                               capiTextoConfig_(d.f.dias), capiTextoConfig_(d.f.desde),
                                               capiTextoConfig_(d.f.hasta), capiTextoConfig_(d.f.horarios),
                                               d.f.activo ? 1 : 0]]);
    hoja.getRange(fila, col + 8).setNumberFormat(CAPI_CLI.FORMATO_FECHA);
  });
}

// ===== LISTA EN LA HOJA "Control API" =====
function capiRegistrar_(mensaje) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = capiHojaControl_();
  const id = ss.getId();
  const estado = PropertiesService.getScriptProperties().getProperty(CAPI_PROP_APAGADO) === '1'
    ? CAPI_CLI.VALOR_OFF : CAPI_CLI.VALOR_ON;
  let activos = '';
  let totales = '';
  let llamadas = ['', '', ''];
  try {
    const tablaApi = capiLeerApi_();
    activos = tablaApi.filas.filter(function (f) { return f.activo; }).length;
    llamadas = capiSumarLlamadas_(tablaApi);
    try {
      capiRegistrarInformes_(hoja, ss, tablaApi);
    } catch (e) {
      Logger.log('Control API: no se pudo anotar el consumo por informe: ' + e.message);
    }
    // Totales = informes bajo el control (no cuenta los apagados a mano): en OFF los guardados para el ON; en ON, los activos.
    if (estado === CAPI_CLI.VALOR_OFF) {
      const guardados = PropertiesService.getScriptProperties().getProperty(CAPI_PROP_ACTIVOS);
      totales = guardados ? JSON.parse(guardados).length : 0;
    } else {
      totales = activos;
    }
  } catch (e) {
    Logger.log('Control API: no se pudo contar los informes: ' + e.message);
  }

  const primera = CAPI_CLI.FILA_PRIMER_ARCHIVO;
  const filasMax = Math.max(hoja.getMaxRows() - primera + 1, 1);
  const ids = hoja.getRange(primera, 2, filasMax, 1).getValues();
  let fila = 0;
  let vacia = 0;
  for (let i = 0; i < ids.length; i++) {
    const v = String(ids[i][0]).trim();
    if (v === id) { fila = primera + i; break; }
    if (!v && !vacia) vacia = primera + i;
  }
  const nueva = !fila;
  if (nueva) {
    fila = vacia || hoja.getMaxRows() + 1;
    if (fila > hoja.getMaxRows()) hoja.insertRowsAfter(hoja.getMaxRows(), 10);
  }
  hoja.getRange(fila, 1, 1, 6).setValues([[ss.getName(), id, estado, new Date(), activos, totales]]);
  hoja.getRange(fila, CAPI_CLI.COL_LLAMADAS, 1, 3).setValues([llamadas]).setNumberFormat('#,##0');
  hoja.getRange(fila, CAPI_CLI.COL_VERSION).setValue(VSR_VERSION).setHorizontalAlignment('center');
  hoja.getRange(fila, CAPI_CLI.COL_PROYECTO)
    .setFormula('=HYPERLINK("https://script.google.com/home/projects/' + ScriptApp.getScriptId() + '/edit","Abrir")');
  if (nueva || mensaje) hoja.getRange(fila, 9).setValue(mensaje || 'Registrado.');
  // Situación: SIN RESPUESTA (sin chequeo hace tiempo), PENDIENTE (no coincide con el interruptor),
  // REVISAR (dice OFF pero tiene informes activos, o el último ON no restauró todos) o, si todo coincide, ON u OFF.
  hoja.getRange(fila, 7).setFormulaR1C1(
    '=IF(NOW()-RC[-3]>' + CAPI_CLI.MINUTOS_SIN_RESPUESTA + '/1440,"SIN RESPUESTA",IF(RC[-4]<>R2C2,"PENDIENTE",' +
    'IF(OR(AND(RC[-4]="' + CAPI_CLI.VALOR_OFF + '",RC[-2]<>0),LEFT(RC[2],8)="ATENCIÓN"),"REVISAR",RC[-4])))');
  hoja.getRange(fila, 10).setFormula('=HYPERLINK("' + ss.getUrl() + '","Abrir")');
}