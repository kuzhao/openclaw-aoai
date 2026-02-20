import { DefaultAzureCredential } from "@azure/identity";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const PROVIDER_ID = "azure-openai";
const PROVIDER_LABEL = "Azure OpenAI";
const ENV_VARS = [
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_DEPLOYMENT_NAME",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
];

type AzureModelEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly ["text"] | readonly ["text", "image"];
};

async function fetchAzureOpenAiModels(params: {
  endpoint: string;
  apiKey?: string;
  bearerToken?: string;
}): Promise<AzureModelEntry[]> {
  const endpointUrl = params.endpoint.replace(/\/$/, "");
  const url = `${endpointUrl}/openai/v1/models`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (params.apiKey) {
    headers["api-key"] = params.apiKey;
  }

  if (params.bearerToken) {
    headers.Authorization = `Bearer ${params.bearerToken}`;
  }

  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch Azure OpenAI models (${response.status} ${response.statusText})${body ? `: ${body}` : ""}`,
    );
  }

  const payload = (await response.json()) as {
    data?: Array<{ id?: string; model?: string; object?: string }>;
  };

  const ids = new Set<string>();
  for (const item of payload.data ?? []) {
    const rawId = String(item.id ?? item.model ?? "").trim();
    if (!rawId) {
      continue;
    }
    ids.add(rawId);
  }

  const models = Array.from(ids)
    .sort((a, b) => a.localeCompare(b))
    .map((id) => {
      const lower = id.toLowerCase();
      const reasoning = /^o\d|reason/i.test(lower);
      const input = lower.includes("vision") || lower.includes("gpt-4o")
        ? (["text", "image"] as const)
        : (["text"] as const);
      return {
        id,
        name: id,
        reasoning,
        input,
      };
    });

  if (!models.length) {
    throw new Error("No models were returned by Azure OpenAI for this resource");
  }

  return models;
}

async function getAzureAccessToken(): Promise<{ token: string; expires: number }> {
  const credential = new DefaultAzureCredential();

  // Azure OpenAI uses the cognitive services scope
  const scope = "https://cognitiveservices.azure.com/.default";

  const tokenResponse = await credential.getToken(scope);
  if (!tokenResponse) {
    throw new Error("No Azure access token returned (DefaultAzureCredential unavailable)");
  }

  return {
    token: tokenResponse.token,
    expires: tokenResponse.expiresOnTimestamp,
  };
}

const azureOpenAiPlugin = {
  id: "azure-openai",
  name: "Azure OpenAI",
  description: "Azure OpenAI provider with API key and keyless authentication",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/models",
      aliases: ["azure"],
      envVars: ENV_VARS,
      auth: [
        {
          id: "api-key",
          label: "API Key",
          hint: "Use Azure OpenAI API key from environment or paste manually",
          kind: "api_key",
          run: async (ctx) => {
            const endpoint = await ctx.prompter.text({
              message: "Azure OpenAI endpoint URL",
              placeholder: "https://your-resource-name.openai.azure.com",
              validate: (value) => {
                const val = String(value ?? "").trim().replace(/\/$/, "");
                if (!val) {
                  return "Endpoint URL is required";
                }
                try {
                  new URL(val);
                  return undefined;
                } catch {
                  return "Invalid URL format";
                }
              },
            });

            const deploymentName = await ctx.prompter.text({
              message: "Deployment name (optional, can be configured per model)",
              placeholder: "gpt-4o",
            });

            const apiKey = await ctx.prompter.text({
              message: "Paste Azure OpenAI API key",
              validate: (value) => {
                const val = String(value ?? "").trim();
                return val ? undefined : "API key is required";
              },
            });

            const endpointUrl = String(endpoint).trim();
            const apiKeyStr = String(apiKey).trim();

            const models = await fetchAzureOpenAiModels({
              endpoint: endpointUrl,
              apiKey: apiKeyStr,
            });

            const selectedDefaultModel = await ctx.prompter.select({
              message: "Select the default Azure OpenAI model",
              options: models.map((model) => ({
                label: model.name,
                value: model.id,
              })),
            });

            const profileId = `azure-openai:${new URL(endpointUrl).hostname}`;

            const baseUrl = `${endpointUrl}/openai/v1`;

            return {
              profiles: [
                {
                  profileId,
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: apiKeyStr,
                    metadata: {
                      endpoint: endpointUrl,
                    },
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl,
                      api: "openai-completions" as const,
                      apiKey: `profile:${profileId}`,
                      headers: {
                        "api-key": `profile:${profileId}`,
                      },
                      models,
                    },
                  },
                },
              },
              defaultModel: `${PROVIDER_ID}/${selectedDefaultModel}`,
              notes: [
                "Model list was fetched from Azure OpenAI v1 REST API.",
                "API version is managed automatically by the OpenAI SDK.",
              ],
            };
          },
        },
        {
          id: "keyless",
          label: "Keyless (DefaultAzureCredential)",
          hint: "Use Azure managed identity or service principal",
          kind: "custom",
          run: async (ctx) => {
            const endpoint = await ctx.prompter.text({
              message: "Azure OpenAI endpoint URL",
              placeholder: "https://your-resource-name.openai.azure.com",
              validate: (value) => {
                const val = String(value ?? "").trim().replace(/\/$/, "");
                if (!val) {
                  return "Endpoint URL is required";
                }
                try {
                  new URL(val);
                  return undefined;
                } catch {
                  return "Invalid URL format";
                }
              },
            });

            const endpointUrl = String(endpoint).trim();

            const spin = ctx.prompter.progress("Acquiring Azure credentials…");
            try {
              // Test the credentials by getting a token
              const tokenResult = await getAzureAccessToken();

              const models = await fetchAzureOpenAiModels({
                endpoint: endpointUrl,
                bearerToken: tokenResult.token,
              });

              const selectedDefaultModel = await ctx.prompter.select({
                message: "Select the default Azure OpenAI model",
                options: models.map((model) => ({
                  label: model.name,
                  value: model.id,
                })),
              });

              spin.stop("Azure credentials acquired successfully");

              const profileId = `azure-openai:${new URL(endpointUrl).hostname}`;

              // Build base URL with deployment if provided
              let baseUrl = `${endpointUrl}/openai/v1`;

              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "oauth",
                      provider: PROVIDER_ID,
                      access: tokenResult.token,
                      refresh: "", // Refresh handled by DefaultAzureCredential
                      expires: tokenResult.expires,
                      metadata: {
                        endpoint: endpointUrl,
                        useKeyless: true,
                      },
                    },
                  },
                ],
                configPatch: {
                  models: {
                    providers: {
                      [PROVIDER_ID]: {
                        baseUrl,
                        api: "openai-completions" as const,
                        auth: "token" as const,
                        models,
                      },
                    },
                  },
                },
                defaultModel: `${PROVIDER_ID}/${selectedDefaultModel}`,
                notes: [
                  "Keyless authentication uses DefaultAzureCredential.",
                  "Supports managed identity, service principal, and Azure CLI credentials.",
                  "Model list was fetched from Azure OpenAI v1 REST API.",
                  "Tokens are refreshed automatically.",
                  "Ensure your Azure identity has 'Cognitive Services OpenAI User' role.",
                ],
              };
            } catch (err) {
              spin.stop("Failed to acquire Azure credentials");
              const errorMessage = [
                `Azure authentication failed: ${String(err)}`,
                "",
                "Ensure you have:",
                "1. Azure CLI installed and logged in (az login), OR",
                "2. Service principal credentials set (AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID), OR",
                "3. Managed identity configured on your Azure resource",
              ].join("\n");
              throw new Error(errorMessage, { cause: err });
            }
          },
        },
      ],
      refreshOAuth: async (cred) => {
        // Only refresh if using keyless authentication
        if (cred.metadata?.useKeyless) {
          const endpoint = String(cred.metadata?.endpoint ?? "");

          const result = await getAzureAccessToken();

          return {
            ...cred,
            access: result.token,
            expires: result.expires,
          };
        }
        return cred;
      },
    });
  },
};

export default azureOpenAiPlugin;
