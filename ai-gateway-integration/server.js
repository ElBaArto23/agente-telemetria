// server.js
// Backend seguro que actua como proxy entre el frontend y el AI Gateway (Azure APIM),
// y expone la telemetria de consumo por usuario consultando Application Insights --
// tal como describe arquitectura_conexion_gateway.md (secciones 3 y 4).
// Nunca expone la api-key del Gateway al cliente; el navegador solo habla con este servidor.

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const appInsights = require('./lib/appInsightsClient');
const logAnalytics = require('./lib/logAnalyticsClient');
const pricing = require('./lib/pricing');

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public')); // sirve el cliente de prueba (public/index.html)

// --- Configuracion del AI Gateway (variables de entorno, nunca hardcodeadas) ---
const APIM_GATEWAY_URL = process.env.APIM_GATEWAY_URL;
const APIM_API_KEY = process.env.APIM_API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'gpt-5.4-mini';

if (!APIM_GATEWAY_URL || !APIM_API_KEY) {
  console.warn(
    '[WARN] Falta APIM_GATEWAY_URL o APIM_API_KEY en el archivo .env. ' +
    'Copia .env.example a .env y completa los valores antes de usar /api/chat.'
  );
}
if (!appInsights.isConfigured()) {
  console.warn(
    '[WARN] Falta APPINSIGHTS_APP_ID o APPINSIGHTS_API_KEY en el archivo .env. ' +
    '/api/telemetry/usuarios respondera vacio hasta que los completes.'
  );
}

/** Health check simple: confirma que el backend esta arriba y que valores estan configurados. */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    gatewayConfigured: Boolean(APIM_GATEWAY_URL && APIM_API_KEY),
    appInsightsConfigured: appInsights.isConfigured()
  });
});

/**
 * Consulta los datos reales de telemetria que se usan cuando el usuario
 * pregunta por consumo/tokens/llamadas en el chat. Combina dos cosas:
 *   1) El consumo PERSONAL del usuario que esta chateando, pero solo en
 *      webapp-chat-api (la unica API donde x-user-id identifica a alguien
 *      real -- las otras dos APIs no pasan por este mismo backend).
 *   2) El consumo TOTAL agregado de cada API conectada al gateway compartido
 *      (reutilizando getResumenGeneral, la misma fuente que usa el panel).
 *
 * Devuelve datos ESTRUCTURADOS (no texto) -- es la funcion que se ejecuta de
 * verdad cuando el MODELO pide la herramienta "consultar_consumo_gateway"
 * (ver TELEMETRY_TOOL y el manejo de tool_calls en /api/chat mas abajo).
 * El resultado se manda de vuelta al modelo como el resultado de la
 * herramienta, y tambien se devuelve tal cual en la respuesta JSON para que
 * el frontend lo pinte en su propio panel de numeros, sin depender de que
 * el modelo los repita bien en su respuesta de texto.
 */
async function obtenerDatosTelemetria(userId) {
  const [personalResult, resumenResult] = await Promise.allSettled([
    appInsights.isConfigured() ? appInsights.getConsumoUsuario(userId, '24h') : Promise.resolve(null),
    getResumenGeneral('24h')
  ]);

  let personal = personalResult.status === 'fulfilled' ? personalResult.value : null;
  if (personalResult.status === 'rejected') {
    console.error('No se pudo obtener el consumo personal para telemetria:', personalResult.reason);
  }
  if (personal) {
    const costoPersonal = pricing.calcularCosto(personal.prompts, personal.respuestas, personal.modelo);
    personal = { ...personal, costoUsd: costoPersonal.total, precioConfigurado: costoPersonal.configurado };
  }

  let resumenPorApi = [];
  let rangoResumen = '24h';
  if (resumenResult.status === 'fulfilled' && resumenResult.value?.configured) {
    rangoResumen = resumenResult.value.range;
    // Se suman todas las filas (usuarios/productos) de cada API para dar un
    // total por API -- ni el chat ni este panel necesitan el desglose fila
    // por fila, eso ya lo tiene el panel principal de telemetria. El costo
    // solo se suma si TODAS las filas de esa API tienen precio configurado --
    // si falta el precio de algun modelo, se marca costoUsd:null en vez de
    // dar un total parcial que parezca completo sin serlo.
    const totalesPorApi = new Map();
    for (const fila of resumenResult.value.usuarios) {
      const acc = totalesPorApi.get(fila.apiId) || { apiId: fila.apiId, consumoTotal: 0, llamadas: 0, costoUsd: 0, precioConfigurado: true };
      acc.consumoTotal += fila.consumoTotal || 0;
      acc.llamadas += fila.llamadas || 0;
      acc.precioConfigurado = acc.precioConfigurado && fila.precioConfigurado;
      acc.costoUsd += fila.costoUsd || 0;
      totalesPorApi.set(fila.apiId, acc);
    }
    resumenPorApi = Array.from(totalesPorApi.values()).map((fila) => ({
      ...fila,
      costoUsd: fila.precioConfigurado ? fila.costoUsd : null
    }));
  } else if (resumenResult.status === 'rejected') {
    console.error('No se pudo obtener el resumen general para telemetria:', resumenResult.reason);
  }

  return { personal, resumenPorApi, rangoResumen };
}

/**
 * Definicion de la "herramienta" (function calling / tool use, formato
 * estandar de la API de Chat Completions) que se le OFRECE al modelo en
 * cada llamada. Es el modelo el que decide, leyendo la pregunta del
 * usuario, si necesita invocarla -- ya no hay un regex nuestro adivinando
 * si la pregunta "suena" a telemetria (isTelemetryQuestion, que se quito).
 * El modelo puede detectar frases que un regex jamas cubriria ("como voy
 * de gasto", "estoy cerca del limite?", etc.) sin que haya que tocar este
 * archivo cada vez que a alguien se le ocurra una forma nueva de preguntar.
 */
const TELEMETRY_TOOL = {
  type: 'function',
  function: {
    name: 'consultar_consumo_gateway',
    description:
      'Consulta el consumo REAL de tokens y llamadas del AI Gateway: el consumo personal del usuario actual en webapp-chat-api, y el consumo total agregado de cada API conectada al gateway compartido (webapp-chat-api, backend-pool-inference-api, finops-framework-inference-api). Llama a esta herramienta SIEMPRE que el usuario pregunte por su consumo, tokens, llamadas, gasto o uso del gateway -- nunca inventes esos numeros de memoria.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }
};

/** Suma dos objetos "usage" de la API de Chat Completions (puede que el segundo no exista). */
function sumarUsage(a, b) {
  if (!b) return a;
  if (!a) return b;
  return {
    prompt_tokens: (a.prompt_tokens || 0) + (b.prompt_tokens || 0),
    completion_tokens: (a.completion_tokens || 0) + (b.completion_tokens || 0),
    total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0)
  };
}

/**
 * Endpoint para que el Frontend envie los mensajes de chat.
 * Reenvia la solicitud al AI Gateway (APIM) inyectando la api-key de forma segura
 * y propagando el x-user-id para que APIM aplique rate-limit y emita telemetria.
 *
 * Usa "function calling": se le ofrece al modelo la herramienta
 * TELEMETRY_TOOL en la primera llamada. Si el modelo decide invocarla (via
 * "tool_calls" en la respuesta), este backend ejecuta obtenerDatosTelemetria()
 * de verdad, le devuelve el resultado como un mensaje role:"tool", y hace
 * una SEGUNDA llamada al gateway para que el modelo redacte la respuesta
 * final ya con esos datos reales en la mano. Ojo: cuando esto pasa, la
 * pregunta cuesta 2 llamadas al backend de IA (2x tokens, 2x contra el
 * rate-limit de llm-token-limit) en vez de 1 -- es el costo de dejar que el
 * modelo decida en vez de adivinar con un regex.
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { prompt, userId, model } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Falta el parametro requerido: prompt (string)' });
    }
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'Falta el parametro requerido: userId (string)' });
    }

    const requestModel = model || DEFAULT_MODEL;
    const chatMessages = [{ role: 'user', content: prompt }];

    /** Llama al AI Gateway (APIM) con la lista de mensajes actual. */
    async function llamarGateway(messages, extraBody) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000); // evita colgarse si el Gateway no responde
      try {
        return await fetch(`${APIM_GATEWAY_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': APIM_API_KEY,  // autenticacion segura contra el Gateway (solo la conoce el backend)
            'x-user-id': userId       // identidad del usuario: usada por APIM para rate-limit y telemetria
          },
          body: JSON.stringify({ model: requestModel, messages, max_completion_tokens: 250, ...extraBody }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    // 1a llamada: se le ofrece la herramienta de telemetria: "auto" deja que
    // el propio modelo decida si la pregunta la necesita o no.
    let response = await llamarGateway(chatMessages, { tools: [TELEMETRY_TOOL], tool_choice: 'auto' });
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: 'Error en el AI Gateway', details: errorText });
    }
    let data = await response.json();
    let usageTotal = data.usage;
    let telemetryData = null;

    const primeraChoice = data.choices?.[0];
    const toolCalls = primeraChoice?.message?.tool_calls;

    if (toolCalls && toolCalls.length) {
      // El modelo pidio la herramienta -- ahora si se ejecuta la consulta real.
      telemetryData = await obtenerDatosTelemetria(userId);

      chatMessages.push(primeraChoice.message); // el mensaje del asistente que contiene los tool_calls
      for (const call of toolCalls) {
        chatMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(telemetryData)
        });
      }

      // 2a llamada: ahora con el resultado real de la herramienta ya en la
      // conversacion, para que el modelo redacte la respuesta final.
      response = await llamarGateway(chatMessages, {});
      if (!response.ok) {
        const errorText = await response.text();
        return res.status(response.status).json({ error: 'Error en el AI Gateway (2a llamada, tras la herramienta)', details: errorText });
      }
      data = await response.json();
      usageTotal = sumarUsage(usageTotal, data.usage);
    }

    res.json({
      message: data.choices?.[0]?.message?.content ?? '',
      usage: usageTotal, // suma de ambas llamadas si hubo tool call
      // Solo presente cuando el MODELO decidio invocar la herramienta de
      // telemetria. El frontend lo pinta en un panel de numeros aparte --
      // no depende de que el modelo los repita bien en el texto de "message".
      telemetria: telemetryData
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Timeout esperando respuesta del AI Gateway');
      return res.status(504).json({ error: 'Timeout esperando respuesta del AI Gateway' });
    }
    console.error('Error procesando solicitud de chat:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Agrupa el consumo de tokens por API + Modelo, para TODAS las APIs del APIM
 * compartido que esten emitiendo estas 3 metricas -- no hay lista fija de
 * APIs en el codigo. Cualquier API nueva que se conecte a Application
 * Insights (diagnostico "applicationinsights" con metrics:true + politica
 * con llm-emit-token-metric en su inbound -- ver
 * gateway/connect-appinsights-diagnostic.sh) aparece aqui sola, sin tocar
 * este archivo ni reiniciar el backend. Ademas agrega finops-framework-inference-api
 * desde su Log Analytics propio (ver lib/logAnalyticsClient.js).
 *
 * Se resume UNA FILA POR (API, Modelo) -- ya NO se desglosa por usuario,
 * producto o IP. (Version anterior de esta funcion si desglosaba por
 * usuario/IP -- se saco a pedido explicito: la tabla del panel se volvia
 * muy larga, con una fila por cada IP anonima distinta de backend-pool-
 * inference-api. Si mas adelante hace falta el detalle por usuario de nuevo
 * -- por ejemplo para facturarle a un cliente especifico de webapp-chat-api
 * -- esa logica esta en el historial de git de este archivo, se puede traer
 * de vuelta como una vista aparte sin perder este resumen simple.)
 *
 * "Model" es la dimension que agregamos en apim-policy.xml / main.bicep
 * para poder calcular el costo en USD de cada fila con lib/pricing.js.
 *
 * Usada tanto por GET /api/telemetry/usuarios (el panel) como por /api/chat
 * (para poder responder preguntas de consumo dentro de la conversacion).
 */
async function getResumenGeneral(range) {
  if (!appInsights.isConfigured()) {
    return { configured: false, range: range || '24h', usuarios: [] };
  }

  const ago = appInsights.rangeToAgo(range);
  const kql = `
customMetrics
| where timestamp > ago(${ago})
| where name in ("Total Tokens", "Prompt Tokens", "Completion Tokens")
| extend APIID = tostring(customDimensions["API ID"])
| extend Model = tostring(customDimensions["Model"])
| where isnotempty(APIID)
| summarize ConsumoTotal = sumif(valueSum, name == "Total Tokens"), Prompts = sumif(valueSum, name == "Prompt Tokens"), Respuestas = sumif(valueSum, name == "Completion Tokens"), Llamadas = sumif(valueCount, name == "Total Tokens") by APIID, Model
| order by APIID asc, ConsumoTotal desc`.trim();

  const rows = await appInsights.runQuery(kql);

  // Acumulador por (API, Modelo) -- si Application Insights y Log Analytics
  // (finops) alguna vez coinciden en la misma API+Modelo, se suman en una
  // sola fila en vez de duplicarla.
  const acumulado = new Map();
  function acumular(apiId, modelo, prompts, respuestas, consumoTotal, llamadas) {
    const key = `${apiId}|${modelo || ''}`;
    const acc = acumulado.get(key) || { apiId, modelo, consumoTotal: 0, prompts: 0, respuestas: 0, llamadas: 0 };
    acc.consumoTotal += consumoTotal || 0;
    acc.prompts += prompts || 0;
    acc.respuestas += respuestas || 0;
    acc.llamadas += llamadas || 0;
    acumulado.set(key, acc);
  }

  // La dimension "Model" en la politica de backend-pool-inference-api se
  // agrego el 2026-09-08 -- el trafico emitido ANTES de ese deploy no trae
  // Model (queda null) y, sin este parche, aparece como una fila aparte sin
  // modelo (y por lo tanto sin costo) en vez de fusionarse con el resto.
  // Confirmado en el dashboard "Backend Pool LB" (pestana Metricas) que TODO
  // este pool sirve un unico modelo fijo, "gpt-5-mini" -- balancea por
  // region/backend, no por modelo -- asi que es seguro asumir que el trafico
  // viejo sin Model tambien fue gpt-5-mini.
  //
  // webapp-chat-api e inference-api-tazvvonn4lhea entraron por el mismo
  // motivo: trafico de antes de que sus politicas emitieran Model, quedaba
  // sin modelo/costo. A diferencia de backend-pool-inference-api (que se
  // confirmo viendo su dashboard), estas dos se confirmaron a mano (el 2026-09-08):
  // ambas usan gpt-5.4-mini.
  //
  // OJO en las 3: si el dia de manana cualquiera de estas APIs pasa a usar
  // mas de un modelo (o cambia de modelo), este parche hay que actualizarlo
  // o quitarlo -- la fila vieja sin Model se volveria ambigua otra vez.
  const MODELO_UNICO_POR_API = {
    'backend-pool-inference-api': 'gpt-5-mini',
    'webapp-chat-api': 'gpt-5.4-mini',
    'inference-api-tazvvonn4lhea': 'gpt-5.4-mini'
  };

  for (const row of rows) {
    const apiId = row.APIID || 'desconocida';
    let modelo = row.Model && row.Model !== 'desconocido' ? row.Model : null;
    if (!modelo && MODELO_UNICO_POR_API[apiId]) {
      modelo = MODELO_UNICO_POR_API[apiId];
    }
    acumular(apiId, modelo, row.Prompts, row.Respuestas, row.ConsumoTotal, row.Llamadas);
  }

  // finops-framework-inference-api no emite via Application Insights (ver
  // lib/logAnalyticsClient.js para el detalle) -- se agrega aparte, desde
  // el Log Analytics workspace propio de ese laboratorio, si esta
  // configurado. Si falla, no tumba el resto: solo se registra el error y
  // esa fila queda ausente. getConsumoFinops devuelve un ARRAY (una fila
  // por modelo) que se acumula igual que las filas de Application Insights.
  //
  // FIX 2026-09-15: antes se le pasaba el "range" crudo del selector, y
  // logAnalyticsClient.js lo volvia a resolver con su PROPIA lista blanca de
  // valores permitidos -- distinta de la que usa appInsights.rangeToAgo()
  // arriba. Si un valor no calzaba igual en las dos listas, esta fuente
  // quedaba consultando una ventana de tiempo DISTINTA a la de las otras 3
  // APIs, aunque el panel mostrara "el mismo" rango seleccionado -- los
  // totales de finops no calzaban contra una consulta manual con el mismo
  // rango, de forma repetible (no era trafico en vivo). Ahora se le pasa
  // "ago" -- el mismo valor YA RESUELTO que usan las otras 3 APIs -- para
  // que las dos fuentes siempre consulten exactamente la misma ventana.
  if (logAnalytics.isConfigured()) {
    try {
      const finopsFilas = await logAnalytics.getConsumoFinops(ago);
      for (const fila of finopsFilas) {
        acumular(fila.apiId, fila.modelo, fila.prompts, fila.respuestas, fila.consumoTotal, fila.llamadas);
      }
    } catch (logAnalyticsErr) {
      console.error('Error consultando Log Analytics de finops-framework-inference-api:', logAnalyticsErr);
    }
  }

  const usuarios = Array.from(acumulado.values())
    .map((fila) => {
      const costo = pricing.calcularCosto(fila.prompts, fila.respuestas, fila.modelo);
      return { ...fila, costoUsd: costo.total, precioConfigurado: costo.configurado };
    })
    .sort((a, b) => (a.apiId < b.apiId ? -1 : a.apiId > b.apiId ? 1 : b.consumoTotal - a.consumoTotal));

  return { configured: true, range: ago, usuarios };
}

/** GET /api/telemetry/usuarios?range=24h -- ver getResumenGeneral() arriba. */
app.get('/api/telemetry/usuarios', async (req, res) => {
  try {
    const resumen = await getResumenGeneral(req.query.range);
    res.json(resumen);
  } catch (error) {
    console.error('Error consultando Application Insights:', error);
    res.status(502).json({ error: 'No se pudo consultar Application Insights', details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
// El guard de require.main permite requerir este archivo desde un script de
// pruebas (mockeando lib/appInsightsClient y lib/logAnalyticsClient) sin
// levantar un servidor real ni pisar el puerto -- "node server.js" sigue
// arrancando normal porque ahi require.main SI es este modulo.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor de aplicacion web escuchando en http://localhost:${PORT}`);
  });
} else {
  module.exports = { getResumenGeneral, obtenerDatosTelemetria };
}