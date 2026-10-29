/**
 * Sucursal Cuotas - control de ventas en cuotas por debajo del precio de lista.
 *
 * La hoja VS se sigue llenando con formulas. Este script LEE VS, evalua cada fila
 * por codigo (evaluarCuotas_) y escribe el resultado en la hoja Resumen.
 * No modifica VS.
 */

// =========================== CONFIGURACION ===========================
const CFG = {
  HOJA_VS: 'VS',
  HOJA_RESUMEN: 'Resumen',
  HOJA_LOG: 'Log Cuotas',
  MAX_FILAS_LOG: 300,

  // Encabezados de VS que lee el script
  VS: {
    fecha: 'Fecha', sucursal: 'Sucursal', pedido: 'Pedido: ID', condicion: 'Condición Comercial',
    producto: 'Producto', precioUnitario: 'Precio Unitario', cuotas: 'Cobranza 2',
    lista: 'Precio', pvm: 'PVM', canal: 'Canal de venta', referencia: 'Referenia'
  },

  // Columnas de Resumen (A:H). La columna I (hoy/ayer) no se toca.
  ENCABEZADO_RESUMEN: [
    'Fecha', 'Sucursal', 'Pedido: ID', 'Condición Comercial', 'Producto', 'Precio Unitario',
    'Cobranza 2', 'Canal de venta'
  ],

  // Reglas
  COND_QR_MINIMO: 'QR 3/6 Visa Master',   // se compara contra PVM en vez de Precio de lista
  RESUMEN_EXCLUIR_COND: ['QR 3s m-s'],
  RESUMEN_CANAL_WEB: 'PaginaWeb',          // PaginaWeb solo entra si la referencia contiene el texto de abajo
  RESUMEN_WEB_REFERENCIA: 'mostrador',

  // Triggers (se instalan una vez con instalarTriggers)
  HORAS_TRIGGER: [8, 13, 16],
  MINUTO_TRIGGER: 20,
  ESPERA_LOCK_MS: 30000
};

// ============================= MENU =============================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Cuotas')
    .addItem('Actualizar Resumen', 'actualizarResumen')
    .addToUi();
}

function instalarTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'actualizarResumen'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  CFG.HORAS_TRIGGER.forEach(function (h) {
    ScriptApp.newTrigger('actualizarResumen').timeBased().everyDays(1).atHour(h).nearMinute(CFG.MINUTO_TRIGGER).create();
  });
  log_('INFO', 'Triggers instalados a las ' + CFG.HORAS_TRIGGER.join(', ') + ' h');
}

// ========================= PROCESO PRINCIPAL =========================
function actualizarResumen() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG.ESPERA_LOCK_MS)) {
    log_('WARN', 'Otra ejecucion en curso, se omite');
    return;
  }
  const t0 = Date.now();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const filas = leerVS_(ss);
    const revisar = filas.filter(esParaResumen_);
    revisar.sort(function (a, b) { return fechaMs_(b.fecha) - fechaMs_(a.fecha); });
    escribirResumen_(ss, revisar);
    log_('OK', 'VS: ' + filas.length + ' filas leidas | Resumen: ' + revisar.length + ' | ' + (Date.now() - t0) + ' ms');
  } catch (e) {
    log_('ERROR', e.message + (e.stack ? ' | ' + e.stack.split('\n')[1] : ''));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

// =========================== LECTURA ===========================
function leerVS_(ss) {
  const sh = ss.getSheetByName(CFG.HOJA_VS);
  if (!sh) throw new Error('Falta la hoja "' + CFG.HOJA_VS + '"');
  const datos = sh.getDataRange().getValues();
  const enc = datos[0].map(function (h) { return String(h).trim(); });
  const col = {};
  Object.keys(CFG.VS).forEach(function (k) {
    const i = enc.indexOf(CFG.VS[k]);
    if (i < 0) throw new Error('VS: no existe la columna "' + CFG.VS[k] + '"');
    col[k] = i;
  });
  const filas = [];
  for (let r = 1; r < datos.length; r++) {
    const f = datos[r];
    if (String(f[col.pedido]).trim() === '') continue;
    const fila = {};
    Object.keys(col).forEach(function (k) { fila[k] = f[col[k]]; });
    fila.estado = evaluarCuotas_(fila);
    filas.push(fila);
  }
  return filas;
}

// ============================ REGLAS ============================
function aNumero_(v) {
  if (typeof v === 'number') return v;
  if (v === '' || v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

/**
 * Evalua una fila de VS. Para sumar o cambiar reglas se toca solo esta funcion.
 * Devuelve '' (no aplica), 'ok', 'bien' o 'revisar'.
 */
function evaluarCuotas_(f) {
  const cuotas = aNumero_(f.cuotas);
  if (cuotas === null || cuotas <= 1) return '';

  const pu = aNumero_(f.precioUnitario);
  const lista = aNumero_(f.lista);
  const pvm = aNumero_(f.pvm);

  if (String(f.condicion) === CFG.COND_QR_MINIMO) {
    return (pu === null || pvm === null || pu < pvm) ? 'revisar' : 'ok';
  }
  if (pu === null || lista === null) return 'revisar'; // sin precio de lista no se puede validar
  if (pu === lista) return 'ok';
  return pu < lista ? 'revisar' : 'bien';
}

function esParaResumen_(f) {
  if (f.estado !== 'revisar') return false;
  if (CFG.RESUMEN_EXCLUIR_COND.indexOf(String(f.condicion)) >= 0) return false;
  if (String(f.canal) === CFG.RESUMEN_CANAL_WEB) {
    return String(f.referencia).toLowerCase().indexOf(CFG.RESUMEN_WEB_REFERENCIA) >= 0;
  }
  return true;
}

function fechaMs_(d) {
  return d instanceof Date ? d.getTime() : 0;
}

// =========================== ESCRITURA ===========================
function escribirResumen_(ss, filas) {
  const sh = ss.getSheetByName(CFG.HOJA_RESUMEN) || ss.insertSheet(CFG.HOJA_RESUMEN);
  const nCols = CFG.ENCABEZADO_RESUMEN.length;
  sh.getRange(1, 1, sh.getMaxRows(), nCols).clearContent(); // tambien saca el QUERY viejo de A1
  sh.getRange(1, 1, 1, nCols).setValues([CFG.ENCABEZADO_RESUMEN]);
  if (filas.length) {
    const valores = filas.map(function (f) {
      return [f.fecha, f.sucursal, f.pedido, f.condicion, f.producto, f.precioUnitario, f.cuotas, f.canal];
    });
    sh.getRange(2, 1, valores.length, nCols).setValues(valores);
  }
}

// ============================== LOG ==============================
function log_(nivel, mensaje) {
  Logger.log('[' + nivel + '] ' + mensaje);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(CFG.HOJA_LOG) || ss.insertSheet(CFG.HOJA_LOG);
    if (sh.getLastRow() === 0) sh.appendRow(['Fecha', 'Nivel', 'Mensaje']);
    sh.appendRow([new Date(), nivel, mensaje]);
    const sobran = sh.getLastRow() - 1 - CFG.MAX_FILAS_LOG;
    if (sobran > 0) sh.deleteRows(2, sobran);
  } catch (e) {
    Logger.log('No se pudo escribir el log: ' + e.message);
  }
}
