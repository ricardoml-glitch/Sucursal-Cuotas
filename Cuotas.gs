/**
 * Sucursal Cuotas - control de ventas en cuotas por debajo del precio de lista.
 *
 * La hoja VS se sigue llenando con formulas. Este script LEE VS, evalua cada fila
 * por codigo (evaluarFila_) y escribe el resultado en la hoja Resumen.
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
    producto: 'Producto', precioUnitario: 'Precio Unitario', cobranza: 'Cobranza', cuotas: 'Cobranza 2',
    lista: 'Precio', pvm: 'PVM', canal: 'Canal de venta', referencia: 'Referenia'
  },

  // Columnas de Resumen (A:H). La columna I (hoy/ayer) no se toca.
  ENCABEZADO_RESUMEN: [
    'Fecha', 'Sucursal', 'Pedido: ID', 'Condición Comercial', 'Producto', 'Precio Unitario',
    'Plan', 'Canal de venta'
  ],
  // Columnas extra de Resumen (J:K), la I (hoy/ayer) no se toca
  COL_EXTRA_RESUMEN: 10,
  ENCABEZADO_EXTRA_RESUMEN: ['Precio esperado', 'Regla aplicada'],

  // Hoja de condiciones comerciales (la baja la hoja API) y sus encabezados
  HOJA_CONDICIONES: 'condiciones comerciales',
  CONDICIONES: {
    codigo: 'Condición Comercial: Código', precioMinimo: 'Precio Mínimo',
    coeficiente: 'Coeficiente sobre precio', precioLista: 'Asignar precio lista'
  },
  // Condiciones que no se analizan (no tienen cobranza en G ni H)
  CONDICIONES_NO_ANALIZAR: ['Deposito Bancario'],
  // Combinaciones canal de venta + condicion comercial que no se analizan
  CANAL_CONDICION_NO_ANALIZAR: [
    { canal: 'TioMusa-ML', condicion: 'MercadoPago' }
  ],
  // Sucursales que no se analizan
  SUCURSALES_NO_ANALIZAR: ['FULFILLMENT'],
  // Si la condicion no define base de precio (Precio Minimo y Asignar precio lista en FALSE):
  // 'omitir' = no se controla | 'lista' = contra precio de lista | 'pvm' = contra PVM
  SIN_BASE: 'omitir',
  CONTROLAR_CUOTAS_NOMBRE: true,           // la cuota que dice el nombre de la condicion debe coincidir con la cobrada (VS col H)
  PATRON_CUOTAS_NOMBRE: '(\\d+)\\s*cuotas?', // ej. "6 Cuotas Verde", "MP 12 Cuotas"
  TOLERANCIA_PESOS: 1,                     // diferencia aceptada por redondeos
  USAR_REGLA_CUOTAS_SIN_CONDICION: true,   // condiciones que no estan en la hoja: regla anterior por cuotas

  // Reglas anteriores (por cuotas)
  COND_QR_MINIMO: 'QR 3/6 Visa Master',   // se compara contra PVM en vez de Precio de lista
  RESUMEN_EXCLUIR_COND: ['QR 3s m-s'],
  // Combinaciones sucursal + condicion comercial que no van a Resumen
  RESUMEN_EXCLUIR_PAR: [
    { sucursal: 'FACT ELECTRONICA', condicion: 'MercadoPago' }
  ],
  RESUMEN_CANAL_WEB: 'PaginaWeb',          // PaginaWeb solo entra si la referencia contiene el texto de abajo
  RESUMEN_WEB_REFERENCIA: 'mostrador',

  // Triggers (se instalan una vez con instalarTriggersCuotas)
  INTERVALO_HORAS: 1,   // el resumen se actualiza cada N horas
  ESPERA_LOCK_MS: 30000
};

// ============================ TRIGGERS ============================
function instalarTriggersCuotas() {
  const manejadores = ['actualizarResumenCuotas', 'menuCuotas'];
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return manejadores.indexOf(t.getHandlerFunction()) >= 0; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('actualizarResumenCuotas').timeBased().everyHours(CUOTAS_CFG.INTERVALO_HORAS).create();
  // Menu como trigger instalable: no pisa un onOpen que ya exista en el proyecto
  ScriptApp.newTrigger('menuCuotas').forSpreadsheet(SpreadsheetApp.getActive()).onOpen().create();
  cuotasLog_('INFO', 'Triggers instalados: resumen cada ' + CUOTAS_CFG.INTERVALO_HORAS + ' h y menu Cuotas');
}

// ============================= MENU =============================
function menuCuotas() {
  SpreadsheetApp.getUi()
    .createMenu('Cuotas')
    .addItem('Actualizar Resumen', 'actualizarResumenCuotas')
    .addItem('Ver Log', 'irALogCuotas')
    .addToUi();
}

function irALogCuotas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CUOTAS_CFG.HOJA_LOG);
  if (sh) ss.setActiveSheet(sh);
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
    const reglas = cuotasLeerReglas_(ss);
    const filas = cuotasLeerVS_(ss, reglas);
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
function cuotasLeerVS_(ss, reglas) {
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
    Object.assign(fila, evaluarFila_(fila, reglas));
    filas.push(fila);
  }
  return filas;
}

// ============================ REGLAS ============================
function cuotasClave_(v) {
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase();
}

function cuotasLeerReglas_(ss) {
  const reglas = {};
  const sh = ss.getSheetByName(CUOTAS_CFG.HOJA_CONDICIONES);
  if (!sh) {
    cuotasLog_('WARN', 'No existe la hoja "' + CUOTAS_CFG.HOJA_CONDICIONES + '", solo rige la regla por cuotas');
    return reglas;
  }
  const datos = sh.getDataRange().getValues();
  const enc = datos[0].map(function (h) { return String(h).trim(); });
  const col = {};
  Object.keys(CUOTAS_CFG.CONDICIONES).forEach(function (k) {
    const i = enc.indexOf(CUOTAS_CFG.CONDICIONES[k]);
    if (i < 0) throw new Error('"' + CUOTAS_CFG.HOJA_CONDICIONES + '": no existe la columna "' + CUOTAS_CFG.CONDICIONES[k] + '"');
    col[k] = i;
  });
  for (let r = 1; r < datos.length; r++) {
    const f = datos[r];
    const nombre = cuotasClave_(f[col.codigo]);
    if (nombre === '') continue;
    reglas[nombre] = {
      nombre: String(f[col.codigo]).trim(),
      precioMinimo: f[col.precioMinimo] === true || String(f[col.precioMinimo]).toUpperCase() === 'TRUE',
      precioLista: f[col.precioLista] === true || String(f[col.precioLista]).toUpperCase() === 'TRUE',
      coeficiente: cuotasANumero_(f[col.coeficiente])
    };
  }
  return reglas;
}

function cuotasANumero_(v) {
  if (typeof v === 'number') return v;
  if (v === '' || v === null || v === undefined) return null;
  const txt = String(v).trim();
  const n = txt.indexOf(',') >= 0 ? parseFloat(txt.replace(/\./g, '').replace(',', '.')) : parseFloat(txt);
  return isNaN(n) ? null : n;
}

/**
 * Evalua una fila de VS. Para sumar o cambiar reglas se toca solo esta parte.
 * Devuelve { estado: '' | 'ok' | 'bien' | 'revisar', esperado, regla }.
 */
function evaluarFila_(f, reglas) {
  const noAnalizar = CUOTAS_CFG.CONDICIONES_NO_ANALIZAR.some(function (c) {
    return cuotasClave_(c) === cuotasClave_(f.condicion);
  }) || CUOTAS_CFG.SUCURSALES_NO_ANALIZAR.some(function (s) {
    return cuotasClave_(s) === cuotasClave_(f.sucursal);
  }) || CUOTAS_CFG.CANAL_CONDICION_NO_ANALIZAR.some(function (p) {
    return cuotasClave_(p.canal) === cuotasClave_(f.canal) && cuotasClave_(p.condicion) === cuotasClave_(f.condicion);
  });
  if (noAnalizar) return { estado: '', esperado: '', regla: '' };
  const regla = reglas[cuotasClave_(f.condicion)];
  if (regla) return evaluarPorCondicion_(f, regla);
  // Condicion que no esta en la hoja: igual se controla la cuota que dice el nombre
  const cuotas = evaluarCuotasNombre_(f, { nombre: f.condicion });
  const estadoCuotas = CUOTAS_CFG.USAR_REGLA_CUOTAS_SIN_CONDICION ? evaluarCuotas_(f) : '';
  if (!cuotas.ok) return { estado: 'revisar', esperado: '', regla: cuotas.detalle };
  if (CUOTAS_CFG.USAR_REGLA_CUOTAS_SIN_CONDICION) {
    return { estado: estadoCuotas, esperado: '', regla: 'cuotas' };
  }
  return { estado: '', esperado: '', regla: '' };
}

// Condicion comercial de la hoja: precio esperado = base (lista o PVM) x coeficiente,
// y la cuota del nombre de la condicion debe coincidir con la cuota cobrada
function evaluarPorCondicion_(f, regla) {
  const precio = evaluarPrecioCondicion_(f, regla);
  const cuotas = evaluarCuotasNombre_(f, regla);
  if (cuotas.detalle === '') return precio;
  return {
    estado: cuotas.ok ? precio.estado : 'revisar',
    esperado: precio.esperado,
    regla: (precio.regla ? precio.regla + ' | ' : '') + cuotas.detalle
  };
}

function evaluarPrecioCondicion_(f, regla) {
  let base = null;
  let nombreBase = '';
  if (regla.precioLista) { base = cuotasANumero_(f.lista); nombreBase = 'Lista'; }
  else if (regla.precioMinimo) { base = cuotasANumero_(f.pvm); nombreBase = 'PVM'; }
  else if (CUOTAS_CFG.SIN_BASE === 'lista') { base = cuotasANumero_(f.lista); nombreBase = 'Lista'; }
  else if (CUOTAS_CFG.SIN_BASE === 'pvm') { base = cuotasANumero_(f.pvm); nombreBase = 'PVM'; }
  else return { estado: '', esperado: '', regla: '' };

  if (regla.coeficiente === null) return { estado: '', esperado: '', regla: '' };
  const etiqueta = nombreBase + ' x ' + regla.coeficiente;
  const pu = cuotasANumero_(f.precioUnitario);
  if (base === null || pu === null) return { estado: 'revisar', esperado: '', regla: etiqueta + ' (falta precio)' };

  const esperado = Math.round(base * regla.coeficiente * 100) / 100;
  let estado;
  if (pu < esperado - CUOTAS_CFG.TOLERANCIA_PESOS) estado = 'revisar';
  else if (pu <= esperado + CUOTAS_CFG.TOLERANCIA_PESOS) estado = 'ok';
  else estado = 'bien';
  return { estado: estado, esperado: esperado, regla: etiqueta };
}

// Cuotas que dice el nombre de la condicion vs cuota cobrada (Cobranza 2).
// Si la cobranza no tiene dato (vacio, X o #N/A) no se puede verificar y no se marca.
function evaluarCuotasNombre_(f, regla) {
  const vacio = { ok: true, detalle: '' };
  if (!CUOTAS_CFG.CONTROLAR_CUOTAS_NOMBRE) return vacio;
  const m = String(regla.nombre).match(new RegExp(CUOTAS_CFG.PATRON_CUOTAS_NOMBRE, 'i'));
  if (!m) return vacio;
  const esperadas = parseInt(m[1], 10);
  const cobranza = String(f.cobranza === null || f.cobranza === undefined ? '' : f.cobranza).trim().toUpperCase();
  if (cobranza === '' || cobranza === 'X' || cobranza === '#N/A') return vacio;
  const cobradas = cuotasANumero_(f.cuotas);
  if (cobradas === null) return vacio;
  if (cobradas === esperadas) return { ok: true, detalle: 'Cuotas ' + esperadas + ' ok' };
  return { ok: false, detalle: 'Cuotas: condicion ' + esperadas + ', cobradas ' + cobradas };
}

// Regla anterior por cuotas (condiciones que no estan en la hoja)
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
  const excluido = CUOTAS_CFG.RESUMEN_EXCLUIR_PAR.some(function (p) {
    return cuotasClave_(p.sucursal) === cuotasClave_(f.sucursal) && cuotasClave_(p.condicion) === cuotasClave_(f.condicion);
  });
  if (excluido) return false;
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
  sh.getRange(1, CUOTAS_CFG.COL_EXTRA_RESUMEN, sh.getMaxRows(), 2).clearContent();
  sh.getRange(1, CUOTAS_CFG.COL_EXTRA_RESUMEN, 1, 2).setValues([CUOTAS_CFG.ENCABEZADO_EXTRA_RESUMEN]);
  if (filas.length) {
    const valores = filas.map(function (f) {
      return [f.fecha, f.sucursal, f.pedido, f.condicion, f.producto, f.precioUnitario, f.cuotas, f.canal];
    });
    sh.getRange(2, 1, valores.length, nCols).setValues(valores);
    const extra = filas.map(function (f) { return [f.esperado, f.regla]; });
    sh.getRange(2, CUOTAS_CFG.COL_EXTRA_RESUMEN, extra.length, 2).setValues(extra);
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
