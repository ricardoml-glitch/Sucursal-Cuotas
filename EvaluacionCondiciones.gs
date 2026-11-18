// ===================== CONFIG (evaluación) =====================
const EV_SHEET_ORIGEN = "Total sin filtro";
const EV_SHEET_DESTINO = "Total";
const EV_SHEET_CC = "condiciones comerciales";
const EV_FIRST_DATA_ROW = 2;
const EV_NUM_COLS_ORIGEN = 11;      // A:K
const EV_NUM_COLS_DESTINO = 15;     // A:O
const EV_IDX_PEDIDO = 1;            // B
const EV_IDX_PRODUCTO = 4;          // E
const EV_IDX_PRECIO = 5;            // F
const EV_IDX_CONDICION = 7;         // H
const EV_IDX_REVISAR = 14;          // O (en destino)
const EV_PREFIJO_PEDIDO = "PED-";
const EV_MARCA_REVISAR = "revisar";
const EV_MARCA_SIN_COND = "sin cond";
const EV_CANALES_SIN_REVISION = ["Corporativo", "Mayorista", "Fravega", "BNA", "BAPRO", "PaginaWeb"];
const EV_FACTOR_DEFAULT = 0.95;
const EV_TOLERANCIA = 0.99;
const EV_LOCK_TIMEOUT_MS = 30000;
const EV_TITULOS_EXTRA = ["% Venta", "% del pvm", "% del Lista", "Revisar"];
// ===============================================================

function evaluarCondicionesComerciales() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(EV_LOCK_TIMEOUT_MS)) {
    console.log("evaluarCondicionesComerciales: no se pudo obtener el lock, se omite esta ejecución.");
    return;
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetOrigen = ss.getSheetByName(EV_SHEET_ORIGEN);
    // "Total" lo genera este script: si no existe se crea
    const sheetDestino = ss.getSheetByName(EV_SHEET_DESTINO) || ss.insertSheet(EV_SHEET_DESTINO);
    const sheetCC = ss.getSheetByName(EV_SHEET_CC);
    const faltan = [];
    if (!sheetOrigen) faltan.push(EV_SHEET_ORIGEN);
    if (!sheetCC) faltan.push(EV_SHEET_CC);
    if (faltan.length > 0) {
      console.log('evaluarCondicionesComerciales: faltan hojas (' + faltan.join(' / ') + '), se omite.');
      return;
    }

    // Quitar filtros activos antes de procesar
    sheetOrigen.getFilter()?.remove();
    sheetDestino.getFilter()?.remove();

    // --- Decisiones previas (antes de borrar Total) ---
    // Solo se congelan pedidos que ya tenían condición asignada y un resultado "revisar" o vacío.
    const previas = {};
    const lastDestino = sheetDestino.getLastRow();
    if (lastDestino >= EV_FIRST_DATA_ROW) {
      const prev = sheetDestino
        .getRange(EV_FIRST_DATA_ROW, 1, lastDestino - EV_FIRST_DATA_ROW + 1, EV_NUM_COLS_DESTINO)
        .getValues();
      const contadorPrev = {};
      for (let i = 0; i < prev.length; i++) {
        const f = prev[i];
        const base = claveBaseEv_(f);
        contadorPrev[base] = (contadorPrev[base] || 0) + 1;
        const condicion = String(f[EV_IDX_CONDICION]).trim();
        const rev = String(f[EV_IDX_REVISAR]).trim();
        if (condicion !== "" && (rev === EV_MARCA_REVISAR || rev === "")) {
          previas[base + "#" + contadorPrev[base]] = rev;
        }
      }
    }

    // --- Condiciones comerciales ---
    const dataCC = sheetCC.getDataRange().getValues();
    const mapCC = {};
    for (let i = 1; i < dataCC.length; i++) {
      const nombre = dataCC[i][0].toString().trim();
      const precioMinimo = dataCC[i][1];
      const coeficiente = dataCC[i][2];
      mapCC[nombre] = {
        precioMinimo: precioMinimo,
        coeficiente: coeficiente === "" ? 1 : Number(coeficiente)
      };
    }

    // --- Datos de origen ---
    const lastRow = sheetOrigen.getLastRow();
    if (lastRow < EV_FIRST_DATA_ROW) {
      console.log("evaluarCondicionesComerciales: Total sin filtro no tiene datos.");
      return;
    }
    const dataTotal = sheetOrigen
      .getRange(EV_FIRST_DATA_ROW, 1, lastRow - EV_FIRST_DATA_ROW + 1, EV_NUM_COLS_ORIGEN)
      .getValues();

    const filas = [];
    const contador = {};
    let congeladas = 0;
    let evaluadas = 0;

    for (let i = 0; i < dataTotal.length; i++) {
      const fila = dataTotal[i];

      // Ignorar filas sin fecha en A o sin ID de pedido en B
      const fecha = fila[0];
      const pedidoId = fila[1].toString().trim();
      if (!fecha || !pedidoId.startsWith(EV_PREFIJO_PEDIDO)) continue;

      const canal = fila[2].toString().trim();   // C
      const precioVenta = fila[5];               // F
      const costo = fila[6];                     // G
      const condicion = fila[7].toString().trim(); // H
      const precioMin = fila[9];                 // J
      const precioLista = fila[10];              // K

      // L: % Venta = (F - G) / G
      const pctVenta = (precioVenta === "" || costo === "" || costo === 0)
        ? "" : (precioVenta - costo) / costo;

      // M: % del pvm = (F - J) / J
      const pctPVM = (precioVenta === "" || precioMin === 0)
        ? "" : (precioVenta - precioMin) / precioMin;

      // N: % del Lista = (F - K) / K
      const pctLista = (precioVenta === "" || precioLista === 0)
        ? "" : (precioVenta - precioLista) / precioLista;

      // O: Revisar (si el pedido ya fue evaluado antes, se respeta esa decisión)
      const base = claveBaseEv_(fila);
      contador[base] = (contador[base] || 0) + 1;
      const clave = base + "#" + contador[base];

      let revisar;
      if (Object.prototype.hasOwnProperty.call(previas, clave)) {
        revisar = previas[clave];
        congeladas++;
      } else {
        revisar = calcularRevisarEv_(canal, condicion, precioVenta, precioMin, precioLista, mapCC);
        evaluadas++;
      }

      filas.push([...fila, pctVenta, pctPVM, pctLista, revisar]);
    }

    // Limpiar destino y escribir todo
    sheetDestino.clearContents();

    const titulosOrigen = sheetOrigen.getRange(1, 1, 1, EV_NUM_COLS_ORIGEN).getValues()[0];
    const titulos = [...titulosOrigen, ...EV_TITULOS_EXTRA];
    sheetDestino.getRange(1, 1, 1, EV_NUM_COLS_DESTINO).setValues([titulos]);

    if (filas.length > 0) {
      sheetDestino.getRange(EV_FIRST_DATA_ROW, 1, filas.length, EV_NUM_COLS_DESTINO).setValues(filas);
    }

    console.log("evaluarCondicionesComerciales: filas=" + filas.length +
      " | respetadas=" + congeladas + " | evaluadas ahora=" + evaluadas);
  } finally {
    lock.releaseLock();
  }
}

function calcularRevisarEv_(canal, condicion, precioVenta, precioMin, precioLista, mapCC) {
  if (condicion === "") return "";
  if (precioVenta >= precioMin) return "";
  if (canal === "TioMusa-ML" && condicion === "MercadoPago") return "";
  if (EV_CANALES_SIN_REVISION.includes(canal)) return "";

  const cc = mapCC[condicion];
  if (!cc) return EV_MARCA_SIN_COND;

  const usaMinimo = cc.precioMinimo === true || cc.precioMinimo.toString().toLowerCase() === "verdadero";
  const base = usaMinimo ? precioMin : precioLista;
  const factor = cc.coeficiente === 1 ? EV_FACTOR_DEFAULT : cc.coeficiente;
  const esperado = base * factor;
  return precioVenta < esperado * EV_TOLERANCIA ? EV_MARCA_REVISAR : "";
}

// Identidad estable de un pedido: ID + Producto + Precio (no cambia con las condiciones)
function claveBaseEv_(f) {
  const precio = typeof f[EV_IDX_PRECIO] === "number"
    ? String(Math.round(f[EV_IDX_PRECIO] * 100) / 100)
    : String(f[EV_IDX_PRECIO]).trim();
  return String(f[EV_IDX_PEDIDO]).trim() + "|" + String(f[EV_IDX_PRODUCTO]).trim() + "|" + precio;
}