/**
 * Sucursal Cuotas - control de ventas en cuotas por debajo del precio de lista.
 *
 * La hoja VS se sigue llenando con formulas. Este script LEE VS, evalua cada fila
 * por codigo (evaluarFila_) y escribe lo que hay que revisar en la hoja Revisar,
 * con una columna Observaciones que explica por que aparece cada pedido.
 * Avisa por mail los pedidos nuevos. No modifica VS.
 */

// =========================== CONFIGURACION ===========================
const CUOTAS_CFG = {
  HOJA_VS: 'VS',
  HOJA_RESUMEN: 'Revisar',
  HOJA_RESUMEN_ANTERIOR: 'Resumen',   // si existe con este nombre, se renombra (conserva formato)
  HOJA_LOG: 'Log Cuotas',
  MAX_FILAS_LOG: 300,

  // Encabezados de VS que lee el script
  VS: {
    fecha: 'Fecha', sucursal: 'Sucursal', pedido: 'Pedido: ID', condicion: 'Condición Comercial',
    producto: 'Producto', precioUnitario: 'Precio Unitario', cobranza: 'Cobranza', cuotas: 'Cobranza 2', cobranzaAuto: 'Cobranza Automática: ID Cobranza',
    lista: 'Precio', pvm: 'PVM', canal: 'Canal de venta', referencia: 'Referenia'
  },

  // Encabezados opcionales de VS (si existen se leen; si no, ese dato queda vacio)
  VS_OPCIONALES: { costo: 'Costo producto' },

  // Columnas de Revisar (A:H).
  ENCABEZADO_RESUMEN: [
    'Fecha', 'Sucursal', 'Pedido: ID', 'Condición Comercial', 'Producto', 'Precio Unitario',
    'Plan', 'Canal de venta'
  ],
  // Columnas extra de Revisar, a partir de la I
  COL_EXTRA_RESUMEN: 9,
  ENCABEZADO_EXTRA_RESUMEN: ['Precio esperado', 'Regla aplicada', '% aplicado', 'Detectado', 'Observaciones'],
  COLUMNA_DETECTADO: 'Detectado',    // columna que lleva formato de fecha y hora
  FORMATO_FECHA_HORA: 'dd/MM/yyyy HH:mm',

  // Historial de ventas: cada fila de VS se guarda una sola vez (VS solo trae los ultimos dias) con lo que decia
  // en ese momento, mas el resultado de la revision. Nunca se borra ni se reescribe.
  HOJA_HISTORIAL: 'Historial',
  // El historial solo guarda ventas hasta ayer: las del dia todavia no tienen el pago cargado (se actualizan en informes distintos)
  HISTORIAL_SOLO_HASTA_AYER: true,
  // Una venta con datos de VS todavia sin resolver (Cobranza con #N/A, X o vacia; Vendedor con error) no se guarda hasta
  // que se resuelvan o pasen estos dias (VS conserva 7): asi el historial no queda con datos incompletos.
  HISTORIAL_ESPERA_DIAS: 3,
  // Las columnas de VS se copian tal cual (mismo orden y encabezados; si VS agrega una, se agrega aca tambien).
  // Despues van estas columnas de control, que ponen el script:
  ENCABEZADO_HISTORIAL_EXTRA: ['Precio esperado', 'Regla aplicada', 'Estado', 'Observaciones', 'Registrado', 'Clave'],

  // Hoja de conteo mensual: cantidad de operaciones (pedidos) por plan de pago, calculada desde Historial
  HOJA_CONTEO: 'Análisis',
  HOJA_CONTEO_ANTERIOR: 'Cuotas',   // si existe con este nombre, se renombra
  GRAFICOS_MESES: 12,              // meses que muestran los graficos (los ultimos)
  GRAFICOS_VENDEDORES: 8,          // vendedores que se muestran en el grafico de evolucion por vendedor
  GRAFICO_ALTO: 300, GRAFICO_ANCHO: 640,
  CONTEO_SIN_PLAN: 'Sin plan',   // cobranza vacia, X o con error
  // Cuando la cobranza no trae el plan (vacia, X o #N/A) se usa la condicion comercial para contarla:
  // por ejemplo GoCuotas cargado a mano porque el sistema no trajo el pago. condicion = texto que contiene el nombre.
  CONTEO_PLAN_POR_CONDICION: [
    { condicion: 'GoCuotas', plan: 'GoCuotas' },
    { condicion: 'Deposito', plan: 'Deposito Bancario' },
    { condicion: 'MODO', plan: 'MODO' }
  ],

  // Hoja de vendedores: por mes y vendedor, productos vendidos (lineas de VS) y su detalle por plan de pago.
  // Toma la columna "Vendedor" de VS (via Historial).
  HOJA_VENDEDORES: 'Vendedores',               // vendedores de los locales (con la sucursal)
  HOJA_VENDEDORES_ONLINE: 'Vendedores Online', // vendedores online, en un informe aparte
  VENDEDORES_ONLINE: ['A Asignar', 'Rocio', 'Marcos P', 'Ricardo Leon', 'Micaela'],
  // Sucursales de VS que en realidad son ventas online: van a "Vendedores Online" y en Analisis se agrupan como ONLINE
  SUCURSALES_ONLINE: ['FACT ELECTRONICA', 'FULFILLMENT'],
  SUCURSAL_ONLINE_ETIQUETA: 'ONLINE',
  VENDEDOR_ENCABEZADO: 'Vendedor',
  VENDEDOR_SIN: '(sin vendedor)',

  // Registro de cuando se detecto cada pedido a revisar (se conserva la primera vez)
  HOJA_DETECTADOS: 'Detectados',
  ENCABEZADO_DETECTADOS: ['Clave', 'Detectado', 'Avisado'],
  ETIQUETA_BASE: { minimo: 'mínimo', lista: 'lista' },

  // Regla con la que se evaluo cada pedido: si la hoja de condiciones cambia despues, no es retroactivo
  HOJA_REGLAS_APLICADAS: 'Reglas aplicadas',
  ENCABEZADO_REGLAS_APLICADAS: ['Clave', 'Condición', 'Precio Mínimo', 'Asignar precio lista', 'Coeficiente', 'Registrada'],
  RETENCION_DIAS: 90,

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
  // Canales de venta que no se analizan (venían excluidos en Ventas para Revisar)
  CANALES_NO_ANALIZAR: ['Corporativo', 'Fravega', 'BNA', 'BAPRO'],
  // Control de margen sobre costo (solo si VS tiene la columna "Costo producto"; ver VS_OPCIONALES)
  COSTO: {
    UMBRAL: 0.09,                                  // se revisa si (precio - costo) / costo es menor a este valor
    CANALES_EXCLUIDOS: ['TioMusaAhora12-ML', 'Mayorista'],
    PRODUCTOS_EXCLUIDOS: ['BENEFICIOS'],           // agregar aca los productos que no se quieren revisar
    PROMO_NEGRO: { condicion: 'Promo Negro', min: -0.20 },   // solo se revisa si el margen sobre costo es menor a esto
    // Condiciones cuyo precio esperado ya esta a ese % del PVM: no se revisan por costo dentro del rango
    VENTANAS_PCT_PVM: [
      { condicion: 'Negro', desde: -0.305, hasta: -0.295 },
      { condicion: 'Rojo', desde: -0.205, hasta: -0.195 }
    ]
  },
  // Si la condicion no define base de precio (Precio Minimo y Asignar precio lista en FALSE):
  // 'omitir' = no se controla | 'lista' = contra precio de lista | 'pvm' = contra PVM
  SIN_BASE: 'omitir',
  // Condiciones que no admiten cuotas: maximo de cuotas permitido en el plan cobrado (0 o 1)
  // Un numero fijo, o una lista de vigencias { desde: 'yyyy-mm-dd', max } segun la fecha del pedido (no es retroactivo)
  CONDICIONES_MAX_CUOTAS: {
    'Precio Online': 1,
    'Debito': 1,
    'Tarjeta de Credito': [{ desde: '2000-01-01', max: 1 }, { desde: '2026-11-16', max: 6 }]
  },
  // Si la cobranza automatica (VS G) es de este medio, la condicion comercial debe ser la de ese medio
  COBRANZA_AUTO_CONDICION: [{ cobranza: 'GOCuotas', condicion: 'GoCuotas' }],
  // Condicion comercial que no puede tener cierta cobranza (VS columna "Cobranza Automatica"): si la condicion
  // contiene el texto de "condicion" y la cobranza contiene el de "cobranza", el pedido entra a Revisar.
  CONDICION_COBRANZA_CRUZADA: [
    { condicion: 'GoCuotas', cobranza: 'MODO' },
    { condicion: 'QR', cobranza: 'MODO' }
  ],
  CONTROLAR_CUOTAS_NOMBRE: true,           // la cuota que dice el nombre de la condicion debe coincidir con la cobrada (VS col H)
  PATRON_CUOTAS_NOMBRE: '(\\d+)\\s*cuotas?', // ej. "6 Cuotas Verde", "MP 12 Cuotas"
  TOLERANCIA_PESOS: 1,
  // Excepciones: tolerancia en % por debajo del precio esperado, por condicion comercial
  TOLERANCIA_PORCENTAJE: { 'Mayorista': 0.15 },                     // diferencia aceptada por redondeos
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

  QR_CONDICION: 'QR Mercadopago',   // condicion que se muestra en Revisar para los pedidos de QR mal cobrado

  // Aviso por mail de los pedidos nuevos a revisar (un solo mail con todos los nuevos)
  MAIL_ACTIVO: true,
  MAIL_PARA: 'ricardoml@tiomusa.com.ar',
  MAIL_ASUNTO: '⚠️ Pedido para revisar',

  // Triggers (se instalan una vez con instalarTriggersCuotas)
  INTERVALO_HORAS: 1,   // Revisar se actualiza cada N horas
  HORA_HISTORIAL: 3,    // el historial (y las hojas Analisis y Vendedores) se arma una vez por dia a esta hora
  ESPERA_LOCK_MS: 30000
};

// ============================ TRIGGERS ============================
function instalarTriggersCuotas() {
  // Incluye los disparadores de versiones anteriores (Ventas para Revisar, menu Revision) para no dejarlos huerfanos
  const manejadores = ['actualizarResumenCuotas', 'actualizarHistorialCuotas', 'menuCuotas', 'revisarQRMercadopago',
                       'ventasParaRevisarCiclo', 'checkAndNotifyOffPrice', 'menuRevision'];
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return manejadores.indexOf(t.getHandlerFunction()) >= 0; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('actualizarResumenCuotas').timeBased().everyHours(CUOTAS_CFG.INTERVALO_HORAS).create();
  ScriptApp.newTrigger('actualizarHistorialCuotas').timeBased().atHour(CUOTAS_CFG.HORA_HISTORIAL).everyDays(1).create();
  // Menu como trigger instalable: no pisa un onOpen que ya exista en el proyecto
  ScriptApp.newTrigger('menuCuotas').forSpreadsheet(SpreadsheetApp.getActive()).onOpen().create();
  cuotasLog_('INFO', 'Triggers instalados: Revisar cada ' + CUOTAS_CFG.INTERVALO_HORAS + ' h (incluye QR Mercadopago), historial diario a las ' + CUOTAS_CFG.HORA_HISTORIAL + ':00 y menu Cuotas');
}

// ============================= MENU =============================
function menuCuotas() {
  SpreadsheetApp.getUi()
    .createMenu('Cuotas')
    .addItem('Actualizar Revisar', 'actualizarResumenCuotas')
    .addItem('Actualizar Historial', 'actualizarHistorialCuotas')
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
    const qr = cuotasLeerQR_(ss);      // pedidos de QR Mercadopago con descuento mal aplicado
    qr.forEach(function (f) { revisar.push(f); });
    const avisados = cuotasProcesarDetectados_(ss, revisar, cuotasSemillaQR_(ss));
    revisar.sort(function (a, b) { return cuotasFechaMs_(b.fecha) - cuotasFechaMs_(a.fecha); });
    cuotasEscribirResumen_(ss, revisar);
    cuotasLog_('OK', 'VS: ' + filas.length + ' filas leidas | QR mal cobrado: ' + qr.length + ' | Revisar: ' + revisar.length + ' | Avisados: ' + avisados + ' | ' + (Date.now() - t0) + ' ms');
  } catch (e) {
    cuotasLog_('ERROR', e.message + (e.stack ? ' | ' + e.stack.split('\n')[1] : ''));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

// =========================== HISTORIAL ===========================
// Copia a "Historial" cada fila de VS que todavia no estaba: todas las columnas de VS tal cual, mas las columnas de
// control (precio esperado, regla, estado, observaciones, cuando se registro y la clave). Cada venta se guarda una
// sola vez (clave pedido||producto||condicion; lineas identicas se distinguen por orden) y no se vuelve a tocar.
function cuotasRegistrarHistorial_(ss, filas) {
  const extra = CUOTAS_CFG.ENCABEZADO_HISTORIAL_EXTRA;
  const vs = ss.getSheetByName(CUOTAS_CFG.HOJA_VS).getDataRange().getValues();
  const encVS = vs[0].map(function (h) { return String(h).trim(); });
  const colsVS = [];   // columnas de VS con encabezado, sin repetir
  encVS.forEach(function (h, i) { if (h !== '' && encVS.indexOf(h) === i) colsVS.push(h); });

  let sh = ss.getSheetByName(CUOTAS_CFG.HOJA_HISTORIAL);
  if (sh && sh.getLastRow() > 0 && String(sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].join('|')).indexOf('Plan de pago') >= 0) {
    sh.setName(CUOTAS_CFG.HOJA_HISTORIAL + ' (version anterior)');   // formato de una version previa: se conserva aparte
    sh = null;
  }
  if (!sh) sh = ss.insertSheet(CUOTAS_CFG.HOJA_HISTORIAL);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, colsVS.length + extra.length).setValues([colsVS.concat(extra)]);
    sh.setFrozenRows(1);
  }
  let enc = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  // Columnas nuevas en VS: se insertan antes de las columnas de control
  colsVS.forEach(function (h) {
    if (enc.indexOf(h) >= 0) return;
    const pos = enc.indexOf(extra[0]) + 1;
    sh.insertColumnsBefore(pos, 1);
    sh.getRange(1, pos).setValue(h);
    enc.splice(pos - 1, 0, h);
  });
  const colClave = enc.indexOf('Clave') + 1;
  const colRegistrado = enc.indexOf('Registrado') + 1;
  const colFecha = enc.indexOf(CUOTAS_CFG.VS.fecha) + 1;

  const existentes = {};
  const ultima = sh.getLastRow();
  if (ultima > 1) {
    sh.getRange(2, colClave, ultima - 1, 1).getValues().forEach(function (r) { existentes[String(r[0])] = true; });
  }

  const ahora = new Date();
  const inicioHoy = new Date(ahora.getTime());
  inicioHoy.setHours(0, 0, 0, 0);
  const repetidas = {};
  const nuevas = [];
  filas.forEach(function (f) {
    repetidas[f.clave] = (repetidas[f.clave] || 0) + 1;
    const clave = f.clave + (repetidas[f.clave] > 1 ? '#' + repetidas[f.clave] : '');
    if (existentes[clave]) return;
    const crudo = vs[f.filaVS - 1];
    if (CUOTAS_CFG.HISTORIAL_SOLO_HASTA_AYER && cuotasFechaMs_(f.fecha) >= inicioHoy.getTime()) return;   // ventas de hoy: se guardan manana
    // Datos de VS que todavia no se resolvieron: se reintenta en la proxima corrida (hasta HISTORIAL_ESPERA_DIAS)
    const esperaMs = CUOTAS_CFG.HISTORIAL_ESPERA_DIAS * 24 * 3600 * 1000;
    if (!cuotasFechaMs_(f.fecha) || ahora.getTime() - cuotasFechaMs_(f.fecha) < esperaMs) {
      const iPlan = encVS.indexOf(CUOTAS_CFG.VS.cobranza), iVend = encVS.indexOf(CUOTAS_CFG.VENDEDOR_ENCABEZADO);
      const plan = iPlan >= 0 ? String(crudo[iPlan]).trim() : 'ok';
      const vend = iVend >= 0 ? String(crudo[iVend]).trim() : 'ok';
      const explicaCond = cuotasPlanPorCondicion_(f.condicion) !== '';   // GoCuotas, Deposito, MODO: el plan sale de la condicion
      if (!explicaCond && (plan === '' || plan.toUpperCase() === 'X' || plan.charAt(0) === '#') || vend.charAt(0) === '#') return;
    }
    existentes[clave] = true;
    const datos = {
      'Precio esperado': f.esperado, 'Regla aplicada': f.regla || '',
      'Estado': cuotasEsParaResumen_(f) ? 'Revisar' : 'OK', 'Observaciones': f.observaciones || '',
      'Registrado': ahora, 'Clave': clave
    };
    const fila = enc.map(function (h) {
      if (h in datos) return datos[h];
      const i = encVS.indexOf(h);
      return i >= 0 && crudo[i] !== undefined ? crudo[i] : '';
    });
    nuevas.push({ ms: cuotasFechaMs_(f.fecha), fila: fila });
  });
  if (!nuevas.length) return 0;
  nuevas.sort(function (a, b) { return a.ms - b.ms; });   // mas antiguas primero
  const valores = nuevas.map(function (n) { return n.fila; });
  const inicio = Math.max(sh.getLastRow(), 1) + 1;
  sh.getRange(inicio, 1, valores.length, enc.length).setValues(valores);
  if (colFecha > 0) sh.getRange(inicio, colFecha, valores.length, 1).setNumberFormat('dd/MM/yyyy');
  sh.getRange(inicio, colRegistrado, valores.length, 1).setNumberFormat(CUOTAS_CFG.FORMATO_FECHA_HORA);
  cuotasLog_('INFO', 'Historial: ' + valores.length + ' ventas nuevas registradas');
  return valores.length;
}

// =========================== CONTEO MENSUAL ===========================
// Hoja "Cuotas": por mes y por sucursal, cuantas operaciones (pedidos) hubo en cada plan de pago (efectivo, 01 Cuota, ...).
// Cada mes trae primero una fila TOTAL (todas las sucursales) y despues una fila por sucursal.
// Se calcula desde "Historial" (columnas Fecha, Sucursal, Pedido: ID y Cobranza), asi acumula todo el historico.
// Un pedido se cuenta una vez por plan, mes y sucursal (si tiene varios productos con el mismo plan, es una operacion).
function cuotasEtiquetaMes_(m) {
  return ('0' + (m % 100)).slice(-2) + '/' + Math.floor(m / 100);
}

// Arma una hoja de analisis: graficos arriba (dos por fila), despues la tabla de detalle y por ultimo los datos
// que alimentan cada grafico. graficos: [{ titulo, cabecera, filas }] (primera columna = categorias, el resto = series).
function cuotasEscribirAnalisis_(ss, nombre, nombreAnterior, tituloDetalle, encabezado, filas, graficos) {
  let sh = ss.getSheetByName(nombre);
  if (!sh) {
    const anterior = nombreAnterior ? ss.getSheetByName(nombreAnterior) : null;
    if (anterior) { anterior.setName(nombre); sh = anterior; }
    else sh = ss.insertSheet(nombre);
  }
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });
  sh.clear();

  const FILAS_POR_GRAFICO = Math.ceil(CUOTAS_CFG.GRAFICO_ALTO / 21) + 1;
  const filasGraficos = Math.ceil(graficos.length / 2) * FILAS_POR_GRAFICO;
  const filaDetalle = filasGraficos + 2;                       // titulo del detalle
  const filaTabla = filaDetalle + 1;                           // encabezado de la tabla
  const filaDatos = filaTabla + filas.length + 3;              // titulo de los datos de graficos
  let anchoMax = encabezado.length;
  let filasDatos = 0;
  graficos.forEach(function (g) {
    anchoMax = Math.max(anchoMax, g.cabecera.length);
    filasDatos += g.filas.length + 3;
  });
  const filasNecesarias = filaDatos + filasDatos + 2;
  if (sh.getMaxRows() < filasNecesarias) sh.insertRowsAfter(sh.getMaxRows(), filasNecesarias - sh.getMaxRows());
  if (sh.getMaxColumns() < Math.max(anchoMax, 15)) sh.insertColumnsAfter(sh.getMaxColumns(), Math.max(anchoMax, 15) - sh.getMaxColumns());
  sh.setColumnWidths(1, 15, 100);

  // Detalle
  sh.getRange(filaDetalle, 1).setValue(tituloDetalle).setFontWeight('bold');
  sh.getRange(filaTabla, 1, 1, encabezado.length).setValues([encabezado]).setFontWeight('bold');
  if (filas.length) {
    sh.getRange(filaTabla + 1, 1, filas.length, encabezado.length).setValues(filas);
    sh.getRange(filaTabla + 1, 1, filas.length, 1).setNumberFormat('MM/yyyy');
  }

  // Datos de los graficos + graficos
  if (graficos.length) sh.getRange(filaDatos, 1).setValue('Datos de los graficos (los usa el script, no editar)').setFontWeight('bold');
  let fila = filaDatos + 1;
  graficos.forEach(function (g, i) {
    sh.getRange(fila, 1).setValue(g.titulo).setFontWeight('bold');
    sh.getRange(fila + 1, 1, 1, g.cabecera.length).setValues([g.cabecera]);
    let rango;
    if (g.filas.length) {
      sh.getRange(fila + 2, 1, g.filas.length, g.cabecera.length).setValues(g.filas);
      rango = sh.getRange(fila + 1, 1, g.filas.length + 1, g.cabecera.length);
    } else {
      rango = sh.getRange(fila + 1, 1, 1, g.cabecera.length);
    }
    const grafico = sh.newChart()
      .setChartType(Charts.ChartType.COLUMN)
      .addRange(rango)
      .setNumHeaders(1)
      .setOption('title', g.titulo)
      .setOption('isStacked', true)
      .setOption('legend', { position: 'right' })
      .setOption('width', CUOTAS_CFG.GRAFICO_ANCHO)
      .setOption('height', CUOTAS_CFG.GRAFICO_ALTO)
      .setPosition(1 + Math.floor(i / 2) * FILAS_POR_GRAFICO, i % 2 === 0 ? 1 : 8, 0, 0)
      .build();
    sh.insertChart(grafico);
    fila += g.filas.length + 3;
  });
}

// Texto del plan de pago para contar: la cobranza tal cual, o "Sin plan" si esta vacia, es X o trae un error
function cuotasTextoPlan_(valor, condicion) {
  const texto = String(valor).trim();
  const clave = cuotasClave_(texto);
  if (clave !== '' && clave !== 'x' && texto.charAt(0) !== '#') return texto;
  const plan = cuotasPlanPorCondicion_(condicion);
  return plan || CUOTAS_CFG.CONTEO_SIN_PLAN;
}

// Plan que corresponde a la condicion comercial cuando la cobranza no lo trae ('' si no aplica)
function cuotasPlanPorCondicion_(condicion) {
  const c = cuotasClave_(condicion);
  if (c === '') return '';
  const lista = CUOTAS_CFG.CONTEO_PLAN_POR_CONDICION;
  for (let i = 0; i < lista.length; i++) {
    if (c.indexOf(cuotasClave_(lista[i].condicion)) >= 0) return lista[i].plan;
  }
  return '';
}

// Orden de columnas de planes: efectivo, luego cuotas de menor a mayor, otros, y "Sin plan" al final
function cuotasOrdenarPlanes_(etiquetas) {
  const sinPlan = cuotasClave_(CUOTAS_CFG.CONTEO_SIN_PLAN);
  const orden = function (k) {
    if (k === sinPlan) return [3, 0, k];
    if (k.indexOf('efectivo') >= 0) return [0, 0, k];
    const m = k.match(/\d+/);
    return m ? [1, parseInt(m[0], 10), k] : [2, 0, k];
  };
  return Object.keys(etiquetas).sort(function (a, b) {
    const x = orden(a), y = orden(b);
    return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
  });
}

function cuotasActualizarConteo_(ss) {
  const hist = ss.getSheetByName(CUOTAS_CFG.HOJA_HISTORIAL);
  if (!hist || hist.getLastRow() < 2) return;
  const datos = hist.getDataRange().getValues();
  const enc = datos[0].map(function (h) { return String(h).trim(); });
  const iFecha = enc.indexOf(CUOTAS_CFG.VS.fecha);
  const iPedido = enc.indexOf(CUOTAS_CFG.VS.pedido);
  const iPlan = enc.indexOf(CUOTAS_CFG.VS.cobranza);
  const iSucursal = enc.indexOf(CUOTAS_CFG.VS.sucursal);
  const iCond = enc.indexOf(CUOTAS_CFG.VS.condicion);
  if (iFecha < 0 || iPedido < 0 || iPlan < 0 || iSucursal < 0) throw new Error('Historial: faltan columnas Fecha, Sucursal, Pedido: ID o Cobranza');

  const etiquetas = {};   // clave del plan -> texto a mostrar
  const meses = {};       // mes (yyyymm) -> { sucursal -> { plan -> {pedido: true} } }
  for (let r = 1; r < datos.length; r++) {
    const d = datos[r];
    const pedido = String(d[iPedido]).trim();
    const ms = cuotasFechaMs_(d[iFecha]);
    if (pedido === '' || !ms) continue;
    const f = new Date(ms);
    const mes = f.getFullYear() * 100 + (f.getMonth() + 1);
    const texto = cuotasTextoPlan_(d[iPlan], iCond >= 0 ? d[iCond] : '');
    const clave = cuotasClave_(texto);
    if (!(clave in etiquetas)) etiquetas[clave] = texto;
    let suc = String(d[iSucursal]).trim() || '(sin sucursal)';
    if (cuotasEsSucursalOnline_(suc)) suc = CUOTAS_CFG.SUCURSAL_ONLINE_ETIQUETA;
    if (!meses[mes]) meses[mes] = {};
    if (!meses[mes][suc]) meses[mes][suc] = {};
    if (!meses[mes][suc][clave]) meses[mes][suc][clave] = {};
    meses[mes][suc][clave][pedido] = true;
  }

  const planes = cuotasOrdenarPlanes_(etiquetas);
  const clavesMes = Object.keys(meses).map(Number).sort(function (a, b) { return b - a; });   // mas reciente primero

  const encabezado = ['Mes', 'Sucursal'].concat(planes.map(function (k) { return etiquetas[k]; }), ['Total operaciones']);
  // Cuenta los pedidos distintos de un conjunto de sucursales (un pedido con dos planes cuenta una vez en el total)
  const contar = function (mesObj, sucursales) {
    const porPlan = {}, todos = {};
    sucursales.forEach(function (suc) {
      planes.forEach(function (k) {
        const peds = mesObj[suc][k];
        if (!peds) return;
        if (!porPlan[k]) porPlan[k] = {};
        Object.keys(peds).forEach(function (p) { porPlan[k][p] = true; todos[p] = true; });
      });
    });
    return planes.map(function (k) { return porPlan[k] ? Object.keys(porPlan[k]).length : 0; }).concat([Object.keys(todos).length]);
  };
  const filas = [];
  clavesMes.forEach(function (m) {
    const fecha = new Date(Math.floor(m / 100), m % 100 - 1, 1);
    const sucursales = Object.keys(meses[m]).sort();
    filas.push([fecha, 'TOTAL'].concat(contar(meses[m], sucursales)));
    sucursales.forEach(function (suc) { filas.push([fecha, suc].concat(contar(meses[m], [suc]))); });
  });

  // --- Graficos: ultimos meses, sin el total de cada fila ---
  const etiquetasPlanes = planes.map(function (k) { return etiquetas[k]; });
  const mesesAsc = clavesMes.slice().reverse().slice(-CUOTAS_CFG.GRAFICOS_MESES);
  const ultimo = clavesMes[0];
  const sinTotal = function (v) { return v.slice(0, planes.length); };
  const todasSuc = {};
  clavesMes.forEach(function (m) { Object.keys(meses[m]).forEach(function (x) { todasSuc[x] = true; }); });
  const sucursalesOrden = Object.keys(todasSuc).sort();
  const graficos = [];
  if (ultimo !== undefined) {
    graficos.push({
      titulo: 'Operaciones por mes - todas las sucursales', cabecera: ['Mes'].concat(etiquetasPlanes),
      filas: mesesAsc.map(function (m) { return [cuotasEtiquetaMes_(m)].concat(sinTotal(contar(meses[m], Object.keys(meses[m])))); })
    });
    graficos.push({
      titulo: 'Operaciones por sucursal - ' + cuotasEtiquetaMes_(ultimo) + ' (mes en curso o ultimo)', cabecera: ['Sucursal'].concat(etiquetasPlanes),
      filas: Object.keys(meses[ultimo]).sort().map(function (x) { return [x].concat(sinTotal(contar(meses[ultimo], [x]))); })
    });
    sucursalesOrden.forEach(function (x) {
      graficos.push({
        titulo: x + ' - operaciones por mes', cabecera: ['Mes'].concat(etiquetasPlanes),
        filas: mesesAsc.map(function (m) {
          return [cuotasEtiquetaMes_(m)].concat(meses[m][x] ? sinTotal(contar(meses[m], [x])) : planes.map(function () { return 0; }));
        })
      });
    });
  }
  cuotasEscribirAnalisis_(ss, CUOTAS_CFG.HOJA_CONTEO, CUOTAS_CFG.HOJA_CONTEO_ANTERIOR, 'Detalle por mes y sucursal (operaciones = pedidos)', encabezado, filas, graficos);
}

// =========================== VENDEDORES ===========================
// Dos hojas desde "Historial": "Vendedores" (locales, con la sucursal) y "Vendedores Online" (los de VENDEDORES_ONLINE).
// Por mes: productos vendidos (cada linea de VS es un producto) y su detalle por plan de pago (efectivo, 01 Cuota, ...).
function cuotasActualizarVendedores_(ss) {
  const hist = ss.getSheetByName(CUOTAS_CFG.HOJA_HISTORIAL);
  if (!hist || hist.getLastRow() < 2) return;
  const datos = hist.getDataRange().getValues();
  const enc = datos[0].map(function (h) { return String(h).trim(); });
  if (enc.indexOf(CUOTAS_CFG.VENDEDOR_ENCABEZADO) < 0) return;   // VS todavia no tiene la columna Vendedor
  if (enc.indexOf(CUOTAS_CFG.VS.fecha) < 0 || enc.indexOf(CUOTAS_CFG.VS.cobranza) < 0) throw new Error('Historial: faltan columnas Fecha o Cobranza');
  const online = {};
  CUOTAS_CFG.VENDEDORES_ONLINE.forEach(function (v) { online[cuotasClave_(v)] = true; });
  const esOnline = function (v, suc) { return !!online[cuotasClave_(v)] || cuotasEsSucursalOnline_(suc); };
  cuotasArmarVendedores_(ss, datos, enc, CUOTAS_CFG.HOJA_VENDEDORES, true, function (v, suc) { return !esOnline(v, suc); });
  cuotasArmarVendedores_(ss, datos, enc, CUOTAS_CFG.HOJA_VENDEDORES_ONLINE, false, esOnline);
}

function cuotasEsSucursalOnline_(suc) {
  const c = cuotasClave_(suc);
  return CUOTAS_CFG.SUCURSALES_ONLINE.some(function (x) { return cuotasClave_(x) === c; });
}

// Arma una hoja de vendedores con los vendedores que cumplen "incluir". conSucursal: agrega la sucursal a la tabla y un grafico por sucursal.
function cuotasArmarVendedores_(ss, datos, enc, nombreHoja, conSucursal, incluir) {
  const iVend = enc.indexOf(CUOTAS_CFG.VENDEDOR_ENCABEZADO);
  const iFecha = enc.indexOf(CUOTAS_CFG.VS.fecha);
  const iPlan = enc.indexOf(CUOTAS_CFG.VS.cobranza);
  const iCond = enc.indexOf(CUOTAS_CFG.VS.condicion);
  const iSuc = enc.indexOf(CUOTAS_CFG.VS.sucursal);
  const sin = CUOTAS_CFG.VENDEDOR_SIN;

  const etiquetas = {};
  const meses = {};   // mes -> { sucursal -> { vendedor -> { plan -> cantidad de productos } } }
  for (let r = 1; r < datos.length; r++) {
    const d = datos[r];
    const vend = String(d[iVend]).trim() || sin;
    if (!incluir(vend, iSuc >= 0 ? String(d[iSuc]).trim() : '')) continue;
    const ms = cuotasFechaMs_(d[iFecha]);
    if (!ms) continue;
    const f = new Date(ms);
    const mes = f.getFullYear() * 100 + (f.getMonth() + 1);
    const texto = cuotasTextoPlan_(d[iPlan], iCond >= 0 ? d[iCond] : '');
    const clave = cuotasClave_(texto);
    if (!(clave in etiquetas)) etiquetas[clave] = texto;
    const suc = conSucursal ? (iSuc >= 0 && String(d[iSuc]).trim() ? String(d[iSuc]).trim() : '(sin sucursal)') : '';
    if (!meses[mes]) meses[mes] = {};
    if (!meses[mes][suc]) meses[mes][suc] = {};
    if (!meses[mes][suc][vend]) meses[mes][suc][vend] = {};
    meses[mes][suc][vend][clave] = (meses[mes][suc][vend][clave] || 0) + 1;
  }

  const planes = cuotasOrdenarPlanes_(etiquetas);
  const etiquetasPlanes = planes.map(function (k) { return etiquetas[k]; });
  const sumar = function (acum, porPlan) { Object.keys(porPlan).forEach(function (k) { acum[k] = (acum[k] || 0) + porPlan[k]; }); };
  const suma = function (porPlan) { return Object.keys(porPlan).reduce(function (a, k) { return a + porPlan[k]; }, 0); };
  const cantidades = function (porPlan) { return planes.map(function (k) { return porPlan[k] || 0; }); };
  // Planes acumulados de un mes: de una sucursal (suc), de un vendedor (vend), de ambos o de todo
  const acumulado = function (m, suc, vend) {
    const acum = {};
    Object.keys(meses[m]).forEach(function (s) {
      if (suc !== null && s !== suc) return;
      Object.keys(meses[m][s]).forEach(function (v) { if (vend === null || v === vend) sumar(acum, meses[m][s][v]); });
    });
    return acum;
  };
  const ordenVend = function (m, suc, a, b) {
    const pa = acumulado(m, suc, a), pb = acumulado(m, suc, b);
    return (a === sin) - (b === sin) || suma(pb) - suma(pa) || (a < b ? -1 : a > b ? 1 : 0);
  };

  const encabezado = (conSucursal ? ['Mes', 'Sucursal', 'Vendedor'] : ['Mes', 'Vendedor']).concat(['Productos vendidos'], etiquetasPlanes);
  const fila = function (fecha, suc, vend, porPlan) {
    return [fecha].concat(conSucursal ? [suc, vend] : [vend], [suma(porPlan)], cantidades(porPlan));
  };
  const clavesMes = Object.keys(meses).map(Number).sort(function (a, b) { return b - a; });   // mas reciente primero
  const filas = [];
  clavesMes.forEach(function (m) {
    const fecha = new Date(Math.floor(m / 100), m % 100 - 1, 1);
    filas.push(fila(fecha, 'TOTAL', 'TOTAL', acumulado(m, null, null)));
    if (conSucursal) {
      // Por sucursal: una fila con el total de la sucursal y debajo sus vendedores
      Object.keys(meses[m]).sort().forEach(function (suc) {
        filas.push(fila(fecha, suc, 'TOTAL SUCURSAL', acumulado(m, suc, null)));
        Object.keys(meses[m][suc]).sort(function (a, b) { return ordenVend(m, suc, a, b); }).forEach(function (v) {
          filas.push(fila(fecha, suc, v, meses[m][suc][v]));
        });
      });
    } else {
      const vendedores = {};
      Object.keys(meses[m]).forEach(function (s) { Object.keys(meses[m][s]).forEach(function (v) { vendedores[v] = true; }); });
      Object.keys(vendedores).sort(function (a, b) { return ordenVend(m, null, a, b); }).forEach(function (v) {
        filas.push(fila(fecha, '', v, acumulado(m, null, v)));
      });
    }
  });

  // --- Graficos ---
  const mesesAsc = clavesMes.slice().reverse().slice(-CUOTAS_CFG.GRAFICOS_MESES);
  const ultimo = clavesMes[0];
  const etiqueta = conSucursal ? 'locales' : 'online';
  const graficos = [];
  if (ultimo !== undefined) {
    const nombresVend = function (m) {
      const v = {};
      Object.keys(meses[m]).forEach(function (s) { Object.keys(meses[m][s]).forEach(function (x) { v[x] = true; }); });
      return Object.keys(v);
    };
    graficos.push({
      titulo: 'Productos vendidos por mes - vendedores ' + etiqueta, cabecera: ['Mes'].concat(etiquetasPlanes),
      filas: mesesAsc.map(function (m) { return [cuotasEtiquetaMes_(m)].concat(cantidades(acumulado(m, null, null))); })
    });
    graficos.push({
      titulo: 'Productos por vendedor - ' + cuotasEtiquetaMes_(ultimo) + ' (mes en curso o ultimo), por plan de pago', cabecera: ['Vendedor'].concat(etiquetasPlanes),
      filas: nombresVend(ultimo).sort(function (a, b) { return ordenVend(ultimo, null, a, b); }).map(function (v) { return [v].concat(cantidades(acumulado(ultimo, null, v))); })
    });
    if (conSucursal) {
      graficos.push({
        titulo: 'Productos por sucursal - ' + cuotasEtiquetaMes_(ultimo) + ' (mes en curso o ultimo), por plan de pago', cabecera: ['Sucursal'].concat(etiquetasPlanes),
        filas: Object.keys(meses[ultimo]).sort().map(function (s) { return [s].concat(cantidades(acumulado(ultimo, s, null))); })
      });
    }
    // Evolucion por vendedor: los que mas vendieron en los meses mostrados
    const acumVend = {};
    mesesAsc.forEach(function (m) { nombresVend(m).forEach(function (v) { acumVend[v] = (acumVend[v] || 0) + suma(acumulado(m, null, v)); }); });
    const top = Object.keys(acumVend).filter(function (v) { return v !== sin; })
      .sort(function (a, b) { return acumVend[b] - acumVend[a]; }).slice(0, CUOTAS_CFG.GRAFICOS_VENDEDORES);
    if (top.length) {
      graficos.push({
        titulo: 'Productos vendidos por mes y vendedor (los ' + top.length + ' con mas ventas)', cabecera: ['Mes'].concat(top),
        filas: mesesAsc.map(function (m) { return [cuotasEtiquetaMes_(m)].concat(top.map(function (v) { return suma(acumulado(m, null, v)); })); })
      });
    }
  }
  const titulo = conSucursal ? 'Detalle por mes, sucursal y vendedor (productos = lineas de VS)' : 'Detalle por mes y vendedor online (productos = lineas de VS)';
  cuotasEscribirAnalisis_(ss, nombreHoja, null, titulo, encabezado, filas, graficos);
}

// =========================== QR MERCADOPAGO ===========================
// Los pedidos de QR Mercadopago con descuento mal aplicado (reglas en QRMercadopago.gs) se muestran en Revisar
// con el motivo en Observaciones y se avisan por el mismo mail que el resto.
function cuotasLeerQR_(ss) {
  return qrEvaluarPedidos_(ss).map(function (p) {
    return {
      fecha: p.fecha, sucursal: p.sucursal, pedido: p.id, condicion: CUOTAS_CFG.QR_CONDICION,
      producto: '(pedido completo)', precioUnitario: p.total, cuotas: '', canal: 'QR Mercadopago',
      esperado: '', regla: 'QR Mercadopago', aplicado: '', observaciones: p.motivo,
      clave: 'qr||' + cuotasClave_(p.id)
    };
  });
}

// Pedidos que ya estaban en la vieja hoja "QR mal cobrado": se registran como ya avisados
function cuotasSemillaQR_(ss) {
  const viejo = qrLeerRegistroViejo_(ss);
  const semilla = {};
  Object.keys(viejo).forEach(function (id) { semilla['qr||' + cuotasClave_(id)] = viejo[id]; });
  return semilla;
}

// Se ejecuta una vez por dia (disparador de las 3 AM; tambien desde el menu): guarda en Historial las ventas de VS
// hasta ayer y rearma las hojas Analisis y Vendedores.
function actualizarHistorialCuotas() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(CUOTAS_CFG.ESPERA_LOCK_MS)) {
    cuotasLog_('WARN', 'Historial: otra ejecucion en curso, se omite');
    return;
  }
  const t0 = Date.now();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const filas = cuotasLeerVS_(ss, cuotasLeerReglas_(ss));
    let nuevas = 0;
    try { nuevas = cuotasRegistrarHistorial_(ss, filas); } catch (e) { cuotasLog_('ERROR', 'Historial: ' + e.message); }
    try { cuotasActualizarConteo_(ss); } catch (e) { cuotasLog_('ERROR', 'Analisis: ' + e.message); }
    try { cuotasActualizarVendedores_(ss); } catch (e) { cuotasLog_('ERROR', 'Vendedores: ' + e.message); }
    cuotasLog_('OK', 'Historial: ' + nuevas + ' ventas nuevas | ' + (Date.now() - t0) + ' ms');
  } catch (e) {
    cuotasLog_('ERROR', 'Historial: ' + e.message);
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
  Object.keys(CUOTAS_CFG.VS_OPCIONALES).forEach(function (k) {
    const i = enc.indexOf(CUOTAS_CFG.VS_OPCIONALES[k]);
    if (i >= 0) col[k] = i;
  });
  const snapshots = cuotasLeerReglasAplicadas_(ss);
  const nuevos = [];
  const filas = [];
  for (let r = 1; r < datos.length; r++) {
    const f = datos[r];
    if (String(f[col.pedido]).trim() === '') continue;
    const fila = {};
    Object.keys(col).forEach(function (k) { fila[k] = f[col[k]]; });

    // Regla vigente al evaluar el pedido por primera vez (no cambia si despues cambia la hoja)
    const cond = cuotasClave_(fila.condicion);
    const clave = cuotasClave_(fila.pedido) + '||' + cuotasClave_(fila.producto) + '||' + cond;
    let regla = snapshots[clave];
    if (!regla && reglas[cond]) {
      regla = reglas[cond];
      snapshots[clave] = regla;
      nuevos.push([clave, regla.nombre, regla.precioMinimo, regla.precioLista, regla.coeficiente === null ? '' : regla.coeficiente, new Date()]);
    }
    const reglasFila = {};
    if (regla) reglasFila[cond] = regla;
    // Regla de la condicion que debieron usar (ej. GoCuotas), tambien congelada al detectar
    const req = cuotasCondicionRequerida_(fila);
    if (req) {
      const condReq = cuotasClave_(req.condicion);
      const claveReq = cuotasClave_(fila.pedido) + '||' + cuotasClave_(fila.producto) + '||' + condReq;
      let reglaReq = snapshots[claveReq];
      if (!reglaReq && reglas[condReq]) {
        reglaReq = reglas[condReq];
        snapshots[claveReq] = reglaReq;
        nuevos.push([claveReq, reglaReq.nombre, reglaReq.precioMinimo, reglaReq.precioLista, reglaReq.coeficiente === null ? '' : reglaReq.coeficiente, new Date()]);
      }
      if (reglaReq) reglasFila[condReq] = reglaReq;
    }
    Object.assign(fila, evaluarFila_(fila, reglasFila));
    fila.clave = clave;
    fila.reglaCongelada = regla || null;   // regla de la condicion vigente cuando se evaluo el pedido por primera vez
    fila.filaVS = r + 1;
    filas.push(fila);
  }
  cuotasGuardarReglasAplicadas_(ss, nuevos);
  return filas;
}

function cuotasLeerReglasAplicadas_(ss) {
  const mapa = {};
  const sh = ss.getSheetByName(CUOTAS_CFG.HOJA_REGLAS_APLICADAS);
  if (!sh || sh.getLastRow() < 2) return mapa;
  const datos = sh.getDataRange().getValues();
  for (let r = 1; r < datos.length; r++) {
    const f = datos[r];
    if (String(f[0]) === '') continue;
    mapa[String(f[0])] = {
      nombre: String(f[1]),
      precioMinimo: f[2] === true || String(f[2]).toUpperCase() === 'TRUE',
      precioLista: f[3] === true || String(f[3]).toUpperCase() === 'TRUE',
      coeficiente: cuotasANumero_(f[4])
    };
  }
  return mapa;
}

function cuotasGuardarReglasAplicadas_(ss, nuevos) {
  const nCols = CUOTAS_CFG.ENCABEZADO_REGLAS_APLICADAS.length;
  const sh = ss.getSheetByName(CUOTAS_CFG.HOJA_REGLAS_APLICADAS) || ss.insertSheet(CUOTAS_CFG.HOJA_REGLAS_APLICADAS);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, nCols).setValues([CUOTAS_CFG.ENCABEZADO_REGLAS_APLICADAS]);
  if (nuevos.length) sh.getRange(sh.getLastRow() + 1, 1, nuevos.length, nCols).setValues(nuevos);

  // Limpieza de registros viejos
  const limite = Date.now() - CUOTAS_CFG.RETENCION_DIAS * 24 * 3600 * 1000;
  const datos = sh.getDataRange().getValues();
  const vigentes = datos.slice(1).filter(function (f) {
    return !(f[5] instanceof Date) || f[5].getTime() >= limite;
  });
  if (vigentes.length < datos.length - 1) {
    sh.getRange(2, 1, sh.getMaxRows() - 1, nCols).clearContent();
    if (vigentes.length) sh.getRange(2, 1, vigentes.length, nCols).setValues(vigentes);
  }
}

// ====================== REGISTRO DE DETECCION ======================
// Guarda cuando se detecto por primera vez cada pedido a revisar (queda en f.detectado) y avisa por mail
// los que todavia no se avisaron. Devuelve la cantidad de pedidos avisados.
function cuotasProcesarDetectados_(ss, filas, semilla) {
  const nCols = CUOTAS_CFG.ENCABEZADO_DETECTADOS.length;
  const sh = ss.getSheetByName(CUOTAS_CFG.HOJA_DETECTADOS) || ss.insertSheet(CUOTAS_CFG.HOJA_DETECTADOS);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, nCols).setValues([CUOTAS_CFG.ENCABEZADO_DETECTADOS]);

  const datos = sh.getDataRange().getValues();
  const conAvisado = String(datos[0][2] === undefined ? '' : datos[0][2]).trim() === CUOTAS_CFG.ENCABEZADO_DETECTADOS[2];
  const registros = [];   // [clave, detectado, avisado]
  const indice = {};
  for (let r = 1; r < datos.length; r++) {
    if (String(datos[r][0]) === '') continue;
    // Registros de antes de existir el aviso: ya se conocian, no se vuelven a avisar
    const avisado = conAvisado ? datos[r][2] : datos[r][1];
    indice[String(datos[r][0])] = registros.length;
    registros.push([datos[r][0], datos[r][1], avisado]);
  }
  // Registros que ya existian en una version anterior: figuran como detectados y avisados
  Object.keys(semilla || {}).forEach(function (k) {
    if (!(k in indice)) {
      const d = semilla[k] instanceof Date ? semilla[k] : new Date();
      indice[k] = registros.length;
      registros.push([k, d, d]);
    }
  });
  const ahora = new Date();
  const pendientes = [];
  filas.forEach(function (f) {
    const k = f.clave;
    if (!(k in indice)) {
      indice[k] = registros.length;
      registros.push([k, ahora, '']);
    }
    const reg = registros[indice[k]];
    f.detectado = reg[1];
    if (reg[2] === '') pendientes.push({ fila: f, reg: reg });
  });

  // Aviso por mail: si falla, no se marcan y se reintenta en la proxima ejecucion
  let avisados = 0;
  if (CUOTAS_CFG.MAIL_ACTIVO && pendientes.length) {
    try {
      cuotasEnviarMail_(pendientes.map(function (p) { return p.fila; }));
      pendientes.forEach(function (p) { p.reg[2] = ahora; });
      avisados = pendientes.length;
    } catch (e) {
      cuotasLog_('ERROR', 'No se pudo enviar el mail (se reintenta): ' + e.message);
    }
  }

  // Limpieza de registros viejos y guardado
  const limite = Date.now() - CUOTAS_CFG.RETENCION_DIAS * 24 * 3600 * 1000;
  const actuales = {};
  filas.forEach(function (f) { actuales[f.clave] = true; });
  const vigentes = registros.filter(function (g) {   // lo que sigue en Revisar no se borra, para no volver a avisarlo
    return actuales[g[0]] || !(g[1] instanceof Date) || g[1].getTime() >= limite;
  });
  sh.getRange(1, 1, 1, nCols).setValues([CUOTAS_CFG.ENCABEZADO_DETECTADOS]);
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), nCols).clearContent();
  if (vigentes.length) sh.getRange(2, 1, vigentes.length, nCols).setValues(vigentes);
  return avisados;
}

// Un solo mail con todos los pedidos nuevos a revisar
function cuotasEnviarMail_(filas) {
  const n = filas.length;
  const tz = Session.getScriptTimeZone();
  let cuerpo = (n === 1 ? '1 pedido para revisar' : n + ' pedidos para revisar') + ':\n';
  filas.forEach(function (f, k) {
    cuerpo += '\n----------------------------------------\n';
    cuerpo += 'Pedido ' + (k + 1) + ' de ' + n + '\n\n';
    cuerpo += 'Pedido: ' + f.pedido + '\n';
    cuerpo += 'Fecha: ' + (f.fecha instanceof Date ? Utilities.formatDate(f.fecha, tz, 'dd/MM/yyyy') : f.fecha) + '\n';
    cuerpo += 'Sucursal: ' + f.sucursal + '\n';
    cuerpo += 'Canal: ' + f.canal + '\n';
    cuerpo += 'Condicion comercial: ' + f.condicion + '\n';
    cuerpo += 'Producto: ' + f.producto + '\n';
    cuerpo += 'Precio cobrado: $' + cuotasMonto_(cuotasANumero_(f.precioUnitario)) + '\n';
    if (f.esperado !== '' && f.esperado !== null && f.esperado !== undefined) cuerpo += 'Precio esperado: $' + cuotasMonto_(f.esperado) + '\n';
    cuerpo += 'Observaciones: ' + f.observaciones + '\n';
  });
  MailApp.sendEmail({
    to: CUOTAS_CFG.MAIL_PARA,
    subject: n === 1 ? CUOTAS_CFG.MAIL_ASUNTO : CUOTAS_CFG.MAIL_ASUNTO + ' (' + n + ')',
    body: cuerpo
  });
}

// ============================ REGLAS ============================
function cuotasClave_(v) {
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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

function cuotasMonto_(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function cuotasPct_(x) {
  return (Math.round(x * 1000) / 10).toFixed(1).replace('.', ',') + '%';
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
  let out = evaluarFilaBase_(f, reglas);
  const req = cuotasCondicionRequerida_(f);
  if (req) {
    const detalle = 'Cobranza ' + req.cobranza + ' pero la condicion es "' + f.condicion + '" (debe ser ' + req.condicion + ')';
    // Precio esperado segun la condicion que debieron usar (ej. GoCuotas con su recargo)
    const reglaReq = reglas[cuotasClave_(req.condicion)];
    const precioReq = reglaReq ? evaluarPrecioCondicion_(f, reglaReq) : null;
    if (precioReq && precioReq.esperado !== '') {
      out = {
        estado: 'revisar',
        esperado: precioReq.esperado,
        regla: 'Debio ser ' + req.condicion + ': ' + precioReq.regla + ' | ' + detalle,
        aplicado: precioReq.aplicado || '',
        motivos: [detalle + '. Con ' + req.condicion + ' debia cobrar $' + cuotasMonto_(precioReq.esperado) +
                  ' (' + precioReq.regla + '), cobro $' + cuotasMonto_(cuotasANumero_(f.precioUnitario))]
      };
    } else {
      out = {
        estado: 'revisar',
        esperado: out.esperado,
        regla: (out.regla ? out.regla + ' | ' : '') + detalle,
        aplicado: out.aplicado || '',
        motivos: (out.motivos || []).concat([detalle])
      };
    }
  }
  // Condicion que no corresponde con la cobranza cargada (ej. GoCuotas cobrado por MODO)
  const cruzada = cuotasCobranzaCruzada_(f);
  if (cruzada) {
    out.estado = 'revisar';
    out.regla = (out.regla ? out.regla + ' | ' : '') + cruzada;
    out.motivos = (out.motivos || []).concat([cruzada]);
  }
  // Margen sobre costo (si VS tiene la columna de costo)
  const costo = cuotasEsNoAnalizar_(f) ? '' : evaluarCostoFila_(f);
  if (costo) {
    out.estado = 'revisar';
    out.motivos = (out.motivos || []).concat([costo]);
  }
  out.observaciones = (out.motivos || []).join(' | ');
  return out;
}

// Margen sobre costo menor al umbral (con las excepciones heredadas de Ventas para Revisar)
function evaluarCostoFila_(f) {
  const c = CUOTAS_CFG.COSTO;
  const costo = cuotasANumero_(f.costo);
  const pu = cuotasANumero_(f.precioUnitario);
  if (costo === null || costo === 0 || pu === null) return '';
  const canal = cuotasClave_(f.canal);
  const producto = cuotasClave_(f.producto);
  const cond = cuotasClave_(f.condicion);
  if (c.CANALES_EXCLUIDOS.some(function (x) { return cuotasClave_(x) === canal; })) return '';
  if (c.PRODUCTOS_EXCLUIDOS.some(function (x) { return cuotasClave_(x) === producto; })) return '';
  const pvm = cuotasANumero_(f.pvm);
  const pctPvm = pvm ? (pu - pvm) / pvm : null;
  if (pctPvm !== null && c.VENTANAS_PCT_PVM.some(function (w) {
    return cuotasClave_(w.condicion) === cond && pctPvm > w.desde && pctPvm < w.hasta;
  })) return '';
  const umbral = cond === cuotasClave_(c.PROMO_NEGRO.condicion) ? c.PROMO_NEGRO.min : c.UMBRAL;
  const pctCosto = (pu - costo) / costo;
  if (pctCosto >= umbral) return '';
  return 'Margen sobre costo ' + cuotasPct_(pctCosto) + ' (menor a ' + cuotasPct_(umbral) + '): cobro $' +
         cuotasMonto_(pu) + ' con costo $' + cuotasMonto_(costo);
}

// Cobranza automatica (VS G) de un medio (ej. GOCuotas) con otra condicion comercial: se evitaria el recargo.
// Devuelve el par { cobranza, condicion } que corresponde, o null
// Texto del cruce si la condicion comercial no puede ir con esa cobranza ('' si esta bien)
function cuotasCobranzaCruzada_(f) {
  if (cuotasEsNoAnalizar_(f)) return '';
  const g = cuotasClave_(f.cobranzaAuto);
  if (g === '') return '';
  const cond = cuotasClave_(f.condicion);
  for (let i = 0; i < CUOTAS_CFG.CONDICION_COBRANZA_CRUZADA.length; i++) {
    const p = CUOTAS_CFG.CONDICION_COBRANZA_CRUZADA[i];
    if (cond.indexOf(cuotasClave_(p.condicion)) >= 0 && g.indexOf(cuotasClave_(p.cobranza)) >= 0) {
      return 'Condicion "' + f.condicion + '" pero la cobranza es ' + p.cobranza;
    }
  }
  return '';
}

function cuotasCondicionRequerida_(f) {
  if (cuotasEsNoAnalizar_(f)) return null;
  const g = cuotasClave_(f.cobranzaAuto);
  if (g === '') return null;
  for (let i = 0; i < CUOTAS_CFG.COBRANZA_AUTO_CONDICION.length; i++) {
    const p = CUOTAS_CFG.COBRANZA_AUTO_CONDICION[i];
    if (g.indexOf(cuotasClave_(p.cobranza)) >= 0 && cuotasClave_(f.condicion).indexOf(cuotasClave_(p.condicion)) < 0) return p;
  }
  return null;
}

function cuotasEsNoAnalizar_(f) {
  return CUOTAS_CFG.CONDICIONES_NO_ANALIZAR.some(function (c) {
    return cuotasClave_(c) === cuotasClave_(f.condicion);
  }) || CUOTAS_CFG.SUCURSALES_NO_ANALIZAR.some(function (s) {
    return cuotasClave_(s) === cuotasClave_(f.sucursal);
  }) || CUOTAS_CFG.CANALES_NO_ANALIZAR.some(function (c) {
    return cuotasClave_(c) === cuotasClave_(f.canal);
  }) || CUOTAS_CFG.CANAL_CONDICION_NO_ANALIZAR.some(function (p) {
    return cuotasClave_(p.canal) === cuotasClave_(f.canal) && cuotasClave_(p.condicion) === cuotasClave_(f.condicion);
  });
}

function evaluarFilaBase_(f, reglas) {
  if (cuotasEsNoAnalizar_(f)) return { estado: '', esperado: '', regla: '', motivos: [] };
  const regla = reglas[cuotasClave_(f.condicion)];
  if (regla) return evaluarPorCondicion_(f, regla);
  // Condicion que no esta en la hoja: igual se controla la cuota que dice el nombre
  const cuotas = evaluarCuotasNombre_(f, { nombre: f.condicion });
  const estadoCuotas = CUOTAS_CFG.USAR_REGLA_CUOTAS_SIN_CONDICION ? evaluarCuotas_(f) : '';
  if (!cuotas.ok) return { estado: 'revisar', esperado: '', regla: cuotas.detalle, motivos: [cuotas.detalle] };
  if (CUOTAS_CFG.USAR_REGLA_CUOTAS_SIN_CONDICION) {
    const motivos = [];
    if (estadoCuotas === 'revisar') {
      const pu = cuotasANumero_(f.precioUnitario);
      const esQr = String(f.condicion) === CUOTAS_CFG.COND_QR_MINIMO;
      const ref = esQr ? cuotasANumero_(f.pvm) : cuotasANumero_(f.lista);
      motivos.push('Condicion "' + f.condicion + '" sin regla en condiciones comerciales; cobro en ' + cuotasANumero_(f.cuotas) +
                   ' cuotas por $' + cuotasMonto_(pu) + (ref === null
                     ? ' y falta el ' + (esQr ? 'PVM' : 'precio de lista') + ' para validar'
                     : ', por debajo del ' + (esQr ? 'PVM' : 'precio de lista') + ' de $' + cuotasMonto_(ref)));
    }
    return { estado: estadoCuotas, esperado: '', regla: 'cuotas', motivos: motivos };
  }
  return { estado: '', esperado: '', regla: '', motivos: [] };
}

// Condicion comercial de la hoja: precio esperado = base (lista o PVM) x coeficiente,
// y la cuota del nombre de la condicion debe coincidir con la cuota cobrada
function evaluarPorCondicion_(f, regla) {
  const precio = evaluarPrecioCondicion_(f, regla);
  const cuotas = evaluarCuotasNombre_(f, regla);
  const motivos = (precio.motivos || []).slice();
  if (!cuotas.ok) motivos.push(cuotas.detalle);
  if (cuotas.detalle === '') return precio;
  return {
    estado: cuotas.ok ? precio.estado : 'revisar',
    esperado: precio.esperado,
    regla: (precio.regla ? precio.regla + ' | ' : '') + cuotas.detalle,
    aplicado: precio.aplicado || '',
    motivos: motivos
  };
}

function evaluarPrecioCondicion_(f, regla) {
  let base = null;
  let nombreBase = '';
  // Si Precio Minimo esta en TRUE la base es el minimo (PVM), aunque Asignar precio lista tambien lo este
  if (regla.precioMinimo) { base = cuotasANumero_(f.pvm); nombreBase = 'PVM'; }
  else if (regla.precioLista) { base = cuotasANumero_(f.lista); nombreBase = 'Lista'; }
  else if (CUOTAS_CFG.SIN_BASE === 'lista') { base = cuotasANumero_(f.lista); nombreBase = 'Lista'; }
  else if (CUOTAS_CFG.SIN_BASE === 'pvm') { base = cuotasANumero_(f.pvm); nombreBase = 'PVM'; }
  else return { estado: '', esperado: '', regla: '', aplicado: '', motivos: [] };

  if (regla.coeficiente === null) return { estado: '', esperado: '', regla: '', aplicado: '', motivos: [] };
  const etiqueta = nombreBase + ' x ' + regla.coeficiente;
  const pu = cuotasANumero_(f.precioUnitario);
  if (base === null || pu === null) {
    return { estado: 'revisar', esperado: '', regla: etiqueta + ' (falta precio)', aplicado: '',
             motivos: ['No se pudo validar el precio con ' + etiqueta + ': falta ' + (pu === null ? 'el precio cobrado' : (nombreBase === 'Lista' ? 'el precio de lista' : 'el PVM'))] };
  }

  const esperado = Math.round(base * regla.coeficiente * 100) / 100;
  const pct = cuotasToleranciaPorcentaje_(regla.nombre);
  const tolerancia = Math.max(CUOTAS_CFG.TOLERANCIA_PESOS, esperado * pct);
  let estado;
  if (pu < esperado - tolerancia) estado = 'revisar';
  else if (pu <= esperado + CUOTAS_CFG.TOLERANCIA_PESOS) estado = 'ok';
  else estado = 'bien';
  const etiquetaFinal = pct > 0 ? etiqueta + ' (tolerancia ' + String(Math.round(pct * 1000) / 10).replace('.', ',') + '%)' : etiqueta;
  const motivos = estado === 'revisar'
    ? ['Cobro $' + cuotasMonto_(pu) + ' y con ' + etiquetaFinal + ' debia cobrar al menos $' + cuotasMonto_(esperado - tolerancia) +
       ' (' + nombreBase + ' $' + cuotasMonto_(base) + ' x ' + regla.coeficiente + ')']
    : [];
  return { estado: estado, esperado: esperado, regla: etiquetaFinal, aplicado: cuotasPorcentajeAplicado_(pu, base, nombreBase), motivos: motivos };
}

function cuotasMaximoCuotas_(nombreCondicion, fecha) {
  const mapa = CUOTAS_CFG.CONDICIONES_MAX_CUOTAS;
  const k = cuotasClave_(nombreCondicion);
  for (const nombre in mapa) {
    if (cuotasClave_(nombre) !== k) continue;
    const v = mapa[nombre];
    if (!Array.isArray(v)) return v;
    const dia = cuotasFechaTexto_(fecha);
    let max = null;
    v.slice().sort(function (a, b) { return a.desde < b.desde ? -1 : 1; }).forEach(function (p) {
      if (dia === '' || p.desde <= dia) max = p.max;
    });
    return max;
  }
  return null;
}

// Fecha del pedido como yyyy-mm-dd (zona horaria del script)
function cuotasFechaTexto_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function cuotasToleranciaPorcentaje_(nombreCondicion) {
  const mapa = CUOTAS_CFG.TOLERANCIA_PORCENTAJE;
  const k = cuotasClave_(nombreCondicion);
  for (const nombre in mapa) {
    if (cuotasClave_(nombre) === k) return mapa[nombre];
  }
  return 0;
}

// % real cobrado sobre la base, ej. "+1,4% sobre lista" o "-5,0% sobre mínimo"
function cuotasPorcentajeAplicado_(precio, base, nombreBase) {
  if (!base) return '';
  const pct = Math.round((precio / base - 1) * 1000) / 10;
  const texto = (pct > 0 ? '+' : '') + pct.toFixed(1).replace('.', ',') + '%';
  const etiqueta = nombreBase === 'Lista' ? CUOTAS_CFG.ETIQUETA_BASE.lista : CUOTAS_CFG.ETIQUETA_BASE.minimo;
  return texto + ' sobre ' + etiqueta;
}

// Cuotas que dice el nombre de la condicion vs cuota cobrada (Cobranza 2).
// Si la cobranza no tiene dato (vacio, X o #N/A) no se puede verificar y no se marca.
function evaluarCuotasNombre_(f, regla) {
  const vacio = { ok: true, detalle: '' };
  if (!CUOTAS_CFG.CONTROLAR_CUOTAS_NOMBRE) return vacio;
  const cobranza = String(f.cobranza === null || f.cobranza === undefined ? '' : f.cobranza).trim().toUpperCase();
  if (cobranza === '' || cobranza === 'X' || cobranza === '#N/A') return vacio;
  const cobradas = cuotasANumero_(f.cuotas);
  if (cobradas === null) return vacio;

  // Condiciones que no admiten cuotas (ej. Precio Online: maximo 1)
  const max = cuotasMaximoCuotas_(regla.nombre, f.fecha);
  if (max !== null) {
    return cobradas <= max ? vacio : { ok: false, detalle: 'Cuotas: ' + regla.nombre + ' admite hasta ' + max + ', cobradas ' + cobradas };
  }

  const m = String(regla.nombre).match(new RegExp(CUOTAS_CFG.PATRON_CUOTAS_NOMBRE, 'i'));
  if (!m) return vacio;
  const esperadas = parseInt(m[1], 10);
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
  let sh = ss.getSheetByName(CUOTAS_CFG.HOJA_RESUMEN);
  if (!sh) {
    // La hoja se llamaba Resumen: se renombra para conservar formato y anchos
    const anterior = ss.getSheetByName(CUOTAS_CFG.HOJA_RESUMEN_ANTERIOR);
    if (anterior) { anterior.setName(CUOTAS_CFG.HOJA_RESUMEN); sh = anterior; }
    else sh = ss.insertSheet(CUOTAS_CFG.HOJA_RESUMEN);
  }
  const nCols = CUOTAS_CFG.ENCABEZADO_RESUMEN.length;
  sh.getRange(1, 1, sh.getMaxRows(), nCols).clearContent(); // tambien saca el QUERY viejo de A1
  sh.getRange(1, 1, 1, nCols).setValues([CUOTAS_CFG.ENCABEZADO_RESUMEN]);
  const nExtra = CUOTAS_CFG.ENCABEZADO_EXTRA_RESUMEN.length;
  sh.getRange(1, CUOTAS_CFG.COL_EXTRA_RESUMEN, sh.getMaxRows(), nExtra + 1).clearContent(); // +1 limpia la columna sobrante del layout anterior
  sh.getRange(1, CUOTAS_CFG.COL_EXTRA_RESUMEN, 1, nExtra).setValues([CUOTAS_CFG.ENCABEZADO_EXTRA_RESUMEN]);
  if (filas.length) {
    const valores = filas.map(function (f) {
      return [f.fecha, f.sucursal, f.pedido, f.condicion, f.producto, f.precioUnitario, f.cuotas, f.canal];
    });
    sh.getRange(2, 1, valores.length, nCols).setValues(valores);
    const extra = filas.map(function (f) { return [f.esperado, f.regla, f.aplicado || '', f.detectado || '', f.observaciones || '']; });
    sh.getRange(2, CUOTAS_CFG.COL_EXTRA_RESUMEN, extra.length, nExtra).setValues(extra);
    const colDetectado = CUOTAS_CFG.COL_EXTRA_RESUMEN + CUOTAS_CFG.ENCABEZADO_EXTRA_RESUMEN.indexOf(CUOTAS_CFG.COLUMNA_DETECTADO);
    sh.getRange(2, colDetectado, extra.length, 1).setNumberFormat(CUOTAS_CFG.FORMATO_FECHA_HORA);
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
