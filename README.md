# iPhone Local AI Test

A zero API fee proof of concept for running a small multimodal vision model directly in iPhone Safari with WebGPU.

## Phase 1

The first model is `HuggingFaceTB/SmolVLM-256M-Instruct`.

The test page checks WebGPU, loads the model from Hugging Face, accepts a camera or photo input, resizes the image locally, and runs vision inference in the browser.

## Cost guard

This test contains no OpenAI API integration, no Firebase integration, no Cloud Functions and no Firebase Storage calls.

Network access is used only to load the GitHub Pages site, Transformers.js from jsDelivr and public model files from Hugging Face. Once loaded, image inference runs locally in the browser.

## Files

`index.html` user interface

`style.css` mobile friendly styling

`app.js` browser controller and diagnostics

`worker.js` WebGPU model loading and local inference
