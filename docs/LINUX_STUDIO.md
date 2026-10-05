# Studio on Linux

Studio installs the pinned stable-diffusion.cpp Linux x86-64 engine directly from
its upstream release, checks its exact size and SHA-256, restores Unix executable
permissions and checks that sd-server starts. Model weights use the same resumable
Hugging Face downloader as Windows. Images, video, custom models and LoRAs use the
shared runtime and gallery.

Choose **Any graphics card** for the Vulkan build (NVIDIA, AMD or Intel with a
working Vulkan driver), or **No graphics card** for the CPU build. NVIDIA on Linux
uses Vulkan in this release: the pinned upstream release does not supply a Linux
CUDA build, so Flint does not offer the Windows CUDA package on Linux.

The server's bundled ggml and codec libraries are placed beside it and prepended
to its LD_LIBRARY_PATH. System C++/OpenMP libraries and, for Vulkan, the system
Vulkan loader and GPU driver are still required. The upstream binaries target
Ubuntu 24.04 x86-64; modern Arch Linux is supported by this packaging. Older glibc
distributions and Linux ARM need a compatible native build before being offered.
If a library or driver is missing, the engine startup check reports the failure.

For example, Arch users need the appropriate Vulkan driver package for their
GPU, plus vulkan-icd-loader and GCC/OpenMP runtime libraries. GPU driver setup
belongs to the system package manager; Flint does not install or replace drivers.

Validation covers platform-specific engine IDs and checksums, extraction path
containment, executable permissions without privilege bits, and extraction and
startup of the actual pinned Linux CPU archive. The full packaged GUI and
model generation still require desktop/GPU testing.
