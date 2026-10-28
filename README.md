# Qwen Studio

A local window for **Qwen Image 2.1 Turbo**. You type how much VRAM you have. It downloads that model and opens the app. No node graph.

## Install

You need **Windows** and an **NVIDIA** GPU.

1. Install [Node.js 22](https://nodejs.org) if it is not already installed. The installer will try to do this for you.
2. [Download this project](https://github.com/negevtvx/qwen-studio/archive/refs/heads/master.zip) and unzip it.
3. Double-click **`Install.bat`**.
4. Type **`12`**, **`16`**, or **`24`** and press Enter.
5. Wait for the download. The app opens when it is done.

If you do not already have ComfyUI, press Enter when it asks. It downloads the official Windows build.

Run `Install.bat` again later to add another size. In the app, only the sizes you downloaded can be selected.

| You type | What you get | Good for |
|---|---|---|
| `12` | Q4 pack, about 10 GB | 1024 images |
| `16` | Q5 pack, about 13 GB | up to about 2 megapixels |
| `24` | Q8 pack, about 18 GB | up to native 2K |

## Examples

Same prompt, same seed, 1024×1024, 8 steps. The only change is the VRAM pack.

### Anime

| 12 GB | 16 GB | 24 GB |
|---|---|---|
| <img src="examples/12gb-anime.jpg" width="250" alt="12 GB anime"> | <img src="examples/16gb-anime.jpg" width="250" alt="16 GB anime"> | <img src="examples/24gb-anime.jpg" width="250" alt="24 GB anime"> |

### Portrait

| 12 GB | 16 GB | 24 GB |
|---|---|---|
| <img src="examples/12gb-portrait.jpg" width="250" alt="12 GB portrait"> | <img src="examples/16gb-portrait.jpg" width="250" alt="16 GB portrait"> | <img src="examples/24gb-portrait.jpg" width="250" alt="24 GB portrait"> |

Q4 on 12 GB already holds the same picture. Q5 and Q8 keep a little more detail in hair, signs, and skin.

## After it is open

Generate with Ctrl+Enter. Images are saved in `outputs\`. Closing the window stops the ComfyUI process this app started.

The models are [Qwen-Image-2.1-Turbo](https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-GGUF) and the [uncensored text encoder](https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF), plus the [official VAE](https://huggingface.co/Comfy-Org/Qwen-Image-2.1). The denoiser is under the Qwen Research License. The text encoder is Apache-2.0. Do not use it to make sexual images of minors, or intimate images of real people without their consent.
