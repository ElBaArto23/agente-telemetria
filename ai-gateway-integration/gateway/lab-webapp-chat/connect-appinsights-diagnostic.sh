#!/usr/bin/env bash
#
# connect-appinsights-diagnostic.sh
#
# Conecta una API del APIM compartido a Application Insights (el diagnostico
# "applicationinsights" -> logger appinsights-logger, metrics: true) en un
# solo paso, en vez de repetir el proceso manual del portal que se hizo hoy
# para webapp-chat-api, backend-pool-inference-api y finops-framework-inference-api.
#
# Requisitos: az cli logueado (az login) con acceso al subscription/RG/APIM,
# y jq instalado (si no lo tienes: apt install jq / choco install jq / brew install jq).
#
# Uso:
#   ./connect-appinsights-diagnostic.sh <API_ID>
#   ./connect-appinsights-diagnostic.sh backend-pool-inference-api
#
# Variables opcionales (si tu APIM/RG/subscription no son los de siempre):
#   SUBSCRIPTION_ID, RESOURCE_GROUP, APIM_SERVICE_NAME, LOGGER_NAME
#
# Lo que NO hace este script (y hay que revisar a mano):
#   - No toca la politica XML de la API. El diagnostico por si solo no basta --
#     la API tambien necesita <llm-emit-token-metric> (no la legada
#     <azure-openai-emit-token-metric>, que resulto no funcionar aqui) en la
#     seccion <inbound> de su politica. Este script SI verifica esto al final
#     y te avisa si falta, pero no lo agrega solo (seria riesgoso editar la
#     politica de una API que puede ser de otro equipo, sin revisión).

set -euo pipefail

API_ID="${1:-}"
if [[ -z "$API_ID" ]]; then
  echo "Uso: $0 <API_ID>"
  echo "Ejemplo: $0 backend-pool-inference-api"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[ERROR] Falta 'jq'. Instalalo (apt install jq / choco install jq / brew install jq) y vuelve a correr el script."
  exit 1
fi

SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-efbaff8f-21cc-49db-8141-2caaf996decd}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-shared-apim-gateway-V2}"
APIM_SERVICE_NAME="${APIM_SERVICE_NAME:-apim-shared-pdcibwky2f5ms}"
LOGGER_NAME="${LOGGER_NAME:-appinsights-logger}"

BASE_URL="https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_SERVICE_NAME}"
LOGGER_ID="${BASE_URL}/loggers/${LOGGER_NAME}"
API_VERSION="2023-05-01-preview"

echo "== Conectando '${API_ID}' a Application Insights (${APIM_SERVICE_NAME}) =="

# 1) Confirmar que la API existe antes de crear nada.
if ! az rest --method get \
    --url "${BASE_URL}/apis/${API_ID}?api-version=${API_VERSION}" >/dev/null 2>&1; then
  echo "[ERROR] No se encontro la API '${API_ID}' en ${APIM_SERVICE_NAME} / ${RESOURCE_GROUP}."
  echo "Revisa el nombre exacto en el portal (APIM > APIs)."
  exit 1
fi
echo "[ok] La API existe."

# 2) Crear (o actualizar, es idempotente) el diagnostico applicationinsights.
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
    "metrics": true
  }
}
JSON

az rest --method put \
  --url "${BASE_URL}/apis/${API_ID}/diagnostics/applicationinsights?api-version=${API_VERSION}" \
  --body "@${TMP_BODY}" >/dev/null

echo "[ok] Diagnostico 'applicationinsights' creado/actualizado (logger: ${LOGGER_NAME}, metrics: true, sampling: 100%)."

# 3) Verificar que quedo como se espera.
DIAG_CHECK="$(az rest --method get \
  --url "${BASE_URL}/apis/${API_ID}/diagnostics/applicationinsights?api-version=${API_VERSION}")"
METRICS_OK="$(echo "$DIAG_CHECK" | jq -r '.properties.metrics')"
LOGGER_OK="$(echo "$DIAG_CHECK" | jq -r '.properties.loggerId' | grep -c "/${LOGGER_NAME}$" || true)"

if [[ "$METRICS_OK" == "true" && "$LOGGER_OK" -ge 1 ]]; then
  echo "[ok] Verificado: metrics=true y loggerId correcto."
else
  echo "[ADVERTENCIA] El diagnostico se creo pero algo no cuadra (metrics=${METRICS_OK}, loggerId apunta a ${LOGGER_NAME}? ${LOGGER_OK}). Revisa manualmente."
fi

# 4) Revisar la politica actual y avisar si le falta la politica de metricas correcta.
echo ""
echo "== Revisando la politica de '${API_ID}' =="
POLICY_JSON="$(az rest --method get \
  --url "${BASE_URL}/apis/${API_ID}/policies/policy?api-version=${API_VERSION}&format=rawxml" 2>/dev/null || echo '{}')"
POLICY_XML="$(echo "$POLICY_JSON" | jq -r '.properties.value // empty')"

if [[ -z "$POLICY_XML" ]]; then
  echo "[ADVERTENCIA] No se pudo leer la politica de la API para verificarla. Revisala a mano en el portal."
elif echo "$POLICY_XML" | grep -q "<llm-emit-token-metric"; then
  echo "[ok] La politica ya tiene <llm-emit-token-metric>. Deberias empezar a ver datos en un par de minutos tras la proxima peticion real."
elif echo "$POLICY_XML" | grep -q "<azure-openai-emit-token-metric"; then
  echo "[ADVERTENCIA] La politica usa <azure-openai-emit-token-metric> (la version legada)."
  echo "Ese es el mismo bug que tuvo finops-framework-inference-api: en este APIM no emite datos de forma confiable."
  echo "Recomendado: reemplazala por <llm-emit-token-metric> en la seccion <inbound>, con la(s) dimension(es) que tenga sentido para esta API (User ID, Product, etc)."
else
  echo "[ADVERTENCIA] La politica no tiene ninguna politica de metricas de tokens todavia."
  echo "Agrega <llm-emit-token-metric namespace=\"...\"><dimension name=\"...\" value=\"...\" /></llm-emit-token-metric> en la seccion <inbound> de su politica."
fi

echo ""
echo "== Listo =="
echo "Cuando llegue trafico real, el panel de telemetria de tu app (public/index.html) la va a mostrar sola -- no hace falta tocar server.js."