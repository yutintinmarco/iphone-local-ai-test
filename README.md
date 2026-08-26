# iPhone Local AI Test

A zero API fee proof of concept for running local vision and OCR models directly in iPhone Safari with WebGPU.

## Phase 1 result

`HuggingFaceTB/SmolVLM-256M-Instruct` successfully loaded and ran locally on iPhone Safari, proving the WebGPU browser inference path. However, repeated tests produced unreliable and degenerate outputs, so SmolVLM 256M is retained only as a failed speed baseline and is not suitable for the Price Tracker use case.

## Phase 2

The current model is `wolfofbackstreet/GLM-OCR-ONNX-q4f16`, a browser optimized q4f16 ONNX packaging of GLM-OCR at about 635 MB.

The first Phase 2 test uses the model's standard `Text Recognition:` instruction to measure raw Chinese and English OCR quality on real supermarket price tags before adding structured price and promotion interpretation.

The test page checks WebGPU, loads the model from Hugging Face, accepts a camera or photo input, resizes the image locally, and runs inference in the browser.

## Cost guard

This test contains no OpenAI API integration, no Firebase integration, no Cloud Functions and no Firebase Storage calls.

Network access is used only to load the GitHub Pages site, Transformers.js from jsDelivr and public model files from Hugging Face. Once loaded, image inference runs locally in the browser.

## Files

`index.html` user interface

`style.css` mobile friendly styling

`bootstrap.js` build version and cache busting

`app.js` browser controller and diagnostics

`worker.js` WebGPU model loading and local inference
