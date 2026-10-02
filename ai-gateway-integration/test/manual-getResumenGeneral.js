// Prueba manual (no automatizada con un framework) para getResumenGeneral()
// y obtenerDatosTelemetria() de server.js, sin tocar Azure real -- mockea
// lib/appInsightsClient.js y lib/logAnalyticsClient.js en el require.cache
// ANTES de requerir server.js, simulando datos con la forma real que
// devolverian Application Insights / Log Analytics con la dimension "Model"
// nueva. Corre: node test/manual-getResumenGeneral.js
//
// Objetivo: confirmar que, con datos de ejemplo, (a) no truena, (b) agrupa
// "UsuarioAnonimo" por Client IP como se espera, (c) calcula costoUsd para
// gpt-5.4-mini (que SI tiene precio en el default de pricing.js) y deja
// costoUsd:null para un modelo inventado sin precio (para que el frontend
// muestre "N/A" en vez de inventar un numero).

const path = require('path');
const Module = require('module');

const appInsightsPath = require.resolve('../lib/appInsightsClient');
const logAnalyticsPath = require.resolve('../lib/logAnalyticsClient');

function mockModule(resolvedPath, exportsObj) {
  const mod = new Module(resolvedPath, null);
  mod.exports = exportsObj;
  mod.loaded = true;
  require.cache[resolvedPath] = mod;
}

// --- Mock de Application Insights: simula 3 filas ya "parseadas" (como las
// devuelve appInsights.runQuery para la consulta de getResumenGeneral) ---
mockModule(appInsightsPath, {
  isConfigured: () => true,
  rangeToAgo: (r) => (['30m','1h','12h','24h','7d','30d'].includes(r) ? r : '24h'),
  runQuery: async (kql) => {
    // getConsumoUsuario tiene "webapp-chat-api" en el KQL; getResumenGeneral no.
    if (kql.includes('webapp-chat-api')) {
      return [{ ConsumoTotal: 1818, Prompts: 1182, Respuestas: 636, Llamadas: 12, Model: 'gpt-5.4-mini' }];
    }
    return [
      // webapp-chat-api: usuario real identificado, modelo conocido con precio
      { APIID: 'webapp-chat-api', UserID: 'usuario-demo-1', Product: null, ClientIP: '10.0.0.5', Model: 'gpt-5.4-mini', ConsumoTotal: 1818, Prompts: 1182, Respuestas: 636, Llamadas: 12 },
      // backend-pool-inference-api: DOS IPs distintas, ambas "UsuarioAnonimo" -- deben quedar en filas separadas "IP: x"
      { APIID: 'backend-pool-inference-api', UserID: 'UsuarioAnonimo', Product: null, ClientIP: '20.1.1.1', Model: 'gpt-5.4', ConsumoTotal: 80000, Prompts: 3000, Respuestas: 77000, Llamadas: 90 },
      { APIID: 'backend-pool-inference-api', UserID: 'UsuarioAnonimo', Product: null, ClientIP: '20.1.1.2', Model: 'gpt-5.4', ConsumoTotal: 27192, Prompts: 900, Respuestas: 26292, Llamadas: 40 },
      // API con un modelo inventado sin precio configurado -- costoUsd debe salir null
      { APIID: 'otra-api', UserID: 'UsuarioAnonimo', Product: null, ClientIP: '30.0.0.9', Model: 'modelo-que-no-existe', ConsumoTotal: 500, Prompts: 200, Respuestas: 300, Llamadas: 5 }
    ];
  },
  getConsumoUsuario: async (userId, range) => ({
    userId, rango: range, modelo: 'gpt-5.4-mini', consumoTotal: 1818, prompts: 1182, respuestas: 636, llamadas: 12
  })
});

// --- Mock de Log Analytics (finops): simula el array nuevo con Model ---
mockModule(logAnalyticsPath, {
  isConfigured: () => true,
  getConsumoFinops: async (range) => ([
    { apiId: 'finops-framework-inference-api', userId: null, product: null, clientIp: null, modelo: 'gpt-5.4', grupo: 'Consumo total (sin desglose por usuario) (gpt-5.4)', anonimo: false, consumoTotal: 44521, prompts: 5085, respuestas: 39436, llamadas: 108 }
  ])
});

process.env.APPINSIGHTS_APP_ID = 'fake';
process.env.APPINSIGHTS_API_KEY = 'fake';
process.env.APIM_GATEWAY_URL = 'https://fake.example.net/x';
process.env.APIM_API_KEY = 'fake';

const { getResumenGeneral, obtenerDatosTelemetria } = require('../server.js');

function assert(cond, msg) {
  if (!cond) throw new Error('FALLO: ' + msg);
  console.log('OK: ' + msg);
}

(async () => {
  const resumen = await getResumenGeneral('24h');
  assert(resumen.configured === true, 'resumen.configured es true');
  assert(resumen.usuarios.length === 5, 'hay 5 filas (2 AI + 2 IPs anonimas + 1 sin precio + 1 finops)  -> ' + resumen.usuarios.length);

  const porApi = Object.fromEntries(resumen.usuarios.map((u) => [u.apiId + '|' + u.grupo, u]));

  const real = porApi['webapp-chat-api|usuario-demo-1'];
  assert(real && real.anonimo === false, 'usuario real no queda marcado como anonimo');
  assert(Math.abs(real.costoUsd - ((1182/1e6)*0.83 + (636/1e6)*4.95)) < 1e-9, 'costo de usuario-demo-1 calculado correctamente con precio de gpt-5.4-mini: ' + real.costoUsd);

  const ip1 = porApi['backend-pool-inference-api|IP: 20.1.1.1'];
  const ip2 = porApi['backend-pool-inference-api|IP: 20.1.1.2'];
  assert(ip1 && ip2, 'las dos IPs anonimas de backend-pool-inference-api quedan en filas SEPARADAS, no fusionadas en "UsuarioAnonimo"');
  assert(ip1.anonimo === true && ip2.anonimo === true, 'las filas por IP se siguen marcando anonimo:true (el checkbox "ocultar anonimos" las sigue tapando)');
  assert(ip1.costoUsd !== null && ip1.precioConfigurado === true, 'costo calculado para gpt-5.4 (backend-pool-inference-api)');

  const sinPrecio = porApi['otra-api|IP: 30.0.0.9'];
  assert(sinPrecio.costoUsd === null && sinPrecio.precioConfigurado === false, 'modelo sin precio configurado da costoUsd:null (nunca un numero inventado)');

  const finops = resumen.usuarios.find((u) => u.apiId === 'finops-framework-inference-api');
  assert(finops && finops.modelo === 'gpt-5.4' && finops.costoUsd !== null, 'fila de finops (Log Analytics) trae modelo y costo calculado');

  const chatData = await obtenerDatosTelemetria('usuario-demo-1');
  assert(chatData.personal && chatData.personal.costoUsd !== null, 'obtenerDatosTelemetria (tool del chat) incluye costoUsd en "personal"');
  const apiEntry = chatData.resumenPorApi.find((a) => a.apiId === 'otra-api');
  assert(apiEntry && apiEntry.costoUsd === null, 'el total por API del chat sale null si ALGUNA fila de esa API no tiene precio (en vez de un total parcial engañoso)');

  console.log('\nTodas las pruebas pasaron.');
  process.exit(0);
})().catch((err) => {
  console.error('\n' + err.stack);
  process.exit(1);
});
