// ===================== CONFIG (revisión QR Mercadopago) =====================
const QR_SHEET_NAME = 'QR Mercadopago';
const QR_REVIEW_SHEET_NAME = 'Revisar Cupones';
const QR_MAL_SHEET_NAME = 'QR mal cobrado';
const QR_FIRST_DATA_ROW = 2;
const QR_NUM_COLS = 9;                // A..I de "QR Mercadopago"

// Columnas de "QR Mercadopago" (base 0: A=0, B=1, ...)
const QR_IDX_FECHA = 0;               // A: Fecha del pedido
const QR_IDX_PEDIDO = 1;              // B: Pedido: ID
const QR_IDX_SUCURSAL = 2;            // C: Sucursal
const QR_IDX_PRECIO = 3;              // D: Precio Unitario
const QR_IDX_DESCUENTO = 4;           // E: Importe Descuento
const QR_IDX_PCT_DESCUENTO = 5;       // F: % Descuento

// Reglas
const QR_MIN_PEDIDO = 300000;         // el descuento corresponde desde este monto (inclusive)
const QR_MAX_DESCUENTO = 30000;       // tope de descuento por pedido
const QR_PCT_ESPERADO = 0;            // % Descuento siempre en 0
const QR_TOLERANCIA = 0.0001;

// Mail de alerta
const QR_EMAIL_TO = 'ricardoml@tiomusa.com.ar';
const QR_ASUNTO = '⚠️ QR mal cobrado';

// Hoja "Revisar Cupones": TODOS los pedidos, con check (columnas base 1)
const QR_HEADER_FECHA = 'Fecha pedido';
const QR_HEADER_SUCURSAL = 'Sucursal';
const QR_REVIEW_HEADERS = ['Revisado', 'Pedido: ID', QR_HEADER_FECHA, QR_HEADER_SUCURSAL, 'Total pedido', 'Descuento total',
                           'Motivo', 'Filas en QR Mercadopago', 'Detectado'];
const QR_REV_COL_CHECK = 1;           // A
const QR_REV_COL_PEDIDO = 2;          // B
const QR_REV_COL_FECHA = 3;           // C (fecha del pedido)
const QR_REV_COL_SUCURSAL = 4;        // D
const QR_REV_COL_TOTAL = 5;           // E (E y F llevan formato de monto)
const QR_REV_NUM_COLS = 9;            // A..I (la última es la fecha de detección)

// Hoja "QR mal cobrado": solo pedidos que no cumplen las reglas
const QR_MAL_HEADERS = ['Pedido: ID', QR_HEADER_FECHA, QR_HEADER_SUCURSAL, 'Total pedido', 'Descuento total',
                        'Motivo', 'Filas en QR Mercadopago', 'Detectado'];
const QR_MAL_COL_PEDIDO = 1;          // A
const QR_MAL_COL_FECHA = 2;           // B (fecha del pedido)
const QR_MAL_COL_SUCURSAL = 3;        // C
const QR_MAL_COL_TOTAL = 4;           // D (D y E llevan formato de monto)
const QR_MAL_NUM_COLS = 8;            // A..H (la última es la fecha de detección)

const QR_FORMATO_MONTO = '#,##0.00';
const QR_FORMATO_FECHA = 'dd/MM/yyyy HH:mm';
const QR_FORMATO_FECHA_PEDIDO = 'dd/MM/yyyy';

const QR_LOCK_TIMEOUT_MS = 30000;
const QR_TRIGGER_CADA_HORAS = 3;
const QR_HANDLER = 'revisarQRMercadopago';
// ===========================================================================

// Ejecutar a mano o por disparador:
// - "Revisar Cupones": agrega todos los pedidos nuevos (una sola vez cada uno)
// - "QR mal cobrado": agrega los pedidos que no cumplen las reglas (una sola vez cada uno)
//   y avisa por mail (un solo mail con todos los nuevos)
function revisarQRMercadopago() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(QR_LOCK_TIMEOUT_MS)) {
    console.log('revisarQRMercadopago: no se pudo obtener el lock, se omite esta ejecución.');
    return;
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(QR_SHEET_NAME);
    if (!sheet) {
      console.error('revisarQRMercadopago: no existe la hoja "' + QR_SHEET_NAME + '".');
      return;
    }

    const review = obtenerHojaQR_(ss, QR_REVIEW_SHEET_NAME, QR_REVIEW_HEADERS);
    const mal = obtenerHojaQR_(ss, QR_MAL_SHEET_NAME, QR_MAL_HEADERS);

    const lastRow = sheet.getLastRow();
    if (lastRow < QR_FIRST_DATA_ROW) {
      console.log('revisarQRMercadopago: "' + QR_SHEET_NAME + '" no tiene datos.');
      return;
    }
    const data = sheet.getRange(QR_FIRST_DATA_ROW, 1, lastRow - QR_FIRST_DATA_ROW + 1, QR_NUM_COLS).getValues();

    // --- Agrupar por pedido ---
    const pedidos = new Map();
    for (let i = 0; i < data.length; i++) {
      const f = data[i];
      const id = String(f[QR_IDX_PEDIDO]).trim();
      if (!id) continue;

      if (!pedidos.has(id)) {
        pedidos.set(id, { total: 0, descuento: 0, pctDistinto: false, filas: [], sucursales: [], fecha: '' });
      }
      const p = pedidos.get(id);
      p.total += numeroQR_(f[QR_IDX_PRECIO]);
      p.descuento += numeroQR_(f[QR_IDX_DESCUENTO]);
      if (Math.abs(numeroQR_(f[QR_IDX_PCT_DESCUENTO]) - QR_PCT_ESPERADO) > QR_TOLERANCIA) {
        p.pctDistinto = true;
      }
      if (p.fecha === '' && f[QR_IDX_FECHA] !== '' && f[QR_IDX_FECHA] !== null && f[QR_IDX_FECHA] !== undefined) p.fecha = f[QR_IDX_FECHA];
      const suc = String(f[QR_IDX_SUCURSAL] === null || f[QR_IDX_SUCURSAL] === undefined ? '' : f[QR_IDX_SUCURSAL]).trim();
      if (suc && p.sucursales.indexOf(suc) === -1) p.sucursales.push(suc);
      p.filas.push(QR_FIRST_DATA_ROW + i);
    }

    // --- Hojas que ya existian sin las columnas Fecha pedido / Sucursal: se agregan y se completan ---
    asegurarColumnaQR_(review, QR_REV_COL_PEDIDO, QR_REV_COL_PEDIDO, QR_HEADER_FECHA, pedidos, function (p) { return p.fecha; }, QR_FORMATO_FECHA_PEDIDO);
    asegurarColumnaQR_(review, QR_REV_COL_PEDIDO, QR_REV_COL_FECHA, QR_HEADER_SUCURSAL, pedidos, function (p) { return p.sucursales.join(', '); }, null);
    asegurarColumnaQR_(mal, QR_MAL_COL_PEDIDO, QR_MAL_COL_PEDIDO, QR_HEADER_FECHA, pedidos, function (p) { return p.fecha; }, QR_FORMATO_FECHA_PEDIDO);
    asegurarColumnaQR_(mal, QR_MAL_COL_PEDIDO, QR_MAL_COL_FECHA, QR_HEADER_SUCURSAL, pedidos, function (p) { return p.sucursales.join(', '); }, null);

    // --- Pedidos ya cargados en cada hoja (tildados o no): no se repiten ---
    const registradosRev = leerPedidosRegistradosQR_(review, QR_REV_COL_PEDIDO);
    const registradosMal = leerPedidosRegistradosQR_(mal, QR_MAL_COL_PEDIDO);

    // --- Evaluar reglas y armar filas nuevas para cada hoja ---
    const ahora = new Date();
    const filasRev = [];
    let filasMal = [];
    pedidos.forEach(function (p, id) {
      const total = redondearQR_(p.total);
      const descuento = redondearQR_(p.descuento);
      const motivos = [];

      if (p.pctDistinto) {
        motivos.push('% Descuento distinto de 0');
      }
      if (descuento > QR_MAX_DESCUENTO + QR_TOLERANCIA) {
        motivos.push('Descuento total $' + formatearMontoQR_(descuento) +
                     ' supera el tope de $' + formatearMontoQR_(QR_MAX_DESCUENTO));
      }
      if (descuento > QR_TOLERANCIA && total < QR_MIN_PEDIDO) {
        motivos.push('Tiene descuento pero el pedido ($' + formatearMontoQR_(total) +
                     ') no llega a $' + formatearMontoQR_(QR_MIN_PEDIDO));
      }

      const motivoTexto = motivos.join(' | ');
      const filasTexto = p.filas.join(', ');
      const sucursalTexto = p.sucursales.join(', ');

      if (!registradosRev.has(id)) {
        registradosRev.add(id);
        filasRev.push([false, id, p.fecha, sucursalTexto, total, descuento, motivoTexto, filasTexto, ahora]);
      }
      if (motivos.length > 0 && !registradosMal.has(id)) {
        registradosMal.add(id);
        filasMal.push([id, p.fecha, sucursalTexto, total, descuento, motivoTexto, filasTexto, ahora]);
      }
    });

    // --- Un solo mail con todos los mal cobrados nuevos ---
    // Si el mail falla, no se guardan en "QR mal cobrado" y se reintenta en la próxima ejecución
    if (filasMal.length > 0) {
      try {
        enviarMailMalCobradoQR_(filasMal);
        console.log('revisarQRMercadopago: mail enviado con ' + filasMal.length + ' pedido(s) mal cobrado(s).');
      } catch (e) {
        console.error('revisarQRMercadopago: error enviando el mail: ' + e.message +
                      '. No se guardan en "' + QR_MAL_SHEET_NAME + '"; se reintenta en la próxima ejecución.');
        filasMal = [];
      }
    }

    // --- Escribir "Revisar Cupones" ---
    if (filasRev.length > 0) {
      const start = Math.max(review.getLastRow(), QR_FIRST_DATA_ROW - 1) + 1;
      review.getRange(start, 1, filasRev.length, QR_REV_NUM_COLS).setValues(filasRev);
      review.getRange(start, QR_REV_COL_CHECK, filasRev.length, 1).insertCheckboxes();
      review.getRange(start, QR_REV_COL_FECHA, filasRev.length, 1).setNumberFormat(QR_FORMATO_FECHA_PEDIDO);
      review.getRange(start, QR_REV_COL_TOTAL, filasRev.length, 2).setNumberFormat(QR_FORMATO_MONTO);
      review.getRange(start, QR_REV_NUM_COLS, filasRev.length, 1).setNumberFormat(QR_FORMATO_FECHA);
    }

    // --- Escribir "QR mal cobrado" ---
    if (filasMal.length > 0) {
      const start = Math.max(mal.getLastRow(), QR_FIRST_DATA_ROW - 1) + 1;
      mal.getRange(start, 1, filasMal.length, QR_MAL_NUM_COLS).setValues(filasMal);
      mal.getRange(start, QR_MAL_COL_FECHA, filasMal.length, 1).setNumberFormat(QR_FORMATO_FECHA_PEDIDO);
      mal.getRange(start, QR_MAL_COL_TOTAL, filasMal.length, 2).setNumberFormat(QR_FORMATO_MONTO);
      mal.getRange(start, QR_MAL_NUM_COLS, filasMal.length, 1).setNumberFormat(QR_FORMATO_FECHA);
    }

    console.log('revisarQRMercadopago: pedidos revisados=' + pedidos.size +
                ' | agregados a "' + QR_REVIEW_SHEET_NAME + '"=' + filasRev.length +
                ' | agregados a "' + QR_MAL_SHEET_NAME + '"=' + filasMal.length);
  } finally {
    lock.releaseLock();
  }
}

// Un solo mail con todos los pedidos mal cobrados nuevos
function enviarMailMalCobradoQR_(filas) {
  const n = filas.length;
  let cuerpo = (n === 1 ? '1 pedido mal cobrado' : n + ' pedidos mal cobrados') +
               ' en "' + QR_SHEET_NAME + '":\n';

  for (let k = 0; k < n; k++) {
    const f = filas[k];   // [pedido, fecha pedido, sucursal, total, descuento, motivo, filas, detectado]
    cuerpo += '\n----------------------------------------\n';
    cuerpo += 'Pedido: ' + f[0] + '\n';
    cuerpo += 'Fecha pedido: ' + formatearFechaQR_(f[1]) + '\n';
    cuerpo += 'Sucursal: ' + f[2] + '\n';
    cuerpo += 'Total pedido: $' + formatearMontoQR_(f[3]) + '\n';
    cuerpo += 'Descuento total: $' + formatearMontoQR_(f[4]) + '\n';
    cuerpo += 'Motivo: ' + f[5] + '\n';
    cuerpo += 'Filas en ' + QR_SHEET_NAME + ': ' + f[6] + '\n';
  }

  MailApp.sendEmail({
    to: QR_EMAIL_TO,
    subject: n === 1 ? QR_ASUNTO : QR_ASUNTO + ' (' + n + ')',
    body: cuerpo
  });
}

// Ejecutar UNA sola vez a mano: deja el disparador automatico de QR Mercadopago
// (instalarTriggersRevision tambien lo instala, junto con el de Ventas para Revisar)
function crearTriggerQRMercadopago() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === QR_HANDLER) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(QR_HANDLER)
    .timeBased()
    .everyHours(QR_TRIGGER_CADA_HORAS)
    .create();
  console.log('Trigger creado: ' + QR_HANDLER + ' cada ' + QR_TRIGGER_CADA_HORAS + ' horas.');
}

// Hojas creadas antes de agregar una columna: la inserta a la derecha de colAnterior y completa las filas existentes
// (el pedido de cada fila se lee de colPedido; valorDe devuelve el dato de ese pedido)
function asegurarColumnaQR_(hoja, colPedido, colAnterior, header, pedidos, valorDe, formato) {
  const col = colAnterior + 1;
  if (String(hoja.getRange(1, col).getValue()).trim() === header) return;
  hoja.insertColumnAfter(colAnterior);
  hoja.getRange(1, col).setValue(header).setFontWeight('bold');
  const last = hoja.getLastRow();
  if (last < QR_FIRST_DATA_ROW) return;
  const valores = hoja.getRange(QR_FIRST_DATA_ROW, colPedido, last - QR_FIRST_DATA_ROW + 1, 1).getValues()
    .map(function (r) {
      const p = pedidos.get(String(r[0]).trim());
      return [p ? valorDe(p) : ''];
    });
  const rango = hoja.getRange(QR_FIRST_DATA_ROW, col, valores.length, 1);
  rango.setValues(valores);
  if (formato) rango.setNumberFormat(formato);
}

// Ejecutar UNA sola vez a mano: deja el disparador automatico de QR Mercadopago
// (instalarTriggersRevision tambien lo instala, junto con el de Ventas para Revisar)
function crearTriggerQRMercadopago() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === QR_HANDLER) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(QR_HANDLER)
    .timeBased()
    .everyHours(QR_TRIGGER_CADA_HORAS)
    .create();
  console.log('Trigger creado: ' + QR_HANDLER + ' cada ' + QR_TRIGGER_CADA_HORAS + ' horas.');
}

function obtenerHojaQR_(ss, nombre, headers) {
  let hoja = ss.getSheetByName(nombre);
  if (!hoja) hoja = ss.insertSheet(nombre);

  if (String(hoja.getRange(1, 1).getValue()).trim() === '') {
    hoja.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function leerPedidosRegistradosQR_(hoja, colPedido) {
  const set = new Set();
  const last = hoja.getLastRow();
  if (last < QR_FIRST_DATA_ROW) return set;
  hoja.getRange(QR_FIRST_DATA_ROW, colPedido, last - QR_FIRST_DATA_ROW + 1, 1)
    .getValues()
    .forEach(function (r) {
      const v = String(r[0]).trim();
      if (v) set.add(v);
    });
  return set;
}

function numeroQR_(v) {
  if (typeof v === 'number') return v;
  let s = String(v === null || v === undefined ? '' : v).replace(/[\s$]/g, '');
  if (s === '') return 0;
  if (s.indexOf(',') !== -1) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

function redondearQR_(n) {
  return Math.round(n * 100) / 100;
}

function formatearFechaQR_(d) {
  if (d instanceof Date) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd/MM/yyyy');
  return String(d === null || d === undefined ? '' : d);
}

function formatearMontoQR_(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}