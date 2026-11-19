// ===================== CONFIG (evaluacion de condiciones comerciales) =====================
// Calcula la marca "revisar" de un pedido de VS segun su condicion comercial.
// La regla (coeficiente y si cobra sobre PVM o lista) es la congelada al detectar el pedido por primera vez
// (hoja "Reglas aplicadas"), asi un cambio posterior en "condiciones comerciales" no es retroactivo.
const EV_MARCA_REVISAR = "revisar";
const EV_MARCA_SIN_COND = "sin cond";
const EV_CANALES_SIN_REVISION = ["Corporativo", "Mayorista", "Fravega", "BNA", "BAPRO", "PaginaWeb"];
const EV_FACTOR_DEFAULT = 0.95;
const EV_TOLERANCIA = 0.99;
// ==========================================================================================

// mapCC: { condicion: { precioMinimo: true|false, coeficiente: numero } }
function calcularRevisarEv_(canal, condicion, precioVenta, precioMin, precioLista, mapCC) {
  if (condicion === "") return "";
  if (precioVenta >= precioMin) return "";
  if (canal === "TioMusa-ML" && condicion === "MercadoPago") return "";
  if (EV_CANALES_SIN_REVISION.includes(canal)) return "";

  const cc = mapCC[condicion];
  if (!cc) return EV_MARCA_SIN_COND;

  const base = cc.precioMinimo ? precioMin : precioLista;
  const factor = cc.coeficiente === 1 ? EV_FACTOR_DEFAULT : cc.coeficiente;
  const esperado = base * factor;
  return precioVenta < esperado * EV_TOLERANCIA ? EV_MARCA_REVISAR : "";
}
