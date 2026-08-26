import {
  AutoProcessor,
  AutoModelForVision2Seq,
  TextStreamer,
  load_image,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

const MODEL_ID = "HuggingFaceTB/SmolVLM-256M-Instruct";
const MAX_NEW_TOKENS = 80;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

let processor = null;
let model = null;
let dtypeConfig = null;
let dtypeLabel = "not selected";
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

  // SmolVLM is an encoder-decoder vision model. Quantizing every module to q4f16
  // can materially hurt image understanding. Keep the sensitive embedding and
  // vision encoder at higher precision, while quantizing only the decoder.
  if (fp16) {
    dtypeConfig = {
      embed_tokens: "fp16",
      vision_encoder: "fp16",
      decoder_model_merged: "q4f16",
    };
    dtypeLabel = "mixed fp16/fp16/q4f16";
  } else {
    dtypeConfig = {
      embed_tokens: "fp32",
      vision_encoder: "fp32",
      decoder_model_merged: "q4",
    };
    dtypeLabel = "mixed fp32/fp32/q4";
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

  post("checked", { fp16, dtype: dtypeLabel, adapterInfo });
}

async function getModel(progressCallback) {
  if (processor && model) return [processor, model];

  if (!loadingPromise) {
    loadingPromise = (async () => {
      await checkWebGPU();
      post("loading", { message: `Loading ${MODEL_ID} (${dtypeLabel})` });

      const processorPromise = AutoProcessor.from_pretrained(MODEL_ID, {
        progress_callback: progressCallback,
      });

      const modelPromise = AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
        device: "webgpu",
        dtype: dtypeConfig,
        progress_callback: progressCallback,
      });

      [processor, model] = await Promise.all([processorPromise, modelPromise]);
      post("ready", { modelId: MODEL_ID, dtype: dtypeLabel });
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
  await getModel((event) => post("progress_event", { event }));
}

async function generate({ image, prompt }) {
  const [localProcessor, localModel] = await getModel((event) =>
    post("progress_event", { event }),
  );

  post("generation_start");

  const messages = [
    {
      role: "user",
      content: [
        { type: "image", image },
        { type: "text", text: prompt },
      ],
    },
  ];

  const images = [await load_image(image)];
  const text = localProcessor.apply_chat_template(messages, {
    add_generation_prompt: true,
  });
  const inputs = await localProcessor(text, images, {
    do_image_splitting: false,
  });

  let generated = "";
  let tokenCount = 0;
  let firstTokenAt = null;

  const streamer = new TextStreamer(localProcessor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk) => {
      generated += chunk;
      post("generation_update", { output: generated });
    },
    token_callback_function: () => {
      tokenCount += 1;
      firstTokenAt ??= performance.now();
    },
  });

  const startedAt = performance.now();
  await localModel.generate({
    ...inputs,
    do_sample: false,
    repetition_penalty: 1.12,
    max_new_tokens: MAX_NEW_TOKENS,
    streamer,
  });

  const elapsedMs = performance.now() - startedAt;
  const generationMs = firstTokenAt ? performance.now() - firstTokenAt : elapsedMs;
  const tokensPerSecond = generationMs > 0 ? (tokenCount / generationMs) * 1000 : null;

  post("generation_complete", {
    output: generated.trim(),
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
