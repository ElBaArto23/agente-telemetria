#!/usr/bin/env bash
# deploy.sh
#
# Registra el lab "webapp-chat" dentro del APIM compartido y deja lista la
# subscription key que va en el .env del backend Node.js (server.js).
#
# Requisitos: az login ya hecho, permisos sobre el resource group del APIM
# compartido, y jq instalado.
#
# Uso:
#   export APIM_SERVICE_NAME=<output apimServiceName del lab Shared APIM Gateway>
#   ./deploy.sh <resourceGroupName-del-apim-compartido> <openAiEndpoint> [modelDeploymentName] [labPrefix]
#
# Ejemplo:
#   export APIM_SERVICE_NAME=apim-shared-abc123
#   ./deploy.sh rg-shared-apim-gateway https://mi-foundry.openai.azure.com gpt-5.4-mini

set -euo pipefail

RESOURCE_GROUP="${1:?Debes indicar el resource group del APIM compartido (output resourceGroupName del lab Shared APIM Gateway)}"
OPENAI_ENDPOINT="${2:?Debes indicar el endpoint de tu recurso Azure OpenAI/Foundry, ej: https://mi-foundry.openai.azure.com}"
MODEL_DEPLOYMENT="${3:-gpt-5.4-mini}"
LAB_PREFIX="${4:-webapp-chat}"
APIM_SERVICE_NAME="${APIM_SERVICE_NAME:?Exporta APIM_SERVICE_NAME con el output apimServiceName del lab Shared APIM Gateway}"

echo "Desplegando lab '$LAB_PREFIX' dentro de APIM '$APIM_SERVICE_NAME' (resource group: $RESOURCE_GROUP)..."

az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file main.bicep \
  --parameters apimServiceName="$APIM_SERVICE_NAME" \
               labPrefix="$LAB_PREFIX" \
               openAiEndpoint="$OPENAI_ENDPOINT" \
               modelDeploymentName="$MODEL_DEPLOYMENT" \
  --query "properties.outputs" -o json > deploy-outputs.json

echo "Outputs guardados en deploy-outputs.json"

GATEWAY_URL=$(jq -r '.apiGatewayUrl.value' deploy-outputs.json)
SUBSCRIPTION_NAME=$(jq -r '.subscriptionName.value' deploy-outputs.json)
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

echo "Obteniendo la clave de la suscripcion '$SUBSCRIPTION_NAME'..."
SUBSCRIPTION_KEY=$(az rest --method post \
  --url "https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ApiManagement/service/${APIM_SERVICE_NAME}/subscriptions/${SUBSCRIPTION_NAME}/listSecrets?api-version=2023-05-01-preview" \
  --query primaryKey -o tsv)

echo ""
echo "Listo. Copia esto a tu .env (ver ../../.env.example):"
echo "APIM_GATEWAY_URL=${GATEWAY_URL}"
echo "APIM_API_KEY=${SUBSCRIPTION_KEY}"
echo ""
echo "Recuerda: la managed identity del APIM compartido debe tener el rol"
echo "\"Cognitive Services OpenAI User\" sobre tu recurso de OpenAI/Foundry"
echo "para que el backend '${LAB_PREFIX}-backend' pueda invocarlo."
