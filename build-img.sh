#!/bin/bash

git clone --depth 1 https://github.com/openclaw/openclaw.git
mkdir -p openclaw/extensions/azure-openai && find . -maxdepth 1 -type f ! -name 'build-img.sh' -exec cp -t openclaw/extensions/azure-openai -- {} +
cd openclaw
echo 'RUN cd extensions/azure-openai && pnpm install' >> Dockerfile
echo 'RUN node openclaw.mjs plugins enable azure-openai' >> Dockerfile
docker build . -t openclaw

