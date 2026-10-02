// lib/pricing.js
//
// Calcula el costo en USD del consumo de tokens, a partir de una tabla de
// precios por modelo (USD por 1.000.000 de tokens, separado en prompt/completion
// porque Azure OpenAI cobra distinto por cada uno).
//
// *** IMPORTANTE -- LEE ESTO ANTES DE CONFIAR EN LOS NUMEROS QUE MUESTRA EL PANEL ***
// Los valores de DEFAULT_PRICING de abajo NO estan tomados de la pagina oficial
// de precios de Azure (https://azure.microsoft.com/pricing/details/azure-openai/)
// porque, al momento de escribir esto, esa pagina todavia no publicaba precio
// para gpt-5.4-mini NI para gpt-5-mini (columnas en blanco). Son una referencia
// de partida:
//   - gpt-5.4        : SI confirmado en un hilo oficial de Microsoft Q&A
//                       (input $2.50 / 1M, output $15.00 / 1M, contexto <=272K).
//   - gpt-5.4-mini    : NO confirmado oficialmente -- valor de agregadores
//                       de terceros (~$0.75-0.83 input / ~$4.50-4.95 output
//                       por 1M), puede estar desactualizado o no reflejar tu
//                       acuerdo/región real.
//   - gpt-5-mini      : NO confirmado oficialmente -- valor tomado de
//                       pricepertoken.com (agregador de terceros, no Microsoft)
//                       el 2026-09-08: $0.25/1M input, $2.00/1M output para
//                       despliegue "Global"; ese mismo sitio listaba $0.275/1M
//                       input y $2.20/1M output para "Data Zone" (swedencentral
//                       entre otras regiones) -- si tu backend-pool-inference-api
//                       usa Data Zone en vez de Global Standard, ajusta estos
//                       numeros a mano o via MODEL_PRICING_JSON.
//   - deepseek-v3.2   : NO confirmado oficialmente -- la pagina oficial de
//                       Azure AI Foundry (.../pricing/details/ai-foundry-models/deepseek/)
//                       tampoco publicaba precio para tu region al momento de
//                       escribir esto ("$-" en las 4 variantes: Global,
//                       DataZone, SP Global, SP DataZone). Valor de DOS
//                       agregadores de terceros que coincidieron (cloudprice.net
//                       y futureagi.com, el 2026-09-08): $0.58/1M input,
//                       $1.68/1M output -- version "estandar" (no la variante
//                       "Fireworks-hosted", que cobra distinto).
// Antes de usar esto para reportar costos reales a alguien, verifica tus
// precios exactos en Azure Portal > tu recurso Azure OpenAI/Foundry > Cost
// Management, o en la calculadora de precios de Azure para tu region y tipo
// de despliegue (Global Standard vs Data Zone cambian el precio).
//
// Como corregir/ajustar sin tocar este archivo: definir la variable de entorno
// MODEL_PRICING_JSON con un JSON de la misma forma que DEFAULT_PRICING; si
// existe, reemplaza por completo la tabla de abajo.
//   Ejemplo:
//   MODEL_PRICING_JSON={"gpt-5.4-mini":{"promptPerMillion":0.83,"completionPerMillion":4.95}}
//
// Cualquier modelo que NO este en la tabla (ni en el default ni en el .env)
// se deja con costo = null a proposito -- nunca se inventa un precio.

const DEFAULT_PRICING = {
  'gpt-5.4': { promptPerMillion: 2.50, completionPerMillion: 15.00 },
  'gpt-5.4-mini': { promptPerMillion: 0.83, completionPerMillion: 4.95 },
  'gpt-5-mini': { promptPerMillion: 0.25, completionPerMillion: 2.00 },
  'deepseek-v3.2': { promptPerMillion: 0.58, completionPerMillion: 1.68 }
};

function cargarTablaPrecios() {
  const raw = process.env.MODEL_PRICING_JSON;
  if (!raw) return DEFAULT_PRICING;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (err) {
    console.warn('[WARN] MODEL_PRICING_JSON no es JSON valido, usando la tabla de precios por defecto:', err.message);
  }
  return DEFAULT_PRICING;
}

const PRICING = cargarTablaPrecios();

/** Normaliza el nombre de modelo para buscarlo en la tabla (case-insensitive, sin espacios extra). */
function normalizar(modelo) {
  return String(modelo || '').trim().toLowerCase();
}

const PRICING_NORMALIZADO = Object.fromEntries(
  Object.entries(PRICING).map(([modelo, precio]) => [normalizar(modelo), precio])
);

// Las claves de la tabla, de mas larga a mas corta -- se usan para el
// "match por prefijo" de abajo, para que la clave mas especifica gane
// siempre (ver comentario de getPrecioModelo).
const CLAVES_POR_LARGO = Object.keys(PRICING_NORMALIZADO).sort((a, b) => b.length - a.length);

/**
 * Devuelve {promptPerMillion, completionPerMillion} o null si el modelo no tiene precio configurado.
 *
 * Azure NO siempre devuelve el nombre "pelado" del modelo (ej. "gpt-5.4-mini")
 * -- lo que trae ModelName en ApiManagementGatewayLlmLog suele venir con la
 * fecha de version pegada, ej. "gpt-5.4-mini-2026-03-17" (confirmado viendo
 * datos reales del panel). Por eso, si no hay match exacto, se prueba si el
 * nombre real EMPIEZA con alguna clave configurada seguida de un guion
 * (":gpt-5.4-mini-2026-03-17".startsWith("gpt-5.4-mini-")) -- se recorren las
 * claves de mas larga a mas corta para que "gpt-5.4-mini" gane sobre "gpt-5.4"
 * (las dos matchean como prefijo, pero la mas larga es la correcta). Un
 * modelo de otra familia que no este en la tabla en absoluto (ej.
 * "deepseek-v3.2") sigue sin matchear nada, como debe ser.
 */
function getPrecioModelo(modelo) {
  if (!modelo) return null;
  const normalizado = normalizar(modelo);

  if (PRICING_NORMALIZADO[normalizado]) return PRICING_NORMALIZADO[normalizado];

  for (const clave of CLAVES_POR_LARGO) {
    if (normalizado.startsWith(clave + '-')) return PRICING_NORMALIZADO[clave];
  }
  return null;
}

/**
 * Calcula el costo en USD para un numero de tokens de prompt/completion de un modelo dado.
 * Devuelve { total, configurado } -- "configurado" es false cuando no hay precio para ese
 * modelo (o no se sabe el modelo): en ese caso "total" es null, NUNCA 0 ni un numero inventado,
 * para que el panel pueda mostrar "N/A" en vez de un costo silenciosamente incorrecto.
 */
function calcularCosto(promptTokens, completionTokens, modelo) {
  const precio = getPrecioModelo(modelo);
  if (!precio) return { total: null, configurado: false };

  const costoPrompt = ((promptTokens || 0) / 1_000_000) * precio.promptPerMillion;
  const costoCompletion = ((completionTokens || 0) / 1_000_000) * precio.completionPerMillion;
  return { total: costoPrompt + costoCompletion, configurado: true };
}

module.exports = { calcularCosto, getPrecioModelo, PRICING };