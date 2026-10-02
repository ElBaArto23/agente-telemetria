#!/usr/bin/env bash
#
# habilitar-log-crudo-finops.sh
#
# No toca la politica de finops-framework-inference-api (esa ya la dejamos
# quieta -- es de otro equipo y el problema no esta ahi). Esto actualiza
# NUESTRO PROPIO diagnostico "applicationinsights" en esa API para que,
# ademas de intentar la metrica (que sabemos que no funciona en este backend
# tipo "Agents"), tambien loguee el cuerpo crudo de cada respuesta LLM.
#
# Con eso, el JSON real que devuelve el backend de Agents queda visible en
# Application Insights -- aunque no tenga la forma que la politica de
# metricas espera, ahi SI vamos a poder ver, con nuestra propia consulta,
# cuantos tokens reporta cada llamada.
#
# Requiere: az cli logueado con acceso a este APIM.

set -euo pipefail

SUBSCRIPTION_ID="efbaff8f-21cc-49db-8141-2caaf996decd"
RESOURCE_GROUP="rg-shared-apim-gateway-V2"
APIM_SERVICE_NAME="apim-shared-pdcibwky2f5ms"
API_ID="finops-framework-inference-api"
LOGGER_NAME="appinsights-logger"
API_VERSION="2023-05-01-preview"

BASE_URL="https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_SERVICE_NAME}"
LOGGER_ID="${BASE_URL}/loggers/${LOGGER_NAME}"

TMP_BODY="$(mktemp)"
trap 'rm -f "$TMP_BODY"' EXIT
cat > "$TMP_BODY" <<JSON
{
  "properties": {
    "loggerId": "${LOGGER_ID}",
    "alwaysLog": "allErrors",
    "sampling": { "samplingType": "fixed", "percentage": 100 },
    "verbosity": "information",
    "logClientIp": true,
    "metrics": true,
    "largeLanguageModel": {
      "logs": "enabled",
      "requests": { "maxSizeInBytes": 262144, "messages": "all" },
      "responses": { "maxSizeInBytes": 262144, "messages": "all" }
    }
  }
}
JSON

echo "== Actualizando diagnostico 'applicationinsights' de ${API_ID} para loguear cuerpos LLM crudos =="
az rest --method put \
  --url "${BASE_URL}/apis/${API_ID}/diagnostics/applicationinsights?api-version=${API_VERSION}" \
  --body "@${TMP_BODY}" >/dev/null

echo "[ok] Actualizado. Ahora:"
echo "1) Manda una peticion de prueba real a finops-framework-inference-api."
echo "2) Espera 1-2 minutos."
echo "3) Corre esta consulta en Application Insights (Logs) para ver donde aparecio el log crudo:"
echo ""
echo '   search "finops-framework-inference-api"'
echo '   | where timestamp > ago(15m)'
echo '   | order by timestamp desc'
echo '   | take 50'
echo ""
echo "El operador 'search' busca en TODAS las tablas -- no se en cual va a caer exactamente"
echo "este log crudo (traces, o una tabla especifica de GenAI), asi que esta consulta amplia"
echo "es la forma de encontrarlo sin adivinar el nombre de tabla."