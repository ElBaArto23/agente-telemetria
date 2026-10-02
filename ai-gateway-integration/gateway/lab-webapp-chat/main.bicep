// main.bicep
//
// Registra la integracion "webapp-chat" (nuestro backend Node.js) como UN LAB MAS
// dentro del APIM compartido creado por el notebook `deploy-shared-apim.ipynb`.
//
// Este template NO crea un Microsoft.ApiManagement/service nuevo -- lo referencia
// como `existing` y solo agrega sus propios recursos (api, backend, product,
// subscription, policy), todos prefijados con `labPrefix` para no colisionar con
// otros labs desplegados sobre la misma instancia compartida.
//
// Scope de despliegue: el MISMO resource group donde vive el APIM compartido
// (el que imprimio el lab base como output `resourceGroupName`, ej. rg-shared-apim-gateway).
//
// Uso tipico:
//   az deployment group create \
//     --resource-group <resourceGroupName-del-apim-compartido> \
//     --template-file main.bicep \
//     --parameters apimServiceName=<apimServiceName-del-apim-compartido> \
//                  openAiEndpoint=https://mi-foundry.openai.azure.com \
//                  modelDeploymentName=gpt-5.4-mini
//
// (ver deploy.sh para un wrapper que ademas extrae la subscription key resultante)

@description('Nombre de la instancia de APIM compartida ya desplegada (output apimServiceName del lab Shared APIM Gateway).')
param apimServiceName string

@description('Prefijo unico para todos los recursos de este lab. Evita colisiones con otros labs sobre el mismo APIM compartido.')
param labPrefix string = 'webapp-chat'

@description('Endpoint base de tu recurso Azure OpenAI / AI Foundry, ej: https://mi-foundry.openai.azure.com')
param openAiEndpoint string

var openAiEndpointTrimmed = endsWith(openAiEndpoint, '/') ? substring(openAiEndpoint, 0, length(openAiEndpoint) - 1) : openAiEndpoint

@description('Nombre del deployment del modelo detras de este backend (ej: gpt-5.4-mini).')
param modelDeploymentName string = 'gpt-5.4-mini'

@description('Limite de tokens por minuto (TPM) por usuario que aplica la politica de este lab.')
param tokensPerMinute int = 1000

// --- Referencia al APIM compartido (NO lo crea, solo lo usa) ---
resource apim 'Microsoft.ApiManagement/service@2023-05-01-preview' existing = {
  name: apimServiceName
}

// --- Backend propio de este lab hacia Azure OpenAI / AI Foundry ---
// Requisito previo (fuera de este template): la managed identity del APIM
// compartido (output `apimPrincipalId` del lab base) debe tener el rol
// "Cognitive Services OpenAI User" sobre el recurso de OpenAI/Foundry.
resource backend 'Microsoft.ApiManagement/service/backends@2023-05-01-preview' = {
  parent: apim
  name: '${labPrefix}-backend'
  properties: {
    protocol: 'http'
    url: '${openAiEndpointTrimmed}/openai/deployments/${modelDeploymentName}'
    description: 'Backend Azure OpenAI/Foundry del lab ${labPrefix}'
  }
}

// --- API propia de este lab dentro del APIM compartido ---
resource api 'Microsoft.ApiManagement/service/apis@2023-05-01-preview' = {
  parent: apim
  name: '${labPrefix}-api'
  properties: {
    displayName: 'Webapp Chat API'
    path: labPrefix
    protocols: ['https']
    subscriptionRequired: true
    serviceUrl: '${openAiEndpointTrimmed}/openai/deployments/${modelDeploymentName}'
    subscriptionKeyParameterNames: {
      header: 'api-key'
      query: 'subscription-key'
    }
  }
}

resource operation 'Microsoft.ApiManagement/service/apis/operations@2023-05-01-preview' = {
  parent: api
  name: 'chat-completions'
  properties: {
    displayName: 'Chat Completions'
    method: 'POST'
    urlTemplate: '/chat/completions'
  }
}

// Politica inbound de este lab: identidad por x-user-id, rate-limit (TPM) y
// telemetria a Application Insights. Equivalente parametrizada de
// ../apim-policy.xml (usa esta version si vas a desplegar via Bicep; usa el
// XML suelto si prefieres pegarla a mano en el portal).
// Nota: dentro de un string multilinea de Bicep (''' ... ''') las comillas
// se escriben literales, sin backslash -- no es una cadena con escapes.
var policyXml = '''
<policies>
    <inbound>
        <base />
        <set-variable name="userId" value='@(context.Request.Headers.GetValueOrDefault("x-user-id", "UsuarioAnonimo"))' />
        <set-variable name="modelName" value="@{
            try {
                var body = context.Request.Body?.As<JObject>(preserveContent: true);
                var model = body != null ? (string)body["model"] : null;
                return string.IsNullOrEmpty(model) ? "desconocido" : model;
            } catch {
                return "desconocido";
            }
        }" />
        <set-query-parameter name="api-version" exists-action="skip">
            <value>2024-10-21</value>
        </set-query-parameter>
        <authentication-managed-identity resource="https://cognitiveservices.azure.com" output-token-variable-name="msi-access-token" ignore-error="false" />
        <set-header name="Authorization" exists-action="override">
            <value>@("Bearer " + (string)context.Variables["msi-access-token"])</value>
        </set-header>
        <set-header name="api-key" exists-action="delete" />
        <llm-token-limit counter-key='@(context.Variables.GetValueOrDefault&lt;string&gt;("userId"))'
                         tokens-per-minute="1000"
                         estimate-prompt-tokens="false"
                         remaining-tokens-variable-name="tokensRestantes" />
        <llm-emit-token-metric namespace="IA-Consumo-Usuarios">
            <dimension name="Client IP" value="@(context.Request.IpAddress)" />
            <dimension name="API ID" value="@(context.Api.Id)" />
            <dimension name="User ID" value='@(context.Variables.GetValueOrDefault&lt;string&gt;("userId"))' />
            <dimension name="Model" value='@(context.Variables.GetValueOrDefault&lt;string&gt;("modelName"))' />
        </llm-emit-token-metric>
    </inbound>
    <backend>
        <forward-request />
    </backend>
    <outbound>
        <base />
    </outbound>
    <on-error>
        <base />
    </on-error>
</policies>
'''

resource policy 'Microsoft.ApiManagement/service/apis/policies@2023-05-01-preview' = {
  parent: api
  name: 'policy'
  properties: {
    format: 'xml'
    value: policyXml
  }
  dependsOn: [
    operation
  ]
}

// --- Product exclusivo de este lab (aisla su cuota del resto de labs sobre el mismo APIM) ---
resource apiDiagnostic 'Microsoft.ApiManagement/service/apis/diagnostics@2023-05-01-preview' = {
  parent: api
  name: 'applicationinsights'
  properties: {
    loggerId: '${apim.id}/loggers/appinsights-logger'
    alwaysLog: 'allErrors'
    sampling: {
      samplingType: 'fixed'
      percentage: 100
    }
    verbosity: 'information'
    logClientIp: true
    metrics: true
  }
  dependsOn: [
    policy
  ]
}

resource product 'Microsoft.ApiManagement/service/products@2023-05-01-preview' = {
  parent: apim
  name: '${labPrefix}-product'
  properties: {
    displayName: 'Webapp Chat Product'
    description: 'Product exclusivo del lab ${labPrefix} sobre el APIM compartido'
    subscriptionRequired: true
    state: 'published'
  }
}

resource productApi 'Microsoft.ApiManagement/service/products/apis@2023-05-01-preview' = {
  parent: product
  name: api.name
}

// --- Suscripcion propia del backend Node.js contra el product de este lab ---
resource labSubscription 'Microsoft.ApiManagement/service/subscriptions@2023-05-01-preview' = {
  parent: apim
  name: '${labPrefix}-subscription'
  properties: {
    scope: '/products/${product.id}'
    displayName: 'Webapp Chat Backend Subscription'
    state: 'active'
  }
  dependsOn: [
    productApi
  ]
}

output apiGatewayUrl string = '${apim.properties.gatewayUrl}/${labPrefix}'
output subscriptionName string = labSubscription.name
output backendName string = backend.name
output productName string = product.name
