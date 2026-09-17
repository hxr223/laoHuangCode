# Custom Model Configuration

LaoHuang loads `custom-models.json` beside its `config.json` (normally
`~/.config/laohuang/custom-models.json`). This is a user-owned file. The existing
`models.json` is a machine-written dynamic catalog cache; do not edit it to add
models.

## Relay Example

```json
{
  "providers": {
    "my-relay": {
      "name": "My Relay",
      "api": "openai-completions",
      "baseUrl": "https://relay.example.com/v1",
      "apiKeyEnv": "MY_RELAY_API_KEY",
      "models": [
        {
          "id": "MODEL_ID_ACCEPTED_BY_RELAY",
          "name": "My Model",
          "contextWindow": 128000,
          "maxTokens": 8192,
          "reasoning": false,
          "input": ["text"]
        }
      ]
    }
  }
}
```

Replace the URL, model ID, token limits and capabilities with the provider's
documented values. `apiKeyEnv` is an environment variable **name**, not a key or
shell expression. Omit it to use `/login my-relay`; login writes to the existing
private `credentials.json`. A stored key takes precedence over the environment.
Provider IDs isolate credentials: `my-relay` never inherits `openai` credentials.
Literal `apiKey`, authentication headers and shell commands are not supported in
this file. Custom headers are literal non-authentication values, not templates.

From an existing session, use `/login my-relay`, then `/model my-relay` or
`/model my-relay MODEL_ID_ACCEPTED_BY_RELAY`. To save a startup profile:

```sh
laohuang config --profile relay --provider my-relay --model MODEL_ID_ACCEPTED_BY_RELAY
```

## Fields

- Providers: `name`, `api`, `baseUrl`, `apiKeyEnv`, `headers`, `compat`, `models`.
- Models: `id`, `name`, `api`, `baseUrl`, `reasoning`, `thinkingLevelMap`, `input`,
  `contextWindow`, `maxTokens`, `cost`, `headers`, `compat`, `samplingParams`.
- Custom protocols: `openai-completions`, `openai-responses`,
  `anthropic-messages`, `google-generative-ai`. Private protocols and OAuth are
  not implemented by this configuration feature.
- New models require an API, URL, context window and output limit. API and URL
  may be declared on the provider; an existing provider's default URL can be
  inherited. `reasoning` defaults to false and `input` defaults to `["text"]`.
- `thinkingLevelMap` maps `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
  to provider effort strings; `null` disables a level. Missing levels use SDK
  defaults. `/effort` uses the resulting capabilities.
- `compat` accepts protocol-specific pi-ai 0.85.1 compatibility fields, such as
  `supportsDeveloperRole`, `maxTokensField`, `thinkingFormat` for completions,
  or `forceAdaptiveThinking` for Anthropic. Unknown fields and incompatible
  protocol/field combinations are rejected.
- Capabilities describe the model; declaring image input does not add an image
  attachment workflow to the CLI. Existing application input limitations still
  apply. New models default to zero pricing unless `cost` is supplied.

## Merge and Reload

Providers merge by provider ID and models by model ID. A model with a new ID is
added; a matching model inherits its existing metadata, overridden by explicit
fields. Other built-in models remain present. Nested `compat`, `headers`,
`thinkingLevelMap`, `samplingParams` and `cost` merge by field; arrays replace.
Model API/URL overrides take precedence over provider API/URL overrides, then
built-in values. Changing API does not inherit the previous API's compatibility
or thinking-level mapping. Unknown model IDs still fail before dispatch.

Definitions load at startup and reload on `/model` (except `/model current`)
and `/login`. No remote catalog service is added. Successful reloads update the
same SDK registry used by both the selector and request adapter. Provider-owned
catalog refreshes retain the custom overlay. No custom definition is written to
the catalog cache. Identical files do not re-register providers.

Invalid reloads report an error and retain the last valid catalog. Correct the
file and retry. At startup, invalid definitions stop startup with a configuration
error. Removing definitions or deleting the file restores built-in definitions
and removes custom-only providers/models; stored credentials are not deleted.
Select another model if the active custom model was removed. Customized providers
are not marked verified merely because the original built-in provider was.

The file follows the active config directory, including `LAOHUANG_CONFIG` and
`XDG_CONFIG_HOME`; it is not loaded from untrusted project directories.
