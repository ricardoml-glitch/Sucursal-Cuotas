/**
 * Sucursal Cuotas - control de ventas en cuotas por debajo del precio de lista.
 *
 * La hoja VS se sigue llenando con formulas. Este script LEE VS, evalua cada fila
 * por codigo (evaluarCuotas_) y escribe el resultado en la hoja Resumen.
 * No modifica VS.
 */

// =========================== CONFIGURACION ===========================
const CUOTAS_CFG = {
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

  // Triggers (se instalan una vez con instalarTriggersCuotas)
  HORAS_TRIGGER: [8, 13, 16],
  MINUTO_TRIGGER: 20,
  ESPERA_LOCK_MS: 30000
};

// ============================ TRIGGERS ============================
function instalarTriggersCuotas() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'actualizarResumenCuotas'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  CUOTAS_CFG.HORAS_TRIGGER.forEach(function (h) {
    ScriptApp.newTrigger('actualizarResumenCuotas').timeBased().everyDays(1).atHour(h).nearMinute(CUOTAS_CFG.MINUTO_TRIGGER).create();
  });
  cuotasLog_('INFO', 'Triggers instalados a las ' + CUOTAS_CFG.HORAS_TRIGGER.join(', ') + ' h');
}

// ========================= PROCESO PRINCIPAL =========================
function actualizarResumenCuotas() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CUOTAS_CFG.ESPERA_LOCK_MS)) {
    cuotasLog_('WARN', 'Otra ejecucion en curso, se omite');
    return;
  }
  const t0 = Date.now();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const filas = cuotasLeerVS_(ss);
    const revisar = filas.filter(cuotasEsParaResumen_);
    revisar.sort(function (a, b) { return cuotasFechaMs_(b.fecha) - cuotasFechaMs_(a.fecha); });
    cuotasEscribirResumen_(ss, revisar);
    cuotasLog_('OK', 'VS: ' + filas.length + ' filas leidas | Resumen: ' + revisar.length + ' | ' + (Date.now() - t0) + ' ms');
  } catch (e) {
    cuotasLog_('ERROR', e.message + (e.stack ? ' | ' + e.stack.split('\n')[1] : ''));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

// =========================== LECTURA ===========================
function cuotasLeerVS_(ss) {
  const sh = ss.getSheetByName(CUOTAS_CFG.HOJA_VS);
  if (!sh) throw new Error('Falta la hoja "' + CUOTAS_CFG.HOJA_VS + '"');
  const datos = sh.getDataRange().getValues();
  const enc = datos[0].map(function (h) { return String(h).trim(); });
  const col = {};
  Object.keys(CUOTAS_CFG.VS).forEach(function (k) {
    const i = enc.indexOf(CUOTAS_CFG.VS[k]);
    if (i < 0) throw new Error('VS: no existe la columna "' + CUOTAS_CFG.VS[k] + '"');
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
function cuotasANumero_(v) {
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
  const cuotas = cuotasANumero_(f.cuotas);
  if (cuotas === null || cuotas <= 1) return '';

  const pu = cuotasANumero_(f.precioUnitario);
  const lista = cuotasANumero_(f.lista);
  const pvm = cuotasANumero_(f.pvm);

  if (String(f.condicion) === CUOTAS_CFG.COND_QR_MINIMO) {
    return (pu === null || pvm === null || pu < pvm) ? 'revisar' : 'ok';
  }
  if (pu === null || lista === null) return 'revisar'; // sin precio de lista no se puede validar
  if (pu === lista) return 'ok';
  return pu < lista ? 'revisar' : 'bien';
}

function cuotasEsParaResumen_(f) {
  if (f.estado !== 'revisar') return false;
  if (CUOTAS_CFG.RESUMEN_EXCLUIR_COND.indexOf(String(f.condicion)) >= 0) return false;
  if (String(f.canal) === CUOTAS_CFG.RESUMEN_CANAL_WEB) {
    return String(f.referencia).toLowerCase().indexOf(CUOTAS_CFG.RESUMEN_WEB_REFERENCIA) >= 0;
  }
  return true;
}

function cuotasFechaMs_(d) {
  return d instanceof Date ? d.getTime() : 0;
}

// =========================== ESCRITURA ===========================
function cuotasEscribirResumen_(ss, filas) {
  const sh = ss.getSheetByName(CUOTAS_CFG.HOJA_RESUMEN) || ss.insertSheet(CUOTAS_CFG.HOJA_RESUMEN);
  const nCols = CUOTAS_CFG.ENCABEZADO_RESUMEN.length;
  sh.getRange(1, 1, sh.getMaxRows(), nCols).clearContent(); // tambien saca el QUERY viejo de A1
  sh.getRange(1, 1, 1, nCols).setValues([CUOTAS_CFG.ENCABEZADO_RESUMEN]);
  if (filas.length) {
    const valores = filas.map(function (f) {
      return [f.fecha, f.sucursal, f.pedido, f.condicion, f.producto, f.precioUnitario, f.cuotas, f.canal];
    });
    sh.getRange(2, 1, valores.length, nCols).setValues(valores);
  }
}

// ============================== LOG ==============================
function cuotasLog_(nivel, mensaje) {
  Logger.log('[' + nivel + '] ' + mensaje);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(CUOTAS_CFG.HOJA_LOG) || ss.insertSheet(CUOTAS_CFG.HOJA_LOG);
    if (sh.getLastRow() === 0) sh.appendRow(['Fecha', 'Nivel', 'Mensaje']);
    sh.appendRow([new Date(), nivel, mensaje]);
    const sobran = sh.getLastRow() - 1 - CUOTAS_CFG.MAX_FILAS_LOG;
    if (sobran > 0) sh.deleteRows(2, sobran);
  } catch (e) {
    Logger.log('No se pudo escribir el log: ' + e.message);
  }
}
