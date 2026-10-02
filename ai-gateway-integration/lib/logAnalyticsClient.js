// lib/logAnalyticsClient.js
//
// Segunda fuente de telemetria, EXCLUSIVA para finops-framework-inference-api.
//
// Por que existe este archivo aparte de appInsightsClient.js: la politica de
// metricas de tokens (llm-emit-token-metric / azure-openai-emit-token-metric)
// nunca emitio nada de forma confiable para esta API especifica en este APIM,
// pese a 3 intentos distintos de politica (ver gateway/finops-framework-inference-api-policy.xml).
// En cambio, este laboratorio (el "AI-Gateway FinOps Framework" oficial de
// Microsoft) ya trae su PROPIO log nativo de tokens -- la tabla
// ApiManagementGatewayLlmLog -- en un Log Analytics workspace dedicado, y esa
// tabla si trae datos reales (confirmado consultandola directamente).
//
// OJO: ese workspace NO es exclusivo de finops-framework-inference-api --
// es compartido con otros labs del mismo APIM (ver el comentario dentro de
// getConsumoFinops() sobre el join contra ApiManagementGatewayLogs, que es
// lo que aisla el consumo de finops del de los demas labs).
//
// Autenticacion: NO usa un Service Principal / App Registration, porque este
// usuario no tiene permisos en el tenant para registrar aplicaciones
// (Insufficient privileges). En su lugar se ELIGE la credencial segun el
// ambiente, en vez de dejarselo a DefaultAzureCredential:
//   - Corriendo en Azure (Container Apps, App Service, VM, etc.): se usa
//     ManagedIdentityCredential explicitamente. Container Apps (y App
//     Service) exponen la variable de entorno IDENTITY_ENDPOINT solo cuando
//     la Managed Identity esta activa -- es la señal que se usa aqui para
//     detectar "estamos en Azure".
//   - Corriendo local (npm start en tu maquina): usa AzureCliCredential, tu
//     sesion de "az login" (si no has corrido "az login" o expiro, ahi es
//     donde va a fallar).
// Se prefirio esto sobre DefaultAzureCredential (que en teoria prueba varios
// metodos en orden y deberia funcionar en los dos ambientes sin este if) por
// un problema real que se encontro en produccion: la cadena automatica de
// DefaultAzureCredential no reconocio bien la Managed Identity de Container
// Apps y termino cayendo hasta AzureCliCredential, que fallo porque el
// contenedor (basado en node:20-slim) no tiene az cli instalado --
// CredentialUnavailableError: "Azure CLI could not be found". Eligiendo la
// credencial explicitamente se evita depender de esa deteccion automatica.
// Si en el futuro se resuelve el permiso para crear una App Registration,
// se puede migrar a ClientSecretCredential sin tocar el resto de este
// archivo (getCredential() es el unico punto que cambiaria).
//
// Limitacion conocida (a diferencia de appInsightsClient.js): la tabla
// ApiManagementGatewayLlmLog NO tiene ningun campo de usuario ni de producto
// -- asi que lo que devolvemos aqui es el consumo TOTAL agregado de
// finops-framework-inference-api, no desglosado por usuario.
//
// FIX 2026-09-15 (1/2): el join contra ApiManagementGatewayLogs filtraba por
// "ApiId == API_ID_LABEL" (igualdad exacta, sensible a mayusculas). Se
// confirmo consultando el workspace directamente que ApiManagementGatewayLlmLog
// SI tenia datos de trafico real, pero la fila de finops seguia devolviendo
// siempre 0/0/0 sin importar el rango de tiempo -- señal de que el join
// nunca encontraba coincidencia, no de que faltara trafico. La causa mas
// probable es el mismo tipo de problema que ya se resolvio en lib/pricing.js
// para nombres de modelo con la version pegada: el campo ApiId en
// ApiManagementGatewayLogs puede venir con la revision pegada
// ("finops-framework-inference-api;rev=1") o con distinta capitalizacion, y
// la igualdad exacta no lo captura. Se cambio a una comparacion insensible a
// mayusculas ("=~") mas una variante que acepta el sufijo de revision.
//
// FIX 2026-09-15 (2/2): ademas del join roto, esta funcion SIEMPRE devolvia
// una fila (filaVacia()) aunque no hubiera trafico real en el rango pedido --
// por eso la fila de finops aparecia en el panel incluso sin uso, a
// diferencia de las demas APIs (que solo aparecen cuando el descubrimiento
// automatico las detecta con trafico). Ahora, si no hay filas reales (o la
// consulta falla), se devuelve [] -- igual que appInsightsClient.js cuando
// una API no tuvo trafico -- para que la fila simplemente no aparezca. Los
// errores de la consulta se registran con console.error() en vez de
// mostrarse como una fila falsa en el panel.
//
// FIX 2026-09-15 (3/3): esta funcion recibia el "range" crudo del selector y
// lo volvia a resolver con su PROPIA lista blanca (rangeToAgo, mas abajo),
// separada de la que usa appInsightsClient.js para las otras 3 APIs. Las dos
// listas no tenian por que coincidir siempre -- y si un valor calzaba en una
// pero no en la otra, las dos fuentes de datos quedaban consultando ventanas
// de tiempo DISTINTAS para lo que en el panel se veia como "el mismo" rango,
// sin ningun error visible. Se confirmo asi: comparando el panel contra una
// consulta manual en Log Analytics con el mismo rango, los totales de finops
// no calzaban de forma consistente (no era trafico en vivo -- se repetia
// igual en pruebas separadas). Ahora getConsumoFinops() YA NO resuelve el
// rango por su cuenta: recibe "ago" ya resuelto por appInsights.rangeToAgo()
// (ver server.js, que lo calcula una sola vez y se lo pasa a las dos
// fuentes), y solo valida que tenga forma de duracion KQL segura antes de
// interpolarlo. rangeToAgo() se deja exportada por compatibilidad (algunas
// pruebas manuales pueden usarla), pero ya no la usa esta funcion.

const { LogsQueryClient } = require('@azure/monitor-query');
const { ManagedIdentityCredential, AzureCliCredential } = require('@azure/identity');

const WORKSPACE_ID = process.env.FINOPS_LOG_ANALYTICS_WORKSPACE_ID; // ej: cbc2aaca-89ea-4fb8-841b-7a0467c45228
const API_ID_LABEL = 'finops-framework-inference-api';
const QUERY_TIMESPAN = { duration: 'P30D' }; // ventana amplia; el filtro real lo hace el ago() dentro del KQL

/** Ver el bloque de comentarios de arriba: elige Managed Identity en Azure, az cli en local. */
function getCredential() {
  if (process.env.IDENTITY_ENDPOINT) {
    return new ManagedIdentityCredential();
  }
  return new AzureCliCredential();
}

let cachedClient = null;
function getClient() {
  if (!cachedClient) {
    cachedClient = new LogsQueryClient(getCredential());
  }
  return cachedClient;
}

function isConfigured() {
  return Boolean(WORKSPACE_ID);
}

/**
 * Convierte el valor del selector de rango (public/index.html: 30m, 1h, 12h,
 * 24h, 7d, 30d) en el "ago(...)" de KQL. Los 6 valores del selector ya son
 * literales validos de duracion en KQL, asi que solo se valida contra la
 * lista blanca (nunca se interpola texto libre en la consulta) y se pasan
 * tal cual -- antes solo se aceptaban 24h/7d/30d/90d, por lo que elegir 30m,
 * 1h o 12h caia siempre en el default de 30d sin avisar.
 */
function rangeToAgo(range) {
  const allowed = new Set(['30m', '1h', '12h', '24h', '7d', '30d']);
  return allowed.has(range) ? range : '24h';
}

/**
 * Valida que "ago" tenga forma de duracion KQL segura (numero + m/h/d) antes
 * de interpolarlo en la consulta -- nunca se acepta texto libre. A
 * diferencia de rangeToAgo() (lista fija de valores), esto acepta cualquier
 * duracion con esa forma, para no reintroducir el problema de FIX 3/3: que
 * appInsightsClient.js acepte un valor que esta lista fija no tuviera (por
 * ejemplo "90d") sin que las dos fuentes se desincronicen otra vez.
 */
function esDuracionKqlValida(ago) {
  return typeof ago === 'string' && /^[0-9]+(m|h|d)$/.test(ago);
}

/**
 * Devuelve el consumo agregado de finops-framework-inference-api en el rango
 * dado, UNA FILA POR MODELO (ModelName), en el mismo formato de fila que usa
 * /api/telemetry/usuarios en server.js -- asi el frontend no necesita saber
 * que esta fila viene de una fuente distinta (Log Analytics en vez de
 * Application Insights). Se separa por modelo porque el costo en USD
 * (lib/pricing.js) depende de que modelo se uso -- ApiManagementGatewayLlmLog
 * SI trae la columna ModelName de forma nativa, a diferencia de Application
 * Insights donde tuvimos que agregar la dimension a mano en la politica.
 *
 * Devuelve [] si no esta configurado o no hay datos en el rango pedido, o un
 * array con una fila por modelo visto.
 *
 * "ago" debe venir YA RESUELTO por el llamador (appInsights.rangeToAgo() en
 * server.js) -- ver FIX 3/3 arriba. Ya no se resuelve aqui por su cuenta.
 */
async function getConsumoFinops(ago) {
  if (!isConfigured()) return [];

  if (!esDuracionKqlValida(ago)) {
    console.error('[logAnalyticsClient] "ago" invalido, se omite la consulta de finops:', ago);
    return [];
  }

  // Cada llamada real genera VARIAS filas en esta tabla con el mismo
  // CorrelationId (una trae los tokens, las demas quedan en 0/0/0) --
  // confirmado inspeccionando el workspace directamente. Sumar por
  // CorrelationId antes del summarize final "rescata" el valor real sin
  // duplicar nada, porque las filas vacias suman 0. "any(ModelName)" toma el
  // modelo de la fila del grupo que si lo trae (las filas vacias del mismo
  // CorrelationId pueden traerlo vacio).
  //
  // IMPORTANTE (bug encontrado el 2026-09-08): ApiManagementGatewayLlmLog NO
  // es exclusiva de finops-framework-inference-api -- es un workspace de Log
  // Analytics COMPARTIDO, y otros labs del mismo APIM (al menos
  // hosted-agents-inference-api) tambien escriben ahi con SUS PROPIOS
  // modelos (ej. gemini-3.5-flash, gpt-5-mini-2025-08-07, gemini-3-flash-preview
  // -- ninguno de los 3 modelos reales de finops: gpt-5.4, gpt-5.4-mini,
  // DeepSeek-V3.2). Sin filtrar, esta consulta devolvia consumo de otros labs
  // mezclado como si fuera de finops. La tabla ApiManagementGatewayLlmLog no
  // trae ApiId directamente, asi que el filtro se hace con un join (leftsemi
  // -- solo filtra, no duplica) contra ApiManagementGatewayLogs, que SI trae
  // ApiId, usando el CorrelationId en comun entre las dos tablas.
  //
  // FIX 2026-09-15: el ApiId de ApiManagementGatewayLogs puede venir con la
  // revision pegada ("finops-framework-inference-api;rev=1") o con distinta
  // capitalizacion -- la igualdad exacta "==" nunca hacia match y el join
  // (leftsemi) vaciaba todo el resultado, aunque la tabla base SI tuviera
  // trafico real. Se cambio a "=~" (insensible a mayusculas) mas una
  // variante que acepta el sufijo de revision.
  const kql = `
ApiManagementGatewayLlmLog
| where TimeGenerated > ago(${ago})
| join kind=leftsemi (
    ApiManagementGatewayLogs
    | where TimeGenerated > ago(${ago})
    | where ApiId =~ "${API_ID_LABEL}" or ApiId startswith strcat("${API_ID_LABEL}", ";")
    | project CorrelationId
) on CorrelationId
| summarize PromptTokens = sum(PromptTokens), CompletionTokens = sum(CompletionTokens), TotalTokens = sum(TotalTokens), Model = take_anyif(ModelName, isnotempty(ModelName)) by CorrelationId
| where TotalTokens > 0
| summarize ConsumoTotal = sum(TotalTokens), Prompts = sum(PromptTokens), Respuestas = sum(CompletionTokens), Llamadas = count() by Model`.trim();

  const result = await getClient().queryWorkspace(WORKSPACE_ID, kql, QUERY_TIMESPAN);

  if (result.status !== 'Success' || !result.tables || !result.tables.length) {
    // Error real consultando Log Analytics -- se registra en el log del
    // servidor para poder diagnosticarlo, pero NO se muestra una fila falsa
    // en el panel (antes esto devolvia filaVacia(), que es lo que hacia que
    // finops apareciera siempre aunque no hubiera trafico).
    console.error('[logAnalyticsClient] Error consultando ApiManagementGatewayLlmLog:', result.status, result.partialError || '');
    return [];
  }

  const table = result.tables[0];
  // Sin trafico real en el rango pedido: no se devuelve ninguna fila, igual
  // que hace appInsightsClient.js para una API sin trafico.
  if (!table.rows.length) return [];

  const columnNames = table.columnDescriptors.map((c) => c.name);
  const get = (row, name) => {
    const idx = columnNames.indexOf(name);
    return idx >= 0 ? row[idx] : 0;
  };

  return table.rows.map((row) => {
    const modelo = get(row, 'Model') || null;
    const etiquetaModelo = modelo ? ` (${modelo})` : '';
    return {
      apiId: API_ID_LABEL,
      userId: null,
      product: null,
      clientIp: null,
      modelo,
      grupo: `Consumo total (sin desglose por usuario)${etiquetaModelo}`,
      anonimo: false,
      consumoTotal: get(row, 'ConsumoTotal') || 0,
      prompts: get(row, 'Prompts') || 0,
      respuestas: get(row, 'Respuestas') || 0,
      llamadas: get(row, 'Llamadas') || 0
    };
  });
}

module.exports = { isConfigured, getConsumoFinops, rangeToAgo };