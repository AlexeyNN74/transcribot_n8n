# Transcribe Studio — Dockerfile v2.1
# v2.1: переход с node:20-alpine на node:20-bookworm-slim,
#       так как @huggingface/transformers использует onnxruntime-node,
#       у которого нет prebuild для musl libc (Alpine).
#       На bookworm (glibc) — native бинарник работает из коробки,
#       INT8-инференс bge-m3 в 3-5× быстрее, чем WASM-фолбэк.
#
# Volume cache модели монтируется как:
#   /opt/transcribe/data/hf-cache:/root/.cache/huggingface
# (bge-m3 q8 ~ 600 МБ, скачивается один раз при первой индексации)

FROM node:20-bookworm-slim

# openssh-client для SSH/SCP к GPU, ca-certificates для HTTPS-загрузки модели
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
