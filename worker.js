import {
  AutoProcessor,
  AutoModelForImageTextToText,
  TextStreamer,
  load_image,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

const MODEL_ID = "wolfofbackstreet/GLM-OCR-ONNX-q4f16";
const DTYPE = "q4f16";
const MAX_NEW_TOKENS = 384;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

let processor = null;
let model = null;
let loadingPromise = null;

function post(status, data = {}) {
  self.postMessage({ status, ...data });
}

async function checkWebGPU() {
  if (!self.navigator?.gpu) {
    throw new Error("WebGPU is not available in this browser.");
  }

  const adapter = await self.navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("WebGPU adapter could not be created.");
  }

  const fp16 = adapter.features.has("shader-f16");
  if (!fp16) {
    throw new Error("This GLM-OCR q4f16 test requires shader-f16 support.");
  }

  let adapterInfo = "WebGPU adapter ready";
  try {
    if (adapter.info) {
      const bits = [adapter.info.vendor, adapter.info.architecture, adapter.info.device]
        .filter(Boolean)
        .join(" · ");
      if (bits) adapterInfo = bits;
    }
  } catch (_) {
    // Adapter information is optional and may be hidden by the browser.
  }

  post("checked", { fp16, dtype: DTYPE, adapterInfo });
}

function progressForwarder(event) {
  post("progress_event", { event });
}

async function buildAugmentedConfig() {
  const configUrl = `https://huggingface.co/${MODEL_ID}/resolve/main/config.json`;
  const response = await fetch(configUrl);
  if (!response.ok) {
    throw new Error(`Could not fetch model config (${response.status})`);
  }

  const config = await response.json();
  const tjsConfig = config["transformers.js_config"] || {};
  const externalData = tjsConfig.use_external_data_format || {};

  externalData["vision_encoder_q4f16.onnx"] = 1;
  externalData["decoder_model_merged_q4f16.onnx"] = 1;
  externalData["embed_tokens_q4f16.onnx"] = 1;

  tjsConfig.use_external_data_format = externalData;
  config["transformers.js_config"] = tjsConfig;
  return config;
}

async function loadGlmOcrModel() {
  const commonOptions = {
    device: "webgpu",
    dtype: DTYPE,
    progress_callback: progressForwarder,
  };

  try {
    return await AutoModelForImageTextToText.from_pretrained(MODEL_ID, commonOptions);
  } catch (firstError) {
    post("loading", {
      message: "Retrying GLM-OCR with explicit external-data configuration…",
    });

    const config = await buildAugmentedConfig();
    try {
      return await AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
        ...commonOptions,
        config,
      });
    } catch (secondError) {
      throw new Error(
        `GLM-OCR model load failed. First attempt: ${firstError?.message || firstError}. Retry: ${secondError?.message || secondError}`,
      );
    }
  }
}

async function getModel() {
  if (processor && model) return [processor, model];

  if (!loadingPromise) {
    loadingPromise = (async () => {
      await checkWebGPU();
      post("loading", {
        message: `Loading GLM-OCR 0.9B browser model (${DTYPE}, about 635 MB)…`,
      });

      processor = await AutoProcessor.from_pretrained(MODEL_ID, {
        progress_callback: progressForwarder,
      });

      model = await loadGlmOcrModel();
      post("ready", { modelId: MODEL_ID, dtype: DTYPE });
      return [processor, model];
    })().catch((error) => {
      loadingPromise = null;
      processor = null;
      model = null;
      throw error;
    });
  }

  return loadingPromise;
}

async function loadModel() {
  await getModel();
}

async function generate({ image, prompt }) {
  const [localProcessor, localModel] = await getModel();
  post("generation_start");

  const instruction = prompt?.trim() || "Text Recognition:";
  const messages = [
    {
      role: "user",
      content: [
        { type: "image" },
        { type: "text", text: instruction },
      ],
    },
  ];

  const imageObject = await load_image(image);
  const text = localProcessor.apply_chat_template(messages, {
    add_generation_prompt: true,
  });
  const inputs = await localProcessor(text, imageObject, {
    add_special_tokens: false,
  });

  let streamed = "";
  let tokenCount = 0;
  let firstTokenAt = null;

  const streamer = new TextStreamer(localProcessor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk) => {
      streamed += chunk;
      post("generation_update", { output: streamed });
    },
    token_callback_function: () => {
      tokenCount += 1;
      firstTokenAt ??= performance.now();
    },
  });

  const startedAt = performance.now();
  const generatedIds = await localModel.generate({
    ...inputs,
    do_sample: false,
    repetition_penalty: 1.15,
    max_new_tokens: MAX_NEW_TOKENS,
    streamer,
  });

  const promptLength = inputs.input_ids?.dims?.at(-1) ?? 0;
  let decoded = "";
  try {
    const completionIds = generatedIds.slice(null, [promptLength, null]);
    const decodedBatch = localProcessor.batch_decode(completionIds, {
      skip_special_tokens: true,
    });
    decoded = decodedBatch?.[0]?.trim() || "";
  } catch (_) {
    decoded = "";
  }

  const output = decoded || streamed.trim();
  const elapsedMs = performance.now() - startedAt;
  const generationMs = firstTokenAt ? performance.now() - firstTokenAt : elapsedMs;
  const tokensPerSecond = generationMs > 0 && tokenCount > 0
    ? (tokenCount / generationMs) * 1000
    : null;

  post("generation_complete", {
    output,
    elapsedMs,
    tokenCount,
    tokensPerSecond,
  });
}

self.addEventListener("message", async (event) => {
  const { type, data } = event.data || {};

  try {
    if (type === "check") {
      await checkWebGPU();
    } else if (type === "load") {
      await loadModel();
    } else if (type === "generate") {
      await generate(data);
    }
  } catch (error) {
    post("error", {
      message: error?.message || String(error),
      stack: error?.stack || "",
    });
  }
});
