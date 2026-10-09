export const anthropicProviderSettings = [
  {
    key: 'api-key',
    title: 'API Key',
    description:
      "The Anthropic API uses API keys for authentication. Visit your [API Keys](https://console.anthropic.com/settings/keys) page to retrieve the API key you'll use in your requests.",
    controller_type: 'input',
    controller_props: {
      placeholder: 'Insert API Key',
      value: '',
      type: 'password',
      input_actions: ['unobscure', 'copy'],
    },
  },
  {
    key: 'base-url',
    title: 'Base URL',
    description:
      'The base endpoint to use. See the [Anthropic API documentation](https://docs.anthropic.com/en/api/getting-started) for more information.',
    controller_type: 'input',
    controller_props: {
      placeholder: 'https://api.anthropic.com/v1',
      value: 'https://api.anthropic.com/v1',
    },
  },
]

export const openAIProviderSettings = [
  {
    key: 'api-key',
    title: 'API Key',
    description:
      "The OpenAI API uses API keys for authentication. Visit your [API Keys](https://platform.openai.com/account/api-keys) page to retrieve the API key you'll use in your requests.",
    controller_type: 'input',
    controller_props: {
      placeholder: 'Insert API Key',
      value: '',
      type: 'password',
      input_actions: ['unobscure', 'copy'],
    },
  },
  {
    key: 'base-url',
    title: 'Base URL',
    description:
      'The base endpoint to use. See the [OpenAI API documentation](https://platform.openai.com/docs/api-reference/chat/create) for more information.',
    controller_type: 'input',
    controller_props: {
      placeholder: 'https://api.openai.com/v1',
      value: 'https://api.openai.com/v1',
    },
  },
]
export const predefinedProviders = [
  {
    active: true,
    api_key: '',
    base_url: 'https://api.openai.com/v1',
    explore_models_url: 'https://platform.openai.com/docs/models',
    provider: 'openai',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The OpenAI API uses API keys for authentication. Visit your [API Keys](https://platform.openai.com/account/api-keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
    explore_models_url: 'https://oai.azure.com/deployments',
    provider: 'azure',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          'The Azure OpenAI API uses API keys for authentication. Visit your [Azure OpenAI Studio](https://oai.azure.com/) to retrieve the API key from your resource.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'Your Azure OpenAI resource endpoint, e.g. https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
        controller_type: 'input',
        controller_props: {
          placeholder: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
          value: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.anthropic.com/v1',
    provider: 'anthropic',
    api_type: 'anthropic',
    explore_models_url:
      'https://docs.anthropic.com/en/docs/about-claude/models',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Anthropic API uses API keys for authentication. Visit your [API Keys](https://console.anthropic.com/settings/keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
    custom_header: [
      {
        header: 'anthropic-version',
        value: '2023-06-01'
      },
      {
        header: 'anthropic-dangerous-direct-browser-access',
        value: 'true'
      }
    ]
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://openrouter.ai/api/v1',
    explore_models_url: 'https://openrouter.ai/models',
    provider: 'openrouter',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The OpenRouter API uses API keys for authentication. Visit your [API Keys](https://openrouter.ai/settings/keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [
      {
        id: 'deepseek/deepseek-r1:free',
        name: 'DeepSeek-R1 (free)',
        version: '1.0',
        description: '',
        capabilities: ['completion'],
      },
      {
        id: 'qwen/qwen3-30b-a3b:free',
        name: 'Qwen3 30B A3B (free)',
        version: '1.0',
        description: '',
        capabilities: ['completion'],
      },
    ],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.mistral.ai/v1',
    explore_models_url:
      'https://docs.mistral.ai/getting-started/models/models_overview/',
    provider: 'mistral',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Mistral API uses API keys for authentication. Visit your [API Keys](https://console.mistral.ai/api-keys/) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.groq.com/openai/v1',
    explore_models_url: 'https://console.groq.com/docs/models',
    provider: 'groq',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Groq API uses API keys for authentication. Visit your [API Keys](https://console.groq.com/keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.x.ai/v1',
    explore_models_url: 'https://docs.x.ai/overview',
    provider: 'xai',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The xAI API uses API keys for authentication. Visit your [API Keys](https://console.x.ai/) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    explore_models_url: 'https://ai.google.dev/gemini-api/docs/models/gemini',
    provider: 'gemini',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Google API uses API keys for authentication. Visit your [API Keys](https://aistudio.google.com/apikey) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.minimax.io/v1',
    explore_models_url: 'https://platform.minimax.io/docs/api-reference/text-openai-api',
    provider: 'minimax',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The MiniMax API uses API keys for authentication. Visit your [API Keys](https://platform.minimax.io/user-center/basic-information/interface-key) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [
      {
        id: 'MiniMax-M3',
        name: 'MiniMax-M3',
        version: '1.0',
        description: 'Latest flagship model for agents, coding and long documents. 1M context window.',
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'MiniMax-M2.7',
        name: 'MiniMax-M2.7',
        version: '1.0',
        description: 'Flagship model with enhanced reasoning and coding. 204K context window.',
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'MiniMax-M2.7-highspeed',
        name: 'MiniMax-M2.7-highspeed',
        version: '1.0',
        description: 'High-speed version of M2.7 for low-latency scenarios.',
        capabilities: ['completion', 'tools'],
      },
    ],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://router.huggingface.co/v1',
    explore_models_url:
      'https://huggingface.co/models?pipeline_tag=text-generation&inference_provider=all',
    provider: 'huggingface',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Hugging Face API uses tokens for authentication. Visit your [Access Tokens](https://huggingface.co/settings/tokens) page to retrieve the token you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Token',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [
      {
        id: 'moonshotai/Kimi-K2-Instruct:groq',
        name: 'Kimi-K2-Instruct',
        version: '1.0',
        description:
          '1T parameters Moonshot chat model tuned for tool-aware, nuanced responses.',
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'deepseek-ai/DeepSeek-R1-0528',
        name: 'DeepSeek-R1-0528',
        version: '1.0',
        description:
          "DeepSeek's flagship reasoning engine with open weights and advanced tool control.",
        capabilities: ['completion', 'tools'],
      },
      {
        id: 'deepseek-ai/DeepSeek-V3-0324',
        name: 'DeepSeek-V3-0324',
        version: '1.0',
        description:
          'Streamlined DeepSeek model focused on fast, high-quality completions and tool use.',
        capabilities: ['completion', 'tools'],
      },
    ],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://integrate.api.nvidia.com/v1',
    explore_models_url: 'https://build.nvidia.com/models',
    provider: 'nvidia',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The NVIDIA NIM API uses API keys for authentication. Visit [NVIDIA NGC API Keys](https://org.ngc.nvidia.com/setup/api-keys) to create an API key for your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.deepseek.com',
    explore_models_url: 'https://api-docs.deepseek.com/',
    provider: 'deepseek',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The DeepSeek API uses API keys for authentication. Visit your [API Keys](https://platform.deepseek.com/api_keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.moonshot.ai/v1',
    explore_models_url: 'https://platform.kimi.ai/docs/models',
    provider: 'moonshot',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Moonshot AI API uses API keys for authentication. Visit your [API Keys](https://platform.kimi.ai/console/api-keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.cohere.ai/compatibility/v1',
    explore_models_url: 'https://docs.cohere.com/docs/models',
    provider: 'cohere',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Cohere API uses API keys for authentication. Visit your [API Keys](https://dashboard.cohere.com/api-keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.perplexity.ai',
    explore_models_url: 'https://docs.perplexity.ai/getting-started/models',
    provider: 'perplexity',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Perplexity API uses API keys for authentication. Visit your [API Keys](https://www.perplexity.ai/settings/api) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.together.ai/v1',
    explore_models_url: 'https://docs.together.ai/docs/serverless/models',
    provider: 'together',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Together AI API uses API keys for authentication. Visit your [API Keys](https://api.together.ai/settings/projects/~current/api-keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.fireworks.ai/inference/v1',
    explore_models_url: 'https://app.fireworks.ai/models',
    provider: 'fireworks',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Fireworks API uses API keys for authentication. Visit your [API Keys](https://app.fireworks.ai/settings/users/api-keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.cerebras.ai/v1',
    explore_models_url: 'https://inference-docs.cerebras.ai/models/overview',
    provider: 'cerebras',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Cerebras API uses API keys for authentication. Visit your [API Keys](https://cloud.cerebras.ai) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.sambanova.ai/v1',
    explore_models_url: 'https://docs.sambanova.ai/docs/en/models/sambacloud-models',
    provider: 'sambanova',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The SambaNova API uses API keys for authentication. Visit your [API Keys](https://cloud.sambanova.ai/apis) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.z.ai/api/paas/v4',
    explore_models_url: 'https://docs.z.ai/guides/overview/overview',
    provider: 'zai',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Z.ai API uses API keys for authentication. Visit your [API Keys](https://z.ai/manage-apikey/apikey-list) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    explore_models_url: 'https://www.alibabacloud.com/help/en/model-studio/models',
    provider: 'qwen',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Alibaba Cloud Model Studio API uses API keys for authentication. Visit your [API Keys](https://www.alibabacloud.com/help/en/model-studio/get-api-key) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'Your Model Studio endpoint. A key only works in the region it was created in: use https://dashscope-intl.aliyuncs.com/compatible-mode/v1 for Singapore or https://dashscope.aliyuncs.com/compatible-mode/v1 for mainland China.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
          value: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://api.poe.com/v1',
    explore_models_url: 'https://poe.com/explore',
    provider: 'poe',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Poe API uses API keys for authentication. Visit your [API Keys](https://poe.com/api/keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://ollama.com/v1',
    explore_models_url: 'https://ollama.com/search?c=cloud',
    provider: 'ollama-cloud',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          "The Ollama Cloud API uses API keys for authentication. Visit your [API Keys](https://ollama.com/settings/keys) page to retrieve the API key you'll use in your requests.",
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
    ],
    models: [],
  },
  {
    active: true,
    api_key: '',
    base_url: 'http://localhost:17434/v1',
    explore_models_url: 'https://hub.docker.com/catalogs/models',
    provider: 'llmman',
    settings: [
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'The base endpoint to use. llmman serves an OpenAI-compatible API on port 17434 by default; change this if you started it with a different LLMMAN_HOST.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'http://localhost:17434/v1',
          value: 'http://localhost:17434/v1',
        },
      },
    ],
    models: [],
  },
]
