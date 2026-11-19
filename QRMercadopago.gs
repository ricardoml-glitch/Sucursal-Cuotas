// ===================== CONFIG (revisión QR Mercadopago) =====================
const QR_SHEET_NAME = 'QR Mercadopago';
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

// Hoja "Cobranzas Descuento QR MP": pedidos que Mercadopago registra con descuento (sale directo de Mercadopago)
const QR_MP_SHEET_NAME = 'Cobranzas Descuento QR MP';
const QR_MP_HEADER_PEDIDO = 'Pedido: ID';
const QR_MP_IDX_PEDIDO_DEFAULT = 0;   // A, si no se encuentra el encabezado
// Un pedido con descuento que no figura en esa hoja se marca recien pasados estos dias (el informe de Mercadopago puede demorar)
const QR_DIAS_ESPERA_MP = 1;

// Reglas
const QR_MIN_PEDIDO = 300000;         // el descuento corresponde desde este monto (inclusive)
const QR_MAX_DESCUENTO = 30000;       // tope de descuento por pedido
const QR_PCT_ESPERADO = 0;            // % Descuento siempre en 0
const QR_TOLERANCIA = 0.0001;


// Hoja "QR mal cobrado" (version anterior): solo se lee para no volver a avisar los pedidos que ya tenia. Ya no hace falta.
const QR_MAL_COL_PEDIDO = 1;          // A
const QR_MAL_COL_DETECTADO = 8;       // H (fecha de deteccion)


// ===========================================================================

// Devuelve los pedidos de "QR Mercadopago" con descuento mal aplicado (los usa Revisar):
// - no cumplen las reglas (% distinto de 0, tope de descuento, minimo del pedido), o
// - figuran con descuento en "QR Mercadopago" pero no en "Cobranzas Descuento QR MP" (lo que Mercadopago registro)
// Cada elemento: { id, fecha, sucursal, total, descuento, motivo }. Si falta la hoja devuelve [].
function qrEvaluarPedidos_(ss) {
  const sheet = ss.getSheetByName(QR_SHEET_NAME);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < QR_FIRST_DATA_ROW) return [];
  const data = sheet.getRange(QR_FIRST_DATA_ROW, 1, lastRow - QR_FIRST_DATA_ROW + 1, QR_NUM_COLS).getValues();

  // --- Agrupar por pedido ---
  const pedidos = new Map();
  for (let i = 0; i < data.length; i++) {
    const f = data[i];
    const id = String(f[QR_IDX_PEDIDO]).trim();
    if (!id) continue;
    if (!pedidos.has(id)) pedidos.set(id, { total: 0, descuento: 0, pctDistinto: false, sucursales: [], fecha: '' });
    const p = pedidos.get(id);
    p.total += numeroQR_(f[QR_IDX_PRECIO]);
    p.descuento += numeroQR_(f[QR_IDX_DESCUENTO]);
    if (Math.abs(numeroQR_(f[QR_IDX_PCT_DESCUENTO]) - QR_PCT_ESPERADO) > QR_TOLERANCIA) p.pctDistinto = true;
    if (p.fecha === '' && f[QR_IDX_FECHA] !== '' && f[QR_IDX_FECHA] !== null && f[QR_IDX_FECHA] !== undefined) p.fecha = f[QR_IDX_FECHA];
    const suc = String(f[QR_IDX_SUCURSAL] === null || f[QR_IDX_SUCURSAL] === undefined ? '' : f[QR_IDX_SUCURSAL]).trim();
    if (suc && p.sucursales.indexOf(suc) === -1) p.sucursales.push(suc);
  }

  // --- Pedidos con descuento en Mercadopago (hoja directa de Mercadopago) ---
  const enMP = leerPedidosMercadopagoQR_(ss);   // null si no se puede verificar: se aplican solo las demas reglas

  const ahora = new Date();
  const mal = [];
  pedidos.forEach(function (p, id) {
    const total = redondearQR_(p.total);
    const descuento = redondearQR_(p.descuento);
    const motivos = [];
    if (p.pctDistinto) motivos.push('% Descuento distinto de 0');
    if (descuento > QR_MAX_DESCUENTO + QR_TOLERANCIA) {
      motivos.push('Descuento total $' + formatearMontoQR_(descuento) + ' supera el tope de $' + formatearMontoQR_(QR_MAX_DESCUENTO));
    }
    if (descuento > QR_TOLERANCIA && total < QR_MIN_PEDIDO) {
      motivos.push('Tiene descuento pero el pedido ($' + formatearMontoQR_(total) + ') no llega a $' + formatearMontoQR_(QR_MIN_PEDIDO));
    }
    if (enMP !== null && descuento > QR_TOLERANCIA && !enMP.has(id) && pasoEsperaMPQR_(p.fecha, ahora)) {
      motivos.push('Descuento que no figura en "' + QR_MP_SHEET_NAME + '" (Mercadopago)');
    }
    if (motivos.length > 0) {
      mal.push({ id: id, fecha: p.fecha, sucursal: p.sucursales.join(', '), total: total, descuento: descuento, motivo: motivos.join(' | ') });
    }
  });
  return mal;
}

// Pedidos que ya estaban en la hoja "QR mal cobrado" de la version anterior (pedido -> fecha de deteccion).
// Sirve para no volver a avisarlos. Si la hoja ya no existe, devuelve {}.
function qrLeerRegistroViejo_(ss) {
  const sh = ss.getSheetByName(QR_MAL_SHEET_NAME);
  const out = {};
  if (!sh || sh.getLastRow() < QR_FIRST_DATA_ROW) return out;
  const datos = sh.getRange(QR_FIRST_DATA_ROW, 1, sh.getLastRow() - QR_FIRST_DATA_ROW + 1, QR_MAL_COL_DETECTADO).getValues();
  datos.forEach(function (r) {
    const id = String(r[QR_MAL_COL_PEDIDO - 1]).trim();
    if (id) out[id] = r[QR_MAL_COL_DETECTADO - 1];
  });
  return out;
}

// Pedidos de la hoja de Mercadopago (Set). null si la hoja no existe o no tiene datos (no se puede verificar)
function leerPedidosMercadopagoQR_(ss) {
  const hoja = ss.getSheetByName(QR_MP_SHEET_NAME);
  if (!hoja) return null;
  const last = hoja.getLastRow();
  if (last < QR_FIRST_DATA_ROW) return null;
  const ancho = Math.max(hoja.getLastColumn ? hoja.getLastColumn() : 1, 1);
  const enc = hoja.getRange(1, 1, 1, ancho).getValues()[0].map(function (h) { return String(h).trim(); });
  const idx = enc.indexOf(QR_MP_HEADER_PEDIDO) >= 0 ? enc.indexOf(QR_MP_HEADER_PEDIDO) : QR_MP_IDX_PEDIDO_DEFAULT;
  const set = new Set();
  hoja.getRange(QR_FIRST_DATA_ROW, idx + 1, last - QR_FIRST_DATA_ROW + 1, 1).getValues().forEach(function (r) {
    const v = String(r[0]).trim();
    if (v) set.add(v);
  });
  return set;
}

// true si el pedido ya tiene QR_DIAS_ESPERA_MP dias (o si no se sabe su fecha)
function pasoEsperaMPQR_(fecha, ahora) {
  if (!(fecha instanceof Date) || isNaN(fecha.getTime())) return true;
  return (ahora.getTime() - fecha.getTime()) >= QR_DIAS_ESPERA_MP * 24 * 60 * 60 * 1000;
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

function formatearMontoQR_(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}