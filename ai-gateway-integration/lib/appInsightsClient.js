// lib/appInsightsClient.js
//
// Cliente minimo para consultar Application Insights via su API REST de Logs
// (App ID + API Key), sin depender del SDK de Azure Monitor.
//
// Como obtener las credenciales:
//   Application Insights (tu recurso) > API Access > Application ID  -> APPINSIGHTS_APP_ID
//   Application Insights (tu recurso) > API Access > Create API Key
//     (permiso "Read telemetry" es suficiente)                       -> APPINSIGHTS_API_KEY
//
// Nota sobre el aviso de "en desuso": el portal de Azure advierte que esta
// API Key se retira en marzo de 2026 y recomienda autenticar con Azure AD en
// su lugar. Ese metodo (client credentials con una App Registration en
// Microsoft Entra ID + rol "Monitoring Reader") es mas robusto, pero requiere
// permisos que no siempre estan disponibles (crear la app en Entra, o que un
// admin de IT lo haga). Mientras tanto la API Key sigue funcionando -- si en
// algun momento Microsoft la corta de verdad, o consigues acceso a Entra ID
// / a alguien que cree la App Registration por ti, este archivo es el unico
// que hay que tocar para migrar (cambiar el header 'x-api-key' por un
// 'Authorization: Bearer <token AAD>', usando client_credentials contra
// https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token con
// scope=https://api.applicationinsights.io/.default) -- las rutas de
// server.js no cambian, porque runQuery() sigue devolviendo lo mismo.

const APPINSIGHTS_APP_ID = process.env.APPINSIGHTS_APP_ID;
const APPINSIGHTS_API_KEY = process.env.APPINSIGHTS_API_KEY;
const QUERY_TIMEOUT_MS = 20_000;

function isConfigured() {
  return Boolean(APPINSIGHTS_APP_ID && APPINSIGHTS_API_KEY);
}

/**
 * Corre una consulta KQL contra Application Insights.
 * Devuelve un array de objetos (una fila = un objeto, llaves = nombres de columna),
 * que es mas comodo de consumir en las rutas que el formato crudo {columns, rows}.
 */
async function runQuery(kql) {
  if (!isConfigured()) {
    const err = new Error('Application Insights no esta configurado (faltan APPINSIGHTS_APP_ID / APPINSIGHTS_API_KEY)');
    err.code = 'APPINSIGHTS_NOT_CONFIGURED';
    throw err;
  }

  const url = `https://api.applicationinsights.io/v1/apps/${APPINSIGHTS_APP_ID}/query?query=${encodeURIComponent(kql)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      headers: { 'x-api-key': APPINSIGHTS_API_KEY },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Application Insights respondio ${response.status}: ${text}`);
    err.code = 'APPINSIGHTS_QUERY_FAILED';
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const table = data.tables && data.tables[0];
  if (!table) return [];

  const columnNames = table.columns.map((c) => c.name);
  return table.rows.map((row) => {
    const obj = {};
    columnNames.forEach((name, i) => { obj[name] = row[i]; });
    return obj;
  });
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

async function getConsumoUsuario(userId, range) {
  const ago = rangeToAgo(range);
  const safeUserId = String(userId).replace(/["\\]/g, " ");
  const kql = `
customMetrics
| where timestamp > ago(${ago})
| where name in ("Total Tokens", "Prompt Tokens", "Completion Tokens")
| extend UserID = tostring(customDimensions["User ID"])
| extend APIID = tostring(customDimensions["API ID"])
| extend Model = tostring(customDimensions["Model"])
| where UserID == "${safeUserId}" and APIID == "webapp-chat-api"
| summarize ConsumoTotal = sumif(valueSum, name == "Total Tokens"), Prompts = sumif(valueSum, name == "Prompt Tokens"), Respuestas = sumif(valueSum, name == "Completion Tokens"), Llamadas = sumif(valueCount, name == "Total Tokens") by Model`.trim();
  const rows = await runQuery(kql);
  // Normalmente una sola fila (un usuario suele usar el mismo modelo en el
  // rango consultado) -- si hubiera mas de un modelo, se suman los tokens
  // pero el campo "modelo" queda del primero, asi el costo no se pierde,
  // aunque en ese caso el numero de costo ya no seria 100% preciso por modelo.
  if (!rows.length) {
    return { userId, rango: ago, consumoTotal: 0, prompts: 0, respuestas: 0, llamadas: 0, modelo: null };
  }
  const totales = rows.reduce((acc, row) => ({
    consumoTotal: acc.consumoTotal + (row.ConsumoTotal || 0),
    prompts: acc.prompts + (row.Prompts || 0),
    respuestas: acc.respuestas + (row.Respuestas || 0),
    llamadas: acc.llamadas + (row.Llamadas || 0)
  }), { consumoTotal: 0, prompts: 0, respuestas: 0, llamadas: 0 });
  const modelo = rows[0].Model && rows[0].Model !== 'desconocido' ? rows[0].Model : null;
  return { userId, rango: ago, modelo, ...totales };
}

module.exports = { isConfigured, runQuery, rangeToAgo, getConsumoUsuario };