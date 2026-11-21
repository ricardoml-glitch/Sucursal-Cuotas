/**
 * Pagos.gs - como se abono cada pedido, armado desde las hojas de origen (VS ya no trae las columnas de cobranza).
 *
 * Un pedido puede pagarse con varios medios a la vez. Las hojas que lo cubren completo son:
 *   - "PED cuenta contable": cuentas contables (MercadoPago con el numero de pago, GoCuotas, Fravega, etc.)
 *   - "PED CV":              transferencias bancarias (comprobante de venta)
 *   - "Ped cpv tpv":         tarjetas fisicas (TPV con su plan: DEBITO, 01 Cuota, 12 Cuotas, ...)
 *   - "Cobranza MP Informe": las cuotas reales de cada pago de MercadoPago (se cruza por el numero de pago)
 *   - "PED Cobranza automatica (R)" (opcional): solo para detectar refacturaciones
 *
 * Resultado por pedido (pagosDePedido_):
 *   cobranza     plan principal de pago (equivale a la vieja VS "Cobranza"): el de mayor cuota entre tarjetas/MP; si no hay,
 *                DEBITO, MODO, GoCuotas, otras cuentas, CC (transferencia), efectivo. 'refacturacion' si corresponde,
 *                'X' si hay un MercadoPago que todavia no aparece en el informe, '' si no hay ningun pago registrado.
 *   cuotas       cuotas mas altas entre tarjetas/MP (equivale a la vieja "Cobranza 2"); 0 si solo hay medios sin cuotas; '' si no hay datos
 *   cuotasLista  cuotas de cada tarjeta/MP del pedido (para detectar un pedido con varias tarjetas en cuotas distintas)
 *   cobranzaAuto ids y cuentas de todos los pagos (equivale a la vieja "Cobranza Automatica: ID Cobranza")
 *   pagos        detalle legible, ej. "TPV-086448 12 Cuotas + MP 183235035046 06 Cuotas"
 *   tipos        tipos de pago presentes: mp, tarjeta, debito, gocuotas, modo, efectivo, cc, otro, refact
 */
const PAGOS_CFG = {
  // Posiciones de columna (A = 0). Todas las hojas tienen encabezado en la fila 1.
  HOJA_TPV: 'Ped cpv tpv',                       // A Pedido (puede venir vacio), B CPV, C TPV, D Plan, E Importe
  TPV: { pedido: 0, cpv: 1, tpv: 2, plan: 3 },
  HOJA_CUENTA: 'PED cuenta contable',            // A Pedido, B CPV, C Cuenta contable (denominacion), D Mercado Pago (numero de pago)
  CUENTA: { pedido: 0, cpv: 1, denominacion: 2, mp: 3 },
  HOJA_CV: 'PED CV',                             // A Pedido, B Comprobante de venta (CV-...): pago por transferencia
  CV: { pedido: 0, cv: 1 },
  HOJA_MP_INFORME: 'Cobranza MP Informe',        // B Numero de cobro MP, C Tipo de pago, D Cuotas
  MP_INFORME: { id: 1, tipo: 2, cuotas: 3 },
  HOJA_REFACT: 'PED Cobranza automatica (R)',    // opcional: B Pedido, C ID cobranza, E Origen
  REFACT: { pedido: 1, id: 2, origen: 4 },

  // Cuentas contables: la primera que coincide (por la denominacion) define el tipo. Sin plan = se usa la denominacion.
  // Cuentas que hoy existen: MercadoPago TM, FRAVEGA, PROVINCIA COMPRAS, REFACTURACION, Redondeo, Caja Cobranza <local>, MODO,
  // Caja Publicidad, MOBBEX, Caja Administracion (y USD), Tienda Nacion, GOCuotas. Las no listadas abajo quedan como tipo "otro".
  CUENTAS: [
    { regex: 'redondeo', tipo: 'ignorar', plan: '' },   // ajuste de centavos: no es un pago
    { regex: 'refactur', tipo: 'refact', plan: 'refacturacion' },
    { regex: 'mercado ?pago|\\bmp\\b', tipo: 'mp', plan: '' },
    { regex: 'go ?cuotas', tipo: 'gocuotas', plan: 'GoCuotas' },
    { regex: 'modo', tipo: 'modo', plan: 'MODO' },
    { regex: 'efectivo|caja', tipo: 'efectivo', plan: 'efectivo' }
  ],
  TEXTO_REFACTURACION: 'refacturacion',
  TEXTO_EFECTIVO: 'efectivo',
  TEXTO_TRANSFERENCIA: 'CC',                     // plan que se muestra para pagos por transferencia (PED CV)
  TEXTO_DEBITO: 'DEBITO',
  TEXTO_PENDIENTE: 'X',                          // MercadoPago que todavia no esta en el informe
  PLAN_SIN_CUOTAS: '^(debito|credito directo)',  // planes de tarjeta fisica sin cuotas
  MP_TIPO_SIN_CUOTAS: 'dinero en cuenta'         // MercadoPago con dinero en cuenta = 1 pago
};

function pagosNumeroId_(v) {
  if (typeof v === 'number') return isFinite(v) && v !== 0 ? String(Math.round(v)) : '';
  return String(v === null || v === undefined ? '' : v).replace(/[^\d]/g, '');
}

function pagosTextoCuotas_(n) {
  return ('0' + n).slice(-2) + (n === 1 ? ' Cuota' : ' Cuotas');
}

function pagosLeerHoja_(ss, nombre, obligatoria) {
  const sh = ss.getSheetByName(nombre);
  if (!sh || sh.getLastRow() < 2) {
    cuotasLog_(obligatoria ? 'WARN' : 'INFO', 'Pagos: la hoja "' + nombre + '" no existe o esta vacia');
    return [];
  }
  return sh.getDataRange().getValues().slice(1);
}

function pagosCargar_(ss) {
  const C = PAGOS_CFG;
  const idx = { tpv: {}, cuenta: {}, cv: {}, refact: {}, informe: {}, cache: {}, stats: {} };
  const clavePed = function (v) { return String(v === null || v === undefined ? '' : v).trim(); };

  // MercadoPago: numero de pago -> tipo y cuotas reales
  pagosLeerHoja_(ss, C.HOJA_MP_INFORME, true).forEach(function (f) {
    const id = pagosNumeroId_(f[C.MP_INFORME.id]);
    if (!id) return;
    const tipo = cuotasClave_(f[C.MP_INFORME.tipo]);
    let cuotas = cuotasANumero_(f[C.MP_INFORME.cuotas]);
    if (tipo.indexOf(C.MP_TIPO_SIN_CUOTAS) >= 0 || cuotas === null || cuotas < 1) cuotas = 1;
    idx.informe[id] = { cuotas: cuotas };
  });

  // Cuentas contables (y de paso CPV -> pedido para las filas de tarjeta fisica que vienen sin pedido)
  const cpvPedido = {};
  const reglasCuenta = C.CUENTAS.map(function (c) { return { re: new RegExp(c.regex, 'i'), tipo: c.tipo, plan: c.plan }; });
  pagosLeerHoja_(ss, C.HOJA_CUENTA, true).forEach(function (f) {
    const ped = clavePed(f[C.CUENTA.pedido]);
    if (!ped) return;
    const cpv = clavePed(f[C.CUENTA.cpv]);
    if (cpv) cpvPedido[cpv] = ped;
    const denom = String(f[C.CUENTA.denominacion] || '').trim();
    const mp = pagosNumeroId_(f[C.CUENTA.mp]);
    if (!denom && !mp) return;
    let tipo = 'otro', plan = denom;
    for (let i = 0; i < reglasCuenta.length; i++) {
      if (reglasCuenta[i].re.test(denom)) { tipo = reglasCuenta[i].tipo; plan = reglasCuenta[i].plan || denom; break; }
    }
    if (tipo === 'ignorar') return;
    if (mp && tipo !== 'refact') tipo = 'mp';
    (idx.cuenta[ped] = idx.cuenta[ped] || []).push({ tipo: tipo, denom: denom, mp: mp, plan: plan });
  });

  // Tarjetas fisicas
  pagosLeerHoja_(ss, C.HOJA_TPV, true).forEach(function (f) {
    let ped = clavePed(f[C.TPV.pedido]);
    const cpv = clavePed(f[C.TPV.cpv]);
    if (!ped && cpv) ped = cpvPedido[cpv] || '';
    const tpv = clavePed(f[C.TPV.tpv]);
    if (!ped || !tpv) return;
    (idx.tpv[ped] = idx.tpv[ped] || []).push({ tpv: tpv, plan: cuotasUnificarPlan_(String(f[C.TPV.plan] || '').trim()) });
  });

  // Transferencias bancarias
  pagosLeerHoja_(ss, C.HOJA_CV, true).forEach(function (f) {
    const ped = clavePed(f[C.CV.pedido]);
    const cv = clavePed(f[C.CV.cv]);
    if (ped && cv) (idx.cv[ped] = idx.cv[ped] || []).push(cv);
  });

  // Refacturaciones (solo deteccion)
  pagosLeerHoja_(ss, C.HOJA_REFACT, false).forEach(function (f) {
    const ped = clavePed(f[C.REFACT.pedido]);
    if (ped && cuotasClave_(f[C.REFACT.id] + ' ' + f[C.REFACT.origen]).indexOf(cuotasClave_(C.TEXTO_REFACTURACION).slice(0, 7)) >= 0) idx.refact[ped] = true;
  });

  idx.stats = {
    informe: Object.keys(idx.informe).length, cuenta: Object.keys(idx.cuenta).length,
    tpv: Object.keys(idx.tpv).length, cv: Object.keys(idx.cv).length
  };
  cuotasLog_('INFO', 'Pagos: pedidos con cuenta contable ' + idx.stats.cuenta + ', tarjeta fisica ' + idx.stats.tpv +
                     ', transferencia ' + idx.stats.cv + '; pagos MP en informe ' + idx.stats.informe);
  return idx;
}

// Todos los pagos de un pedido: [{ tipo, texto, id, plan, cuotas, pendiente }]
function pagosListar_(idx, pedido) {
  const C = PAGOS_CFG;
  const ped = String(pedido === null || pedido === undefined ? '' : pedido).trim();
  const pagos = [], vistos = {};
  const agregar = function (p) {
    const k = p.tipo + '|' + (p.id || p.texto);
    if (vistos[k]) return;
    vistos[k] = true;
    pagos.push(p);
  };
  (idx.cuenta[ped] || []).forEach(function (c) {
    if (c.tipo === 'mp') {
      const inf = c.mp ? idx.informe[c.mp] : null;
      agregar({ tipo: 'mp', id: c.mp || c.denom, desc: c.denom + (c.mp ? ' ' + c.mp : ''), plan: inf ? pagosTextoCuotas_(inf.cuotas) : C.TEXTO_PENDIENTE,
                cuotas: inf ? inf.cuotas : null, pendiente: !inf,
                texto: 'MP ' + (c.mp || c.denom) + ' ' + (inf ? pagosTextoCuotas_(inf.cuotas) : '(sin datos de cuotas)') });
    } else {
      agregar({ tipo: c.tipo, id: c.denom, desc: c.denom, plan: c.plan, cuotas: null, pendiente: false, texto: c.denom });
    }
  });
  (idx.tpv[ped] || []).forEach(function (t) {
    const sinCuotas = new RegExp(C.PLAN_SIN_CUOTAS, 'i').test(t.plan);
    const m = t.plan.match(/^(\d+)/);
    const cuotas = sinCuotas ? 0 : (m ? parseInt(m[1], 10) : null);
    const tipo = sinCuotas ? 'debito' : 'tarjeta';
    const plan = sinCuotas ? (/^debito/i.test(t.plan) ? C.TEXTO_DEBITO : t.plan) : (t.plan || C.TEXTO_PENDIENTE);
    agregar({ tipo: tipo, id: t.tpv, desc: t.tpv, plan: plan, cuotas: cuotas, pendiente: !sinCuotas && cuotas === null,
              texto: t.tpv + ' ' + (t.plan || '(sin plan)') });
  });
  (idx.cv[ped] || []).forEach(function (cv) {
    agregar({ tipo: 'cc', id: cv, desc: cv, plan: C.TEXTO_TRANSFERENCIA, cuotas: null, pendiente: false, texto: cv + ' (transferencia)' });
  });
  if (idx.refact[ped]) agregar({ tipo: 'refact', id: 'refact', desc: C.TEXTO_REFACTURACION, plan: C.TEXTO_REFACTURACION, cuotas: null, pendiente: false, texto: C.TEXTO_REFACTURACION });
  return pagos;
}

// Resumen de pagos de un pedido (con cache por pedido)
function pagosDePedido_(idx, pedido) {
  const C = PAGOS_CFG;
  const ped = String(pedido === null || pedido === undefined ? '' : pedido).trim();
  if (ped in idx.cache) return idx.cache[ped];
  const pagos = pagosListar_(idx, ped);
  const tipos = [];
  pagos.forEach(function (p) { if (tipos.indexOf(p.tipo) < 0) tipos.push(p.tipo); });
  const con = function (t) { return pagos.filter(function (p) { return p.tipo === t; }); };

  const conCuotas = pagos.filter(function (p) { return (p.tipo === 'mp' || p.tipo === 'tarjeta') && p.cuotas !== null; });
  const cuotasLista = conCuotas.map(function (p) { return p.cuotas; });
  let cobranza = '';
  if (tipos.indexOf('refact') >= 0) cobranza = C.TEXTO_REFACTURACION;
  else if (conCuotas.length) {
    cobranza = conCuotas.slice().sort(function (a, b) { return b.cuotas - a.cuotas; })[0].plan;
  } else if (pagos.some(function (p) { return p.pendiente; })) cobranza = C.TEXTO_PENDIENTE;
  else if (con('debito').length) cobranza = C.TEXTO_DEBITO;
  else if (con('modo').length) cobranza = 'MODO';
  else if (con('gocuotas').length) cobranza = 'GoCuotas';
  else if (con('otro').length) cobranza = con('otro')[0].plan;
  else if (con('cc').length) cobranza = C.TEXTO_TRANSFERENCIA;
  else if (con('efectivo').length) cobranza = C.TEXTO_EFECTIVO;

  let cuotas = '';
  if (cuotasLista.length) cuotas = Math.max.apply(null, cuotasLista);
  else if (pagos.length && !pagos.some(function (p) { return p.pendiente; })) cuotas = 0;

  const out = {
    cobranza: cobranza, cuotas: cuotas, cuotasLista: cuotasLista, tipos: tipos,
    cobranzaAuto: pagos.map(function (p) { return p.desc; }).join(' | '),
    pagos: pagos.map(function (p) { return p.texto; }).join(' + ')
  };
  idx.cache[ped] = out;
  return out;
}
