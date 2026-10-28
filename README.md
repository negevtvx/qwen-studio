# Qwen Studio

A small local window for **Qwen Image 2.1 Turbo**. You pick how much VRAM you have. The installer downloads the matching model and opens the app. There is no node graph.

Double-click **`Install.bat`**.

| VRAM | What it downloads | Comfortable size |
|---|---|---|
| **12 GB** | Q4 Turbo denoiser + Q4 uncensored text encoder | 1 megapixel (1024) |
| **16 GB** | Q5 pack | up to about 2 megapixels |
| **24 GB** | Q8 pack | up to native 2K |

Each pack is a few to about 18 GB. The same vision file and VAE are shared. Run `Install.bat` again to add another size. In the app, the 12 / 16 / 24 buttons light up only after that pack is on disk.

You need an NVIDIA GPU, Windows, and Node.js 22 or newer. If Node is missing, the installer tries to install it and then asks you to run it once more. If you do not already have ComfyUI, press Enter when asked and it downloads the official Windows portable build (about 2 GB, unpacked with 7-Zip).

Generation is 8 Euler steps at CFG 1, which is the schedule Turbo was distilled for. On 12 GB the cache stays in system RAM and ComfyUI is started with `--lowvram`.

Images land in `outputs\`. Closing the window stops the ComfyUI process this app started.

The models come from [AtomicChat/Qwen-Image-2.1-Turbo-GGUF](https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-GGUF), [AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF](https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF), and [Comfy-Org/Qwen-Image-2.1](https://huggingface.co/Comfy-Org/Qwen-Image-2.1). The denoiser is under the Qwen Research License. The text encoder is Apache-2.0. Do not use it to make sexual images of minors, or intimate images of real people without their consent.
