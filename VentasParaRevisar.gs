// ===================== CONFIG =====================
const VR_SHEET_NAME = 'Ventas para Revisar';
const VR_EMAIL_TO = 'ricardoml@tiomusa.com.ar';
const VR_ASUNTO = '⚠️ Pedido para revisar';
const VR_FIRST_DATA_ROW = 2;
const VR_TRIGGER_CADA_HORAS = 3;

// Hoja "Ventas para Revisar"
const VR_NUM_COLS = 11;                 // A..K (datos)
const VR_IDX_PEDIDO_ID = 1;             // Pedido: ID dentro de A..K (columna B)
const VR_COL_PEDIDO_ID = 2;             // columna B (para detectar la última fila con datos)
const VR_COL_NOTIFICADO = 12;           // columna L
const VR_NUM_COLS_BLOQUE = 12;          // A..L (bloque que se desplaza al insertar arriba)
const VR_COL_EXCLUIDOS = 14;            // columna N (productos que no querés que te avise)
const VR_COL_PORCENTAJES = 9;           // columna I (%PMV); I..K llevan formato 0.00
const VR_NUM_COLS_PORCENTAJES = 3;      // I, J, K
const VR_MARCA_NOTIFICADO = 'SI';                 // revisado + mail enviado (automático)
const VR_MARCA_MANUAL = 'Revision Manual';        // revisado sin mail (menú manual)
const VR_HEADERS = ['Fecha', 'Pedido: ID', 'Canal de venta', 'Condicion', 'Producto',
                 'Precio', 'PMV', 'Lista', '%PMV', '%Lista', '%costo'];
const VR_HEADER_NOTIFICADO = 'Notificado';

// Estructura de la fila de ventas (indices heredados de la hoja Total; hoy se arma desde VS)
const VR_T_FECHA = 0;       // A
const VR_T_PEDIDO = 1;      // B
const VR_T_CANAL = 2;       // C
const VR_T_PRODUCTO = 4;    // E
const VR_T_PRECIO = 5;      // F
const VR_T_CONDICION = 7;   // H
const VR_T_PMV = 9;         // J
const VR_T_LISTA = 10;      // K
const VR_T_PCT_COSTO = 11;  // L
const VR_T_PCT_PMV = 12;    // M
const VR_T_PCT_LISTA = 13;  // N
const VR_T_REVISAR = 14;    // O
const VR_IDX_PRODUCTO = 4;             // E dentro de A..K
const VR_IDX_PRECIO = 5;               // F dentro de A..K
const VR_ORDEN = [VR_T_FECHA, VR_T_PEDIDO, VR_T_CANAL, VR_T_CONDICION, VR_T_PRODUCTO,
               VR_T_PRECIO, VR_T_PMV, VR_T_LISTA, VR_T_PCT_PMV, VR_T_PCT_LISTA, VR_T_PCT_COSTO];

// Filtros
const VR_UMBRAL_COSTO = 0.09;           // %costo < 0.09 (o columna O = 'revisar')
const VR_MARCA_REVISAR = 'revisar';
const VR_CANALES_EXCLUIDOS = ['TioMusaAhora12-ML', 'Mayorista'];
const VR_PRODUCTO_EXCLUIDO_FIJO = 'BENEFICIOS';
const VR_PROMO_NEGRO_TEXT = 'promo negro';
const VR_PROMO_NEGRO_MIN = -0.20;       // Promo Negro: solo entra si %costo < -0.20

const VR_DECIMALES = 2;                 // todos los números se guardan y comparan a 0.00
const VR_FORMATO_NUMERO = '0.00';
const VR_MENU_NAME = 'Revisión';
const VR_MENU_ITEM = 'Revisar ahora (sin mail)';
// ====================================================

function menuRevision() {
  SpreadsheetApp.getUi()
    .createMenu(VR_MENU_NAME)
    .addItem(VR_MENU_ITEM, 'revisionManual')
    .addItem('Revisar QR Mercadopago', 'revisarQRMercadopago')
    .addToUi();
}

// Menú manual: solo revisa y agrega filas, NO envía mail
function revisionManual() {
  vrProcesar_(false);
}

// Disparador automático: revisa, envía UN mail con todo lo nuevo y marca SI
function checkAndNotifyOffPrice() {
  vrProcesar_(true);
}

// Ciclo del disparador: avisa lo nuevo (lee VS directamente)
function ventasParaRevisarCiclo() {
  checkAndNotifyOffPrice();
}

// Ejecutar UNA sola vez a mano: deja los disparadores de Ventas para Revisar y QR Mercadopago
// (los de Resumen Cuotas se instalan con instalarTriggersCuotas)
function instalarTriggersRevision() {
  const manejadores = ['ventasParaRevisarCiclo', 'checkAndNotifyOffPrice', 'revisarQRMercadopago', 'menuRevision'];
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return manejadores.indexOf(t.getHandlerFunction()) >= 0; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('ventasParaRevisarCiclo').timeBased().everyHours(VR_TRIGGER_CADA_HORAS).create();
  ScriptApp.newTrigger(QR_HANDLER).timeBased().everyHours(QR_TRIGGER_CADA_HORAS).create();
  // Menu como trigger instalable: no pisa el onOpen que ya existe en el proyecto
  ScriptApp.newTrigger('menuRevision').forSpreadsheet(SpreadsheetApp.getActive()).onOpen().create();
  console.log('Triggers instalados: ciclo Ventas para Revisar cada ' + VR_TRIGGER_CADA_HORAS +
              ' h, QR Mercadopago cada ' + QR_TRIGGER_CADA_HORAS + ' h y menu Revision.');
}

function vrProcesar_(enviarMail) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.log('No se pudo obtener el lock, se omite esta ejecución.');
    return;
  }

  let nuevas = [];   // { row, rowNum, fecha }
  let sheet = null;

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    sheet = ss.getSheetByName(VR_SHEET_NAME) || ss.insertSheet(VR_SHEET_NAME);

    vrAsegurarEncabezados_(sheet);

    // --- Pedidos ya registrados en la hoja (pedido + producto + precio) ---
    const ultimaConDatos = vrUltimaFilaConDatos_(sheet);
    const registradas = new Set();
    if (ultimaConDatos >= VR_FIRST_DATA_ROW) {
      const existentes = sheet.getRange(VR_FIRST_DATA_ROW, 1, ultimaConDatos - VR_FIRST_DATA_ROW + 1, VR_NUM_COLS).getValues();
      for (let i = 0; i < existentes.length; i++) {
        if (String(existentes[i][VR_IDX_PEDIDO_ID]).trim()) registradas.add(vrClaveBase_(existentes[i]));
      }
    }

    const excluidos = vrLeerExcluidos_(sheet);

    // --- Datos de VS (con la regla congelada de cada pedido) ---
    const data = vrLeerVentasVS_(ss);

    for (let i = 0; i < data.length; i++) {
      const src = data[i].src;
      if (!vrCumpleFiltros_(src, excluidos)) continue;

      const row = VR_ORDEN.map(function (idx) { return vrRedondear_(src[idx]); });
      const pedidoId = String(row[VR_IDX_PEDIDO_ID]).trim();
      if (!pedidoId) continue;

      const clave = vrClaveBase_(row);
      if (registradas.has(clave)) continue;

      registradas.add(clave);
      nuevas.push({ row: row, rowNum: data[i].filaVS, fecha: src[VR_T_FECHA] });
    }

    // Más reciente primero
    nuevas.sort(function (a, b) {
      return (b.fecha instanceof Date ? b.fecha.getTime() : 0) - (a.fecha instanceof Date ? a.fecha.getTime() : 0);
    });

    // --- Un solo mail con todo lo nuevo ---
    if (enviarMail && nuevas.length > 0) {
      try {
        vrEnviarNotificacion_(nuevas);
        console.log('Mail enviado con ' + nuevas.length + ' pedido(s).');
      } catch (e) {
        console.error('Error enviando el mail: ' + e.message + '. No se guardan las filas; se reintenta en la próxima ejecución.');
        nuevas = [];
      }
    }

    console.log('Ejecución terminada. Filas agregadas: ' + nuevas.length + (enviarMail ? ' | Mails enviados: ' + (nuevas.length > 0 ? 1 : 0) : ' (sin mail)'));
  } finally {
    try {
      if (sheet && nuevas.length > 0) {
        const filas = nuevas.map(function (n) { return n.row; });
        const marca = enviarMail ? VR_MARCA_NOTIFICADO : VR_MARCA_MANUAL;

        // Desplaza solo A..L hacia abajo, así la lista de la columna N no se mueve
        sheet.getRange(VR_FIRST_DATA_ROW, 1, filas.length, VR_NUM_COLS_BLOQUE)
          .insertCells(SpreadsheetApp.Dimension.ROWS);
        sheet.getRange(VR_FIRST_DATA_ROW, 1, filas.length, VR_NUM_COLS).setValues(filas);
        sheet.getRange(VR_FIRST_DATA_ROW, VR_COL_NOTIFICADO, filas.length, 1)
          .setValues(filas.map(function () { return [marca]; }));
        sheet.getRange(VR_FIRST_DATA_ROW, VR_COL_PORCENTAJES, filas.length, VR_NUM_COLS_PORCENTAJES)
          .setNumberFormat(VR_FORMATO_NUMERO);
      }
    } catch (e) {
      console.error('Error guardando filas en la hoja: ' + e.message);
    }
    lock.releaseLock();
  }
}

// Lee VS y arma, por cada fila, el vector con la estructura de columnas que usan los filtros (indices VR_T_*)
// La marca "revisar" se calcula con la regla congelada del pedido; el % sobre costo solo si VS tiene la columna de costo.
function vrLeerVentasVS_(ss) {
  const filas = cuotasLeerVS_(ss, cuotasLeerReglas_(ss));
  return filas.map(function (f) {
    const precio = cuotasANumero_(f.precioUnitario);
    const pvm = cuotasANumero_(f.pvm);
    const lista = cuotasANumero_(f.lista);
    const costo = cuotasANumero_(f.costo);
    const condicion = String(f.condicion).trim();
    const canal = String(f.canal).trim();

    const pctCosto = (precio === null || costo === null || costo === 0) ? '' : (precio - costo) / costo;
    const pctPmv = (precio === null || !pvm) ? '' : (precio - pvm) / pvm;
    const pctLista = (precio === null || !lista) ? '' : (precio - lista) / lista;

    const mapCC = {};
    if (f.reglaCongelada) {
      mapCC[condicion] = {
        precioMinimo: f.reglaCongelada.precioMinimo === true,
        coeficiente: f.reglaCongelada.coeficiente === null ? 1 : Number(f.reglaCongelada.coeficiente)
      };
    }
    const revisar = calcularRevisarEv_(canal, condicion, precio === null ? 0 : precio, pvm === null ? 0 : pvm,
                                       lista === null ? 0 : lista, mapCC);

    const src = [];
    src[VR_T_FECHA] = f.fecha;
    src[VR_T_PEDIDO] = f.pedido;
    src[VR_T_CANAL] = canal;
    src[VR_T_PRODUCTO] = f.producto;
    src[VR_T_PRECIO] = precio === null ? '' : precio;
    src[VR_T_CONDICION] = condicion;
    src[VR_T_PMV] = pvm === null ? '' : pvm;
    src[VR_T_LISTA] = lista === null ? '' : lista;
    src[VR_T_PCT_COSTO] = pctCosto;
    src[VR_T_PCT_PMV] = pctPmv;
    src[VR_T_PCT_LISTA] = pctLista;
    src[VR_T_REVISAR] = revisar;
    return { src: src, filaVS: f.filaVS };
  });
}

// Identidad de un pedido ya registrado: pedido + producto + precio (no cambia con las condiciones ni con el costo)
function vrClaveBase_(row) {
  const precio = typeof row[VR_IDX_PRECIO] === 'number' ? String(vrRedondear_(row[VR_IDX_PRECIO])) : String(row[VR_IDX_PRECIO]).trim();
  return String(row[VR_IDX_PEDIDO_ID]).trim() + '|' + String(row[VR_IDX_PRODUCTO]).trim() + '|' + precio;
}

function vrCumpleFiltros_(r, excluidos) {
  const costo = r[VR_T_PCT_COSTO];
  const pctPmv = r[VR_T_PCT_PMV];
  const condicion = String(r[VR_T_CONDICION]).trim();
  const canal = String(r[VR_T_CANAL]).trim();
  const producto = String(r[VR_T_PRODUCTO]).trim();

  const entra = (typeof costo === 'number' && costo < VR_UMBRAL_COSTO) ||
                String(r[VR_T_REVISAR]).trim() === VR_MARCA_REVISAR;
  if (!entra) return false;

  if (VR_CANALES_EXCLUIDOS.indexOf(canal) !== -1) return false;
  if (producto === VR_PRODUCTO_EXCLUIDO_FIJO) return false;
  if (excluidos.has(producto)) return false;

  if (condicion === 'Negro' && typeof pctPmv === 'number' && pctPmv > -0.305 && pctPmv < -0.295) return false;
  if (condicion === 'Rojo' && typeof pctPmv === 'number' && pctPmv > -0.205 && pctPmv < -0.195) return false;

  // Promo Negro: solo si %costo supera el -20%
  if (condicion.toLowerCase() === VR_PROMO_NEGRO_TEXT &&
      !(typeof costo === 'number' && costo < VR_PROMO_NEGRO_MIN)) return false;

  return true;
}

function vrAsegurarEncabezados_(sheet) {
  const actuales = sheet.getRange(1, 1, 1, VR_NUM_COLS).getValues()[0];
  const vacios = actuales.every(function (v) { return String(v).trim() === ''; });
  if (vacios) sheet.getRange(1, 1, 1, VR_NUM_COLS).setValues([VR_HEADERS]);
  if (String(sheet.getRange(1, VR_COL_NOTIFICADO).getValue()).trim() === '') {
    sheet.getRange(1, VR_COL_NOTIFICADO).setValue(VR_HEADER_NOTIFICADO);
  }
  const max = sheet.getMaxRows();
  if (max >= VR_FIRST_DATA_ROW) {
    sheet.getRange(VR_FIRST_DATA_ROW, VR_COL_PORCENTAJES, max - VR_FIRST_DATA_ROW + 1, VR_NUM_COLS_PORCENTAJES)
      .setNumberFormat(VR_FORMATO_NUMERO);
  }
}

function vrUltimaFilaConDatos_(sheet) {
  const max = sheet.getMaxRows();
  if (max < VR_FIRST_DATA_ROW) return VR_FIRST_DATA_ROW - 1;
  const ids = sheet.getRange(VR_FIRST_DATA_ROW, VR_COL_PEDIDO_ID, max - VR_FIRST_DATA_ROW + 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]).trim() !== '') return VR_FIRST_DATA_ROW + i;
  }
  return VR_FIRST_DATA_ROW - 1;
}

function vrLeerExcluidos_(sheet) {
  const set = new Set();
  const max = sheet.getMaxRows();
  if (max < VR_FIRST_DATA_ROW) return set;
  const vals = sheet.getRange(VR_FIRST_DATA_ROW, VR_COL_EXCLUIDOS, max - VR_FIRST_DATA_ROW + 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    const v = String(vals[i][0]).trim();
    if (v) set.add(v);
  }
  return set;
}

function vrRedondear_(v) {
  if (typeof v !== 'number') return v;
  const f = Math.pow(10, VR_DECIMALES);
  return Math.round(v * f) / f;
}

function vrClaveFila_(row, tz) {
  return row.map(function (v) {
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    if (typeof v === 'number') return String(vrRedondear_(v));
    return String(v === null || v === undefined ? '' : v).trim();
  }).join('|');
}

// Un solo mail con todos los pedidos nuevos
function vrEnviarNotificacion_(nuevas) {
  const n = nuevas.length;
  let cuerpo = (n === 1 ? '1 pedido para revisar' : n + ' pedidos para revisar') + ':\n';

  for (let k = 0; k < n; k++) {
    const item = nuevas[k];
    cuerpo += '\n----------------------------------------\n';
    cuerpo += 'Pedido ' + (k + 1) + ' de ' + n + ' (fila ' + item.rowNum + ' de VS)\n\n';
    for (let i = 0; i < item.row.length; i++) {
      const v = item.row[i];
      const valor = v instanceof Date ? v.toLocaleDateString('es-AR') : v;
      cuerpo += VR_HEADERS[i] + ': ' + valor + '\n';
    }
  }

  MailApp.sendEmail({
    to: VR_EMAIL_TO,
    subject: n === 1 ? VR_ASUNTO : VR_ASUNTO + ' (' + n + ')',
    body: cuerpo
  });
}