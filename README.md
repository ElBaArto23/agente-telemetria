[Informe Telemetría y costos del AI Gateway en APIM compartido.md](https://github.com/user-attachments/files/32977604/Informe.Telemetria.y.costos.del.AI.Gateway.en.APIM.compartido.md)
# Informe: Telemetría y costos del AI Gateway en APIM compartido

Oct 2, 2026 · @Yackson

## Resumen ejecutivo

La función de telemetría del lab `ai-gateway-integration` muestra cuántos tokens, cuántas llamadas y cuántos dólares consume cada API y cada modelo de un Azure API Management (APIM) compartido entre varios labs.

El sistema es un backend Node.js (`server.js`) desplegado en Azure Container Apps. Hace dos cosas: reenvía el chat al Gateway sin exponer la `api-key` al navegador, y consulta la telemetría real para mostrarla en un panel web y en el chat.

- **Qué mide:** tokens de prompt, de completion y totales, número de llamadas y costo estimado en USD, con una fila por combinación de API y modelo.
- **De dónde sale el dato:** la política de APIM emite una métrica por cada llamada; el backend la consulta en Application Insights. Una API (finops) se lee de su propio Log Analytics.
- **Cómo se ve:** tabla con tres gráficas (tokens, llamadas y costo por API) y una herramienta dentro del chat que responde preguntas de consumo.
- **Qué la hace extensible:** no hay lista fija de APIs; cualquier API que emita la misma métrica aparece sola.
- **Pendiente de negocio:** confirmar en Azure Cost Management los precios de gpt-5.4-mini, gpt-5-mini y deepseek-v3.2, hoy tomados de fuentes no oficiales.

## Arquitectura y flujo de datos

&#91;embedded content: arquitectura · 4 componentes y 2 fuentes de datos\]

El chat y el panel hablan solo con el backend. El backend reenvía el chat al APIM, que mide cada llamada y la manda al modelo. Los datos de consumo se leen de Application Insights y, para finops, de su Log Analytics.

## Cómo funciona paso a paso

Cada llamada recorre cuatro etapas: APIM la mide, Application Insights la guarda, el backend la consulta y le calcula el costo.

1. **Medición en APIM.** La política (`apim-policy.xml`, versión IaC en `main.bicep`) lee el usuario del header `x-user-id` y el modelo del campo `model` del body. Aplica un límite de tokens por minuto por usuario (`llm-token-limit`) y emite la métrica `llm-emit-token-metric` con las dimensiones `API ID`, `Model`, `User ID` y `Client IP`.
2. **Almacenamiento.** La métrica llega a la tabla `customMetrics` de Application Insights como `Total Tokens`, `Prompt Tokens` y `Completion Tokens`.
3. **Consulta.** `lib/appInsightsClient.js` llama a la API REST de Application Insights. La consulta KQL suma los tokens y cuenta las llamadas agrupando por `API ID` y `Model`, dentro del rango elegido: 30 min, 1 h, 12 h, 24 h, 7 d o 30 d. El rango se valida contra una lista fija antes de entrar a la consulta.
4. **Costo.** `getResumenGeneral()` en `server.js` junta las fuentes en una fila por API y modelo, y `lib/pricing.js` calcula el costo en USD.

### Dos fuentes de datos

| Fuente | Qué cubre | Archivo |
| --- | --- | --- |
| Application Insights (`customMetrics`) | webapp-chat-api, backend-pool-inference-api, inference-api-tazvvonn4lhea y cualquier API que emita la métrica | `lib/appInsightsClient.js` |
| Log Analytics (`ApiManagementGatewayLlmLog`) | finops-framework-inference-api, cuya política nunca emitió de forma confiable a Application Insights | `lib/logAnalyticsClient.js` |

Esa tabla de Log Analytics la comparten otros labs del mismo APIM. Por eso la consulta hace un join con `ApiManagementGatewayLogs` por `CorrelationId` y se queda solo con las filas de finops. La comparación de `ApiId` no distingue mayúsculas y acepta el sufijo de revisión. Ambas fuentes usan la misma ventana de tiempo, para que los totales sean comparables.

### Cálculo del costo

- La tabla de precios está en USD por millón de tokens, separada en prompt y completion, porque Azure cobra distinto cada uno.
- Azure suele devolver el modelo con la fecha pegada (`gpt-5.4-mini-2026-03-17`). La búsqueda prueba primero el nombre exacto y luego por prefijo, y gana la clave más larga.
- Si un modelo no tiene precio, el costo queda en `null` y el panel muestra "—". Nunca se muestra un 0 ni un número inventado.
- Los precios se pueden cambiar sin tocar código con la variable de entorno `MODEL_PRICING_JSON`.
- El tráfico anterior a la dimensión `Model` se asigna al modelo único conocido de cada API (`MODELO_UNICO_POR_API`), para que no aparezca como una fila duplicada sin costo.

## Cómo se consume

Los mismos datos se ven de dos formas: un panel web y una pregunta en el chat.

### Panel web

- El endpoint `GET /api/telemetry/usuarios?range=24h` devuelve una fila por API y modelo.
- `public/index.html` la pinta como tabla con modelo, tokens, llamadas y costo, más tres gráficas: tokens, llamadas y costo total por API.
- El costo total de una API solo se suma si todos sus modelos tienen precio. Si falta alguno, se muestra "—" en vez de un total parcial que parezca completo.
- Un selector de rango cambia la ventana de tiempo, de 30 minutos a 30 días.

### Chat con herramienta (function calling)

1. El frontend envía el mensaje a `POST /api/chat`. El backend lo reenvía al Gateway con la `api-key` y el `x-user-id`, y le ofrece al modelo la herramienta `consultar_consumo_gateway`.
2. Si la pregunta es de consumo ("¿cuántos tokens llevo hoy?"), el modelo decide invocar la herramienta. No hay palabras clave en el backend que adivinen la intención.
3. El backend ejecuta `obtenerDatosTelemetria()`, que devuelve el consumo personal del usuario en `webapp-chat-api` y el total por API. Se lo entrega al modelo como resultado de la herramienta.
4. Una segunda llamada al Gateway permite al modelo redactar la respuesta con los datos reales.
5. La respuesta HTTP incluye también el resultado tal cual, y el panel "Telemetría de esta pregunta" lo muestra. Así el dato exacto aparece aunque el modelo se equivoque al escribir un número.

Una pregunta de consumo cuesta dos llamadas al modelo en vez de una: el doble de tokens y el doble contra el límite por minuto.

## Cómo conectar una API nueva

Una API nueva aparece sola en el panel si se configura igual que `webapp-chat-api`. No hay que tocar `server.js` ni redesplegar el backend.

1. **Diagnóstico de Application Insights.** Conectar el diagnóstico `applicationinsights` de la API al mismo recurso que usa este proyecto, con `metrics: true`. Sirven de ejemplo `connect-appinsights-diagnostic.sh` y el bloque `apiDiagnostic` de `main.bicep`.
2. **Dimensiones en la política.** Agregar `llm-emit-token-metric` en el inbound, con al menos `API ID` y `Model`. El modelo se lee del body o se deja fijo si la API siempre sirve el mismo.
3. **Esperar tráfico.** La fila aparece uno o dos minutos después de la primera llamada, lo que tarda Application Insights en ingerir.
4. **Precio (opcional).** Si el modelo no está en `lib/pricing.js`, la fila aparece igual con el costo en "—" hasta que se agregue.

### Cuándo no aplica este camino

finops-framework-inference-api tomó otro camino porque su política no logró emitir a Application Insights tras tres intentos. Ese rescate no es una plantilla:

- Depende de que exista un log nativo alternativo, y `ApiManagementGatewayLlmLog` es propio de ese laboratorio.
- Requiere escribir un cliente y una consulta a mano, y resolver la autenticación (Managed Identity en Azure, `az login` en local).
- El workspace es compartido con otros labs, así que sin un filtro explícito se mezclan datos ajenos.
- Nadie lo mantiene solo: si la tabla cambia de esquema, hay que arreglar la consulta a mano.

Para cualquier API nueva, el primer intento debe ser siempre el camino de Application Insights.

## Limitaciones, riesgos y seguridad

El mayor riesgo es presentar como reales costos calculados con precios que aún no se confirmaron.

| Tema | Detalle | Qué hacer |
| --- | --- | --- |
| Precios sin confirmar | Solo gpt-5.4 ($2.50 / $15.00 por millón de tokens de entrada y salida) tiene fuente oficial. gpt-5.4-mini, gpt-5-mini y deepseek-v3.2 vienen de agregadores de terceros. | Verificar en Azure Cost Management; el tipo de despliegue (Global o Data Zone) cambia el precio. |
| Parche de modelo único | `MODELO_UNICO_POR_API` asume que tres APIs usan un solo modelo cada una. | Revisarlo si alguna pasa a usar más de uno. |
| Modelo fijo en el pool | En backend-pool-inference-api el modelo está escrito a mano en la política (`gpt-5-mini`), porque el body no trae el campo `model`. | Actualizarlo si el pool sirve otro modelo. |
| API Key de Application Insights | Azure la marca en desuso, con retiro anunciado para marzo de 2026 (fecha ya pasada). | Migrar a Microsoft Entra ID con el rol Monitoring Reader; solo cambia `lib/appInsightsClient.js`. |
| Sin desglose por usuario | La tabla agrupa solo por API y modelo; el detalle por usuario se retiró a pedido. | Recuperarlo desde el historial de `getResumenGeneral()` si hace falta facturar por cliente. |
| Doble costo en el chat | Cada pregunta de consumo hace dos llamadas al modelo. | Tenerlo en cuenta frente al límite de tokens por minuto. |

### Seguridad

- La `api-key` del Gateway vive solo en el backend y nunca llega al navegador.
- El archivo `.env` contiene valores reales (la key del Gateway, la key de Application Insights y el ID del workspace). No debe subirse a un repositorio ni compartirse; si ya circuló, conviene rotar esas keys.
- En Azure, finops se consulta con Managed Identity, sin App Registration; en local usa `az login`.

## Recomendaciones y próximos pasos

- [ ] Confirmar en Azure Cost Management los precios de gpt-5.4-mini, gpt-5-mini y deepseek-v3.2, y cargarlos con `MODEL_PRICING_JSON`.
- [ ] Rotar las keys del archivo `.env` si el zip del proyecto circuló fuera del equipo.
- [ ] Planear la migración de Application Insights a Microsoft Entra ID, ya que la fecha de retiro anunciada para la API Key (marzo de 2026) pasó; confirmar que sigue operativa.
- [ ] Al conectar una API nueva, definir desde el principio la política con las dimensiones `API ID` y `Model`.
- [ ] Revisar `MODELO_UNICO_POR_API` y el modelo fijo del pool cada vez que cambie un despliegue de modelo.
